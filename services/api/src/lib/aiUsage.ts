/**
 * What every AI call cost (slice 8.1). TypeScript counterpart of
 * services/orchestrator/src/ai_usage.py: one row per call in `ai_usage` (V33),
 * priced by the DATABASE from `ai_prices`, so this file only reports tokens.
 *
 * Recording must never break the request that triggered it: failures are logged
 * and swallowed. It writes inside the current tenant (the request's company), so
 * it does nothing outside one.
 *
 * `key_source` is 'platform' when the call used the platform's own Anthropic key
 * (ANTHROPIC_API_KEY) and 'org' when it used a key the company connected. Budgets
 * and the platform's profit count only 'platform'.
 */

import { query } from '../db/client';
import { logger } from '../logger';
import { currentTenant } from './tenantContext';

/** The `usage` object of an Anthropic response (every field optional). */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

const n = (v: unknown): number => {
  const x = Math.trunc(Number(v ?? 0));
  return Number.isFinite(x) && x > 0 ? x : 0;
};

export function usageNumbers(u: AnthropicUsage | null | undefined) {
  return {
    input_tokens: n(u?.input_tokens),
    output_tokens: n(u?.output_tokens),
    cache_read_tokens: n(u?.cache_read_input_tokens),
    cache_write_tokens: n(u?.cache_creation_input_tokens),
    web_searches: n(u?.server_tool_use?.web_search_requests),
  };
}

/** 'platform' when `apiKey` is the platform's own key, else 'org'. */
export function keySourceFor(apiKey: string | undefined): 'platform' | 'org' {
  const platform = (process.env.ANTHROPIC_API_KEY ?? '').trim();
  return platform && (apiKey ?? '').trim() === platform ? 'platform' : 'org';
}

export async function recordAiUsage(
  feature: string,
  model: string,
  usage: AnthropicUsage | null | undefined,
  opts: { apiKey?: string; keySource?: 'platform' | 'org'; campaignId?: string } = {},
): Promise<void> {
  try {
    if (!currentTenant() || !usage) return;
    const u = usageNumbers(usage);
    if (!Object.values(u).some((v) => v > 0)) return;
    await query(
      `INSERT INTO ai_usage (campaign_id, feature, model, key_source, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens, web_searches)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [opts.campaignId ?? null, feature.slice(0, 40), model.slice(0, 80), opts.keySource ?? keySourceFor(opts.apiKey),
        u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.web_searches],
    );
  } catch (e) {
    logger.warn('could not record AI usage', { feature, error: (e as Error).message });
  }
}

export interface AiUsageMonth {
  period_start: string;
  /** What the platform paid this month for this company, in US dollars. */
  platform_cost_usd: number;
  /** What this company's own Anthropic key paid (not our cost), in US dollars. */
  own_key_cost_usd: number;
  calls: number;
  web_searches: number;
  /** The plan's monthly budget for platform-paid AI in US dollars; null = unlimited. */
  budget_usd: number | null;
  /** The platform's own AI account is configured, so companies need not connect one. */
  managed: boolean;
  /** This month's platform-paid AI has reached the plan's budget. */
  exhausted: boolean;
}

/** True when the platform has its own Anthropic key (managed AI). */
export const platformAiConfigured = (): boolean => !!(process.env.ANTHROPIC_API_KEY ?? '').trim();

interface UsageRow {
  period_start: Date | string; platform_cost_micros: string; own_key_cost_micros: string;
  calls: string; web_searches: string; budget_micros: string | null;
}

const usd = (micros: string | number | null): number => Math.round(Number(micros ?? 0)) / 1e6;

export async function getAiUsageMonth(orgId: string): Promise<AiUsageMonth> {
  const r = (await query<UsageRow>(`SELECT * FROM org_ai_usage($1)`, [orgId])).rows[0];
  const platformCost = Math.round(Number(r?.platform_cost_micros ?? 0));
  const budget = r?.budget_micros == null ? null : Math.round(Number(r.budget_micros));
  return {
    period_start: new Date(r?.period_start ?? Date.now()).toISOString(),
    platform_cost_usd: usd(platformCost),
    own_key_cost_usd: usd(r?.own_key_cost_micros ?? 0),
    calls: Number(r?.calls ?? 0),
    web_searches: Number(r?.web_searches ?? 0),
    budget_usd: budget === null ? null : usd(budget),
    managed: platformAiConfigured(),
    exhausted: budget !== null && platformCost >= budget,
  };
}
