/**
 * campaignPlanner.ts — the AI campaign planner.
 *
 * Turns a plain-English goal ("book discovery calls with fintech CTOs in
 * the US who are hiring engineers") into a COMPLETE, ready-to-launch
 * campaign proposal: ICP filters, channel mix, sequence + cadence, daily
 * limits, batch size, and the service-line / market positioning to lead
 * with — plus a short rationale for each major choice so the operator can
 * approve with confidence.
 *
 * The output matches the create-campaign payload shape exactly, so the
 * dashboard can hand an approved plan straight to POST /api/campaigns.
 *
 * Never throws garbage: on any model/parse failure it falls back to a
 * sensible default plan derived from the goal text.
 */

import { env } from '../env';
import { logger } from '../logger';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.PLANNER_MODEL ?? 'claude-sonnet-4-6';

export interface SequenceStep {
  step_number: number;
  channel: 'email' | 'linkedin' | 'whatsapp';
  action: string;
  delay_days: number;
}

export interface CampaignPlan {
  name: string;
  goal: string;
  tone: 'professional' | 'consultative' | 'direct' | 'friendly';
  sender_company: string;
  sender_name: string;
  value_proposition: string;
  icp_criteria: {
    industries: string[];
    company_sizes: string[];
    countries: string[];
    titles: string[];
    intent_keywords: string[];
  };
  channels_enabled: Array<'email' | 'linkedin' | 'whatsapp'>;
  sequence_steps: SequenceStep[];
  daily_limits: { email: number; linkedin: number; whatsapp: number };
  batch_size: number;
  service_line: 'ai_consulting' | 'staff_augmentation' | 'mixed';
  rationale: string;
}

interface SenderContext {
  sender_name?: string;
  sender_company?: string;
  value_proposition?: string;
}

const VALID_INDUSTRIES = [
  'Logistics', 'Manufacturing', 'Financial Services', 'Healthcare', 'Retail',
  'Professional Services', 'SaaS', 'Fintech', 'Insurance', 'Real Estate',
  'Education', 'Media & Advertising', 'Technology', 'E-commerce',
  'Telecommunications', 'Energy', 'Automotive', 'Consulting',
];
const VALID_SIZES = ['1-50', '51-200', '201-500', '501-1000', '1000+'];

function buildPrompt(goal: string, ctx: SenderContext): string {
  return [
    'You are a senior outbound strategist. Turn the operator\'s goal into a',
    'COMPLETE B2B outbound campaign plan for a company that offers two',
    'service lines from one talent pool:',
    '  - AI Consulting (AI/automation strategy + build)',
    '  - Staff Augmentation (contract developers + distributed remote teams:',
    '    DevOps, Microsoft, SAP, Salesforce, web, mobile, CMS, AI/ML).',
    '',
    `Operator goal: "${goal}"`,
    '',
    ctx.sender_name ? `Sender name: ${ctx.sender_name}` : '',
    ctx.sender_company ? `Sender company: ${ctx.sender_company}` : '',
    ctx.value_proposition ? `Value prop: ${ctx.value_proposition}` : '',
    '',
    'Design the plan. Consider:',
    '  - ICP: which industries, company sizes, countries, decision-maker',
    '    titles, and intent keywords best fit the goal.',
    '  - Market positioning: US/W.Europe/Australia/Gulf = lead with cost+',
    '    speed; India/SEA/most LATAM = lead with speed + AI/ML niche;',
    '    E.Europe/rich LATAM = niche + quality. Pick countries deliberately.',
    '  - Channels + a realistic multi-touch sequence with sensible delays.',
    '  - Safe daily limits (LinkedIn <= 20/day, email <= 200/day).',
    '',
    `Valid industries (choose from): ${VALID_INDUSTRIES.join(', ')}.`,
    `Valid company sizes: ${VALID_SIZES.join(', ')}.`,
    '',
    'Output ONLY a single JSON object, no prose, in exactly this shape:',
    '{',
    '  "name": "short campaign name",',
    '  "goal": "one-line goal",',
    '  "tone": "professional|consultative|direct|friendly",',
    '  "value_proposition": "1-2 sentences",',
    '  "icp_criteria": {"industries":[],"company_sizes":[],"countries":[],',
    '                   "titles":[],"intent_keywords":[]},',
    '  "channels_enabled": ["email","linkedin"],',
    '  "sequence_steps": [{"step_number":1,"channel":"linkedin",',
    '                      "action":"Connection request","delay_days":0}],',
    '  "daily_limits": {"email":100,"linkedin":20,"whatsapp":0},',
    '  "batch_size": 250,',
    '  "service_line": "ai_consulting|staff_augmentation|mixed",',
    '  "rationale": "3-4 sentences explaining the ICP, positioning, and',
    '                sequence choices in plain language for the operator."',
    '}',
  ].filter(Boolean).join('\n');
}

function coerceEnum<T extends string>(
  v: unknown, allowed: readonly T[], fallback: T,
): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/**
 * Robustly extract a JSON object from the model's text. Handles markdown
 * fences, trailing prose, and light repairs (trailing commas, a JSON
 * truncated mid-value by the token cap — we close open brackets).
 */
function extractJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = text.trim();
  // Strip ```json fences.
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = t.indexOf('{');
  if (start === -1) return null;
  t = t.slice(start);

  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  // 1. Direct parse.
  let obj = tryParse(t);
  if (obj) return obj;

  // 2. Remove trailing commas before } or ].
  const noTrailing = t.replace(/,(\s*[}\]])/g, '$1');
  obj = tryParse(noTrailing);
  if (obj) return obj;

  // 3. Truncated JSON (hit token cap mid-value): walk the string tracking
  //    string/bracket state, cut at the last complete top-level property,
  //    and close open brackets.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let lastGoodComma = -1;
  const stack: string[] = [];
  for (let i = 0; i < noTrailing.length; i++) {
    const ch = noTrailing[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') { stack.push(ch); depth++; }
    else if (ch === '}' || ch === ']') { stack.pop(); depth--; }
    else if (ch === ',' && depth === 1) lastGoodComma = i;
  }
  if (lastGoodComma > 0) {
    let repaired = noTrailing.slice(0, lastGoodComma);
    // Close whatever brackets are still open, innermost first.
    const open = [...noTrailing.slice(0, lastGoodComma)];
    void open;
    // Recompute open stack for the truncated slice.
    const st: string[] = [];
    let s2 = false, e2 = false;
    for (const ch of repaired) {
      if (s2) { if (e2) e2 = false; else if (ch === '\\') e2 = true; else if (ch === '"') s2 = false; continue; }
      if (ch === '"') s2 = true;
      else if (ch === '{' || ch === '[') st.push(ch);
      else if (ch === '}' || ch === ']') st.pop();
    }
    while (st.length) {
      repaired += st.pop() === '{' ? '}' : ']';
    }
    obj = tryParse(repaired);
    if (obj) return obj;
  }
  return null;
}

function fallbackPlan(goal: string, ctx: SenderContext): CampaignPlan {
  return {
    name: goal.slice(0, 60) || 'New AI-planned campaign',
    goal: goal.slice(0, 120) || 'Book discovery calls',
    tone: 'consultative',
    sender_company: ctx.sender_company ?? '',
    sender_name: ctx.sender_name ?? '',
    value_proposition:
      ctx.value_proposition ??
      'AI consulting + staff augmentation: vetted engineers and distributed teams, fast.',
    icp_criteria: {
      industries: ['SaaS', 'Fintech', 'Technology'],
      company_sizes: ['51-200', '201-500'],
      countries: ['United States'],
      titles: ['CTO', 'VP Engineering', 'Head of Engineering'],
      intent_keywords: ['hiring engineers', 'digital transformation'],
    },
    channels_enabled: ['email', 'linkedin'],
    sequence_steps: [
      { step_number: 1, channel: 'linkedin', action: 'Connection request', delay_days: 0 },
      { step_number: 2, channel: 'email', action: 'Intro', delay_days: 2 },
      { step_number: 3, channel: 'email', action: 'Follow-up', delay_days: 5 },
    ],
    daily_limits: { email: 100, linkedin: 20, whatsapp: 0 },
    batch_size: 250,
    service_line: 'mixed',
    rationale:
      'Default plan (AI planner unavailable) — a US tech/fintech ICP with a ' +
      'LinkedIn-then-email sequence. Review and adjust the ICP + sequence to fit your goal.',
  };
}

function normalise(raw: Record<string, unknown>, goal: string, ctx: SenderContext): CampaignPlan {
  const fb = fallbackPlan(goal, ctx);
  const icp = (raw.icp_criteria ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
  const steps = Array.isArray(raw.sequence_steps) ? raw.sequence_steps : [];
  const dl = (raw.daily_limits ?? {}) as Record<string, unknown>;

  const industries = arr(icp.industries).filter((i) => VALID_INDUSTRIES.includes(i));
  const sizes = arr(icp.company_sizes).filter((s) => VALID_SIZES.includes(s));

  return {
    name: String(raw.name ?? fb.name).slice(0, 120),
    goal: String(raw.goal ?? fb.goal).slice(0, 200),
    tone: coerceEnum(raw.tone, ['professional', 'consultative', 'direct', 'friendly'] as const, 'consultative'),
    sender_company: ctx.sender_company ?? '',
    sender_name: ctx.sender_name ?? '',
    value_proposition: String(raw.value_proposition ?? fb.value_proposition).slice(0, 600),
    icp_criteria: {
      industries: industries.length ? industries : fb.icp_criteria.industries,
      company_sizes: sizes.length ? sizes : fb.icp_criteria.company_sizes,
      countries: arr(icp.countries).length ? arr(icp.countries) : fb.icp_criteria.countries,
      titles: arr(icp.titles).length ? arr(icp.titles) : fb.icp_criteria.titles,
      intent_keywords: arr(icp.intent_keywords),
    },
    channels_enabled: (arr(raw.channels_enabled).filter((c) =>
      ['email', 'linkedin', 'whatsapp'].includes(c),
    ) as CampaignPlan['channels_enabled']).length
      ? (arr(raw.channels_enabled) as CampaignPlan['channels_enabled'])
      : fb.channels_enabled,
    sequence_steps: steps.length
      ? steps.map((s, i) => {
          const st = s as Record<string, unknown>;
          return {
            step_number: i + 1,
            channel: coerceEnum(st.channel, ['email', 'linkedin', 'whatsapp'] as const, 'email'),
            action: String(st.action ?? 'send').slice(0, 60),
            delay_days: Math.max(0, Math.min(60, Number(st.delay_days) || 0)),
          };
        })
      : fb.sequence_steps,
    daily_limits: {
      email: Math.max(0, Math.min(300, Number(dl.email) || 100)),
      linkedin: Math.max(0, Math.min(25, Number(dl.linkedin) || 20)),
      whatsapp: Math.max(0, Math.min(100, Number(dl.whatsapp) || 0)),
    },
    batch_size: Math.max(1, Math.min(2000, Number(raw.batch_size) || 250)),
    service_line: coerceEnum(
      raw.service_line,
      ['ai_consulting', 'staff_augmentation', 'mixed'] as const,
      'mixed',
    ),
    rationale: String(raw.rationale ?? fb.rationale).slice(0, 1200),
  };
}

export async function planCampaign(
  goal: string,
  ctx: SenderContext = {},
): Promise<CampaignPlan> {
  const key = process.env.ANTHROPIC_API_KEY ?? '';
  if (!key) {
    logger.warn('planner: ANTHROPIC_API_KEY not set — returning fallback plan');
    return fallbackPlan(goal, ctx);
  }
  try {
    // A full plan is ~3k tokens; 45s was too tight and aborted mid-flight
    // ("This operation was aborted"), silently degrading to the fallback.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const r = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 3000,
        messages: [{ role: 'user', content: buildPrompt(goal, ctx) }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      logger.warn('planner anthropic non-2xx', { status: r.status });
      return fallbackPlan(goal, ctx);
    }
    const body = (await r.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (body.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    const parsed = extractJson(text);
    if (!parsed) return fallbackPlan(goal, ctx);
    return normalise(parsed, goal, ctx);
  } catch (err) {
    logger.warn('planner failed', { error: (err as Error).message });
    return fallbackPlan(goal, ctx);
  }
}
