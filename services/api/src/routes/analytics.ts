/**
 * Analytics route — funnel + channel + pitch + per-campaign rollups.
 *
 * Reads from the V7 views (`pitch_performance`, `channel_performance`) plus
 * a couple of ad-hoc aggregates for the overall funnel / per-campaign table.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';

import { query } from '../db/client';
import { ok } from '../lib/response';

const router = Router();

router.get(
  '/api/analytics/funnel',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const funnel = await query(
        `
        SELECT
          COUNT(*) FILTER (WHERE p.status = 'DISCOVERED')     AS discovered,
          COUNT(*) FILTER (WHERE p.status = 'ENRICHED')       AS enriched,
          COUNT(*) FILTER (WHERE p.status = 'CONTACTED')      AS contacted,
          COUNT(*) FILTER (WHERE p.status = 'REPLIED')        AS replied,
          COUNT(*) FILTER (WHERE p.status = 'MEETING_BOOKED') AS meeting_booked
        FROM prospects p
        JOIN campaigns c ON c.id = p.campaign_id
        WHERE c.status = 'ACTIVE'
        `,
      );

      const opened = await query<{ opened: string }>(
        `
        SELECT COUNT(*)::text AS opened
        FROM messages m
        JOIN campaigns c ON c.id = m.campaign_id
        WHERE c.status = 'ACTIVE'
          AND m.direction = 'outbound'
          AND m.status IN ('OPENED','REPLIED')
        `,
      );

      const channel = await query(`SELECT * FROM channel_performance`);
      const pitch = await query(`SELECT * FROM pitch_performance`);

      return ok(res, {
        funnel: {
          ...(funnel.rows[0] ?? {}),
          opened: Number(opened.rows[0]?.opened ?? 0),
        },
        channel_performance: channel.rows,
        pitch_performance: pitch.rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/analytics/campaigns',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `
        SELECT
          c.id,
          c.name,
          c.status,
          c.created_at,
          COALESCE(p.total_prospects, 0)::int   AS total_prospects,
          COALESCE(p.contacted, 0)::int         AS contacted,
          COALESCE(p.replied, 0)::int           AS replied,
          COALESCE(p.meetings, 0)::int          AS meetings,
          ROUND(
            COALESCE(p.replied, 0)::numeric
            / NULLIF(COALESCE(p.contacted, 0), 0) * 100, 1
          )                                     AS reply_rate_pct,
          ROUND(
            COALESCE(p.meetings, 0)::numeric
            / NULLIF(COALESCE(p.contacted, 0), 0) * 100, 1
          )                                     AS meeting_rate_pct
        FROM campaigns c
        LEFT JOIN (
          SELECT
            campaign_id,
            COUNT(*) AS total_prospects,
            COUNT(*) FILTER (WHERE status = 'CONTACTED')      AS contacted,
            COUNT(*) FILTER (WHERE status = 'REPLIED')        AS replied,
            COUNT(*) FILTER (WHERE status = 'MEETING_BOOKED') AS meetings
          FROM prospects
          GROUP BY campaign_id
        ) p ON p.campaign_id = c.id
        ORDER BY c.created_at DESC
        `,
      );
      return ok(res, result.rows);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/analytics/pitch-performance',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(`SELECT * FROM pitch_performance`);
      return ok(res, result.rows);
    } catch (err) {
      next(err);
    }
  },
);

router.get(
  '/api/analytics/channels',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(`SELECT * FROM channel_performance`);
      return ok(res, result.rows);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// GET /api/analytics/meetings — recent meetings feed
// ---------------------------------------------------------------------------
router.get(
  '/api/analytics/meetings',
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await query(
        `
        SELECT
          m.id,
          m.scheduled_at,
          m.status,
          m.created_at,
          c.full_name             AS contact_name,
          c.title                 AS contact_title,
          p.company_name          AS company_name,
          camp.id                 AS campaign_id,
          camp.name               AS campaign_name,
          (
            SELECT msg.channel
            FROM messages msg
            WHERE msg.contact_id = c.id
              AND msg.direction = 'outbound'
              AND msg.status IN ('REPLIED','OPENED','SENT','DELIVERED')
            ORDER BY COALESCE(msg.sent_at, msg.created_at) DESC
            LIMIT 1
          )                       AS converted_channel
        FROM meetings m
        JOIN contacts  c    ON c.id  = m.contact_id
        JOIN prospects p    ON p.id  = m.prospect_id
        JOIN campaigns camp ON camp.id = m.campaign_id
        ORDER BY m.scheduled_at DESC NULLS LAST, m.created_at DESC
        LIMIT 50
        `,
      );
      return ok(res, result.rows);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
