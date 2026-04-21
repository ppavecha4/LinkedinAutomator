/**
 * Campaigns route — the main CRUD + launch + analytics surface.
 *
 *   POST   /api/campaigns                     create
 *   GET    /api/campaigns                     list (paginated + metrics)
 *   GET    /api/campaigns/estimate            prospect-count estimate for ICP
 *   GET    /api/campaigns/:id                 detail + sequence_steps + metrics
 *   PATCH  /api/campaigns/:id/status          change status
 *   POST   /api/campaigns/:id/launch          DRAFT|PAUSED → ACTIVE + SQS enqueue
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
import { publishJson } from '../lib/sqs';
import { buildPagination, ok, okPaginated, parsePageLimit } from '../lib/response';
import { validate } from '../middleware/validate';
import { dashboardHub } from '../ws/server';

const router = Router();

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
            icp_criteria, daily_limits, batch_size, created_by
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10
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

        return campaign;
      });

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

router.patch(
  '/api/campaigns/:id/status',
  validate({ params: uuidParam, body: statusBodySchema }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
      const { status } = req.validated!.body as z.infer<typeof statusBodySchema>;
      const result = await query<CampaignRow>(
        `UPDATE campaigns SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
        [status, id],
      );
      if (result.rowCount === 0) throw ApiError.notFound('campaign not found');
      return ok(res, result.rows[0]);
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/api/campaigns/:id/launch',
  validate({ params: uuidParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id;
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

      await query(
        `UPDATE campaigns SET status = 'ACTIVE', updated_at = now() WHERE id = $1`,
        [id],
      );

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

export default router;
