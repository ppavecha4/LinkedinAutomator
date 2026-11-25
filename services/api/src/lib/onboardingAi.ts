/**
 * Which Anthropic key pays for an ONBOARDING AI call (decision 2026-11-14,
 * revised 2026-11-20: the platform pays FIRST, so a new customer gets the
 * AI help without connecting anything).
 *
 * 1. The platform's own key (ANTHROPIC_API_KEY), for at most
 *    ONBOARDING_AI_CAP calls per org, counted atomically in
 *    `organizations.onboarding_ai_calls`.
 * 2. Once that allowance is used up (or no platform key is configured):
 *    the org's own connected key, exactly like every other AI call
 *    (lib/providerKeys.ts; the operator org uses the .env key).
 * 3. Neither: 409 "connect your Anthropic account".
 *
 * Only the onboarding features use this (read website, AI summary, sample
 * message). Campaign generation, discovery and writing never fall back to
 * the platform key.
 */

import { query } from '../db/client';
import { env } from '../env';
import { ApiError } from './errors';
import { providerSecret } from './providerKeys';

export interface OnboardingKey {
  apiKey: string;
  source: 'org' | 'platform';
  /** Platform-paid calls left after this one (source 'platform' only). */
  remaining?: number;
}

export async function onboardingAiKey(): Promise<OnboardingKey> {
  const platformKey = process.env.ANTHROPIC_API_KEY ?? '';

  if (platformKey) {
    // Atomic: never more than the cap, even with concurrent requests. RLS
    // limits the UPDATE to the caller's own org row.
    const r = await query<{ used: number }>(
      `UPDATE organizations
          SET onboarding_ai_calls = onboarding_ai_calls + 1
        WHERE onboarding_ai_calls < $1
       RETURNING onboarding_ai_calls AS used`,
      [env.onboardingAiCap],
    );
    if (r.rowCount && r.rowCount > 0) {
      return { apiKey: platformKey, source: 'platform', remaining: env.onboardingAiCap - r.rows[0].used };
    }
  }

  try {
    return { apiKey: await providerSecret('anthropic'), source: 'org' };
  } catch (e) {
    // Only "not connected" becomes the friendly message; anything else
    // (vault misconfigured, decrypt failure) is a real error.
    const missing = (e as ApiError).details as { missing?: string[] } | undefined;
    if (!(e instanceof ApiError) || e.status !== 409 || !missing?.missing) throw e;
  }
  if (!platformKey) throw ApiError.conflict('connect your Anthropic (AI model) account first', { missing: ['anthropic'] });
  throw ApiError.conflict(
    'the free onboarding AI allowance is used up; connect your Anthropic (AI model) account to continue',
    { missing: ['anthropic'], allowance: env.onboardingAiCap },
  );
}
