/**
 * Business profile + onboarding (SaaS phase 3, slice 3.1).
 *
 *   GET  /api/profile                    profile + completeness + onboarding state
 *   PUT  /api/profile/:section           replace one section (company|offer|customers|voice|rules)
 *   POST /api/profile/read-website {url} AI draft of company/offer from the site (not saved)
 *   POST /api/profile/understanding      AI summary + suggested offering from the profile (not saved)
 *   POST /api/profile/sample-message     a sample first message for an example prospect
 *   POST /api/onboarding/complete        finish onboarding (optionally saving the offering)
 *
 * The three AI endpoints run on lib/onboardingAi.ts: the org's own key, or
 * a capped platform allowance during onboarding. Nothing they return is
 * saved until the customer confirms it. Owners/admins/members may write.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { orgChannels } from '../lib/channels';
import { ApiError } from '../lib/errors';
import { callAnthropic, generateOffering, offeringSchema, OfferingGenerationError, type CallModel } from '../lib/offering';
import { onboardingAiKey } from '../lib/onboardingAi';
import { completeness, profileDescription, SECTION_SCHEMAS, SECTIONS, type Profile, type Section } from '../lib/profile';
import { ok } from '../lib/response';
import { draftProfileFromWebsite, readWebsite, WebsiteError } from '../lib/websiteReader';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { env } from '../env';

const router = Router();
const canWrite = requireRole('owner', 'admin', 'member');

// Tests swap the model call and the page fetcher.
let modelOverride: CallModel | undefined;
let fetchOverride: typeof fetch | undefined;
let resolveOverride: ((host: string) => Promise<string[]>) | undefined;
export function setProfileTestHooks(h: {
  model?: CallModel; fetch?: typeof fetch; resolve?: (host: string) => Promise<string[]>;
}): void {
  modelOverride = h.model;
  fetchOverride = h.fetch;
  resolveOverride = h.resolve;
}
const model = () => modelOverride ?? callAnthropic;

type ProfileRow = Profile & { website_read_at: string | null; updated_at: string | null };

async function loadProfile(): Promise<ProfileRow> {
  const r = await query<ProfileRow>(
    `SELECT company, offer, customers, voice, rules, website_read_at, updated_at FROM org_profiles`,
  );
  if (r.rowCount === 0) {
    // Orgs created before V21 seeded a row (V21 backfills them); create on demand anyway.
    await query(`INSERT INTO org_profiles DEFAULT VALUES ON CONFLICT (org_id) DO NOTHING`);
    return { company: {}, offer: {}, customers: {}, voice: {}, rules: {}, website_read_at: null, updated_at: null };
  }
  return r.rows[0];
}

// ── Read / write ───────────────────────────────────────────────────────

router.get('/api/profile', async (_req, res, next) => {
  try {
    const p = await loadProfile();
    const org = await query<{ onboarding_completed_at: string | null; onboarding_ai_calls: number }>(
      `SELECT onboarding_completed_at, onboarding_ai_calls FROM organizations`,
    );
    return ok(res, {
      profile: p,
      completeness: completeness(p),
      onboarding: {
        completed_at: org.rows[0]?.onboarding_completed_at ?? null,
        ai_calls_used: org.rows[0]?.onboarding_ai_calls ?? 0,
        ai_calls_cap: env.onboardingAiCap,
      },
    });
  } catch (err) {
    next(err);
  }
});

const sectionParams = z.object({ section: z.enum(SECTIONS as [Section, ...Section[]]) });

router.put(
  '/api/profile/:section',
  canWrite,
  validate({ params: sectionParams }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { section } = req.validated!.params as z.infer<typeof sectionParams>;
      const parsed = SECTION_SCHEMAS[section].safeParse(req.body);
      if (!parsed.success) throw ApiError.badRequest('validation failed', { issues: parsed.error.issues });
      await loadProfile(); // ensure the row exists
      // `section` comes from the enum above, never from free text.
      await query(
        `UPDATE org_profiles SET ${section} = $1::jsonb, updated_at = now(), updated_by = $2`,
        [JSON.stringify(parsed.data), req.user!.id],
      );
      const p = await loadProfile();
      return ok(res, { profile: p, completeness: completeness(p) });
    } catch (err) {
      next(err);
    }
  },
);

// ── AI helpers (onboarding allowance) ──────────────────────────────────

const websiteBody = z.object({ url: z.string().trim().min(4).max(500) }).strict();

router.post(
  '/api/profile/read-website',
  canWrite,
  validate({ body: websiteBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { url } = req.validated!.body as z.infer<typeof websiteBody>;
      const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      let site;
      try {
        site = await readWebsite(withScheme, { fetchImpl: fetchOverride, resolve: resolveOverride });
      } catch (e) {
        if (e instanceof WebsiteError) throw ApiError.badRequest(e.message);
        throw e;
      }
      if (site.text.trim().length < 40) throw ApiError.badRequest('that website has too little text to read');
      const key = await onboardingAiKey();
      let draft;
      try {
        draft = await draftProfileFromWebsite(site.url, site.text, key.apiKey, model());
      } catch {
        throw new ApiError(422, 'UNPROCESSABLE', 'could not draft a profile from that website; fill it in by hand');
      }
      await query(`UPDATE org_profiles SET website_read_at = now()`);
      return ok(res, { draft, sources: site.sources, ai: { source: key.source, remaining: key.remaining } });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/api/profile/understanding', canWrite, async (_req, res, next) => {
  try {
    const p = await loadProfile();
    const description = profileDescription(p);
    if (description.length < 40) throw ApiError.badRequest('fill in your business and ideal customers first');
    const key = await onboardingAiKey();
    try {
      const draft = await generateOffering(description, {
        apiKey: key.apiKey,
        allowedChannels: await orgChannels(),
        callModel: model(),
      });
      return ok(res, { ...draft, ai: { source: key.source, remaining: key.remaining } });
    } catch (e) {
      if (e instanceof OfferingGenerationError) throw new ApiError(422, 'UNPROCESSABLE', e.message);
      throw e;
    }
  } catch (err) {
    next(err);
  }
});

const sampleBody = z
  .object({
    channel: z.enum(['email', 'whatsapp']).default('whatsapp'),
    prospect: z.object({
      name: z.string().trim().min(1).max(120),
      title: z.string().trim().max(120).optional(),
      company: z.string().trim().min(1).max(200),
      country: z.string().trim().max(100).optional(),
      language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional(),
      context: z.string().trim().max(500).optional(), // e.g. "started exporting blueberries to NL"
    }).strict(),
  })
  .strict();

/** Mirrors the orchestrator's generic writer prompt (smoke_test_campaign.py
 * GENERIC_PROMPT) closely enough for a preview; the real messages are
 * written there. */
export function samplePrompt(p: Profile, b: z.infer<typeof sampleBody>): string {
  const pr = b.prospect;
  const language = pr.language
    ? `Write it in the language with code "${pr.language}"`
    : `Write it in the main business language of ${pr.country ?? 'the prospect\'s country'}`;
  return [
    `Write a short first outreach message from ${p.voice.sender_name ?? 'the sender'}${p.voice.sender_title ? `, ${p.voice.sender_title}` : ''} at ${p.company.name ?? 'the company'}.`,
    'Use ONLY these facts about the sender; never invent clients, numbers or claims:',
    profileDescription(p),
    '',
    `Prospect: ${pr.name}${pr.title ? `, ${pr.title}` : ''} at ${pr.company}${pr.country ? ` (${pr.country})` : ''}.`,
    pr.context ? `Real context about them: ${pr.context}` : 'No research about them: personalise from their role and company only.',
    `${language}, natively (not a translation), with ${p.voice.formality === 'informal' ? 'informal' : 'formal'} address.`,
    b.channel === 'whatsapp'
      ? 'Channel: WhatsApp, at most 300 characters, conversational, ending with a short line telling them to reply STOP to opt out (keep the word STOP).'
      : 'Channel: email, 80-120 words, one clear call to action, no subject line, no sign-off.',
    p.voice.meeting_link ? `The call to action may offer this meeting link: ${p.voice.meeting_link}` : 'Ask for a short call.',
    // Same rule as the engine's writer (orchestrator agents/profile_rules.py).
    ...(p.voice.example
      ? ['STYLE REFERENCE — a message that worked for them. Match its length, rhythm and tone only; do NOT reuse its facts, names, numbers or claims:',
        `<example>\n${p.voice.example.slice(0, 1500)}\n</example>`]
      : []),
    'Output ONLY the message.',
  ].join('\n');
}

router.post(
  '/api/profile/sample-message',
  canWrite,
  validate({ body: sampleBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.validated!.body as z.infer<typeof sampleBody>;
      const p = await loadProfile();
      const key = await onboardingAiKey();
      let text: string;
      try {
        text = (await model()(key.apiKey, samplePrompt(p, b))).trim();
      } catch {
        throw new ApiError(422, 'UNPROCESSABLE', 'could not write a sample right now; try again');
      }
      return ok(res, { message: text, channel: b.channel, ai: { source: key.source, remaining: key.remaining } });
    } catch (err) {
      next(err);
    }
  },
);

// ── Finish onboarding ──────────────────────────────────────────────────

const completeBody = z.object({ offering: offeringSchema.optional() }).strict();

router.post(
  '/api/onboarding/complete',
  requireRole('owner', 'admin'),
  validate({ body: completeBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { offering } = req.validated!.body as z.infer<typeof completeBody>;
      let offeringId: string | null = null;
      if (offering) {
        const o = await query<{ id: string }>(
          `INSERT INTO org_offerings (name, description, value_proposition, tone, icp, routing, source_prompt)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'onboarding') RETURNING id`,
          [offering.name, offering.description ?? null, offering.value_proposition, offering.tone,
           JSON.stringify(offering.icp), JSON.stringify(offering.routing)],
        );
        offeringId = o.rows[0].id;
      }
      const r = await query<{ onboarding_completed_at: string }>(
        `UPDATE organizations SET onboarding_completed_at = COALESCE(onboarding_completed_at, now())
         RETURNING onboarding_completed_at`,
      );
      return ok(res, { onboarding_completed_at: r.rows[0]?.onboarding_completed_at, offering_id: offeringId });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
