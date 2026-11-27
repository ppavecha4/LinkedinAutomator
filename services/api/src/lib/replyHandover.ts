/**
 * Tell a company that conversations are waiting for a person (V40). The reply job marks them; this
 * job emails the owners and admins one short note per batch. A conversation is announced once per wait.
 * Without a platform mailbox nothing is claimed, so the note goes out once one is set up.
 */

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { mailerConfigured, sendMail } from './mailer';
import { runAsOrg } from './tenantLookup';

const EVERY_MINUTES = 5;

async function notifyOrg(): Promise<number> {
  const claimed = await query(
    `UPDATE conversations SET notified_at = now()
      WHERE needs_person_reason IS NOT NULL AND notified_at IS NULL RETURNING id`);
  const waiting = claimed.rowCount ?? 0;
  if (!waiting) return 0;
  const people = await query<{ email: string; full_name: string | null }>(
    `SELECT u.email, u.full_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role IN ('owner', 'admin')`);
  const link = `${env.dashboardUrl.replace(/\/+$/, '')}/inbox`;
  const what = waiting === 1 ? '1 conversation is' : `${waiting} conversations are`;
  let sent = 0;
  for (const p of people.rows) {
    try {
      await sendMail({
        to: p.email,
        subject: `${what} waiting for you`,
        text: `Hi ${p.full_name ?? 'there'},\n\n${what} waiting for a person: a reply to approve, a call or price request, or something the assistant should not answer alone.\n\nOpen your inbox:\n\n${link}\n`,
      });
      sent += 1;
    } catch (e) {
      logger.warn('handover email failed', { error: (e as Error).message });
    }
  }
  return sent;
}

export async function announceWaitingHandovers(): Promise<number> {
  if (!mailerConfigured()) return 0;
  const orgs = await query<{ org_id: string }>(`SELECT org_id FROM orgs_with_waiting_handovers()`);
  let sent = 0;
  for (const { org_id: orgId } of orgs.rows) {
    try {
      sent += await runAsOrg(orgId, notifyOrg);
    } catch (e) {
      logger.error('handover notification failed', { org_id: orgId, error: (e as Error).message });
    }
  }
  return sent;
}

/** Start the job (local-auth deployments: that is where companies have their own people). */
export function startReplyHandover(): () => void {
  if (env.authMode !== 'local') return () => undefined;
  const run = () => { void announceWaitingHandovers().catch((e) => logger.error('handover run failed', { error: (e as Error).message })); };
  const every = setInterval(run, EVERY_MINUTES * 60_000);
  every.unref();
  return () => clearInterval(every);
}
