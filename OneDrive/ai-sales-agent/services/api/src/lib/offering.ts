/**
 * Offerings: what a customer sells and to whom (SaaS phase 2, slice 2.3).
 *
 * A customer describes their business and ideal customer in plain words
 * (any language); `generateOffering()` turns that into a structured,
 * editable offering stored in `org_offerings`. Campaigns link to an
 * offering; the orchestrator writes messages from it instead of Appson's
 * hardcoded service lines.
 *
 * Shape (org_offerings columns):
 *   name, description, value_proposition, tone,
 *   icp     { titles, industries, company_sizes, countries, keywords }
 *           → copied into campaigns.icp_criteria (Apollo discovery)
 *   routing { angles: [{label, fits, lead_with, proof_points}], cta, guardrails }
 *           → the writer picks the angle that fits each prospect
 */

import { z } from 'zod';

import { logger } from '../logger';
import type { Channel } from './channels';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.OFFERING_MODEL ?? process.env.PLANNER_MODEL ?? 'claude-sonnet-4-6';

export const TONES = ['professional', 'consultative', 'direct', 'friendly'] as const;
export const COMPANY_SIZES = ['1-50', '51-200', '201-500', '501-1000', '1000+'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const list = (max: number, itemMax: number) =>
  z.array(z.string().trim().min(1).max(itemMax)).max(max).default([]);

export const angleSchema = z.object({
  label: text(80),
  fits: text(300),            // who this angle is for
  lead_with: text(500),       // what to open with for them
  proof_points: list(5, 200), // facts the writer may cite (customer-supplied)
});

export const icpSchema = z
  .object({
    titles: list(15, 100),
    industries: list(15, 100),
    company_sizes: z.array(z.enum(COMPANY_SIZES)).max(5).default([]),
    countries: list(30, 100), // English names (Apollo person_locations)
    keywords: list(20, 60),
  })
  .default({});

export const routingSchema = z
  .object({
    angles: z.array(angleSchema).max(5).default([]),
    cta: z.string().trim().max(300).default('a short call'),
    guardrails: list(10, 300),
  })
  .default({});

export const offeringSchema = z.object({
  name: text(255),
  description: z.string().trim().max(2000).nullable().optional(),
  value_proposition: text(2000),
  tone: z.enum(TONES).default('professional'),
  icp: icpSchema,
  routing: routingSchema,
});
export type Offering = z.infer<typeof offeringSchema>;

/** What generation returns: the offering draft + campaign suggestions. */
export interface OfferingDraft {
  offering: Offering;
  suggested_channels: Channel[];
  suggested_languages: string[];
  campaign_goal: string;
}

/** Injectable model call (tests replace it). Returns the raw text reply. */
export type CallModel = (apiKey: string, prompt: string) => Promise<string>;

export const callAnthropic: CallModel = async (apiKey, prompt) => {
  const r = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    logger.warn('offering generation: model call failed', { status: r.status, detail });
    throw new Error(`model call failed (${r.status})`);
  }
  const data = (await r.json()) as { content?: Array<{ type: string; text?: string }> };
  return (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
};

export function buildOfferingPrompt(description: string, allowedChannels: readonly Channel[]): string {
  return [
    'You help a business set up B2B / B2C outbound outreach. Read how they describe',
    'their business and ideal customer, and return ONE JSON object, nothing else.',
    '',
    'Their description (may be in any language):',
    '"""',
    description,
    '"""',
    '',
    'Rules:',
    '- Use ONLY what they said or what follows directly from it. Do not invent',
    '  customers, numbers, awards or certifications. If you have no real proof',
    '  points, leave proof_points empty.',
    '- Write all values in English (messages are translated per prospect later),',
    '  except names of their products/companies.',
    '- countries: English country names. company_sizes from',
    `  ${JSON.stringify(COMPANY_SIZES)}.`,
    '- angles: 1-4 distinct reasons different buyers would care (e.g. by segment,',
    '  role or need). Each: label, fits (who), lead_with (what to open with),',
    '  proof_points (facts from their description only).',
    '- guardrails: things their messages must never do (e.g. quote prices, promise',
    '  delivery dates) — only if implied by their description or common sense for',
    '  their industry; keep it short.',
    `- suggested_channels: subset of ${JSON.stringify(allowedChannels)} that fits their buyers.`,
    '- suggested_languages: BCP 47 codes their prospects likely speak (from the countries).',
    '',
    'JSON shape:',
    JSON.stringify({
      name: 'short offering name',
      description: 'one or two sentences',
      value_proposition: 'what they deliver and why it matters to the buyer',
      tone: TONES.join('|'),
      icp: { titles: [], industries: [], company_sizes: [], countries: [], keywords: [] },
      routing: { angles: [{ label: '', fits: '', lead_with: '', proof_points: [] }], cta: '', guardrails: [] },
      suggested_channels: [],
      suggested_languages: [],
      campaign_goal: 'what a successful reply looks like, e.g. book a 15-minute call',
    }),
  ].join('\n');
}

/** First top-level {...} in the reply (models sometimes add fences/prose). */
export function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the model reply');
  return JSON.parse(reply.slice(start, end + 1));
}

export class OfferingGenerationError extends Error {}

export async function generateOffering(
  description: string,
  opts: { apiKey: string; allowedChannels: readonly Channel[]; callModel?: CallModel },
): Promise<OfferingDraft> {
  const call = opts.callModel ?? callAnthropic;
  let raw: unknown;
  try {
    raw = extractJson(await call(opts.apiKey, buildOfferingPrompt(description, opts.allowedChannels)));
  } catch (e) {
    throw new OfferingGenerationError(`could not draft an offering: ${(e as Error).message}`);
  }
  const obj = (raw ?? {}) as Record<string, unknown>;
  const parsed = offeringSchema.safeParse(obj);
  if (!parsed.success) {
    throw new OfferingGenerationError('the AI draft was incomplete; try describing your business in more detail');
  }
  const allowed = new Set<string>(opts.allowedChannels);
  const channels = (Array.isArray(obj.suggested_channels) ? obj.suggested_channels : [])
    .filter((c): c is Channel => typeof c === 'string' && allowed.has(c));
  const languages = (Array.isArray(obj.suggested_languages) ? obj.suggested_languages : [])
    .filter((l): l is string => typeof l === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l))
    .slice(0, 10);
  return {
    offering: parsed.data,
    suggested_channels: channels.length > 0 ? [...new Set(channels)] : [opts.allowedChannels.includes('email') ? 'email' : opts.allowedChannels[0]],
    suggested_languages: [...new Set(languages)],
    campaign_goal: typeof obj.campaign_goal === 'string' && obj.campaign_goal.trim()
      ? obj.campaign_goal.trim().slice(0, 500)
      : 'book a short introductory call',
  };
}
