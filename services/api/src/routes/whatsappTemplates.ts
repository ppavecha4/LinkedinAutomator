/**
 * WhatsApp message templates (slice 9.1): the AI writes them, Meta approves them,
 * the sender uses them. See lib/whatsappTemplates.ts.
 *
 *   GET    /api/whatsapp/templates          the templates, readiness per language, suggested languages
 *   POST   /api/whatsapp/templates/draft    the AI writes first message + follow-up per language {languages?}
 *   PATCH  /api/whatsapp/templates/:id      edit a draft or a rejected one {body}
 *   POST   /api/whatsapp/templates/submit   send drafts to Meta through the company's Twilio {ids?}
 *   POST   /api/whatsapp/templates/refresh  ask Twilio where pending ones stand
 *   DELETE /api/whatsapp/templates/:id      remove a draft or a rejected one
 *
 * Owners and admins write (it speaks for the company to Meta); everyone can read and refresh.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';

import { query } from '../db/client';
import { resolveAiKey } from '../lib/aiKey';
import { ApiError } from '../lib/errors';
import { callAnthropic, type CallModel } from '../lib/offering';
import { type Profile } from '../lib/profile';
import { ok } from '../lib/response';
import {
  draftTemplates, editTemplate, listTemplates, loadTwilioAuth, primaryLanguage, readiness,
  removeTemplate, saveDrafts, submitTemplate, syncPending, templateIssues, type TemplateRow,
} from '../lib/whatsappTemplates';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const canWrite = requireRole('owner', 'admin');

// Tests swap the model call; production uses the real one.
let modelOverride: CallModel | undefined;
export function setTemplateModelForTests(fn: CallModel | undefined): void {
  modelOverride = fn;
}

const idParams = z.object({ id: z.string().uuid() });
const lang = z.string().trim().toLowerCase().regex(/^[a-z]{2,3}$/, 'use a language code like "en" or "es"');
const draftBody = z.object({ languages: z.array(lang).min(1).max(5).optional() }).strict();
const editBody = z.object({ body: z.string().max(2000) }).strict();
const submitBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(20).optional() }).strict();

async function loadProfile(): Promise<{ profile: Profile; orgName: string; defaultLanguage: string }> {
  const p = await query<Profile>(`SELECT company, offer, customers, voice, rules FROM org_profiles`);
  const o = await query<{ name: string; default_language: string }>(`SELECT name, default_language FROM organizations`);
  const profile = p.rows[0] ?? { company: {}, offer: {}, customers: {}, voice: {}, rules: {} };
  return { profile: profile as Profile, orgName: o.rows[0]?.name ?? '', defaultLanguage: o.rows[0]?.default_language ?? 'en' };
}

/** Languages to write for when nobody chose: the ones the team answers in, else the company's default. */
function suggestedLanguages(profile: Profile, defaultLanguage: string): string[] {
  const fromProfile = (profile.company?.languages_handled ?? []).map(primaryLanguage).filter((l): l is string => !!l);
  const list = [...new Set(fromProfile.length ? fromProfile : [primaryLanguage(defaultLanguage) ?? 'en'])];
  return list.slice(0, 5);
}

async function twilioConnected(): Promise<boolean> {
  const r = await query(`SELECT 1 FROM org_credentials WHERE provider = 'twilio' AND secret_enc IS NOT NULL AND status NOT IN ('REVOKED', 'FAILED') LIMIT 1`);
  return (r.rowCount ?? 0) > 0;
}

async function view(): Promise<{ templates: TemplateRow[]; languages: ReturnType<typeof readiness>; twilio_connected: boolean; suggested_languages: string[] }> {
  const [templates, connected, { profile, defaultLanguage }] = await Promise.all([listTemplates(), twilioConnected(), loadProfile()]);
  return { templates, languages: readiness(templates), twilio_connected: connected, suggested_languages: suggestedLanguages(profile, defaultLanguage) };
}

router.get('/api/whatsapp/templates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    return ok(res, await view());
  } catch (e) {
    next(e);
  }
});

router.post('/api/whatsapp/templates/draft', canWrite, validate({ body: draftBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = req.validated!.body as z.infer<typeof draftBody>;
    const { profile, orgName, defaultLanguage } = await loadProfile();
    // Without something real to say, the AI would invent it: ask for the offer first.
    const knowsWhatItSells = (profile.offer?.offers?.length ?? 0) > 0 || !!profile.offer?.value_proposition?.trim() || !!profile.company?.description?.trim();
    if (!knowsWhatItSells) {
      throw ApiError.conflict('tell us what you sell first (Business profile), so the messages say something real');
    }
    const languages = body.languages ?? suggestedLanguages(profile, defaultLanguage);
    const { apiKey } = await resolveAiKey();                                   // managed AI within the plan, or their own key
    const call = modelOverride ?? callAnthropic;
    const companyName = profile.company?.name?.trim() || orgName;
    const result = await draftTemplates(
      { profile, companyName, senderName: profile.voice?.sender_name?.trim() || companyName, languages },
      (prompt) => call(apiKey, prompt, 'whatsapp_templates'),
    );
    const saved = await saveDrafts(result.drafts);
    return ok(res, { ...(await view()), saved: saved.saved, kept: saved.kept, problems: result.problems });
  } catch (e) {
    next(e);
  }
});

router.patch('/api/whatsapp/templates/:id', canWrite, validate({ params: idParams, body: editBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    const { body } = req.validated!.body as z.infer<typeof editBody>;
    const row = await editTemplate(id, body);
    return ok(res, { template: row, issues: templateIssues(row.body) });
  } catch (e) {
    next(e);
  }
});

router.post('/api/whatsapp/templates/submit', canWrite, validate({ body: submitBody }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids } = req.validated!.body as z.infer<typeof submitBody>;
    const auth = await loadTwilioAuth();
    const targets = ids ?? (await listTemplates()).filter((t) => t.status === 'DRAFT' || t.status === 'REJECTED').map((t) => t.id);
    if (targets.length === 0) throw ApiError.conflict('there is nothing to send: write the messages first');
    const results = [];
    for (const id of targets) results.push(await submitTemplate(id, auth));
    return ok(res, { results, ...(await view()) });
  } catch (e) {
    next(e);
  }
});

router.post('/api/whatsapp/templates/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    let checked = { checked: 0, changed: 0 };
    if (await twilioConnected()) {
      try {
        checked = await syncPending();
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;                                 // a broken connection is shown, not fatal here
      }
    }
    return ok(res, { ...checked, ...(await view()) });
  } catch (e) {
    next(e);
  }
});

router.delete('/api/whatsapp/templates/:id', canWrite, validate({ params: idParams }), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.validated!.params as z.infer<typeof idParams>;
    await removeTemplate(id);
    return ok(res, await view());
  } catch (e) {
    next(e);
  }
});

export default router;
