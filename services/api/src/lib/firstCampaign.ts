/**
 * The first campaign, proposed for a company that just finished setting up (slice 9.3).
 *
 * Nothing here calls the AI: the hard part, what the company sells and who to look for, was already
 * written by the AI during onboarding and reviewed by the owner (the saved offering + business profile).
 * This only assembles a sensible campaign from that and from what is really ready to send, so a
 * non-technical owner presses one button instead of filling a four-step wizard.
 *
 *   - channels: email once a mailbox is verified; WhatsApp only once the Twilio account is verified AND
 *     both WhatsApp messages (first + follow-up) are approved. Never LinkedIn or calls on their own.
 *   - sequence: two follow-ups, three days apart, if there is no reply (the wizard's own defaults).
 *   - language: each person's own; sender: the profile's sender name, else the signed-in person.
 *
 * The result is the exact body for POST /api/campaigns: creating it goes through the normal path
 * (quota, channel entitlement, audit), so there is no second way to make a campaign. It is saved as a
 * DRAFT: nothing is sent until the owner adds people and launches.
 */

import { query } from '../db/client';
import { orgChannels, type Channel } from './channels';
import { currentTenant } from './tenantContext';

export interface FirstCampaignBody {
  name: string;
  goal: string;
  sender_name: string;
  sender_company: string;
  offering_id: string;
  channels: Channel[];
  languages: null;
  language_fallback: 'country';
  sequence_steps: Array<{ step_number: number; channel: Channel; action: 'follow_up'; delay_days: number }>;
}

export interface FirstCampaignSummary {
  offering: string;
  goal: string;
  channels: Channel[];
  /** Plain lines about who the AI will look for (roles, industries, countries). */
  audience: string[];
  follow_ups: { count: number; gap_days: number; channels: Channel[] };
  languages: string;
}

export interface FirstCampaignView {
  /** Campaigns the company already has: once there is one, no proposal is needed. */
  existing_campaigns: number;
  /** The newest campaign, so the checklist can point at "add your people" / "launch". */
  latest: { id: string; name: string; status: string } | null;
  proposal: { body: FirstCampaignBody; summary: FirstCampaignSummary } | null;
  /** Why there is no proposal yet, in plain words (empty when there is one or a campaign exists). */
  blockers: string[];
}

const FOLLOW_UPS = 2;
const GAP_DAYS = 3;
const EMAIL_PROVIDERS = ['google_workspace', 'smtp', 'ses'];

interface OfferingRow {
  id: string;
  name: string;
  tone: string;
  icp: { titles?: string[]; industries?: string[]; countries?: string[] } | null;
}

/** Both WhatsApp messages approved for at least one language (at the provider in use), or the pasted-by-hand equivalents. */
async function whatsappReady(): Promise<boolean> {
  // Straight through Meta (slice 10.2): only a VERIFIED connection counts, with approved messages of its own.
  const viaMeta = await query(`SELECT 1 FROM org_credentials WHERE provider = 'whatsapp_meta' AND status = 'VERIFIED' AND secret_enc IS NOT NULL LIMIT 1`);
  const meta = (viaMeta.rowCount ?? 0) > 0;
  if (!meta) {
    const tw = await query<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM org_credentials WHERE provider = 'twilio' AND status = 'VERIFIED' AND secret_enc IS NOT NULL`);
    const account = tw.rows.find((r) => String(r.meta?.whatsapp_from ?? '').trim() !== '');
    if (!account) return false;
    const manual = Object.keys(account.meta).some((k) => k === 'template_sid' || k.startsWith('template_sid_'))
      && Object.keys(account.meta).some((k) => k === 'followup_template_sid' || k.startsWith('followup_template_sid_'));
    if (manual) return true;
  }
  const approved = await query<{ language: string; kind: string }>(
    `SELECT language, kind FROM whatsapp_templates WHERE status = 'APPROVED' AND provider = $1`, [meta ? 'meta' : 'twilio']);
  const byLanguage = new Map<string, Set<string>>();
  for (const r of approved.rows) byLanguage.set(r.language, (byLanguage.get(r.language) ?? new Set()).add(r.kind));
  return [...byLanguage.values()].some((kinds) => kinds.has('first') && kinds.has('followup'));
}

const list = (xs: string[] | undefined, max = 4): string => (xs ?? []).slice(0, max).join(', ');

export async function buildFirstCampaign(): Promise<FirstCampaignView> {
  const existing = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM campaigns`)).rows[0].n);
  if (existing > 0) {
    const latest = (await query<{ id: string; name: string; status: string }>(
      `SELECT id, name, status FROM campaigns ORDER BY created_at DESC LIMIT 1`)).rows[0] ?? null;
    return { existing_campaigns: existing, latest, proposal: null, blockers: [] };
  }

  const blockers: string[] = [];
  const offering = (await query<OfferingRow>(
    `SELECT id, name, tone, icp FROM org_offerings ORDER BY updated_at DESC LIMIT 1`)).rows[0];
  if (!offering) blockers.push('Finish telling us about your business, so the AI knows what you sell and who to look for.');

  const profile = (await query<{ company: { name?: string }; voice: { sender_name?: string } }>(
    `SELECT company, voice FROM org_profiles`)).rows[0];
  const org = (await query<{ name: string }>(`SELECT name FROM organizations`)).rows[0];
  const userId = currentTenant()?.userId;
  const person = userId
    ? (await query<{ full_name: string | null }>(`SELECT full_name FROM users WHERE id = $1`, [userId])).rows[0]?.full_name
    : null;
  const senderName = (profile?.voice?.sender_name || person || '').trim();
  const senderCompany = (profile?.company?.name || org?.name || '').trim();
  if (!senderName) blockers.push('Add the name messages go out under (Business profile › How you sound).');

  const entitled = new Set(await orgChannels());
  const channels: Channel[] = [];
  const mailbox = await query(`SELECT 1 FROM org_credentials WHERE provider = ANY($1::text[]) AND status = 'VERIFIED' AND secret_enc IS NOT NULL LIMIT 1`, [EMAIL_PROVIDERS]);
  if (entitled.has('email') && (mailbox.rowCount ?? 0) > 0) channels.push('email');
  if (entitled.has('whatsapp') && (await whatsappReady())) channels.push('whatsapp');
  if (channels.length === 0) blockers.push('Connect your email, or get your WhatsApp messages approved, so there is somewhere to send from.');

  if (blockers.length > 0 || !offering) return { existing_campaigns: 0, latest: null, proposal: null, blockers };

  // Follow-up steps per channel: email is steps 2.., WhatsApp 12.. so numbers never collide (as the wizard does).
  const followChannels = channels.filter((c): c is 'email' | 'whatsapp' => c === 'email' || c === 'whatsapp');
  const steps = followChannels.flatMap((channel) =>
    Array.from({ length: FOLLOW_UPS }, (_, i) => ({
      step_number: (channel === 'email' ? 2 : 12) + i,
      channel: channel as Channel,
      action: 'follow_up' as const,
      delay_days: GAP_DAYS * (i + 1),
    })));

  const icp = offering.icp ?? {};
  const audience = [
    icp.titles?.length ? `Roles: ${list(icp.titles)}` : '',
    icp.industries?.length ? `Industries: ${list(icp.industries)}` : '',
    icp.countries?.length ? `Countries: ${list(icp.countries)}` : '',
  ].filter(Boolean);

  const goal = 'Book a short call';
  return {
    existing_campaigns: 0,
    latest: null,
    blockers: [],
    proposal: {
      body: {
        name: `${offering.name}: first outreach`.slice(0, 255),
        goal,
        sender_name: senderName,
        sender_company: senderCompany,
        offering_id: offering.id,
        channels,
        languages: null,
        language_fallback: 'country',
        sequence_steps: steps,
      },
      summary: {
        offering: offering.name,
        goal,
        channels,
        audience,
        follow_ups: { count: FOLLOW_UPS, gap_days: GAP_DAYS, channels: followChannels },
        languages: "Each person's own language",
      },
    },
  };
}
