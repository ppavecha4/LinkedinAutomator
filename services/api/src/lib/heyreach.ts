/**
 * Heyreach client — minimal wrapper for the parts of Heyreach's REST API
 * that the platform uses during the campaign lifecycle.
 *
 * What the platform actually does with Heyreach:
 *   1. After an operator creates a platform campaign, the dashboard
 *      shows a "Pick a Heyreach campaign" dropdown populated by
 *      `listHeyreachCampaigns()`.
 *   2. The operator picks one (or creates a new one in Heyreach's UI
 *      and refreshes). The selected id is stored on the campaign row.
 *   3. The orchestrator's LinkedInHeyreachChannel + the
 *      send_drafts_to_heyreach.py script push leads to that campaign.
 *
 * Why NOT auto-create:
 *   Heyreach's public API exposes a /campaign/Create endpoint but the
 *   required payload couples to internal resources (list types,
 *   sequence templates, LinkedIn account assignments) that aren't
 *   reliably settable from outside their UI. After many probe calls
 *   on June 2026 we couldn't synthesize a payload that produced a
 *   USABLE campaign — even when /campaign/Create returned 200, the
 *   resulting Heyreach campaign was missing sequence config and
 *   couldn't accept leads until the operator opened it in Heyreach UI
 *   anyway. The dropdown-pick pattern skips that round-trip.
 *
 * Design contract:
 *   - NEVER throws on Heyreach errors. Every public function returns
 *     {ok: bool, …, error: string | null}. Callers decide what to
 *     surface.
 *   - 10-second timeout. If Heyreach is down we tell the operator.
 *   - Returns empty list when Heyreach isn't configured (no API key) —
 *     dashboard handles this as "no campaigns to pick".
 */

import { logger } from '../logger';

const HEYREACH_BASE = 'https://api.heyreach.io/api/public';
const REQUEST_TIMEOUT_MS = 10_000;

/** One campaign as returned by /campaign/GetAll, normalised for the
 *  dashboard. We surface only the fields the dropdown picker needs. */
export interface HeyreachCampaign {
  id: string;
  name: string;
  status: string;
  /** Number of LinkedIn accounts attached. 0 = not usable yet. */
  account_count?: number;
  created_at?: string;
}

export interface HeyreachListResult {
  ok: boolean;
  campaigns: HeyreachCampaign[];
  total: number;
  error: string | null;
  /** True when Heyreach is not configured (no API key). Callers should
   *  treat as "no campaigns" rather than "failed". */
  skipped: boolean;
}

/** True when the API service has Heyreach configured. */
export function isHeyreachConfigured(): boolean {
  return !!(process.env.HEYREACH_API_KEY || '').trim();
}

/**
 * Fetch the operator's Heyreach campaigns. Used by the dashboard's
 * Heyreach link panel to populate a dropdown picker.
 *
 * Heyreach's endpoint is paginated (offset + limit). We fetch up to
 * 100 — more than that and the picker becomes unusable anyway; the
 * dashboard's UX is "find the campaign you just created", not
 * "browse 500 historic campaigns".
 */
export async function listHeyreachCampaigns(): Promise<HeyreachListResult> {
  const apiKey = (process.env.HEYREACH_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, campaigns: [], total: 0, error: null, skipped: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const r = await fetch(`${HEYREACH_BASE}/campaign/GetAll`, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ offset: 0, limit: 100 }),
      signal: controller.signal,
    });

    if (!r.ok) {
      let body = '';
      try {
        body = (await r.text()).slice(0, 200);
      } catch {
        body = '';
      }
      logger.warn('heyreach listCampaigns non-2xx', { status: r.status, body });
      return {
        ok: false,
        campaigns: [],
        total: 0,
        error: `heyreach ${r.status}: ${body || 'no body'}`,
        skipped: false,
      };
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = (await r.json()) as Record<string, unknown>;
    } catch {
      payload = {};
    }

    const items = (payload.items as Array<Record<string, unknown>>) || [];
    const campaigns: HeyreachCampaign[] = items
      .filter((it) => it && (it.id !== undefined))
      .map((it) => ({
        id: String(it.id),
        name: String(it.name ?? '(unnamed)'),
        status: String(it.status ?? 'UNKNOWN'),
        account_count: typeof it.linkedInAccountIdsCount === 'number'
          ? (it.linkedInAccountIdsCount as number)
          : Array.isArray(it.linkedInAccountIds)
            ? (it.linkedInAccountIds as unknown[]).length
            : undefined,
        created_at:
          typeof it.creationTime === 'string'
            ? (it.creationTime as string)
            : undefined,
      }));

    return {
      ok: true,
      campaigns,
      total: typeof payload.totalCount === 'number'
        ? (payload.totalCount as number)
        : campaigns.length,
      error: null,
      skipped: false,
    };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    const msg = aborted ? 'heyreach API timeout (10s)' : (e as Error).message;
    logger.warn('heyreach listCampaigns exception', { message: msg });
    return {
      ok: false,
      campaigns: [],
      total: 0,
      error: msg,
      skipped: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
