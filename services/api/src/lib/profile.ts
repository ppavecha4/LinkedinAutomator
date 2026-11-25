/**
 * The business profile (SaaS phase 3, slice 3.1): what the org is, sells,
 * targets and sounds like. One `org_profiles` row per org, five JSONB
 * sections validated here. See docs/saas-architecture.md, "Business
 * profile and onboarding" — the table there says which part of the engine
 * reads each field.
 */

import { z } from 'zod';

import { COMPANY_SIZES, TONES } from './offering';

const text = (max: number) => z.string().trim().max(max);
const list = (max: number, itemMax: number) =>
  z.array(z.string().trim().min(1).max(itemMax)).max(max).default([]);
const iso2 = z.string().regex(/^[A-Z]{2}$/, 'use a 2-letter country code like "PE"');
const lang = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'use a language code like "es"');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

export const SIGNALS = ['new_markets', 'trade_fairs', 'hiring', 'funding', 'new_product', 'tenders'] as const;

export const companySchema = z
  .object({
    name: text(255).min(1),
    // Who is legally sending, and where: both go in the footer of every email
    // (anti-spam laws: CAN-SPAM, CASL, GDPR transparency). The address is
    // required before an email campaign can launch.
    legal_name: text(255).optional(),
    address: text(300).optional(),
    website: z.string().trim().url().max(500).nullable().optional(),
    industry: text(150).optional(),
    size: z.enum(COMPANY_SIZES).optional(),
    hq_country: iso2.optional(),
    description: text(1500).optional(),
    // Languages the team can answer replies in (limits what we write in).
    languages_handled: z.array(lang).max(10).default([]),
  })
  .strict();

export const offerSchema = z
  .object({
    offers: z
      .array(z.object({
        name: text(150).min(1),
        description: text(600).optional(),
        typical_buyer: text(300).optional(),
      }).strict())
      .max(10)
      .default([]),
    value_proposition: text(1500).optional(),
    // Each proof point says whether the AI may cite it in messages.
    proof: z.array(z.object({ text: text(300).min(1), may_mention: z.boolean().default(true) }).strict())
      .max(15)
      .default([]),
    price_policy: z.enum(['never', 'starting_price']).default('never'),
  })
  .strict();

export const customersSchema = z
  .object({
    industries: list(15, 100),
    roles: list(15, 100),
    company_sizes: z.array(z.enum(COMPANY_SIZES)).max(5).default([]),
    countries: z.array(iso2).max(40).default([]),
    problems: text(1500).optional(),
    signals: z.array(z.enum(SIGNALS)).max(SIGNALS.length).default([]),
    // Domains (or company names) never to contact: customers, competitors.
    never_contact: z.array(text(255).min(1).transform((s) => s.toLowerCase()))
      .max(5000)
      .default([]),
  })
  .strict();

export const voiceSchema = z
  .object({
    tone: z.enum(TONES).default('professional'),
    formality: z.enum(['formal', 'informal']).default('formal'),
    sender_name: text(120).optional(),
    sender_title: text(120).optional(),
    meeting_link: z.string().trim().url().max(500).optional(),
    avoid: list(30, 80),
    // A message that worked — style reference only, never a source of facts.
    example: text(3000).optional(),
  })
  .strict();

export const rulesSchema = z
  .object({
    // The prospect's local time. A window that ends before it starts
    // (overnight) is not supported: start must be earlier than end.
    contact_hours: z
      .object({ start: hhmm, end: hhmm, weekdays_only: z.boolean().default(true) })
      .strict()
      .refine((h) => h.start < h.end, { message: 'contact hours must start before they end', path: ['end'] })
      .optional(),
    blocked_countries: z.array(iso2).max(250).default([]),
  })
  .strict();

export const SECTION_SCHEMAS = {
  company: companySchema,
  offer: offerSchema,
  customers: customersSchema,
  voice: voiceSchema,
  rules: rulesSchema,
} as const;
export type Section = keyof typeof SECTION_SCHEMAS;
export const SECTIONS = Object.keys(SECTION_SCHEMAS) as Section[];

export interface Profile {
  company: Partial<z.infer<typeof companySchema>>;
  offer: Partial<z.infer<typeof offerSchema>>;
  customers: Partial<z.infer<typeof customersSchema>>;
  voice: Partial<z.infer<typeof voiceSchema>>;
  rules: Partial<z.infer<typeof rulesSchema>>;
}

interface Check {
  section: Section;
  item: string;
  hint: string;
  weight: number;
  ok: (p: Profile) => boolean;
}

const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null);

// What makes the engine work well, weighted by how much it matters.
const CHECKS: Check[] = [
  { section: 'company', item: 'description', weight: 10, hint: 'Describe what you do in one or two sentences.', ok: (p) => has(p.company.description) },
  { section: 'company', item: 'address', weight: 6, hint: "Add your company's postal address: it goes in every email's footer, and email campaigns cannot launch without it.", ok: (p) => has(p.company.address) },
  { section: 'company', item: 'industry', weight: 4, hint: 'Add your industry.', ok: (p) => has(p.company.industry) },
  { section: 'company', item: 'languages_handled', weight: 6, hint: 'Say which languages your team can answer replies in.', ok: (p) => has(p.company.languages_handled) },
  { section: 'offer', item: 'offers', weight: 12, hint: 'Add at least one product or service.', ok: (p) => has(p.offer.offers) },
  { section: 'offer', item: 'value_proposition', weight: 12, hint: 'Say why customers choose you.', ok: (p) => has(p.offer.value_proposition) },
  { section: 'offer', item: 'proof', weight: 10, hint: 'Add proof the AI may mention (a certification or a customer result).', ok: (p) => (p.offer.proof ?? []).some((x) => x.may_mention) },
  { section: 'customers', item: 'roles', weight: 10, hint: 'Say which roles to contact.', ok: (p) => has(p.customers.roles) },
  { section: 'customers', item: 'industries', weight: 8, hint: 'Add the industries you sell to.', ok: (p) => has(p.customers.industries) },
  { section: 'customers', item: 'countries', weight: 8, hint: 'Add the countries you sell to.', ok: (p) => has(p.customers.countries) },
  { section: 'customers', item: 'problems', weight: 8, hint: 'Describe the problems you solve for them.', ok: (p) => has(p.customers.problems) },
  { section: 'voice', item: 'sender_name', weight: 6, hint: 'Add the sender name messages go out under.', ok: (p) => has(p.voice.sender_name) },
  { section: 'voice', item: 'meeting_link', weight: 6, hint: 'Add a meeting link so interested prospects can book.', ok: (p) => has(p.voice.meeting_link) },
];

export function completeness(p: Profile): { score: number; missing: Array<{ section: Section; item: string; hint: string }> } {
  const total = CHECKS.reduce((s, c) => s + c.weight, 0);
  const done = CHECKS.filter((c) => c.ok(p));
  const score = Math.round((done.reduce((s, c) => s + c.weight, 0) / total) * 100);
  const missing = CHECKS.filter((c) => !c.ok(p)).map(({ section, item, hint }) => ({ section, item, hint }));
  return { score, missing };
}

const SIGNAL_TEXT: Record<(typeof SIGNALS)[number], string> = {
  new_markets: 'expanding to new export markets',
  trade_fairs: 'exhibiting at trade fairs',
  hiring: 'hiring relevant staff',
  funding: 'recent funding or a new plant',
  new_product: 'launching a new product',
  tenders: 'publishing tenders',
};

/** The profile as plain text: the input to the offering generator. Only
 * proof the customer allowed is included, so the AI can never cite the rest. */
export function profileDescription(p: Profile): string {
  const lines: string[] = [];
  const c = p.company, o = p.offer, k = p.customers, v = p.voice;
  if (c.name) lines.push(`Company: ${c.name}${c.industry ? ` (${c.industry})` : ''}${c.hq_country ? `, based in ${c.hq_country}` : ''}.`);
  if (c.description) lines.push(c.description);
  for (const off of o.offers ?? []) {
    lines.push(`Offer: ${off.name}${off.description ? ` — ${off.description}` : ''}${off.typical_buyer ? ` (typical buyer: ${off.typical_buyer})` : ''}.`);
  }
  if (o.value_proposition) lines.push(`Why customers choose us: ${o.value_proposition}`);
  const proof = (o.proof ?? []).filter((x) => x.may_mention).map((x) => x.text);
  if (proof.length) lines.push(`Proof we may cite: ${proof.join('; ')}.`);
  lines.push(o.price_policy === 'starting_price' ? 'We may mention a starting price.' : 'Never mention prices.');
  if (k.roles?.length) lines.push(`We sell to: ${k.roles.join(', ')}.`);
  if (k.industries?.length) lines.push(`Industries: ${k.industries.join(', ')}.`);
  if (k.company_sizes?.length) lines.push(`Company sizes: ${k.company_sizes.join(', ')} employees.`);
  if (k.countries?.length) lines.push(`Countries (ISO codes): ${k.countries.join(', ')}.`);
  if (k.problems) lines.push(`Problems we solve: ${k.problems}`);
  if (k.signals?.length) lines.push(`Good timing signals: ${k.signals.map((s) => SIGNAL_TEXT[s]).join(', ')}.`);
  if (v.tone) lines.push(`Tone: ${v.tone}${v.formality ? `, ${v.formality}` : ''}.`);
  if (v.avoid?.length) lines.push(`Never use these words or claims: ${v.avoid.join(', ')}.`);
  return lines.join('\n');
}
