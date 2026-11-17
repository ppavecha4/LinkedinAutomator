/**
 * What a signed-in session may do RIGHT NOW (V23 session_state()).
 *
 * The session cookie is a 7-day JWT, but removing a member, changing a
 * role, suspending an organization or resetting a password must take
 * effect at once. So every local-auth request asks the database (through
 * a narrow SECURITY DEFINER function — there is no tenant yet) and the
 * role comes from the membership, not from the cookie. Answers are cached
 * for a few seconds so this is not a query per request; changes made by
 * this API process drop the cache entry immediately (forgetSession).
 */

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from './errors';
import { mailerConfigured } from './mailer';
import { isOrgRole, type OrgRole } from './tenantContext';

export interface SessionState {
  role: OrgRole;
  org_status: string;
  password_changed_at: Date | null;
  email_verified_at: Date | null;
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; state: SessionState | null }>();

export async function sessionState(userId: string, orgId: string): Promise<SessionState | null> {
  const key = `${userId}:${orgId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.state;
  const r = await query<SessionState & { role: string }>(`SELECT * FROM session_state($1, $2)`, [userId, orgId]);
  const row = r.rows[0];
  const state = row && isOrgRole(row.role) ? { ...row, role: row.role } : null;
  cache.set(key, { at: Date.now(), state });
  return state;
}

/** Drop cached answers for a user (all orgs), e.g. after a role change or removal. */
export function forgetSession(userId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
}

export function clearSessionCache(): void {
  cache.clear();
}

/**
 * Launching a campaign needs a verified email address — but only where we
 * can actually send the verification email (otherwise nobody could ever
 * verify). The env operator and bypass mode are exempt.
 */
export async function assertEmailVerified(user: { id: string; orgId: string; email?: string } | undefined): Promise<void> {
  if (env.authMode !== 'local' || !env.requireVerifiedEmail || !mailerConfigured() || !user) return;
  if (env.authUserEmail && (user.email ?? '').toLowerCase() === env.authUserEmail.trim().toLowerCase()) return;
  const state = await sessionState(user.id, user.orgId);
  if (state && !state.email_verified_at) {
    throw ApiError.forbidden('verify your email address before launching a campaign (check your inbox, or resend the link from the banner)');
  }
}
