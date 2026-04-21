/**
 * Cognito JWT auth middleware.
 *
 * Two modes (see env.AUTH_MODE):
 *
 *   bypass  → local dev. Attaches a fake user to req.user and calls next().
 *             Also honours the X-Dev-User header so tests can specify a user id.
 *
 *   cognito → production. Verifies the Bearer token using the Cognito User
 *             Pool's JWKS endpoint. On any failure, returns 401.
 */

import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtHeader, type VerifyOptions } from 'jsonwebtoken';
import type { JwksClient, SigningKey } from 'jwks-rsa';
import jwksClient from 'jwks-rsa';

import { env } from '../env';
import { ApiError } from '../lib/errors';
import { logger } from '../logger';

export interface AuthenticatedUser {
  id: string;
  email?: string;
  sub: string;
  token_use?: string;
  [key: string]: unknown;
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

export function auth(req: Request, _res: Response, next: NextFunction): void {
  if (env.authMode === 'bypass') {
    const devUserId = (req.header('x-dev-user') || env.devUserId).trim();
    req.user = {
      id: devUserId,
      sub: devUserId,
      email: 'dev@local',
      token_use: 'dev-bypass',
    };
    return next();
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
    req.user = {
      id,
      sub: id,
      email: payload.email as string | undefined,
      token_use: payload.token_use as string | undefined,
      ...payload,
    };
    next();
  });
}
