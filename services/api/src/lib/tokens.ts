/**
 * One-time link tokens (invites, password reset, email verification).
 * The token goes in the emailed/shared link; only its SHA-256 is stored,
 * so a database leak does not hand out working links.
 */

import { createHash, randomBytes } from 'crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/** Plausible shape, so junk is refused before any query. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{40,64}$/;
