/**
 * The AI writes a company's WhatsApp message templates and gets them approved
 * (slice 9.1, V34).
 *
 * WhatsApp lets a business START a conversation only with a template Meta approved.
 * This module covers the whole path so a non-technical owner never touches Twilio's
 * template screens or pastes a template ID:
 *
 *   1. draft:  the AI writes a FIRST message and a FOLLOW-UP per language from the
 *              business profile, inside WhatsApp's rules (checked here, not trusted).
 *   2. submit: sent to Meta for approval, either straight through Meta's Cloud API (a company
 *              connected with Embedded Signup, slice 10.3) or through the company's own Twilio
 *              account (Twilio Content API). Meta wins when it is connected.
 *   3. follow: statuses are checked on demand and every few minutes in the background;
 *              APPROVED templates are picked up by the sender by itself
 *              (orchestrator db/accounts.py), REJECTED ones keep Meta's reason, can be
 *              edited and sent again.
 *
 * Variables are fixed by the sender (scripts/send_pending_whatsapp.py): {{1}} is the
 * prospect's FIRST NAME and {{2}} the prospect's COMPANY. Everything else, who we are
 * and what we offer, is plain text in the template. Every template must carry an
 * opt-out ("Reply STOP"): it is WhatsApp policy and our opt-out handling relies on it.
 *
 * Messages may only go to people who agreed to receive them (WhatsApp's opt-in rule);
 * the sender's own gates enforce that, not this module.
 */

import { z } from 'zod';

import { query } from '../db/client';
import { env } from '../env';
import { logger } from '../logger';
import { ApiError } from './errors';
import { profileDescription, type Profile } from './profile';
import { runAsOrg } from './tenantLookup';
import { currentTenant } from './tenantContext';
import { createMessageTemplate, getMessageTemplate, MetaGraphError } from './metaGraph';
import { aadFor, decryptSecret, vaultKey } from './vault';

export const TEMPLATE_KINDS = ['first', 'followup'] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export type TemplateProvider = 'twilio' | 'meta';
export type TemplateStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'PAUSED' | 'DISABLED';

export interface TemplateRow {
  id: string;
  kind: TemplateKind;
  language: string;
  body: string;
  category: 'MARKETING' | 'UTILITY';
  status: TemplateStatus;
  version: number;
  name: string | null;
  content_sid: string | null;
  provider: TemplateProvider;
  meta_template_id: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
  approved_at: string | null;
  last_checked_at: string | null;
}

const COLUMNS = `id, kind, language, body, category, status, version, name, content_sid, provider, meta_template_id, rejection_reason,
  created_at, updated_at, submitted_at, approved_at, last_checked_at`;

// ── WhatsApp's rules, checked on every body (ours and anything the user edits) ──

export const MIN_BODY = 20;
export const MAX_BODY = 1024;

/** What is wrong with a template body, in plain words. Empty means it can be sent to Meta. */
export function templateIssues(body: string): string[] {
  const issues: string[] = [];
  const text = body ?? '';
  const trimmed = text.trim();
  if (trimmed.length < MIN_BODY) issues.push(`Write at least ${MIN_BODY} characters.`);
  if (text.length > MAX_BODY) issues.push(`Keep it under ${MAX_BODY} characters (it is ${text.length}).`);
  const placeholders = [...text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
  if (placeholders.some((p) => p !== '1' && p !== '2')) issues.push('Only {{1}} (first name) and {{2}} (their company) can be used.');
  if (!placeholders.includes('1')) issues.push('Use {{1}} for the person\'s first name.');
  if (!placeholders.includes('2')) issues.push('Use {{2}} for the person\'s company.');
  if (/^\s*\{\{/.test(text) || /\}\}\s*$/.test(text)) issues.push('A name cannot be the very first or very last thing in the message.');
  if (/\{\{[^}]*\}\}\s*\{\{[^}]*\}\}/.test(text)) issues.push('Do not put two {{ }} next to each other: add words between them.');
  if (/\t/.test(text) || /\n{3,}/.test(text) || / {4,}/.test(text)) issues.push('Remove tabs, blank-line runs and long runs of spaces: WhatsApp rejects them.');
  if (!/\bSTOP\b/i.test(text)) issues.push('Add an opt-out line such as "Reply STOP to opt out".');
  return issues;
}

/** Whether one specific word of the body can still be edited (anything not with Meta). */
export const isEditable = (status: TemplateStatus): boolean => status === 'DRAFT' || status === 'REJECTED';

// ── drafting ──

export interface DraftContext {
  profile: Profile;
  companyName: string;
  senderName: string;
  languages: string[];
}

export interface Draft {
  kind: TemplateKind;
  language: string;
  body: string;
}

const draftReply = z.object({
  templates: z.array(z.object({
    kind: z.enum(TEMPLATE_KINDS),
    language: z.string().trim().toLowerCase().regex(/^[a-z]{2,3}/),
    body: z.string().trim(),
  })),
});

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', ar: 'Arabic',
  hi: 'Hindi', nl: 'Dutch', tr: 'Turkish', id: 'Indonesian', ja: 'Japanese', zh: 'Chinese', ru: 'Russian',
};
const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

/** The primary subtag, lower case ("es-MX" -> "es"); undefined when it is not a language code. */
export function primaryLanguage(code: string | null | undefined): string | undefined {
  const m = /^([A-Za-z]{2,3})(?:[-_]|$)/.exec((code ?? '').trim());
  return m ? m[1].toLowerCase() : undefined;
}

export function buildDraftPrompt(ctx: DraftContext, repair?: Array<{ kind: string; language: string; body: string; issues: string[] }>): string {
  const wanted = ctx.languages.flatMap((l) => TEMPLATE_KINDS.map((k) => `${k} / ${l} (${languageName(l)})`));
  const lines = [
    'You write WhatsApp message TEMPLATES for a business that contacts people about its products.',
    'Meta must approve each template before it can be sent, so follow these rules exactly.',
    '',
    `Business sending the messages: ${ctx.companyName}. Sender name: ${ctx.senderName}.`,
    'What we know about the business (use only this, invent nothing):',
    '"""',
    profileDescription(ctx.profile) || '(little is known: keep it general and honest)',
    '"""',
    '',
    'Write these templates:',
    ...wanted.map((w) => `- ${w}`),
    '',
    'Template rules:',
    '- "first" is the FIRST message to someone who agreed to hear from us: a warm one-line introduction (who we are),',
    '  one concrete reason it matters to THEM, and a soft question that is easy to answer. No hard sell.',
    '- "followup" goes to someone who has not replied: shorter, a different angle, one easy next step. Never guilt them.',
    '- The two variables are fixed: {{1}} is the person\'s FIRST NAME and {{2}} is THEIR COMPANY NAME. Use both, in the',
    '  middle of the text (never as the first or last words, and never two variables side by side).',
    '- Mention who we are and what we offer in plain words in the text itself.',
    '- End with an opt-out in that language that includes the English word STOP, e.g. "Reply STOP to opt out".',
    '- 250 to 600 characters. No tabs, no blank-line runs, at most one emoji, no links, no prices, no promises or numbers',
    '  that are not in the facts above, and never say the message was written by AI.',
    '- Write each template in its own language, natural and polite, in the tone the business uses.',
    '',
    'Return ONE JSON object and nothing else:',
    '{"templates":[{"kind":"first","language":"en","body":"..."}, ...]}',
  ];
  if (repair?.length) {
    lines.push('', 'These earlier drafts broke the rules. Rewrite ONLY these, fixing every problem listed:');
    for (const r of repair) lines.push(`- ${r.kind} / ${r.language}: ${r.issues.join(' ')}\n  Draft was: ${JSON.stringify(r.body)}`);
  }
  return lines.join('\n');
}

function parseDrafts(raw: string): Draft[] {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = draftReply.safeParse(JSON.parse(raw.slice(start, end + 1)));
    if (!parsed.success) return [];
    return parsed.data.templates.map((t) => ({ kind: t.kind, language: primaryLanguage(t.language) ?? t.language, body: t.body }));
  } catch {
    return [];
  }
}

export interface DraftResult {
  drafts: Draft[];
  /** Templates the AI could not get right even after one rewrite: say so, do not store. */
  problems: Array<{ kind: TemplateKind; language: string; issues: string[] }>;
}

/** Ask the model for every kind x language, check each against the rules, rewrite the failures once. */
export async function draftTemplates(
  ctx: DraftContext,
  callModel: (prompt: string) => Promise<string>,
): Promise<DraftResult> {
  const want = new Set(ctx.languages.flatMap((l) => TEMPLATE_KINDS.map((k) => `${k}/${l}`)));
  const good = new Map<string, Draft>();
  let todo: Array<{ kind: string; language: string; body: string; issues: string[] }> | undefined;

  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = parseDrafts(await callModel(buildDraftPrompt(ctx, todo)));
    const failed: NonNullable<typeof todo> = [];
    for (const d of reply) {
      const key = `${d.kind}/${d.language}`;
      if (!want.has(key)) continue;
      const issues = templateIssues(d.body);
      if (issues.length === 0) good.set(key, d);
      else failed.push({ kind: d.kind, language: d.language, body: d.body, issues });
    }
    // Whatever is neither good nor repaired yet.
    const missing = [...want].filter((k) => !good.has(k));
    todo = missing.map((k) => {
      const [kind, language] = k.split('/');
      return failed.find((f) => f.kind === kind && f.language === language)
        ?? { kind, language, body: '', issues: ['No draft was returned for this one.'] };
    });
    if (todo.length === 0) break;
  }
  return {
    drafts: [...good.values()],
    problems: (todo ?? []).map((t) => ({ kind: t.kind as TemplateKind, language: t.language, issues: t.issues })),
  };
}

// ── the company's Twilio account ──

export interface TwilioAuth {
  sid: string;
  token: string;
}

/** The connected Twilio account of the current company (decrypted). 409 when there is none. */
export async function loadTwilioAuth(): Promise<TwilioAuth> {
  const r = await query<{ secret_enc: Buffer; label: string; meta: Record<string, unknown> }>(
    `SELECT secret_enc, label, meta FROM org_credentials
      WHERE provider = 'twilio' AND secret_enc IS NOT NULL AND status NOT IN ('REVOKED', 'FAILED')
      ORDER BY (label = 'default') DESC, (status = 'VERIFIED') DESC, updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (!row) throw ApiError.conflict('connect your Twilio account first (Connected accounts)', { missing: ['twilio'] });
  const key = vaultKey();
  const orgId = currentTenant()?.orgId;
  if (!key || !orgId) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
  const secret = decryptSecret(row.secret_enc, aadFor(orgId, 'twilio', row.label), key);
  const sid = String(row.meta?.account_id ?? '').trim();
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid) || !secret.auth_token) {
    throw ApiError.conflict('your Twilio connection is incomplete: reconnect it (Connected accounts)', { missing: ['twilio'] });
  }
  return { sid, token: secret.auth_token };
}

// ── Where this company's templates live: Meta directly, or its Twilio account ──

export type Sender =
  | { provider: 'twilio'; auth: TwilioAuth }
  | { provider: 'meta'; token: string; wabaId: string };

/** A verified Meta connection (Embedded Signup, V35) wins; otherwise a usable Twilio account; otherwise none. */
export async function currentProvider(): Promise<TemplateProvider | null> {
  const meta = await query(`SELECT 1 FROM org_credentials WHERE provider = 'whatsapp_meta' AND status = 'VERIFIED' AND secret_enc IS NOT NULL LIMIT 1`);
  if ((meta.rowCount ?? 0) > 0) return 'meta';
  const tw = await query(`SELECT 1 FROM org_credentials WHERE provider = 'twilio' AND secret_enc IS NOT NULL AND status NOT IN ('REVOKED', 'FAILED') LIMIT 1`);
  return (tw.rowCount ?? 0) > 0 ? 'twilio' : null;
}

/** The company's verified Meta connection, decrypted. 409 when there is none. */
export async function loadMetaSender(): Promise<Sender> {
  const r = await query<{ secret_enc: Buffer; label: string; meta: Record<string, unknown> }>(
    `SELECT secret_enc, label, meta FROM org_credentials
      WHERE provider = 'whatsapp_meta' AND secret_enc IS NOT NULL AND status = 'VERIFIED'
      ORDER BY (label = 'default') DESC, updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (!row) throw ApiError.conflict('connect WhatsApp first (Connected accounts)', { missing: ['whatsapp'] });
  const key = vaultKey();
  const orgId = currentTenant()?.orgId;
  if (!key || !orgId) throw ApiError.internal('credential vault not configured (CREDENTIALS_KEY)');
  const secret = decryptSecret(row.secret_enc, aadFor(orgId, 'whatsapp_meta', row.label), key);
  const wabaId = String(row.meta?.waba_id ?? '').trim();
  if (!/^\d{5,25}$/.test(wabaId) || !secret.access_token) {
    throw ApiError.conflict('your WhatsApp connection is incomplete: connect WhatsApp again (Connected accounts)', { missing: ['whatsapp'] });
  }
  return { provider: 'meta', token: secret.access_token, wabaId };
}

/** Where to send this company's templates now. 409 when WhatsApp is not connected at all. */
export async function loadSender(): Promise<Sender> {
  const provider = await currentProvider();
  if (provider === 'meta') return loadMetaSender();
  if (provider === 'twilio') return { provider: 'twilio', auth: await loadTwilioAuth() };
  throw ApiError.conflict('connect WhatsApp first (Connected accounts)', { missing: ['whatsapp'] });
}

/**
 * Templates that live at the OTHER provider than the one in use now (the company switched) count as
 * not sent yet: they are shown as drafts and sending them again submits them to the current provider.
 */
export function effectiveRows(rows: TemplateRow[], current: TemplateProvider | null): TemplateRow[] {
  if (!current) return rows;
  return rows.map((r) => (r.provider !== current && r.status !== 'DRAFT' ? { ...r, status: 'DRAFT' as const, rejection_reason: null } : r));
}

// ── Twilio Content API ──

const CONTENT_API = 'https://content.twilio.com/v1';
const TIMEOUT_MS = 15_000;

interface Hooks { fetch: typeof fetch }
let hooks: Hooks = { fetch: (...a) => fetch(...a) };
/** Tests replace the network; production never calls this. */
export function setTwilioContentHooks(h?: Partial<Hooks>): void {
  hooks = { fetch: (...a) => fetch(...a), ...h };
}

export class TwilioContentError extends Error {
  constructor(message: string, readonly status: number, readonly transient = false) {
    super(message);
  }
}

async function content(auth: TwilioAuth, method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await hooks.fetch(`${CONTENT_API}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${Buffer.from(`${auth.sid}:${auth.token}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data: unknown = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* not JSON */ }
  if (r.ok) return data;
  const detail = String((data as { message?: string }).message ?? '').replace(auth.token, '•••').slice(0, 300);
  if (r.status === 401 || r.status === 403) throw new TwilioContentError('Twilio rejected your account details: reconnect Twilio in Connected accounts.', r.status);
  if (r.status === 429 || r.status >= 500) throw new TwilioContentError('Twilio is busy right now: try again in a minute.', r.status, true);
  throw new TwilioContentError(detail || `Twilio answered ${r.status}.`, r.status);
}

/** Twilio's language codes differ from ours for a few languages. */
export function twilioLanguage(lang: string): string {
  return ({ pt: 'pt_BR', zh: 'zh_CN' } as Record<string, string>)[lang] ?? lang;
}

/** A name Meta accepts and never reuses: lower case letters, digits and underscores. */
export function templateName(orgId: string, kind: TemplateKind, language: string, version: number): string {
  return `av_${orgId.replace(/-/g, '').slice(0, 8)}_${kind}_${language}_v${version}`.toLowerCase();
}

export const createContent = async (auth: TwilioAuth, name: string, language: string, body: string): Promise<string> => {
  const d = (await content(auth, 'POST', '/Content', {
    friendly_name: name,
    language: twilioLanguage(language),
    variables: { 1: 'Ana', 2: 'Acme' },
    types: { 'twilio/text': { body } },
  })) as { sid?: string };
  if (!d.sid) throw new TwilioContentError('Twilio did not return a template ID.', 502, true);
  return d.sid;
};

export const requestApproval = async (auth: TwilioAuth, sid: string, name: string, category: string): Promise<void> => {
  await content(auth, 'POST', `/Content/${sid}/ApprovalRequests/whatsapp`, { name, category });
};

export const deleteContent = async (auth: TwilioAuth, sid: string): Promise<void> => {
  await hooks.fetch(`${CONTENT_API}/Content/${sid}`, {
    method: 'DELETE',
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Authorization: `Basic ${Buffer.from(`${auth.sid}:${auth.token}`).toString('base64')}` },
  }).catch(() => undefined);
};

export interface Approval { status: TemplateStatus; reason: string | null }

/** Twilio's WhatsApp approval status, in our words. */
export function mapApproval(whatsapp: { status?: string; rejection_reason?: string } | undefined): Approval {
  const s = (whatsapp?.status ?? '').toLowerCase();
  if (s === 'approved') return { status: 'APPROVED', reason: null };
  if (s === 'rejected') return { status: 'REJECTED', reason: (whatsapp?.rejection_reason || 'Meta did not say why.').slice(0, 500) };
  if (s === 'paused') return { status: 'PAUSED', reason: (whatsapp?.rejection_reason || null) };
  if (s === 'disabled') return { status: 'DISABLED', reason: (whatsapp?.rejection_reason || null) };
  return { status: 'PENDING', reason: null };            // received, pending, unsubmitted
}

export const getApproval = async (auth: TwilioAuth, sid: string): Promise<Approval> => {
  const d = (await content(auth, 'GET', `/Content/${sid}/ApprovalRequests`)) as {
    whatsapp?: { status?: string; rejection_reason?: string };
  };
  return mapApproval(d.whatsapp);
};

const META_REASONS: Record<string, string> = {
  ABUSIVE_CONTENT: 'Meta says the message looks abusive or inappropriate. Rewrite it more plainly.',
  INCORRECT_CATEGORY: 'Meta says the message does not fit its category. Rewrite it so it is clearly a business message.',
  INVALID_FORMAT: 'Meta says the format is not allowed: check the {{ }} placeholders and the spacing.',
  SCAM: 'Meta says the message looks like a scam. Rewrite it more plainly, with nothing that sounds like a prize or a threat.',
  TAG_CONTENT_MISMATCH: 'Meta says the content does not match what was declared. Rewrite it.',
};

/** Meta's template status, in our words. Only an explicit APPROVED lets the sender use a template. */
export function mapMetaApproval(state: { status?: string; rejected_reason?: string | null } | undefined): Approval {
  const s = (state?.status ?? '').toUpperCase();
  const raw = (state?.rejected_reason ?? '').toUpperCase();
  const reason = raw && raw !== 'NONE' ? (META_REASONS[raw] ?? `Meta's reason: ${raw.toLowerCase().replace(/_/g, ' ')}.`) : null;
  if (s === 'APPROVED') return { status: 'APPROVED', reason: null };
  if (s === 'REJECTED') return { status: 'REJECTED', reason: reason ?? 'Meta did not say why.' };
  if (s === 'PAUSED') return { status: 'PAUSED', reason };
  if (s === 'DISABLED' || s === 'DELETED' || s === 'PENDING_DELETION') return { status: 'DISABLED', reason };
  return { status: 'PENDING', reason: null };            // PENDING, IN_APPEAL, FLAGGED, anything new
}

// ── persistence (all inside the caller's tenant) ──

export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = (await query<TemplateRow>(`SELECT ${COLUMNS} FROM whatsapp_templates ORDER BY language, kind`)).rows;
  return effectiveRows(rows, await currentProvider());
}

/** Store drafts. Anything already with Meta (PENDING / APPROVED / PAUSED / DISABLED) is left alone. */
export async function saveDrafts(drafts: Draft[], current: TemplateProvider | null = null): Promise<{ saved: number; kept: Array<{ kind: TemplateKind; language: string }> }> {
  let saved = 0;
  const kept: Array<{ kind: TemplateKind; language: string }> = [];
  for (const d of drafts) {
    const r = await query(
      `INSERT INTO whatsapp_templates (kind, language, body) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, kind, language) DO UPDATE
          SET body = EXCLUDED.body, status = 'DRAFT', rejection_reason = NULL, updated_at = now()
        WHERE whatsapp_templates.status IN ('DRAFT', 'REJECTED')
           OR ($4::text IS NOT NULL AND whatsapp_templates.provider <> $4::text)
       RETURNING id`,
      [d.kind, d.language, d.body, current],
    );
    if (r.rowCount) saved += 1; else kept.push({ kind: d.kind, language: d.language });
  }
  return { saved, kept };
}

export async function getTemplate(id: string): Promise<TemplateRow> {
  const r = await query<TemplateRow>(`SELECT ${COLUMNS} FROM whatsapp_templates WHERE id = $1`, [id]);
  if (!r.rows[0]) throw ApiError.notFound('template not found');
  return effectiveRows(r.rows, await currentProvider())[0];
}

export async function editTemplate(id: string, body: string): Promise<TemplateRow> {
  const row = await getTemplate(id);
  if (!isEditable(row.status)) throw ApiError.conflict('this message is with WhatsApp already: it can be changed once it is rejected');
  const issues = templateIssues(body);
  if (issues.length) throw ApiError.badRequest(issues.join(' '));
  const r = await query<TemplateRow>(
    `UPDATE whatsapp_templates SET body = $2, status = 'DRAFT', rejection_reason = NULL, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`, [id, body.trim()]);
  return r.rows[0];
}

export async function removeTemplate(id: string): Promise<void> {
  const row = await getTemplate(id);
  if (!isEditable(row.status)) throw ApiError.conflict('only drafts and rejected messages can be removed');
  await query(`DELETE FROM whatsapp_templates WHERE id = $1`, [id]);
}

export interface SubmitOutcome { id: string; kind: TemplateKind; language: string; ok: boolean; error?: string }

/** Send one DRAFT / REJECTED template to Meta for approval: straight through Meta, or through the company's Twilio. */
export async function submitTemplate(id: string, sender: Sender): Promise<SubmitOutcome> {
  const row = await getTemplate(id);
  const base = { id, kind: row.kind, language: row.language };
  if (!isEditable(row.status)) return { ...base, ok: false, error: 'already with WhatsApp' };
  const issues = templateIssues(row.body);
  if (issues.length) return { ...base, ok: false, error: issues.join(' ') };
  const orgId = currentTenant()!.orgId;
  const version = row.version + 1;
  const name = templateName(orgId, row.kind, row.language, version);

  if (sender.provider === 'meta') {
    let created;
    try {
      created = await createMessageTemplate(sender.token, sender.wabaId, {
        name, language: twilioLanguage(row.language), category: row.category, body: row.body,
      });
    } catch (e) {
      return { ...base, ok: false, error: e instanceof MetaGraphError ? e.message : 'could not reach Meta: try again' };
    }
    const first = mapMetaApproval({ status: created.status });      // Meta sometimes approves at once
    await query(
      `UPDATE whatsapp_templates
          SET status = $2::varchar, version = $3, name = $4, provider = 'meta', meta_template_id = $5, content_sid = NULL,
              rejection_reason = $6::text, submitted_at = now(), last_checked_at = NULL, updated_at = now(),
              approved_at = CASE WHEN $2::varchar = 'APPROVED' THEN now() ELSE NULL END
        WHERE id = $1`, [id, first.status, version, name, created.id, first.reason]);
    return { ...base, ok: true };
  }

  const auth = sender.auth;
  let sid: string | undefined;
  try {
    sid = await createContent(auth, name, row.language, row.body);
    await requestApproval(auth, sid, name, row.category);
  } catch (e) {
    if (sid) await deleteContent(auth, sid);              // do not leave an orphan behind in their Twilio
    return { ...base, ok: false, error: e instanceof TwilioContentError ? e.message : 'could not reach Twilio: try again' };
  }
  await query(
    `UPDATE whatsapp_templates
        SET status = 'PENDING', version = $2, name = $3, provider = 'twilio', content_sid = $4, meta_template_id = NULL,
            rejection_reason = NULL, submitted_at = now(), last_checked_at = NULL, updated_at = now(), approved_at = NULL
      WHERE id = $1`, [id, version, name, sid]);
  return { ...base, ok: true };
}

/**
 * Ask where every pending template of the current company stands: each one at the provider it was sent to.
 * A provider whose connection is gone is skipped (the template stays pending). Returns how many changed.
 */
export async function syncPending(twilioAuth?: TwilioAuth): Promise<{ checked: number; changed: number }> {
  const pending = (await query<TemplateRow>(
    `SELECT ${COLUMNS} FROM whatsapp_templates
      WHERE status = 'PENDING' AND (content_sid IS NOT NULL OR meta_template_id IS NOT NULL)`)).rows;
  if (pending.length === 0) return { checked: 0, changed: 0 };

  const senders = new Map<TemplateProvider, Sender | null>();
  const senderFor = async (p: TemplateProvider): Promise<Sender | null> => {
    if (!senders.has(p)) {
      try {
        senders.set(p, p === 'meta' ? await loadMetaSender() : { provider: 'twilio', auth: twilioAuth ?? await loadTwilioAuth() });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        senders.set(p, null);
      }
    }
    return senders.get(p) ?? null;
  };

  let changed = 0;
  for (const t of pending) {
    try {
      const sender = await senderFor(t.provider);
      if (!sender) { await query(`UPDATE whatsapp_templates SET last_checked_at = now() WHERE id = $1`, [t.id]); continue; }
      const a = sender.provider === 'meta'
        ? mapMetaApproval(await getMessageTemplate(sender.token, t.meta_template_id!))
        : await getApproval(sender.auth, t.content_sid!);
      const r = await query(
        `UPDATE whatsapp_templates
            SET status = $2::varchar, rejection_reason = $3::text, last_checked_at = now(), updated_at = now(),
                approved_at = CASE WHEN $2::varchar = 'APPROVED' THEN now() ELSE approved_at END
          WHERE id = $1 AND status = 'PENDING'`, [t.id, a.status, a.reason]);
      if (a.status !== 'PENDING' && r.rowCount) changed += 1;
      if (a.status === 'PENDING') await query(`UPDATE whatsapp_templates SET last_checked_at = now() WHERE id = $1`, [t.id]);
    } catch (e) {
      logger.warn('whatsapp template status check failed', { id: t.id, error: (e as Error).message });
      await query(`UPDATE whatsapp_templates SET last_checked_at = now() WHERE id = $1`, [t.id]);   // try again later, not in a tight loop
    }
  }
  return { checked: pending.length, changed };
}

/** What is ready to send, per language: both messages approved. */
export function readiness(rows: TemplateRow[]): Array<{ language: string; first: TemplateStatus | null; followup: TemplateStatus | null; ready: boolean }> {
  const langs = [...new Set(rows.map((r) => r.language))].sort();
  return langs.map((language) => {
    const first = rows.find((r) => r.language === language && r.kind === 'first')?.status ?? null;
    const followup = rows.find((r) => r.language === language && r.kind === 'followup')?.status ?? null;
    return { language, first, followup, ready: first === 'APPROVED' && followup === 'APPROVED' };
  });
}

// ── background: finish what nobody is watching ──

async function syncOrg(orgId: string): Promise<void> {
  if (orgId === env.authOrgId) return;                    // the operator runs on its own .env templates
  await runAsOrg(orgId, async () => { await syncPending(); });
}

/** One pass over every company with templates waiting for Meta. */
export async function syncAllPending(limit = 100): Promise<number> {
  const due = await query<{ id: string; org_id: string }>(`SELECT * FROM whatsapp_templates_pending($1, $2)`, [limit, 5]);
  const orgs = [...new Set(due.rows.map((r) => r.org_id))];
  for (const orgId of orgs) {
    try {
      await syncOrg(orgId);
    } catch (e) {
      logger.warn('whatsapp template sync failed for a company', { org_id: orgId, error: (e as Error).message });
    }
  }
  return orgs.length;
}

/** Start the periodic check (every 10 minutes; Meta usually answers within a day). */
export function startTemplateSync(): () => void {
  if (env.authMode !== 'local') return () => undefined;
  const run = () => { void syncAllPending().catch((e) => logger.error('template sync run failed', { error: (e as Error).message })); };
  const first = setTimeout(run, 3 * 60_000);
  const every = setInterval(run, 10 * 60_000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}
