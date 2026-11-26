/**
 * Meta's WhatsApp webhooks (slice 10.5): checking the signature, reading the events, and handing them on.
 *
 *   replies, buttons, STOP        → inbound_events 'whatsapp_meta.message'     (the orchestrator records them)
 *   delivered / read / failed     → inbound_events 'whatsapp_meta.status'
 *   "stop marketing messages"     → inbound_events 'whatsapp_meta.preference'  (an opt-out)
 *   template approved / rejected  → applied here to whatsapp_templates
 *
 * Every event is routed to the company that owns the number or template (V38) and written under that
 * company's row-level security. An event nobody owns is dropped with a log line: it is never filed under
 * another company. Meta redelivers until it gets a 200, so storing is idempotent and a failure to store
 * must surface as an error (never swallowed: a lost "STOP" is a compliance failure).
 */

import crypto from 'crypto';

import { query } from '../db/client';
import { logger } from '../logger';
import { runAsOrg } from './tenantLookup';
import { mapMetaApproval } from './whatsappTemplates';

/** `X-Hub-Signature-256: sha256=<hex HMAC of the raw body with the app secret>`. */
export function verifyMetaSignature(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`);
  const given = Buffer.from(header);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Template ids are numbers too long for JavaScript to hold exactly: keep them as text. */
export function parseMetaPayload(text: string): unknown {
  return JSON.parse(text.replace(/("message_template_id"\s*:\s*)(\d+)/g, '$1"$2"'));
}

export type InboundSource = 'whatsapp_meta.message' | 'whatsapp_meta.status' | 'whatsapp_meta.preference';

export interface InboundEvent {
  source: InboundSource;
  phoneNumberId: string;
  payload: Record<string, unknown> & { wamid: string };
}

export interface TemplateUpdate { templateId: string; event: string; reason: string | null }

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown, max = 200): string => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, max) : '');

/** The words of an incoming message; media and other kinds become a short label (or their caption). */
function textOf(m: Obj): string {
  const type = str(m.type);
  if (type === 'text') return str(obj(m.text).body, 4000);
  if (type === 'button') return str(obj(m.button).text, 4000);
  if (type === 'interactive') {
    const i = obj(m.interactive);
    return str(obj(i.button_reply).title || obj(i.list_reply).title, 4000);
  }
  const caption = str(obj(m[type]).caption, 4000);
  if (caption) return caption;
  return ['image', 'video', 'audio', 'document', 'sticker', 'location', 'contacts'].includes(type) ? `[${type}]` : '[unsupported message]';
}

/** What a webhook body says, as plain events. Unknown fields are ignored. */
export function extractMetaEvents(body: unknown): { inbound: InboundEvent[]; templates: TemplateUpdate[] } {
  const inbound: InboundEvent[] = [];
  const templates: TemplateUpdate[] = [];
  if (obj(body).object !== 'whatsapp_business_account') return { inbound, templates };

  for (const entry of list(obj(body).entry)) {
    for (const change of list(entry.changes)) {
      const field = str(change.field);
      const v = obj(change.value);
      const phoneNumberId = str(obj(v.metadata).phone_number_id);

      if (field === 'messages' && phoneNumberId) {
        const names = new Map(list(v.contacts).map((c) => [str(c.wa_id), str(obj(c.profile).name)]));
        for (const m of list(v.messages)) {
          // A thumbs-up on our message is not a reply, and must not stop a follow-up.
          if (!str(m.id) || !str(m.from) || m.type === 'reaction') continue;
          inbound.push({
            source: 'whatsapp_meta.message', phoneNumberId,
            payload: { wamid: str(m.id), from: str(m.from), type: str(m.type), text: textOf(m), name: names.get(str(m.from)) ?? '', timestamp: str(m.timestamp), phone_number_id: phoneNumberId },
          });
        }
        for (const s of list(v.statuses)) {
          const status = str(s.status);
          if (!str(s.id) || !['delivered', 'read', 'failed'].includes(status)) continue;    // 'sent' tells us nothing new
          const err = list(s.errors)[0] ?? {};
          inbound.push({
            source: 'whatsapp_meta.status', phoneNumberId,
            payload: {
              wamid: str(s.id), status, recipient_id: str(s.recipient_id), timestamp: str(s.timestamp), phone_number_id: phoneNumberId,
              ...(status === 'failed' ? { error_code: Number(err.code) || null, error: str(obj(err.error_data).details || err.message || err.title) } : {}),
            },
          });
        }
      } else if (field === 'user_preferences' && phoneNumberId) {
        for (const p of list(v.user_preferences)) {
          if (p.category !== 'marketing_messages' || !str(p.wa_id) || !['stop', 'resume'].includes(str(p.value))) continue;
          inbound.push({
            source: 'whatsapp_meta.preference', phoneNumberId,
            // No message id here: build one from the facts so a redelivery is recognised.
            payload: { wamid: `pref:${str(p.wa_id)}:${str(p.timestamp)}:${str(p.value)}`, from: str(p.wa_id), value: str(p.value), phone_number_id: phoneNumberId },
          });
        }
      } else if (field === 'message_template_status_update') {
        const templateId = str(v.message_template_id);
        const event = str(v.event).toUpperCase();
        if (templateId && event) templates.push({ templateId, event, reason: str(v.reason) || null });
      }
    }
  }
  return { inbound, templates };
}

async function owner(fn: 'org_of_whatsapp_meta_inbound' | 'org_of_whatsapp_meta_template', id: string): Promise<string | null> {
  // `fn` is one of the two fixed names above, never user input.
  const r = await query<{ org: string | null }>(`SELECT ${fn}($1) AS org`, [id]);
  return r.rows[0]?.org ?? null;
}

async function store(org: string, e: InboundEvent): Promise<boolean> {
  const r = await runAsOrg(org, () => query(
    `INSERT INTO inbound_events (source, payload)
     SELECT $1::varchar, $2::jsonb
      WHERE NOT EXISTS (
            SELECT 1 FROM inbound_events
             WHERE source = $1::varchar AND payload->>'wamid' = $3 AND payload->>'status' IS NOT DISTINCT FROM $4::text)`,
    [e.source, JSON.stringify(e.payload), e.payload.wamid, (e.payload.status as string | undefined) ?? null],
  ));
  return (r.rowCount ?? 0) > 0;
}

async function applyTemplateUpdate(org: string, u: TemplateUpdate): Promise<boolean> {
  const a = mapMetaApproval({ status: u.event === 'REINSTATED' ? 'APPROVED' : u.event, rejected_reason: u.reason });
  if (a.status === 'PENDING') return false;              // flagged, in appeal, ...: nothing changes until Meta decides
  const r = await runAsOrg(org, () => query(
    `UPDATE whatsapp_templates
        SET status = $2::varchar, rejection_reason = $3::text, last_checked_at = now(), updated_at = now(),
            approved_at = CASE WHEN $2::varchar = 'APPROVED' THEN now() ELSE approved_at END
      WHERE meta_template_id = $1 AND provider = 'meta' AND status <> 'DRAFT'`,      // a draft was rewritten since: old news
    [u.templateId, a.status, a.reason],
  ));
  return (r.rowCount ?? 0) > 0;
}

/** Route and store everything in one webhook call. Throws if something that should be kept could not be. */
export async function handleMetaWebhook(body: unknown): Promise<{ stored: number; templates: number; unrouted: number }> {
  const { inbound, templates } = extractMetaEvents(body);
  const orgs = new Map<string, string | null>();
  let stored = 0;
  let updated = 0;
  let unrouted = 0;
  for (const e of inbound) {
    if (!orgs.has(e.phoneNumberId)) orgs.set(e.phoneNumberId, await owner('org_of_whatsapp_meta_inbound', e.phoneNumberId));
    const org = orgs.get(e.phoneNumberId);
    if (!org) {
      unrouted += 1;
      logger.warn('meta webhook for a number nobody has connected', { phone_number_id: e.phoneNumberId, source: e.source });
      continue;
    }
    if (await store(org, e)) stored += 1;
  }
  for (const u of templates) {
    const org = await owner('org_of_whatsapp_meta_template', u.templateId);
    if (!org) { unrouted += 1; continue; }
    if (await applyTemplateUpdate(org, u)) updated += 1;
  }
  return { stored, templates: updated, unrouted };
}
