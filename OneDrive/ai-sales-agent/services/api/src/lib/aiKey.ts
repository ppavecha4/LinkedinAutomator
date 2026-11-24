/**
 * Which Anthropic key pays for an AI call, one rule for the whole API (slice 8.2).
 *
 * 1. The operator organisation (AUTH_ORG_ID, the Appson deployment) uses the
 *    `.env` key and is never limited.
 * 2. A company that connected its OWN Anthropic account uses it: it pays for
 *    itself, nothing counts against its plan, and it needs nothing from us.
 * 3. Everyone else is on managed AI: the platform's key (ANTHROPIC_API_KEY),
 *    until this month's platform-paid AI reaches the plan's budget
 *    (plans.monthly_ai_budget_micros; NULL is unlimited). Then 402 PLAN_LIMIT:
 *    upgrade, wait for the new month, or connect your own account.
 * 4. No platform key configured and no own key: 409 "connect your account".
 *
 * Onboarding's setup helpers (lib/onboardingAi.ts) keep their own earlier rule:
 * the platform pays first for a few calls so a new company needs nothing at all.
 */

import { env } from '../env';
import { getAiUsageMonth, platformAiConfigured } from './aiUsage';
import { ApiError } from './errors';
import { getQuota } from './quota';
import { providerSecret } from './providerKeys';
import { currentTenant } from './tenantContext';

export interface AiKey {
  apiKey: string;
  /** 'platform' = our account (counts toward the budget); 'org' = the company's own. */
  source: 'platform' | 'org';
}

export async function resolveAiKey(): Promise<AiKey> {
  const orgId = currentTenant()?.orgId;
  if (!orgId) throw ApiError.internal('resolveAiKey() needs a tenant');

  if (orgId === env.authOrgId) return { apiKey: await providerSecret('anthropic'), source: 'platform' };

  try {
    return { apiKey: await providerSecret('anthropic'), source: 'org' };
  } catch (e) {
    // Only "not connected" falls through to managed AI; a broken vault is a real error.
    const missing = (e as ApiError).details as { missing?: string[] } | undefined;
    if (!(e instanceof ApiError) || e.status !== 409 || !missing?.missing) throw e;
  }

  if (!platformAiConfigured()) {
    throw ApiError.conflict('connect your Anthropic (AI model) account first', { missing: ['anthropic'] });
  }
  const usage = await getAiUsageMonth(orgId);
  if (usage.exhausted) {
    const q = await getQuota(orgId);
    throw ApiError.planLimit(
      `You have used all the AI included in your ${q.plan_label} plan this month. Upgrade your plan, wait for the new month, or connect your own Anthropic account to keep going.`,
      { kind: 'ai', plan: q.plan, used_usd: usage.platform_cost_usd, budget_usd: usage.budget_usd },
    );
  }
  return { apiKey: (process.env.ANTHROPIC_API_KEY ?? '').trim(), source: 'platform' };
}
