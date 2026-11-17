/**
 * Periodic re-check of connected accounts (SaaS phase 3, slice 3.7).
 *
 * "Verify" runs once, when an account is saved. Later the account can
 * break — a revoked app password, a rotated key, a suspended Twilio
 * account — and until now that only showed up as failed sends. Every
 * hour (ACCOUNT_RECHECK_INTERVAL_MINUTES) the API re-checks the VERIFIED
 * accounts not checked for ACCOUNT_RECHECK_AGE_HOURS (default 24):
 *
 *   still fine               → stays VERIFIED
 *   definitively rejected    → FAILED with the reason; the senders only
 *                              use VERIFIED accounts, so sending stops;
 *                              owners and admins are emailed (when the
 *                              platform can email) and the dashboard shows
 *                              a banner
 *   provider unreachable     → left alone (a timeout or a 5xx says nothing
 *                              about the credential)
 *
 * Work is claimed through V24's claim_credentials_for_recheck(), so
 * several API instances never check the same account twice. The operator
 * org runs on .env keys, so its vault entries are not re-checked.
 */

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { checkCredential } from './credentialCheck';
import { mailerConfigured, sendMail } from './mailer';
import { runAsOrg } from './tenantLookup';
import { aadFor, decryptSecret, vaultKey } from './vault';

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'AI model (Anthropic)',
  apollo: 'Lead search (Apollo)',
  twilio: 'WhatsApp (Twilio)',
  google_workspace: 'Email (Google Workspace)',
  smtp: 'Email (your mail server)',
};

export interface RecheckSummary {
  checked: number;
  failed: number;
  transient: number;
  notified: number;
}

async function notifyOwners(provider: string, reason: string): Promise<number> {
  if (!mailerConfigured()) return 0;
  const people = await query<{ email: string; full_name: string | null }>(
    `SELECT u.email, u.full_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role IN ('owner', 'admin')`);
  const org = await query<{ name: string }>(`SELECT name FROM organizations`);
  const what = PROVIDER_NAMES[provider] ?? provider;
  let sent = 0;
  for (const p of people.rows) {
    try {
      await sendMail({
        to: p.email,
        subject: `${what} stopped working for ${org.rows[0]?.name ?? 'your company'}`,
        text: `Hi ${p.full_name ?? 'there'},\n\nWe checked your connected ${what} account and it no longer works:\n\n  ${reason}\n\nUntil you reconnect it, anything that needs it is on hold (nothing is lost; queued messages go out once it works again). Fix it here:\n\n${env.dashboardUrl.replace(/\/+$/, '')}/settings/connections\n`,
      });
      sent += 1;
    } catch (e) {
      logger.warn('account health email failed', { error: (e as Error).message });
    }
  }
  return sent;
}

/** Re-check one claimed account, as its own org. */
async function recheckOne(id: string, orgId: string, summary: RecheckSummary): Promise<void> {
  if (orgId === env.authOrgId) return; // the operator uses .env keys
  const key = vaultKey();
  if (!key) return;
  await runAsOrg(orgId, async () => {
    const found = await query<{ provider: string; label: string; meta: Record<string, unknown>; secret_enc: Buffer | null }>(
      `SELECT provider, label, meta, secret_enc FROM org_credentials WHERE id = $1 AND status = 'VERIFIED' AND secret_enc IS NOT NULL`, [id]);
    const row = found.rows[0];
    if (!row?.secret_enc) return;
    summary.checked += 1;
    let result;
    try {
      result = await checkCredential(row.provider, decryptSecret(row.secret_enc, aadFor(orgId, row.provider, row.label), key), row.meta);
    } catch (e) {
      logger.warn('account recheck could not run', { provider: row.provider, error: (e as Error).message });
      summary.transient += 1;
      return;
    }
    if (!result || result.ok) {
      await query(`UPDATE org_credentials SET verified_at = now(), last_checked_at = now(), last_error = NULL WHERE id = $1`, [id]);
      return;
    }
    if (result.transient) {
      summary.transient += 1;
      return;
    }
    const reason = (result.error ?? 'the provider rejected it').slice(0, 500);
    // Only flip an account that is still VERIFIED (it may have been re-saved meanwhile).
    const flipped = await query(
      `UPDATE org_credentials SET status = 'FAILED', verified_at = NULL, last_checked_at = now(), last_error = $2, updated_at = now()
        WHERE id = $1 AND status = 'VERIFIED' RETURNING id`, [id, reason]);
    if (!flipped.rowCount) return;
    summary.failed += 1;
    logger.warn('connected account stopped working', { org_id: orgId, provider: row.provider });
    summary.notified += await notifyOwners(row.provider, reason);
  });
}

export async function recheckDueCredentials(opts: { limit?: number; minAgeHours?: number } = {}): Promise<RecheckSummary> {
  const summary: RecheckSummary = { checked: 0, failed: 0, transient: 0, notified: 0 };
  const claimed = await query<{ id: string; org_id: string }>(
    `SELECT * FROM claim_credentials_for_recheck($1, $2)`, [opts.limit ?? 25, opts.minAgeHours ?? env.accountRecheckAgeHours]);
  for (const c of claimed.rows) {
    try {
      await recheckOne(c.id, c.org_id, summary);
    } catch (e) {
      logger.error('account recheck failed', { id: c.id, error: (e as Error).message });
    }
  }
  if (claimed.rowCount) logger.info('account recheck', { ...summary });
  return summary;
}

/** Start the hourly job (local-auth deployments only: that is where customers' vaults live). */
export function startAccountHealth(): () => void {
  if (env.authMode !== 'local' || !env.accountRecheckEnabled) return () => undefined;
  const run = () => { void recheckDueCredentials().catch((e) => logger.error('account health run failed', { error: (e as Error).message })); };
  const first = setTimeout(run, 2 * 60_000);
  const every = setInterval(run, Math.max(1, env.accountRecheckIntervalMinutes) * 60_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}

