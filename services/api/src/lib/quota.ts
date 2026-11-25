/**
 * Plans and quotas (slice 4.1). What a company's plan includes and what it
 * has used this month come from one SQL function, org_quota() (V28); usage
 * is derived from the tables that hold it. A NULL limit is unlimited.
 *
 * Enforced here, in the API: launching a campaign (active campaigns,
 * messages left) and inviting people (seats). Enforced in the orchestrator
 * (compliance/send_gate.py): the monthly message cap, as a DEFER, so queued
 * messages go out when the month rolls over or the plan is upgraded.
 */

import { query } from '../db/client';
import { ApiError } from './errors';

export interface Quota {
  plan: string;
  plan_label: string;
  period_start: string;
  messages: { limit: number | null; used: number };
  campaigns: { limit: number | null; used: number };
  seats: { limit: number | null; used: number };
}

interface QuotaRow {
  plan: string; plan_label: string; period_start: Date | string;
  messages_limit: number | null; messages_used: string;
  campaigns_limit: number | null; campaigns_used: string;
  seats_limit: number | null; seats_used: string;
}

export async function getQuota(orgId: string): Promise<Quota> {
  const r = (await query<QuotaRow>(`SELECT * FROM org_quota($1)`, [orgId])).rows[0];
  if (!r) throw ApiError.notFound('organization not found');
  return {
    plan: r.plan,
    plan_label: r.plan_label,
    period_start: new Date(r.period_start).toISOString(),
    messages: { limit: r.messages_limit, used: Number(r.messages_used) },
    campaigns: { limit: r.campaigns_limit, used: Number(r.campaigns_used) },
    seats: { limit: r.seats_limit, used: Number(r.seats_used) },
  };
}

const full = (m: { limit: number | null; used: number }, adding = 1): boolean =>
  m.limit !== null && m.used + adding > m.limit;

const UPGRADE = 'Upgrade your plan to continue.';

/** A campaign may go live if the plan has room for another and messages are left this month. */
export async function assertCanLaunch(orgId: string): Promise<void> {
  const q = await getQuota(orgId);
  if (full(q.campaigns)) {
    throw ApiError.planLimit(
      `Your ${q.plan_label} plan allows ${q.campaigns.limit} active campaign${q.campaigns.limit === 1 ? '' : 's'}. Pause one, or upgrade.`,
      { kind: 'campaigns', plan: q.plan, ...q.campaigns },
    );
  }
  if (q.messages.limit !== null && q.messages.used >= q.messages.limit) {
    throw ApiError.planLimit(
      `You have used all ${q.messages.limit} messages included in your ${q.plan_label} plan this month. ${UPGRADE}`,
      { kind: 'messages', plan: q.plan, ...q.messages },
    );
  }
}

/** Another person may be invited if a seat is free. Re-inviting an address that already holds an open invite takes no extra seat. */
export async function assertCanAddSeat(orgId: string, email: string): Promise<void> {
  const q = await getQuota(orgId);
  if (q.seats.limit === null) return;
  const open = await query(
    `SELECT 1 FROM org_invites WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
    [email.trim().toLowerCase()],
  );
  const used = q.seats.used - (open.rowCount ? 1 : 0);
  if (used + 1 > q.seats.limit) {
    throw ApiError.planLimit(
      `Your ${q.plan_label} plan includes ${q.seats.limit} seat${q.seats.limit === 1 ? '' : 's'} (people and open invitations). Remove someone, or upgrade.`,
      { kind: 'seats', plan: q.plan, ...q.seats },
    );
  }
}
