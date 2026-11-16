/**
 * Tenant resolution for UNAUTHENTICATED entry points (webhooks, the
 * unsubscribe link, the open-tracking pixel). SaaS phase 1, V17.
 *
 * These requests carry no session, so the org comes from the thing they
 * reference: a contact, a message, or the provider account that sent the
 * webhook. The lookups call V17's SECURITY DEFINER functions, which are
 * the only way to read across orgs; the actual work then runs as the
 * resolved org via `runAsOrg()`, under row-level security like any
 * signed-in request.
 */

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { isUuid, runWithTenant } from './tenantContext';
import { aadFor, decryptSecret, vaultKey } from './vault';

/** Actor id recorded for work done on behalf of an org by the system. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Run `fn` as `orgId`, acting as the system (not a signed-in user). */
export function runAsOrg<T>(orgId: string, fn: () => T): T {
  return runWithTenant({ orgId, userId: SYSTEM_USER_ID, role: 'owner' }, fn);
}

async function lookup(fn: string, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  // `fn` is one of the fixed names below, never user input.
  const r = await query<{ org: string | null }>(`SELECT ${fn}($1) AS org`, [id]);
  return r.rows[0]?.org ?? null;
}

export const orgOfContact = (contactId: string) => lookup('org_of_contact', contactId);
export const orgOfMessage = (messageId: string) => lookup('org_of_message', messageId);

/**
 * Which org should an inbound webhook event belong to?
 *
 * Twilio events carry the receiving `AccountSid`; a tenant that connected
 * that account in the credential store (`org_credentials.meta.account_id`)
 * owns the event. Everything else, and Twilio accounts nobody has
 * connected yet, goes to AUTH_ORG_ID: correct for today's single-operator
 * deploy. Multi-tenant Heyreach/LinkedIn routing needs per-tenant webhook
 * URLs (tracked in docs/saas-architecture.md).
 */
export async function orgForInbound(
  source: string,
  payload: unknown,
): Promise<string> {
  const body = (payload ?? {}) as Record<string, unknown>;
  if (source.startsWith('whatsapp.') && typeof body.AccountSid === 'string') {
    const r = await query<{ org: string | null }>(
      `SELECT org_of_provider_account('twilio', $1) AS org`,
      [body.AccountSid],
    );
    const org = r.rows[0]?.org;
    if (org) return org;
  }
  logger.info('inbound event routed to default org', { source });
  return env.authOrgId;
}

/**
 * The auth token that signs webhooks for this Twilio account (slice 3.4).
 *
 * A customer who connected their own Twilio account gets webhooks signed
 * with THEIR token, so checking them against the operator's .env token
 * would reject every one. The account's owner is found by AccountSid
 * (V17 org_of_provider_account), then its token is read and decrypted as
 * that org. Unknown accounts and the operator fall back to the .env token.
 */
export async function twilioAuthTokenFor(accountSid: unknown): Promise<string> {
  if (typeof accountSid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(accountSid)) return env.twilioAuthToken;
  try {
    const r = await query<{ org: string | null }>(
      `SELECT org_of_provider_account('twilio', $1) AS org`,
      [accountSid],
    );
    const org = r.rows[0]?.org;
    if (!org || org === env.authOrgId) return env.twilioAuthToken;
    const key = vaultKey();
    if (!key) return env.twilioAuthToken;
    const cred = await runAsOrg(org, () =>
      query<{ org_id: string; label: string; secret_enc: Buffer }>(
        `SELECT org_id, label, secret_enc FROM org_credentials
          WHERE provider = 'twilio' AND meta->>'account_id' = $1 AND secret_enc IS NOT NULL
          ORDER BY (status = 'VERIFIED') DESC, updated_at DESC LIMIT 1`,
        [accountSid],
      ),
    );
    const row = cred.rows[0];
    if (!row) return env.twilioAuthToken;
    return decryptSecret(row.secret_enc, aadFor(row.org_id, 'twilio', row.label), key).auth_token ?? '';
  } catch (e) {
    logger.warn('twilio token lookup failed', { error: (e as Error).message });
    return '';
  }
}
