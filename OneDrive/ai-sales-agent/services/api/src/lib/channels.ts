/**
 * Outreach channels: entitlement, campaign consistency and the launch gate
 * (SaaS phase 2). See docs/saas-architecture.md, "Channel selection".
 *
 * - An org may only use the channels in `organizations.channels`.
 *   Customers get email, WhatsApp and voice; LinkedIn is Appson-internal.
 * - A campaign picks a non-empty subset; its sequence steps must stay
 *   inside it. (V19 also enforces both rules in the database.)
 * - A campaign can only go ACTIVE when every chosen channel has a
 *   connected account in the credential vault.
 */

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from './errors';
import { currentTenant } from './tenantContext';

export const CHANNELS = ['email', 'whatsapp', 'linkedin', 'voice'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  linkedin: 'LinkedIn',
  voice: 'AI phone calls',
};

/** Which connected account(s) can serve each channel. */
export const CHANNEL_PROVIDERS: Record<Channel, readonly string[]> = {
  email: ['google_workspace', 'smtp', 'ses'],
  whatsapp: ['twilio'],
  linkedin: ['heyreach'],
  voice: ['voice'],
};

/** Channels the current org is entitled to (RLS: only its own row). */
export async function orgChannels(): Promise<Channel[]> {
  const r = await query<{ channels: Channel[] }>(`SELECT channels FROM organizations`);
  if (r.rowCount === 0) throw ApiError.forbidden('organization not found');
  return r.rows[0].channels;
}

export async function assertChannelsAllowed(channels: readonly Channel[]): Promise<void> {
  const allowed = new Set(await orgChannels());
  const denied = channels.filter((c) => !allowed.has(c));
  if (denied.length > 0) {
    throw ApiError.badRequest(
      `${denied.map((c) => CHANNEL_LABELS[c]).join(', ')} ` +
        `${denied.length === 1 ? 'is' : 'are'} not available for your organization`,
      { denied, allowed: [...allowed] },
    );
  }
}

export function assertStepsWithin(
  steps: ReadonlyArray<{ step_number: number; channel: Channel }>,
  channels: readonly Channel[],
): void {
  const chosen = new Set(channels);
  const outside = steps.filter((s) => !chosen.has(s.channel));
  if (outside.length > 0) {
    throw ApiError.badRequest(
      'every sequence step must use one of the campaign\'s channels',
      { steps: outside.map((s) => ({ step_number: s.step_number, channel: s.channel })), channels },
    );
  }
}

/** The action name of an automated follow-up step (orchestrator schedule_followups.py). */
export const FOLLOW_UP_ACTION = 'follow_up';
export const MAX_FOLLOW_UPS = 5;
export const MAX_FOLLOW_UP_DAYS = 90;

/**
 * Follow-up steps (action 'follow_up', slice 3.5) are email only for now:
 * a WhatsApp follow-up would need a second Meta-approved template. They
 * come after the first email (step_number >= 2) and their delay_days
 * (days after the FIRST email) must grow from one step to the next.
 * Steps with any other action are not checked (Appson's older campaigns).
 */
export function assertFollowUps(
  steps: ReadonlyArray<{ step_number: number; channel: Channel; action?: string; delay_days?: number }>,
): void {
  const fu = steps.filter((s) => s.action === FOLLOW_UP_ACTION).sort((a, b) => a.step_number - b.step_number);
  if (fu.length === 0) return;
  const fail = (msg: string) => {
    throw ApiError.badRequest(msg, { steps: fu.map((s) => ({ step_number: s.step_number, delay_days: s.delay_days })) });
  };
  if (fu.length > MAX_FOLLOW_UPS) fail(`at most ${MAX_FOLLOW_UPS} follow-ups`);
  if (fu.some((s) => s.channel !== 'email')) fail('follow-ups are email only for now');
  if (fu.some((s) => s.step_number < 2)) fail('follow-ups come after the first message (step 2 onwards)');
  let previous = 0;
  for (const s of fu) {
    const d = s.delay_days ?? 0;
    if (d < 1 || d > MAX_FOLLOW_UP_DAYS) fail(`a follow-up goes out 1–${MAX_FOLLOW_UP_DAYS} days after the first email`);
    if (d <= previous) fail('each follow-up must go out later than the one before');
    previous = d;
  }
}

/** Distinct channels in step order, for campaigns created without `channels`. */
export function channelsFromSteps(steps: ReadonlyArray<{ channel: Channel }>): Channel[] {
  return [...new Set(steps.map((s) => s.channel))];
}

/**
 * Channels in `channels` that have no usable connected account.
 *
 * The operator org configured through `.env` (AUTH_ORG_ID: today's
 * single-operator deploy) sends with its env keys, so it has nothing
 * missing. For everyone else a channel counts only once one of its
 * accounts passed "verify" (slice 3.4): the senders use VERIFIED
 * accounts only, so launching on an unchecked one would send nothing.
 */
export async function missingChannelCredentials(channels: readonly Channel[]): Promise<Channel[]> {
  if (currentTenant()?.orgId === env.authOrgId) return [];
  const r = await query<{ provider: string }>(
    `SELECT DISTINCT provider FROM org_credentials
      WHERE secret_enc IS NOT NULL AND status = 'VERIFIED'`,
  );
  const connected = new Set(r.rows.map((x) => x.provider));
  return channels.filter((c) => !CHANNEL_PROVIDERS[c].some((p) => connected.has(p)));
}

/** Throw 409 with the list of channels still to connect, if any. */
export async function assertReadyToLaunch(channels: readonly Channel[]): Promise<void> {
  const missing = await missingChannelCredentials(channels);
  if (missing.length > 0) {
    throw ApiError.conflict(
      `connect and verify ${missing.map((c) => CHANNEL_LABELS[c]).join(', ')} before launching`,
      { missing },
    );
  }
}
