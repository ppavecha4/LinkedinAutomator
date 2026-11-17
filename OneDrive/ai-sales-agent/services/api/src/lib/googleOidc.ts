/**
 * Sign in with Google (OpenID Connect, authorization-code flow + PKCE).
 *
 * The browser is sent to Google with a one-time `state`, `nonce` and PKCE
 * challenge (kept in a short-lived signed cookie). Google sends it back
 * with a `code`; the API exchanges that for an id_token over TLS, checks
 * its signature against Google's published keys, and only then trusts the
 * email in it — and only if Google says the email is verified.
 */

import { createHash, randomBytes } from 'crypto';

import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

import { env } from '../env';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS: [string, string] = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleIdentity {
  email: string;
  name: string | null;
}

export class GoogleAuthError extends Error {
  constructor(public readonly code: 'failed' | 'unverified', message: string) {
    super(message);
  }
}

/** Test seams: the token exchange and the signing-key lookup. */
export interface GoogleHooks {
  exchange?: (code: string, verifier: string) => Promise<string>;
  getKey?: (kid: string | undefined) => Promise<string>;
}
let hooks: GoogleHooks = {};
export function setGoogleHooks(h: GoogleHooks | undefined): void {
  hooks = h ?? {};
}

export function googleConfigured(): boolean {
  return !!(env.googleClientId && env.googleClientSecret);
}

export function redirectUri(): string {
  return env.googleRedirectUri || `${env.dashboardUrl.replace(/\/+$/, '')}/api/auth/google/callback`;
}

export interface Flow {
  state: string;
  nonce: string;
  verifier: string;
}

export function newFlow(): Flow {
  return {
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    verifier: randomBytes(48).toString('base64url'),
  };
}

export function authorizationUrl(f: Flow): string {
  const q = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state: f.state,
    nonce: f.nonce,
    code_challenge: createHash('sha256').update(f.verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${AUTH_URL}?${q.toString()}`;
}

async function exchangeCode(code: string, verifier: string): Promise<string> {
  if (hooks.exchange) return hooks.exchange(code, verifier);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !body.id_token) throw new GoogleAuthError('failed', `token exchange failed (${res.status})`);
  return body.id_token;
}

let jwks: ReturnType<typeof jwksClient> | null = null;
async function signingKey(kid: string | undefined): Promise<string> {
  if (hooks.getKey) return hooks.getKey(kid);
  jwks ??= jwksClient({ jwksUri: JWKS_URL, cache: true, cacheMaxAge: 6 * 60 * 60 * 1000, rateLimit: true });
  return (await jwks.getSigningKey(kid)).getPublicKey();
}

/** Check a Google id_token and return who it says signed in. */
export async function verifyIdToken(idToken: string, nonce: string): Promise<GoogleIdentity> {
  const header = jwt.decode(idToken, { complete: true })?.header;
  if (!header || header.alg !== 'RS256') throw new GoogleAuthError('failed', 'unexpected token');
  let claims: Record<string, unknown>;
  try {
    const key = await signingKey(header.kid);
    claims = jwt.verify(idToken, key, {
      algorithms: ['RS256'],
      audience: env.googleClientId,
      issuer: ISSUERS,
    }) as Record<string, unknown>;
  } catch (e) {
    throw new GoogleAuthError('failed', `token rejected: ${(e as Error).message}`);
  }
  if (claims.nonce !== nonce) throw new GoogleAuthError('failed', 'nonce mismatch');
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email || !(claims.email_verified === true || claims.email_verified === 'true')) {
    throw new GoogleAuthError('unverified', 'Google has not verified this email');
  }
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 255) : null;
  return { email, name };
}

export async function identityForCode(code: string, flow: Flow): Promise<GoogleIdentity> {
  return verifyIdToken(await exchangeCode(code, flow.verifier), flow.nonce);
}
