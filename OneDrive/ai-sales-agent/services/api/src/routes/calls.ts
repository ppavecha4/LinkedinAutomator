/**
 * AI phone calls (voice channel).
 *
 *   GET  /api/calls?campaign_id=&status=&limit=       recent calls
 *   GET  /api/calls/:id                               one call with its transcript
 *   POST /api/calls/:id/cancel                        a call that has not started
 *   GET  /api/campaigns/:id/calls/eligibility         who could be called, and why not
 *   POST /api/campaigns/:id/voice-opt-in              the company confirms these people agreed to calls
 *   POST /api/campaigns/:id/calls                     queue calls for everyone eligible (or the named contacts)
 *
 * We only call people who OPTED IN to calls or who already REPLIED to us
 * (contacts.voice_opt_in_at / a conversation); there is no cold-calling mode.
 * The queue only records the intent: the voice server (orchestrator) re-checks
 * every rule right before it dials (consent, suppression, hours in the person's
 * local time, company status) and does the dialing.
 */

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import { Router } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { ApiError } from '../lib/errors';
import { assertChannelsAllowed, assertReadyToLaunch } from '../lib/channels';
import { ok } from '../lib/response';
import { assertEmailVerified } from '../lib/sessionState';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';

const router = Router();
const canWrite = requireRole('owner', 'admin', 'member');
const MAX_PER_REQUEST = 200;
const RECALL_DAYS = 14;

const idParams = z.object({ id: z.string().uuid() });

const LIST_COLUMNS = `c.id, c.status, c.outcome, c.direction, c.to_number, c.language, c.created_at, c.answered_at,
  c.ended_at, c.duration_seconds, c.failure_reason, c.summary, c.campaign_id,
  ct.full_name AS contact_name, p.company_name`;

router.get('/api/calls', validate({
  query: z.object({
    campaign_id: z.string().uuid().optional(),
    status: z.string().regex(/^[A-Z_]{3,20}$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
}), async (req, res, next) => {
  try {
    const q = req.validated!.query as { campaign_id?: string; status?: string; limit: number };
    const r = await query(
      `SELECT ${LIST_COLUMNS} FROM calls c
         LEFT JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN prospects p ON p.id = c.prospect_id
        WHERE ($1::uuid IS NULL OR c.campaign_id = $1) AND ($2::text IS NULL OR c.status = $2)
        ORDER BY c.created_at DESC LIMIT $3`,
      [q.campaign_id ?? null, q.status ?? null, q.limit]);
    return ok(res, r.rows);
  } catch (e) {
    next(e);
  }
});

router.get('/api/calls/:id', validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as { id: string };
    const r = await query(
      `SELECT ${LIST_COLUMNS}, c.transcript, c.tts_chars, c.stt_seconds FROM calls c
         LEFT JOIN contacts ct ON ct.id = c.contact_id
         LEFT JOIN prospects p ON p.id = c.prospect_id WHERE c.id = $1`, [id]);
    if (r.rowCount === 0) throw ApiError.notFound('call not found');
    return ok(res, r.rows[0]);
  } catch (e) {
    next(e);
  }
});

router.post('/api/calls/:id/cancel', canWrite, validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as { id: string };
    const r = await query(
      `UPDATE calls SET status = 'CANCELLED', ended_at = now() WHERE id = $1 AND status = 'QUEUED' RETURNING id`, [id]);
    if (r.rowCount === 0) throw ApiError.conflict('only a call that has not started yet can be cancelled');
    return ok(res, { cancelled: true });
  } catch (e) {
    next(e);
  }
});

// ── who can be called ───────────────────────────────────────────────────

interface Row {
  id: string; prospect_id: string; number: string | null; country: string | null; language: string | null;
  opted_in: boolean; replied: boolean; suppressed: boolean; prospect_status: string; recently_called: boolean;
}

type Reason = 'no_phone' | 'suppressed' | 'not_contactable' | 'no_basis' | 'already_called';

function e164(raw: string | null, country: string | null): string | null {
  if (!raw) return null;
  const c = country && /^[A-Z]{2}$/.test(country) ? (country as CountryCode) : undefined;
  const p = parsePhoneNumberFromString(raw.replace(/^whatsapp:/i, '').trim(), c);
  return p?.isValid() ? p.number : null;
}

function classify(r: Row): { reason?: Reason; number: string | null } {
  const number = e164(r.number, r.country);
  if (!number) return { reason: 'no_phone', number };
  if (r.suppressed) return { reason: 'suppressed', number };
  if (['UNSUBSCRIBED', 'DISQUALIFIED'].includes(r.prospect_status)) return { reason: 'not_contactable', number };
  if (!r.opted_in && !r.replied) return { reason: 'no_basis', number };
  if (r.recently_called) return { reason: 'already_called', number };
  return { number };
}

async function loadContacts(campaignId: string, ids: string[] | null): Promise<Row[]> {
  const r = await query<Row>(
    `SELECT ct.id, ct.prospect_id, coalesce(ct.phone, ct.whatsapp_number) AS number,
            coalesce(ct.country, left(p.country, 2)) AS country, ct.language,
            (ct.voice_opt_in_at IS NOT NULL) AS opted_in,
            (EXISTS (SELECT 1 FROM conversations v WHERE v.contact_id = ct.id AND v.channel <> 'voice')
             OR EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = ct.id AND m.status = 'REPLIED')) AS replied,
            EXISTS (SELECT 1 FROM suppression_list s
                     WHERE s.expires_at IS NULL AND s.reason <> 'BOUNCE'
                       AND ((ct.email IS NOT NULL AND lower(s.email) = lower(ct.email))
                            OR s.whatsapp_number IN (ct.phone, ct.whatsapp_number))) AS suppressed,
            p.status AS prospect_status,
            EXISTS (SELECT 1 FROM calls k WHERE k.contact_id = ct.id
                     AND (k.status IN ('QUEUED', 'DIALING', 'IN_PROGRESS')
                          OR (k.status IN ('COMPLETED', 'NO_ANSWER', 'BUSY', 'VOICEMAIL')
                              AND k.created_at > now() - make_interval(days => $3)))) AS recently_called
       FROM contacts ct JOIN prospects p ON p.id = ct.prospect_id
      WHERE ct.campaign_id = $1 AND ($2::uuid[] IS NULL OR ct.id = ANY($2))
      ORDER BY ct.created_at LIMIT 5000`,
    [campaignId, ids, RECALL_DAYS]);
  return r.rows;
}

async function voiceCampaign(id: string): Promise<{ id: string; status: string; channels: string[] }> {
  const r = await query<{ id: string; status: string; channels: string[] }>(`SELECT id, status, channels FROM campaigns WHERE id = $1`, [id]);
  if (r.rowCount === 0) throw ApiError.notFound('campaign not found');
  if (!r.rows[0].channels.includes('voice')) throw ApiError.conflict('this campaign does not use AI phone calls');
  return r.rows[0];
}

router.get('/api/campaigns/:id/calls/eligibility', validate({ params: idParams }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as { id: string };
    await voiceCampaign(id);
    const counts: Record<string, number> = { eligible: 0, no_phone: 0, suppressed: 0, not_contactable: 0, no_basis: 0, already_called: 0 };
    for (const row of await loadContacts(id, null)) counts[classify(row).reason ?? 'eligible'] += 1;
    return ok(res, { total: Object.values(counts).reduce((a, b) => a + b, 0), ...counts });
  } catch (e) {
    next(e);
  }
});

// ── consent ─────────────────────────────────────────────────────────────

const optInBody = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(5000).optional(),
  // The company is the one who knows whether these people agreed to calls: it says so, in writing.
  attestation: z.literal(true, { errorMap: () => ({ message: 'confirm that these people agreed to receive calls' }) }),
}).strict();

router.post('/api/campaigns/:id/voice-opt-in', canWrite, validate({ params: idParams, body: optInBody }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as { id: string };
    const b = req.validated!.body as z.infer<typeof optInBody>;
    await voiceCampaign(id);
    const marked = await withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE contacts ct SET voice_opt_in_at = now(), voice_opt_in_source = 'customer_attested'
          WHERE ct.campaign_id = $1 AND ct.voice_opt_in_at IS NULL AND ($2::uuid[] IS NULL OR ct.id = ANY($2))
            AND NOT EXISTS (SELECT 1 FROM suppression_list s
                             WHERE s.expires_at IS NULL AND s.reason <> 'BOUNCE'
                               AND ((ct.email IS NOT NULL AND lower(s.email) = lower(ct.email))
                                    OR s.whatsapp_number IN (ct.phone, ct.whatsapp_number)))
        RETURNING ct.id`,
        [id, b.contact_ids ?? null]);
      await client.query(
        `INSERT INTO compliance_log (action, campaign_id, channel, data) VALUES ('voice_opt_in_attested', $1, 'voice', $2::jsonb)`,
        [id, JSON.stringify({ contacts: r.rowCount, by: req.user!.id, statement: 'the company confirms these people agreed to receive AI phone calls' })]);
      return r.rowCount ?? 0;
    });
    return ok(res, { marked });
  } catch (e) {
    next(e);
  }
});

// ── queue calls ─────────────────────────────────────────────────────────

const queueBody = z.object({
  contact_ids: z.array(z.string().uuid()).min(1).max(MAX_PER_REQUEST).optional(),
}).strict();

router.post('/api/campaigns/:id/calls', canWrite, validate({ params: idParams, body: queueBody }), async (req, res, next) => {
  try {
    const { id } = req.validated!.params as { id: string };
    const b = req.validated!.body as z.infer<typeof queueBody>;
    await assertChannelsAllowed(['voice']);
    await assertEmailVerified(req.user);
    const campaign = await voiceCampaign(id);
    if (campaign.status !== 'ACTIVE') throw ApiError.conflict('launch the campaign before queueing calls');
    await assertReadyToLaunch(['voice']);

    const skipped: Record<string, number> = { no_phone: 0, suppressed: 0, not_contactable: 0, no_basis: 0, already_called: 0 };
    const ready: Array<{ row: Row; number: string }> = [];
    for (const row of await loadContacts(id, b.contact_ids ?? null)) {
      const c = classify(row);
      if (c.reason) skipped[c.reason] += 1;
      else if (ready.length < MAX_PER_REQUEST) ready.push({ row, number: c.number! });
    }
    let queued = 0;
    if (ready.length > 0) {
      const r = await query(
        `INSERT INTO calls (campaign_id, contact_id, prospect_id, to_number, language, requested_by)
         SELECT $1, x.contact_id, x.prospect_id, x.num, x.lang, $6
           FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::text[]) AS x(contact_id, prospect_id, num, lang)
         ON CONFLICT DO NOTHING RETURNING id`,
        [id, ready.map((x) => x.row.id), ready.map((x) => x.row.prospect_id), ready.map((x) => x.number),
         ready.map((x) => x.row.language), req.user!.id]);
      queued = r.rowCount ?? 0;
    }
    return ok(res, { queued, skipped }, 201);
  } catch (e) {
    next(e);
  }
});

export default router;
