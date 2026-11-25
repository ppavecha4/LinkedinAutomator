/**
 * Whose API key pays for a call (SaaS phase 2, slice 2.3).
 *
 * BYO-first: a customer org's AI and lead-search calls use the accounts
 * it connected in the credential vault. The env-configured operator org
 * (AUTH_ORG_ID, today's Appson deploy) keeps using the `.env` keys. A
 * customer without a connected account gets a clear 409 instead of
 * quietly spending the platform's credits.
 */

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from './errors';
import { currentTenant } from './tenantContext';
import { aadFor, decryptSecret, vaultKey } from './vault';

const ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  apollo: 'APOLLO_API_KEY',
};

const LABELS: Record<string, string> = { anthropic: 'Anthropic (AI model)', apollo: 'Apollo (lead search)' };

/**
 * The current org's secret `field` for `provider` (e.g. anthropic/api_key).
 * Throws 409 when a customer org has not connected the account.
 */
export async function providerSecret(provider: 'anthropic' | 'apollo', field = 'api_key'): Promise<string> {
  const orgId = currentTenant()?.orgId;
  if (!orgId) throw ApiError.internal('providerSecret() needs a tenant');

  if (orgId === env.authOrgId) {
    const v = process.env[ENV_KEYS[provider]] ?? '';
    if (!v) throw ApiError.conflict(`${ENV_KEYS[provider]} is not set`);
    return v;
  }

  const r = await query<{ secret_enc: Buffer; label: string }>(
    `SELECT secret_enc, label FROM org_credentials
      WHERE provider = $1 AND secret_enc IS NOT NULL AND status NOT IN ('REVOKED','FAILED')
      ORDER BY (label = 'default') DESC, (status = 'VERIFIED') DESC, updated_at DESC
      LIMIT 1`,
    [provider],
  );
  if (r.rowCount === 0) {
    throw ApiError.conflict(`connect your ${LABELS[provider]} account first`, { missing: [provider] });
  }
  const key = vaultKey();
  if (!key) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
  const secret = decryptSecret(r.rows[0].secret_enc, aadFor(orgId, provider, r.rows[0].label), key);
  const value = secret[field];
  if (!value) throw ApiError.conflict(`your ${LABELS[provider]} connection has no ${field}`);
  return value;
}
