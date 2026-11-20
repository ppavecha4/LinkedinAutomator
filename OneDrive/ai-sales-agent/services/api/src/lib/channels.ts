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
  voice: ['elevenlabs'],
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
 * Follow-up steps (action 'follow_up', slices 3.5 and 3.10) are automated
 * for email and WhatsApp. They come after the first message (step_number
 * >= 2); delay_days is days after the FIRST message on that channel and
 * must grow from one follow-up to the next on the same channel (at most
 * MAX_FOLLOW_UPS per channel, up to MAX_FOLLOW_UP_DAYS). A WhatsApp
 * follow-up needs the customer's second approved template (it waits until
 * they add one). Steps with any other action are not checked (Appson's
 * older campaigns).
 */
const FOLLOW_UP_CHANNELS: readonly Channel[] = ['email', 'whatsapp'];

export function assertFollowUps(
  steps: ReadonlyArray<{ step_number: number; channel: Channel; action?: string; delay_days?: number }>,
): void {
  const fu = steps.filter((s) => s.action === FOLLOW_UP_ACTION).sort((a, b) => a.step_number - b.step_number);
  if (fu.length === 0) return;
  const fail = (msg: string) => {
    throw ApiError.badRequest(msg, { steps: fu.map((s) => ({ step_number: s.step_number, channel: s.channel, delay_days: s.delay_days })) });
  };
  if (fu.some((s) => !FOLLOW_UP_CHANNELS.includes(s.channel))) fail('follow-ups are for email and WhatsApp');
  if (fu.some((s) => s.step_number < 2)) fail('follow-ups come after the first message (step 2 onwards)');
  for (const channel of FOLLOW_UP_CHANNELS) {
    const mine = fu.filter((s) => s.channel === channel);
    if (mine.length > MAX_FOLLOW_UPS) fail(`at most ${MAX_FOLLOW_UPS} follow-ups per channel`);
    let previous = 0;
    for (const s of mine) {
      const d = s.delay_days ?? 0;
      if (d < 1 || d > MAX_FOLLOW_UP_DAYS) fail(`a follow-up goes out 1–${MAX_FOLLOW_UP_DAYS} days after the first message`);
      if (d <= previous) fail('each follow-up must go out later than the one before');
      previous = d;
    }
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
  const r = await query<{ provider: string; meta: Record<string, unknown> }>(
    `SELECT provider, meta FROM org_credentials
      WHERE secret_enc IS NOT NULL AND status = 'VERIFIED'`,
  );
  const has = (provider: string, field?: string) =>
    r.rows.some((x) => x.provider === provider && (!field || String(x.meta?.[field] ?? '').trim() !== ''));
  // One Twilio account can serve WhatsApp (a WhatsApp number) and calls (a voice number): each
  // channel needs ITS number. Calls also need the voice (ElevenLabs) and the AI that writes the words.
  const usable: Record<Channel, boolean> = {
    email: ['google_workspace', 'smtp', 'ses'].some((p) => has(p)),
    whatsapp: has('twilio', 'whatsapp_from'),
    linkedin: has('heyreach'),
    voice: has('elevenlabs') && has('twilio', 'voice_from') && has('anthropic'),
  };
  return channels.filter((c) => !usable[c]);
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
  await assertSenderIdentity(channels);
}

/**
 * Every customer email carries the sender's name and postal address in its
 * footer (slice 5.1), so an email campaign needs the address on the business
 * profile. The operator (Appson) has its own signature and is exempt.
 */
export async function assertSenderIdentity(channels: readonly Channel[]): Promise<void> {
  if (!channels.includes('email') || currentTenant()?.orgId === env.authOrgId) return;
  const r = await query<{ address: string | null }>(`SELECT company->>'address' AS address FROM org_profiles`);
  if (!(r.rows[0]?.address ?? '').trim()) {
    throw ApiError.conflict(
      "add your company's postal address (Business profile › Company) before launching an email campaign: the law requires it in every email",
      { missing_identity: ['address'] },
    );
  }
}
