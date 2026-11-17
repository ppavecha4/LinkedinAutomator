/**
 * Auth middleware.
 *
 * Three modes (see env.AUTH_MODE):
 *
 *   bypass  → local dev. Attaches a fake user to req.user and calls next().
 *             Honours X-Dev-User / X-Dev-Org / X-Dev-Role headers so tests
 *             can act as any user, org and role.
 *
 *   local   → HS256 session cookie minted by POST /api/auth/login.
 *
 *   cognito → Verifies the Bearer token using the Cognito User Pool's JWKS
 *             endpoint. On any failure, returns 401.
 *
 * Every mode also resolves the ORGANIZATION the request acts for and runs
 * the rest of the request inside `runWithTenant()`, so `db/client.ts` can
 * set `app.current_org` on each transaction (SaaS phase 1). Roles are
 * carried but not enforced yet.
 */

import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtHeader, type VerifyOptions } from 'jsonwebtoken';
import type { JwksClient, SigningKey } from 'jwks-rsa';
import jwksClient from 'jwks-rsa';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { sessionState } from '../lib/sessionState';
import {
  isOrgRole,
  isUuid,
  runWithTenant,
  type OrgRole,
} from '../lib/tenantContext';
import { logger } from '../logger';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  sub: string;
  token_use?: string;
  /** Organization this request acts for. */
  orgId: string;
  /** The user's role in that organization. */
  role: OrgRole;
  [key: string]: unknown;
}

/**
 * Attach the user and continue the request inside its tenant context.
 * Everything downstream of `next()` (handlers, awaited DB calls) sees the
 * context via `currentTenant()`.
 */
function proceedAs(
  req: Request,
  next: NextFunction,
  user: AuthenticatedUser,
): void {
  if (!isUuid(user.orgId)) {
    logger.warn('auth: unusable org id', { org_id: String(user.orgId) });
    return next(ApiError.unauthorized('session has no valid organization'));
  }
  req.user = user;
  runWithTenant({ orgId: user.orgId, userId: user.id, role: user.role }, () =>
    next(),
  );
}

/** A role claim if it is a known role, else `fallback`. */
function roleOr(value: unknown, fallback: OrgRole): OrgRole {
  return isOrgRole(value) ? value : fallback;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

// Lazy JWKS client so we never hit the network in bypass mode.
let jwks: JwksClient | null = null;

function getJwks(): JwksClient {
  if (!jwks) {
    if (!env.cognitoUserPoolId) {
      throw new Error(
        'COGNITO_USER_POOL_ID must be set when AUTH_MODE=cognito',
      );
    }
    const url = `https://cognito-idp.${env.cognitoRegion}.amazonaws.com/${env.cognitoUserPoolId}/.well-known/jwks.json`;
    jwks = jwksClient({
      jwksUri: url,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000, // 10 minutes
      rateLimit: true,
      jwksRequestsPerMinute: 30,
    });
  }
  return jwks;
}

function getKey(
  header: JwtHeader,
  callback: (err: Error | null, key?: string) => void,
): void {
  const kid = header.kid;
  if (!kid) return callback(new Error('JWT has no kid'));
  getJwks().getSigningKey(kid, (err, key?: SigningKey) => {
    if (err) return callback(err);
    if (!key) return callback(new Error('no signing key'));
    callback(null, key.getPublicKey());
  });
}

/**
 * Local sessions follow the database (V23 session_state): the role is the
 * member's CURRENT role, and a removed member, a suspended org or a
 * password changed after the cookie was issued ends the session now.
 * The env operator and pre-phase-3 cookies (no user id) are exempt.
 */
async function currentSession(
  uid: string,
  orgId: string,
  issuedAt: number | undefined,
): Promise<{ role: OrgRole } | string> {
  const state = await sessionState(uid, orgId);
  if (!state) return 'you are no longer a member of this organization';
  if (state.org_status !== 'ACTIVE') return 'this organization is not active';
  if (state.password_changed_at && issuedAt && issuedAt < Math.floor(state.password_changed_at.getTime() / 1000)) {
    return 'your password was changed; sign in again';
  }
  return { role: state.role };
}

export function auth(req: Request, _res: Response, next: NextFunction): void {
  if (env.authMode === 'bypass') {
    const devUserId = (req.header('x-dev-user') || env.devUserId).trim();
    const devOrgId = (req.header('x-dev-org') || env.devOrgId).trim();
    return proceedAs(req, next, {
      id: devUserId,
      sub: devUserId,
      email: 'dev@local',
      token_use: 'dev-bypass',
      orgId: devOrgId,
      role: roleOr(req.header('x-dev-role')?.trim(), 'owner'),
    });
  }

  if (env.authMode === 'local') {
    // Cookie-based session: HS256 JWT minted by POST /api/auth/login.
    // No JWKS round-trip, no Bearer header needed.
    const token = (req as Request & { cookies?: Record<string, string> })
      .cookies?.[env.authCookieName];
    if (!token) {
      return next(ApiError.unauthorized('not signed in'));
    }
    if (!env.authJwtSecret) {
      return next(ApiError.internal('auth misconfigured'));
    }
    try {
      const decoded = jwt.verify(token, env.authJwtSecret, {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload & {
        email?: string;
        org_id?: unknown;
        role?: unknown;
        uid?: unknown;
      };
      const subject = (decoded.sub as string | undefined) ?? '';
      if (!subject) return next(ApiError.unauthorized('session missing sub'));
      // Sessions minted before SaaS phase 1 carry no org_id: they belong
      // to the configured (legacy) org, so nobody is logged out by the
      // upgrade. A token that DOES carry org_id must carry a valid one.
      const orgId =
        decoded.org_id === undefined ? env.authOrgId : decoded.org_id;
      // In local mode the JWT subject is the operator's EMAIL, but
      // `req.user.id` is written to uuid columns (campaigns.created_by,
      // audit rows). Use the configured operator UUID for `id` and keep
      // the email on `sub`/`email` for display. Without this every
      // campaign INSERT fails with "invalid input syntax for type uuid".
      const user: AuthenticatedUser = {
        // Self-serve users (phase 3) carry their own id; the env operator
        // and older sessions fall back to AUTH_USER_ID.
        id: isUuid(decoded.uid) ? decoded.uid : env.authUserId,
        sub: subject,
        email: decoded.email ?? subject,
        token_use: 'local',
        orgId: orgId as string,
        role: roleOr(decoded.role, 'owner'),
      };
      const isEnvOperator =
        !!env.authUserEmail && subject.trim().toLowerCase() === env.authUserEmail.trim().toLowerCase();
      if (!isUuid(decoded.uid) || isEnvOperator || !isUuid(orgId)) return proceedAs(req, next, user);
      currentSession(decoded.uid, orgId as string, decoded.iat)
        .then((r) =>
          typeof r === 'string'
            ? next(ApiError.unauthorized(r))
            : proceedAs(req, next, { ...user, role: r.role }),
        )
        .catch(next);
      return;
    } catch (e) {
      logger.warn('local session verify failed', {
        error: (e as Error).message,
      });
      return next(ApiError.unauthorized('invalid session'));
    }
  }

  const header = req.header('authorization') || req.header('Authorization');
  if (!header || !header.toLowerCase().startsWith('bearer ')) {
    return next(ApiError.unauthorized('missing bearer token'));
  }
  const token = header.slice(7).trim();

  const verifyOptions: VerifyOptions = {
    algorithms: ['RS256'],
    issuer: `https://cognito-idp.${env.cognitoRegion}.amazonaws.com/${env.cognitoUserPoolId}`,
  };
  if (env.cognitoClientId) {
    verifyOptions.audience = env.cognitoClientId;
  }

  jwt.verify(token, getKey, verifyOptions, (err, decoded) => {
    if (err || !decoded || typeof decoded === 'string') {
      logger.warn('jwt verify failed', { error: err?.message });
      return next(ApiError.unauthorized('invalid token'));
    }
    const payload = decoded as jwt.JwtPayload & Record<string, unknown>;
    const id = (payload.sub as string | undefined) ?? '';
    if (!id) {
      return next(ApiError.unauthorized('token missing sub'));
    }
    // Cognito: the org comes from the `custom:org_id` attribute. Pools
    // without it (single-tenant deployments) fall back to AUTH_ORG_ID.
    const orgClaim = payload['custom:org_id'];
    proceedAs(req, next, {
      ...payload,
      id,
      sub: id,
      email: payload.email as string | undefined,
      token_use: payload.token_use as string | undefined,
      orgId: (orgClaim === undefined ? env.authOrgId : orgClaim) as string,
      role: roleOr(payload['custom:org_role'], 'owner'),
    });
  });
}
