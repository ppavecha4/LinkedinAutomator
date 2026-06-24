/**
 * Campaigns route — the main CRUD + launch + analytics surface.
 *
 *   POST   /api/campaigns                     create
 *   GET    /api/campaigns                     list (paginated + metrics)
 *   GET    /api/campaigns/estimate            prospect-count estimate for ICP
 *   GET    /api/campaigns/:id                 detail + sequence_steps + metrics
 *   PATCH  /api/campaigns/:id                 partial update of editable fields
 *   PATCH  /api/campaigns/:id/status          change status (pause/resume/archive)
 *   POST   /api/campaigns/:id/launch          DRAFT|PAUSED → ACTIVE + SQS enqueue
 *   POST   /api/campaigns/:id/clone           duplicate as DRAFT (status reset)
 *   GET    /api/campaigns/:id/audit-log       full change history (timeline)
 *   GET    /api/campaigns/:id/prospects       list prospects for a campaign
 *   GET    /api/campaigns/:id/analytics       funnel + channel + pitch + distribution
 *
 * Validation via Zod; responses via ok()/okPaginated(); errors via ApiError.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { query, withTransaction } from '../db/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';
import { listHeyreachCampaigns } from '../lib/heyreach';
import { publishJson } from '../lib/sqs';
import { buildPagination, ok, okPaginated, parsePageLimit } from '../lib/response';
import { validate } from '../middleware/validate';
import { dashboardHub } from '../ws/server';

const router = Router();

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------
//
// `auditCampaign` writes a row into campaign_audit_log. It accepts a
// pg client so it can run inside a transaction (e.g. PATCH writes the
// campaign update + the audit row in the same TX, so a partial failure
// can't leave the timeline lying about what happened).
//
// `action` is a free-form verb: 'created' | 'updated' | 'launched' |
// 'paused' | 'resumed' | 'archived' | 'unarchived' | 'cloned' | …
// `changes` is a JSON object documenting what changed:
//     {field_name: {before: <old>, after: <new>}, ...}
// State transitions (launch / pause / archive) typically use a small
// {note: '...'} so the timeline reads naturally.

interface AuditWrite {
  campaignId: string;
  actorId: string | null;
  action: string;
  changes?: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function auditCampaign(client: any, w: AuditWrite): Promise<void> {
  await client.query(
    `
    INSERT INTO campaign_audit_log (campaign_id, actor_id, action, changes)
    VALUES ($1, $2, $3, $4::jsonb)
    `,
    [w.campaignId, w.actorId, w.action, JSON.stringify(w.changes ?? {})],
  );
}

/** Compute a {field: {before, after}} diff between two campaign rows for
 * the fields a PATCH can touch. Excludes JSON columns (icp_criteria,
 * daily_limits) which are too noisy to diff field-by-field — those
 * collapse to a single 'icp_criteria changed' or 'daily_limits changed'
 * marker. */
function diffCampaign(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  const scalarFields = [
    'name',
    'goal',
    'tone',
    'sender_company',
    'sender_name',
    'value_proposition',
    'batch_size',
  ];
  for (const k of scalarFields) {
    if (before[k] !== after[k]) {
      out[k] = { before: before[k], after: after[k] };
    }
  }
  // jsonb columns: collapse to a "changed" marker if their stringified
  // representation differs.
  if (
    JSON.stringify(before.icp_criteria) !== JSON.stringify(after.icp_criteria)
  ) {
    out.icp_criteria = {
      before: before.icp_criteria,
      after: after.icp_criteria,
    };
  }
  if (
    JSON.stringify(before.daily_limits) !== JSON.stringify(after.daily_limits)
  ) {
    out.daily_limits = {
      before: before.daily_limits,
      after: after.daily_limits,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const uuidParam = z.object({ id: z.string().uuid() });

const channelEnum = z.enum(['email', 'linkedin', 'whatsapp']);
const statusEnum = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'ARCHIVED']);

const sequenceStepSchema = z.object({
  step_number: z.number().int().min(1),
  channel: channelEnum,
  action: z.string().min(1),
  delay_days: z.number().int().min(0).default(0),
  template_subject: z.string().optional(),
  template_body: z.string().optional(),
});

const dailyLimitsSchema = z
  .object({
    email: z.number().int().min(0).default(100),
    linkedin: z.number().int().min(0).default(20),
    whatsapp: z.number().int().min(0).default(50),
  })
  .partial()
  .default({ email: 100, linkedin: 20, whatsapp: 50 });

const createCampaignSchema = z.object({
  name: z.string().min(1).max(255),
  goal: z.string().min(1),
  tone: z.string().min(1).max(30).default('professional'),
  sender_company: z.string().min(1).max(255),
  sender_name: z.string().min(1).max(255),
  value_proposition: z.string().min(1),
  icp_criteria: z.record(z.unknown()).default({}),
  sequence_steps: z.array(sequenceStepSchema).default([]),
  daily_limits: dailyLimitsSchema,
  batch_size: z.number().int().min(1).max(10000).default(500),
  // Optional link to a Heyreach campaign picked from the dropdown in
  // step 4 of the wizard. NULL when the operator skips the picker.
  heyreach_campaign_id: z.string().max(100).nullable().optional(),
});

// PATCH body — every field is optional. Only the supplied keys are
// updated; everything else is left as-is. `status`, `id`, and the
// audit columns are not editable here (use PATCH /:id/status for
// state transitions).
const updateCampaignSchema = z
  .object({
    name: z.string().min(1).max(255),
    goal: z.string().min(1),
    tone: z.string().min(1).max(30),
    sender_company: z.string().min(1).max(255),
    sender_name: z.string().min(1).max(255),
    value_proposition: z.string().min(1),
    icp_criteria: z.record(z.unknown()),
    sequence_steps: z.array(sequenceStepSchema),
    daily_limits: dailyLimitsSchema,
    batch_size: z.number().int().min(1).max(10000),
    // Allow the operator to paste / clear a Heyreach campaign id if the
    // auto-link at create time failed or they prefer to use a specific
    // campaign they configured in Heyreach UI. Empty string clears the
    // link; a valid string sets it.
    heyreach_campaign_id: z.string().max(100).nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, {
    message: 'at least one field is required',
  });

const listQuerySchema = z.object({
  status: statusEnum.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});

const prospectsQuerySchema = z.object({
  status: z
    .enum([
      'DISCOVERED',
      'ENRICHED',
      'CONTACTED',
      'REPLIED',
      'MEETING_BOOKED',
      'UNSUBSCRIBED',
      'DISQUALIFIED',
    ])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const statusBodySchema = z.object({
  status: statusEnum,
});

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  goal: string;
  tone: string;
  sender_company: string;
  sender_name: string;
  value_proposition: string;
  icp_criteria: Record<string, unknown>;
  daily_limits: Record<string, unknown>;
  batch_size: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface MetricsRow {
  discovered: number;
  enriched: number;
  contacted: number;
  replied: number;
  meeting_booked: number;
  total_messages: number;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

router.post(
  '/api/campaigns',
  validate({ body: createCampaignSchema }),
  async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const body = req.validated!.body as z.infer<typeof createCampaignSchema>;
      const userId = req.user?.id;
      if (!userId) throw ApiError.unauthorized('missing user id on request');

      const created = await withTransaction(async (client) => {
        const inserted = await client.query<CampaignRow>(
          `
          INSERT INTO campaigns (
            name, goal, tone, sender_company, sender_name, value_proposition,
            icp_criteria, daily_limits, batch_size, created_by,
            heyreach_campaign_id
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11
          )
          RETURNING *
          `,
          [
            body.name,
            body.goal,
            body.tone,
            body.sender_company,
            body.sender_name,
            body.value_proposition,
            JSON.stringify(body.icp_criteria),
            JSON.stringify(body.daily_limits),
            body.batch_size,
            userId,
            // Empty string from the dropdown ("— Pick…") normalises to NULL.
            (body.heyreach_campaign_id ?? '').trim() || null,
          ],
        );
        const campaign = inserted.rows[0];

        if (body.sequence_steps.length > 0) {
          for (const step of body.sequence_steps) {
            await client.query(
              `
              INSERT INTO sequence_steps (
                campaign_id, step_number, channel, action, delay_days,
                template_subject, template_body
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              `,
              [
                campaign.id,
                step.step_number,
                step.channel,
                step.action,
                step.delay_days,
                step.template_subject ?? null,
                step.template_body ?? null,
              ],
            );
          }
        }

        // Audit: campaign created.
        await auditCampaign(client, {
          campaignId: campaign.id,
          actorId: userId,
          action: 'created',
          changes: {
            note: `created with ${body.sequence_steps.length} sequence step(s)`,
            initial_status: campaign.status,
          },
        });

        return campaign;
      });

      // We deliberately do NOT auto-create a matching Heyreach campaign
      // here. Heyreach's public API exposes a /campaign/Create endpoint
      // but its required payload couples to internal resources
      // (sequence templates, account roles) that aren't reliably settable
      // from outside their UI — even a 200 response often produces a
      // campaign that can't accept leads until the operator finalises
      // setup in Heyreach UI anyway. Instead, the dashboard's edit page
      // exposes a "Pick a Heyreach campaign" dropdown populated from
      // GET /api/heyreach/campaigns, plus a link to create new ones in
      // Heyreach UI. The chosen id is stored via the standard PATCH path.
      return ok(_res, created, 201);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/campaigns',
  validate({ query: listQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validated!.query as z.infer<typeof listQuerySchema>;
      const { page, limit, offset } = parsePageLimit(q);

      const params: unknown[] = [];
      let where = '';
      if (q.status) {
        params.push(q.status);
        where = `WHERE c.status = $${params.length}`;
      }

      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM campaigns c ${where}`,
        params,
      );
      const total = Number(countResult.rows[0]?.total ?? 0);

      params.push(limit, offset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;
      const listResult = await query(
        `
        SELECT
          c.*,
          COALESCE(p.total_prospects, 0)::int          AS total_prospects,
          COALESCE(p.contacted, 0)::int                AS contacted,
          COALESCE(p.replied, 0)::int                  AS replied,
          COALESCE(p.meeting_booked, 0)::int           AS meeting_booked,
          COALESCE(m.messages_sent, 0)::int            AS messages_sent
        FROM campaigns c
        LEFT JOIN (
          SELECT
            campaign_id,
            COUNT(*) AS total_prospects,
            COUNT(*) FILTER (WHERE status = 'CONTACTED')      AS contacted,
            COUNT(*) FILTER (WHERE status = 'REPLIED')        AS replied,
            COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS meeting_booked
          FROM prospects
          GROUP BY campaign_id
        ) p ON p.campaign_id = c.id
        LEFT JOIN (
          SELECT campaign_id, COUNT(*) AS messages_sent
          FROM messages
          WHERE direction = 'outbound' AND status IN ('SENT','DELIVERED','OPENED','REPLIED')
          GROUP BY campaign_id
        ) m ON m.campaign_id = c.id
        ${where}
        ORDER BY c.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `,
        params,
      );

      return okPaginated(res, listResult.rows, buildPagination(page, limit, total));
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/campaigns/estimate — prospect-count estimate for an ICP
// ---------------------------------------------------------------------------
//
// Rough heuristic: count *existing* prospects in the DB that match each ICP
// facet (industry / country / size). This isn't a true "how many exist in
// the world" figure (that needs Apollo's /mixed_people/search) — it's a
// lower-bound "how many are already in our system". The dashboard labels it
// with that caveat in the estimate panel.
const estimateQuerySchema = z.object({
  industries: z.string().optional(),
  countries: z.string().optional(),
  company_sizes: z.string().optional(),
});

router.get(
  '/api/campaigns/estimate',
  validate({ query: estimateQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = req.validated!.query as z.infer<typeof estimateQuerySchema>;
      const industries = q.industries
        ? q.industries.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const countries = q.countries
        ? q.countries.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const sizes = q.company_sizes
        ? q.company_sizes.split(',').map((s) => s.trim()).filter(Boolean)
        : [];

      const params: unknown[] = [];
      const clauses: string[] = [];
      if (industries.length > 0) {
        params.push(industries);
        clauses.push(`industry = ANY($${params.length}::text[])`);
      }
      if (countries.length > 0) {
        params.push(countries);
        clauses.push(`country = ANY($${params.length}::text[])`);
      }
      if (sizes.length > 0) {
        params.push(sizes);
        clauses.push(`company_size = ANY($${params.length}::text[])`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const result = await query<{ estimate: string }>(
        `SELECT COUNT(*)::text AS estimate FROM prospects ${where}`,
        params,
      );
      return ok(res, {
        estimate: Number(result.rows[0]?.estimate ?? 0),
        basis: 'existing prospects in database (heuristic)',
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/campaigns/:id',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const campaignResult = await query<CampaignRow>(
        `SELECT * FROM campaigns WHERE id = $1`,
        [id],
      );
      if (campaignResult.rowCount === 0) throw ApiError.notFound('campaign not found');

      const stepsResult = await query(
        `SELECT * FROM sequence_steps WHERE campaign_id = $1 ORDER BY step_number ASC`,
        [id],
      );

      const metricsResult = await query<MetricsRow>(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'DISCOVERED')     AS discovered,
          COUNT(*) FILTER (WHERE status = 'ENRICHED')       AS enriched,
          COUNT(*) FILTER (WHERE status = 'CONTACTED')      AS contacted,
          COUNT(*) FILTER (WHERE status = 'REPLIED')        AS replied,
          COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS meeting_booked,
          0::bigint AS total_messages
        FROM prospects
        WHERE campaign_id = $1
        `,
        [id],
      );

      return ok(res, {
        campaign: campaignResult.rows[0],
        sequence_steps: stepsResult.rows,
        metrics: metricsResult.rows[0] ?? {},
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/:id — partial update of a campaign's editable fields
// ---------------------------------------------------------------------------
//
// Edits any combination of name / goal / tone / sender_* / value_proposition
// / icp_criteria / daily_limits / batch_size in a single transaction. If
// `sequence_steps` is supplied, the existing rows for the campaign are
// deleted and replaced atomically — partial step edits aren't supported
// because the orchestrator's pacing logic depends on contiguous step_number
// ordering.
//
// Caveat surfaced to the operator in the dashboard's edit page:
// changes to `icp_criteria` do NOT retroactively affect prospects already
// discovered for this campaign — they only apply to subsequent batches.
router.patch(
  '/api/campaigns/:id',
  validate({ params: uuidParam, body: updateCampaignSchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const userId = req.user?.id ?? null;
      const body = req.validated!.body as z.infer<typeof updateCampaignSchema>;

      const updated = await withTransaction(async (client) => {
        // Build a dynamic UPDATE statement covering only the columns the
        // caller supplied. Order is locked so $N indices match.
        const sets: string[] = [];
        const params: unknown[] = [];
        const push = (col: string, val: unknown) => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };

        if (body.name !== undefined)               push('name', body.name);
        if (body.goal !== undefined)               push('goal', body.goal);
        if (body.tone !== undefined)               push('tone', body.tone);
        if (body.sender_company !== undefined)     push('sender_company', body.sender_company);
        if (body.sender_name !== undefined)        push('sender_name', body.sender_name);
        if (body.value_proposition !== undefined)  push('value_proposition', body.value_proposition);
        if (body.batch_size !== undefined)         push('batch_size', body.batch_size);
        if (body.heyreach_campaign_id !== undefined) {
          // Empty string normalises to NULL so the operator can clear
          // the link by submitting an empty value.
          const v = (body.heyreach_campaign_id ?? '').trim();
          push('heyreach_campaign_id', v ? v : null);
        }
        if (body.icp_criteria !== undefined) {
          params.push(JSON.stringify(body.icp_criteria));
          sets.push(`icp_criteria = $${params.length}::jsonb`);
        }
        if (body.daily_limits !== undefined) {
          params.push(JSON.stringify(body.daily_limits));
          sets.push(`daily_limits = $${params.length}::jsonb`);
        }

        if (sets.length === 0 && body.sequence_steps === undefined) {
          throw ApiError.badRequest('no editable fields supplied');
        }

        // Snapshot the campaign BEFORE the update so the audit row can
        // capture {field: {before, after}} diffs for every changed key.
        const before = await client.query(
          `SELECT * FROM campaigns WHERE id = $1`,
          [id],
        );
        if (before.rowCount === 0) throw ApiError.notFound('campaign not found');
        const beforeRow = before.rows[0] as Record<string, unknown>;

        if (sets.length > 0) {
          // updated_at is bumped on every patch so dashboards can sort by it.
          sets.push('updated_at = now()');
          params.push(id);
          const sql = `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`;
          const result = await client.query<CampaignRow>(sql, params);
          if (result.rowCount === 0) throw ApiError.notFound('campaign not found');
        } else {
          // Caller is only updating sequence_steps. Bump updated_at.
          await client.query(
            `UPDATE campaigns SET updated_at = now() WHERE id = $1`,
            [id],
          );
        }

        // Replace-all sequence steps if supplied. Two-step transactional
        // update — same as Flyway-managed reference-table refresh.
        if (body.sequence_steps !== undefined) {
          await client.query(
            `DELETE FROM sequence_steps WHERE campaign_id = $1`,
            [id],
          );
          for (const step of body.sequence_steps) {
            await client.query(
              `
              INSERT INTO sequence_steps (
                campaign_id, step_number, channel, action, delay_days,
                template_subject, template_body
              ) VALUES ($1, $2, $3, $4, $5, $6, $7)
              `,
              [
                id, step.step_number, step.channel, step.action,
                step.delay_days, step.template_subject ?? null,
                step.template_body ?? null,
              ],
            );
          }
        }

        // Return the fresh row + steps so the dashboard cache stays in sync.
        const fresh = await client.query<CampaignRow>(
          `SELECT * FROM campaigns WHERE id = $1`,
          [id],
        );
        const steps = await client.query(
          `SELECT * FROM sequence_steps WHERE campaign_id = $1 ORDER BY step_number ASC`,
          [id],
        );

        // Audit: scalar + jsonb diff plus a marker if sequence_steps was
        // replaced (we don't diff individual steps because the wizard
        // does a wholesale replace and the timeline noise isn't worth it).
        const changes: Record<string, unknown> = diffCampaign(
          beforeRow,
          fresh.rows[0] as unknown as Record<string, unknown>,
        );
        if (body.sequence_steps !== undefined) {
          changes.sequence_steps = {
            before: '(replaced)',
            after: `${body.sequence_steps.length} step(s)`,
          };
        }
        if (Object.keys(changes).length > 0) {
          await auditCampaign(client, {
            campaignId: id,
            actorId: userId,
            action: 'updated',
            changes,
          });
        }

        return { ...fresh.rows[0], sequence_steps: steps.rows };
      });

      return ok(res, updated);
    } catch (err) {
      next(err);
    }
  },
);

router.patch(
  '/api/campaigns/:id/status',
  validate({ params: uuidParam, body: statusBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const userId = req.user?.id ?? null;
      const { status } = req.validated!.body as z.infer<typeof statusBodySchema>;

      const updated = await withTransaction(async (client) => {
        // Snapshot previous status so the audit row can capture the
        // exact transition + we can pick the right verb (paused vs
        // archived vs unarchived, etc.).
        const before = await client.query<{ status: string }>(
          `SELECT status FROM campaigns WHERE id = $1`,
          [id],
        );
        if (before.rowCount === 0) throw ApiError.notFound('campaign not found');
        const previousStatus = before.rows[0].status;

        const result = await client.query<CampaignRow>(
          `UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
          [status, id],
        );

        // Pick a human-readable verb for the timeline. Falls back to a
        // generic 'status_changed' when the transition isn't one of
        // the named patterns (e.g. force-set ARCHIVED → DRAFT etc).
        const verb = pickStatusVerb(previousStatus, status);
        await auditCampaign(client, {
          campaignId: id,
          actorId: userId,
          action: verb,
          changes: { status: { before: previousStatus, after: status } },
        });

        return result.rows[0];
      });

      return ok(res, updated);
    } catch (err) {
      next(err);
    }
  },
);

/** Map (before, after) status pair → verb shown in the audit timeline. */
function pickStatusVerb(before: string, after: string): string {
  if (before === 'PAUSED' && after === 'ACTIVE') return 'resumed';
  if (after === 'PAUSED') return 'paused';
  if (after === 'ARCHIVED') return 'archived';
  if (before === 'ARCHIVED' && after !== 'ARCHIVED') return 'unarchived';
  if (after === 'COMPLETED') return 'completed';
  if (before === 'DRAFT' && after === 'ACTIVE') return 'launched';
  return 'status_changed';
}

router.post(
  '/api/campaigns/:id/launch',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const userId = req.user?.id ?? null;
      const current = await query<CampaignRow>(
        `SELECT * FROM campaigns WHERE id = $1`,
        [id],
      );
      if (current.rowCount === 0) throw ApiError.notFound('campaign not found');
      const campaign = current.rows[0];
      if (!['DRAFT', 'PAUSED'].includes(campaign.status)) {
        throw ApiError.conflict(
          `campaign must be DRAFT or PAUSED to launch, got ${campaign.status}`,
        );
      }
      const previousStatus = campaign.status;

      // Status flip + audit in one transaction. The SQS publish runs
      // outside the TX because a queue write isn't reversible, but the
      // audit row faithfully reflects the intent regardless of whether
      // the SQS publish succeeded — the dashboard timeline is a record
      // of operator actions, not of SQS state.
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE campaigns SET status = 'ACTIVE', updated_at = now() WHERE id = $1`,
          [id],
        );
        await auditCampaign(client, {
          campaignId: id,
          actorId: userId,
          action: 'launched',
          changes: { status: { before: previousStatus, after: 'ACTIVE' } },
        });
      });

      const launchedAt = new Date().toISOString();
      const sqsResult = await publishJson(env.sqsCampaignQueueUrl, {
        campaign_id: id,
        action: 'LAUNCH',
        launched_at: launchedAt,
      });

      dashboardHub.broadcast({
        type: 'CAMPAIGN_STARTED',
        campaign_id: id,
        payload: { sqs_message_id: sqsResult.messageId },
        timestamp: launchedAt,
      });

      return ok(res, {
        queued: sqsResult.queued,
        sqs_message_id: sqsResult.messageId,
        estimated_prospects: campaign.batch_size,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/campaigns/:id/clone — duplicate as DRAFT
// ---------------------------------------------------------------------------
//
// Use case: operator wants to launch a "Wave 2" of a successful campaign
// with the same ICP + sequence + sender, just a few tweaks. Cloning gives
// them a starting point without re-typing the whole wizard.
//
// Behaviour:
//   - new campaign id
//   - status reset to DRAFT (cloned campaigns aren't auto-launched)
//   - name = "Copy of <original name>" (operator can rename in the editor)
//   - sequence_steps copied as-is in step_number order
//   - audit row on BOTH the source ("cloned") and the new campaign
//     ("created") so the timeline on either side surfaces the relationship
//
// Note: prospects, contacts, messages are NOT copied. The clone starts
// with an empty pipeline so the new run can discover its own.
router.post(
  '/api/campaigns/:id/clone',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const userId = req.user?.id ?? null;
      if (!userId) throw ApiError.unauthorized('missing user id on request');

      const cloned = await withTransaction(async (client) => {
        const src = await client.query<CampaignRow>(
          `SELECT * FROM campaigns WHERE id = $1`,
          [id],
        );
        if (src.rowCount === 0) throw ApiError.notFound('campaign not found');
        const c = src.rows[0];

        const inserted = await client.query<CampaignRow>(
          `
          INSERT INTO campaigns (
            name, goal, tone, sender_company, sender_name, value_proposition,
            icp_criteria, daily_limits, batch_size, status, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, 'DRAFT', $10
          )
          RETURNING *
          `,
          [
            `Copy of ${c.name}`.slice(0, 255),
            c.goal,
            c.tone,
            c.sender_company,
            c.sender_name,
            c.value_proposition,
            JSON.stringify(c.icp_criteria),
            JSON.stringify(c.daily_limits),
            c.batch_size,
            userId,
          ],
        );
        const newCampaign = inserted.rows[0];

        // Copy sequence steps in step_number order.
        await client.query(
          `
          INSERT INTO sequence_steps (
            campaign_id, step_number, channel, action, delay_days,
            template_subject, template_body
          )
          SELECT $1, step_number, channel, action, delay_days,
                 template_subject, template_body
            FROM sequence_steps
           WHERE campaign_id = $2
           ORDER BY step_number ASC
          `,
          [newCampaign.id, id],
        );

        // Audit on the NEW campaign — created from clone source.
        await auditCampaign(client, {
          campaignId: newCampaign.id,
          actorId: userId,
          action: 'created',
          changes: {
            note: 'cloned from another campaign',
            cloned_from: id,
            source_name: c.name,
          },
        });
        // Audit on the SOURCE campaign — surfaces the clone in its
        // timeline so operators can trace the lineage.
        await auditCampaign(client, {
          campaignId: id,
          actorId: userId,
          action: 'cloned',
          changes: {
            note: `cloned to a new campaign`,
            new_campaign_id: newCampaign.id,
            new_campaign_name: newCampaign.name,
          },
        });

        return newCampaign;
      });

      return ok(res, cloned, 201);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/campaigns/:id/audit-log — full change history (timeline)
// ---------------------------------------------------------------------------
//
// Returns rows newest-first, paginated. The dashboard's edit page renders
// these as a vertical timeline so operators can see who did what when.
router.get(
  '/api/campaigns/:id/audit-log',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const { page, limit, offset } = parsePageLimit(req.query);

      const exists = await query(
        `SELECT 1 FROM campaigns WHERE id = $1`,
        [id],
      );
      if (exists.rowCount === 0) throw ApiError.notFound('campaign not found');

      const totalResult = await query<{ total: string }>(
        `SELECT count(*) AS total FROM campaign_audit_log WHERE campaign_id = $1`,
        [id],
      );
      const total = Number(totalResult.rows[0]?.total ?? 0);

      const rows = await query(
        `
        SELECT id::text, campaign_id::text, actor_id::text,
               action, changes, created_at
          FROM campaign_audit_log
         WHERE campaign_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3
        `,
        [id, limit, offset],
      );

      okPaginated(res, rows.rows, buildPagination(page, limit, total));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/campaigns/:id/prospects',
  validate({ params: uuidParam, query: prospectsQuerySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const q = req.validated!.query as z.infer<typeof prospectsQuerySchema>;
      const { page, limit, offset } = parsePageLimit(q);

      const params: unknown[] = [id];
      let statusFilter = '';
      if (q.status) {
        params.push(q.status);
        statusFilter = `AND p.status = $${params.length}`;
      }

      const countResult = await query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM prospects p WHERE p.campaign_id = $1 ${statusFilter}`,
        params,
      );
      const total = Number(countResult.rows[0]?.total ?? 0);

      params.push(limit, offset);
      const limitIdx = params.length - 1;
      const offsetIdx = params.length;

      const result = await query(
        `
        SELECT
          p.*,
          COALESCE(
            json_agg(
              json_build_object(
                'id', c.id,
                'full_name', c.full_name,
                'title', c.title,
                'email', c.email,
                'linkedin_urn', c.linkedin_urn,
                'is_decision_maker', c.is_decision_maker
              )
            ) FILTER (WHERE c.id IS NOT NULL), '[]'
          ) AS contacts,
          (
            SELECT json_build_object(
              'id', m.id,
              'channel', m.channel,
              'status', m.status,
              'sent_at', m.sent_at
            )
            FROM messages m
            JOIN contacts cx ON cx.id = m.contact_id
            WHERE cx.prospect_id = p.id
            ORDER BY m.sent_at DESC NULLS LAST
            LIMIT 1
          ) AS latest_message
        FROM prospects p
        LEFT JOIN contacts c ON c.prospect_id = p.id
        WHERE p.campaign_id = $1 ${statusFilter}
        GROUP BY p.id
        ORDER BY p.created_at DESC
        LIMIT $${limitIdx} OFFSET $${offsetIdx}
        `,
        params,
      );

      return okPaginated(res, result.rows, buildPagination(page, limit, total));
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/campaigns/:id/analytics',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;

      const funnelResult = await query(
        `
        SELECT
          COUNT(*) FILTER (WHERE status = 'DISCOVERED')     AS discovered,
          COUNT(*) FILTER (WHERE status = 'ENRICHED')       AS enriched,
          COUNT(*) FILTER (WHERE status = 'CONTACTED')      AS contacted,
          COUNT(*) FILTER (WHERE status = 'REPLIED')        AS replied,
          COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS meeting_booked
        FROM prospects
        WHERE campaign_id = $1
        `,
        [id],
      );

      const openedResult = await query<{ opened: string }>(
        `
        SELECT COUNT(*)::text AS opened
        FROM messages
        WHERE campaign_id = $1
          AND direction = 'outbound'
          AND status IN ('OPENED','REPLIED')
        `,
        [id],
      );

      const channelResult = await query(
        `
        SELECT
          channel,
          COUNT(*) FILTER (WHERE direction = 'outbound')   AS sent,
          COUNT(*) FILTER (WHERE status    = 'DELIVERED')  AS delivered,
          COUNT(*) FILTER (WHERE status    = 'OPENED')     AS opened,
          COUNT(*) FILTER (WHERE status    = 'REPLIED')    AS replied,
          COUNT(*) FILTER (WHERE status    = 'BOUNCED')    AS bounced
        FROM messages
        WHERE campaign_id = $1
        GROUP BY channel
        `,
        [id],
      );

      const pitchResult = await query(
        `
        SELECT
          pitch_type,
          COUNT(*)                                            AS total_contacted,
          COUNT(*) FILTER (WHERE status = 'REPLIED')          AS replied,
          COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED')   AS meetings,
          ROUND(
            COUNT(*) FILTER (WHERE status = 'REPLIED')::numeric
            / NULLIF(COUNT(*), 0) * 100, 1
          ) AS reply_rate_pct
        FROM prospects
        WHERE campaign_id = $1 AND pitch_type IS NOT NULL
        GROUP BY pitch_type
        `,
        [id],
      );

      // Pitch distribution — what percentage of this campaign's prospects
      // got each pitch angle. Drives the tri-colour band on the campaign card.
      const distResult = await query<{
        ai_agents: string;
        rpa_workflow: string;
        consulting: string;
        total: string;
      }>(
        `
        SELECT
          COUNT(*) FILTER (WHERE pitch_type = 'ai_agents')    AS ai_agents,
          COUNT(*) FILTER (WHERE pitch_type = 'rpa_workflow') AS rpa_workflow,
          COUNT(*) FILTER (WHERE pitch_type = 'consulting')   AS consulting,
          COUNT(*) FILTER (WHERE pitch_type IS NOT NULL)      AS total
        FROM prospects
        WHERE campaign_id = $1
        `,
        [id],
      );
      const dRow = distResult.rows[0] ?? {
        ai_agents: '0',
        rpa_workflow: '0',
        consulting: '0',
        total: '0',
      };
      const total = Number(dRow.total) || 0;
      const pct = (n: string): number =>
        total > 0 ? Math.round((Number(n) / total) * 1000) / 10 : 0;

      return ok(res, {
        funnel: {
          ...(funnelResult.rows[0] ?? {}),
          opened: Number(openedResult.rows[0]?.opened ?? 0),
        },
        channel_breakdown: channelResult.rows,
        pitch_performance: pitchResult.rows,
        pitch_distribution: {
          ai_agents: { count: Number(dRow.ai_agents), pct: pct(dRow.ai_agents) },
          rpa_workflow: {
            count: Number(dRow.rpa_workflow),
            pct: pct(dRow.rpa_workflow),
          },
          consulting: {
            count: Number(dRow.consulting),
            pct: pct(dRow.consulting),
          },
          total,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/heyreach/campaigns — list operator's Heyreach campaigns
// ---------------------------------------------------------------------------
//
// Populates the dashboard's Heyreach link panel dropdown. Returns the
// {ok, campaigns, total, error, skipped} shape from the heyreach client
// so the panel can render "Heyreach not configured" vs "API down" vs
// "no campaigns yet" with the right CTA.
router.get(
  '/api/heyreach/campaigns',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await listHeyreachCampaigns();
      return ok(res, result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
