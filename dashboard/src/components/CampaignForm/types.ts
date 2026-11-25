/**
 * Shared wizard-state type — the draft the user is building before submit.
 */

import type { Channel } from '../../lib/types';

export interface WizardSequenceStep {
  day: number;
  channel: Channel;
  action: string;
  note?: string;
}

export interface WizardDraft {
  // Step 1 — Basics
  name: string;
  goal: string;
  customGoal?: string;
  sender_name: string;
  sender_company: string;
  value_proposition: string;
  tone: 'professional' | 'consultative' | 'direct' | 'friendly';

  // Step 2 — ICP
  industries: string[];
  company_sizes: string[];
  countries: string[];
  titles: string[];
  intent_keywords: string[];

  // Step 3 — Sequence
  channels_enabled: Channel[];
  sequence: WizardSequenceStep[];
  daily_limits: { email: number; linkedin: number; whatsapp: number };
  batch_size: number;

  // Step 4 — Review: link to a Heyreach campaign (LinkedIn SaaS sender).
  // Optional. When set, our orchestrator pushes LinkedIn leads into this
  // Heyreach campaign and Heyreach owns the actual outreach.
  heyreach_campaign_id?: string | null;
}

export const INITIAL_DRAFT: WizardDraft = {
  name: '',
  goal: 'Book discovery calls',
  customGoal: '',
  sender_name: '',
  sender_company: '',
  value_proposition: '',
  tone: 'consultative',

  industries: [],
  company_sizes: [],
  countries: [],
  titles: [],
  intent_keywords: [],

  channels_enabled: ['email', 'linkedin'],
  sequence: [
    { day: 1, channel: 'linkedin', action: 'Connection request', note: 'personalised note' },
    { day: 3, channel: 'email', action: 'Intro', note: 'AI-generated per prospect' },
    { day: 7, channel: 'email', action: 'Follow-up 1', note: 'based on reply signal' },
    { day: 12, channel: 'linkedin', action: 'DM follow-up', note: 'only if connected' },
  ],
  daily_limits: { email: 100, linkedin: 20, whatsapp: 0 },
  batch_size: 500,

  heyreach_campaign_id: null,
};

export const INDUSTRY_OPTIONS = [
  'Logistics',
  'Manufacturing',
  'Financial Services',
  'Healthcare',
  'Retail',
  'Professional Services',
  'SaaS',
  'Fintech',
  'Insurance',
  'Real Estate',
  'Education',
  'Media & Advertising',
];

export const COMPANY_SIZE_OPTIONS = ['51-200', '201-500', '501-1000', '1000+'];

export const COUNTRY_GROUPS: Record<string, string[]> = {
  'North America': ['United States', 'Canada', 'Mexico'],
  Europe: ['United Kingdom', 'Germany', 'France', 'Netherlands', 'Spain', 'Ireland'],
  'APAC': ['India', 'Singapore', 'Australia', 'Japan', 'UAE'],
  'Latin America': ['Brazil', 'Argentina', 'Chile', 'Colombia'],
};

export const TITLE_SUGGESTIONS = [
  'CEO',
  'COO',
  'CTO',
  'CIO',
  'VP Operations',
  'VP Engineering',
  'Head of Digital Transformation',
  'Director of Operations',
  'Chief Data Officer',
];

export const INTENT_SUGGESTIONS = [
  'AI engineer',
  'digital transformation',
  'SAP',
  'RPA',
  'ML platform',
  'process automation',
];

export const GOAL_OPTIONS = [
  'Book discovery calls',
  'Demo requests',
  'Partnership',
  'Custom',
];

export const TONE_OPTIONS: Array<{
  value: WizardDraft['tone'];
  label: string;
  description: string;
  recommended?: boolean;
}> = [
  { value: 'professional', label: 'Professional', description: 'Formal, respectful' },
  {
    value: 'consultative',
    label: 'Consultative',
    description: 'Advisory, insight-led',
    recommended: true,
  },
  { value: 'direct', label: 'Direct', description: 'Concise, no fluff' },
  { value: 'friendly', label: 'Friendly', description: 'Warm, conversational' },
];

/**
 * Reverse of `buildPayload()` — transforms a fetched campaign (which
 * includes the campaign row + sequence_steps) back into a WizardDraft so
 * the edit-mode form can prefill from the API response. Used by the
 * /campaigns/:id/edit route.
 *
 * Field-by-field defaulting falls back to the same values `INITIAL_DRAFT`
 * uses, so a campaign that's missing optional sub-fields (e.g. an
 * older row without `intent_keywords`) still renders cleanly.
 */
export function campaignToDraft(
  campaign: {
    name?: string;
    goal?: string;
    tone?: string;
    sender_name?: string;
    sender_company?: string;
    value_proposition?: string;
    icp_criteria?: Record<string, unknown>;
    daily_limits?: { email?: number; linkedin?: number; whatsapp?: number };
    batch_size?: number;
    heyreach_campaign_id?: string | null;
    sequence_steps?: Array<{
      step_number: number;
      channel: 'email' | 'linkedin' | 'whatsapp';
      action: string;
      delay_days: number;
    }>;
  },
): WizardDraft {
  const icp = (campaign.icp_criteria || {}) as Record<string, unknown>;
  const limits = campaign.daily_limits || {};
  const knownGoals = GOAL_OPTIONS.filter((g) => g !== 'Custom');
  const goal = campaign.goal || INITIAL_DRAFT.goal;
  const isKnownGoal = knownGoals.includes(goal);

  // Channels enabled = the union of channels referenced in any step.
  // If sequence_steps is missing, fall back to the INITIAL_DRAFT defaults.
  const steps = campaign.sequence_steps ?? [];
  const channelsEnabled = Array.from(
    new Set(steps.map((s) => s.channel)),
  ) as WizardDraft['channels_enabled'];

  return {
    name: campaign.name ?? '',
    goal: isKnownGoal ? goal : 'Custom',
    customGoal: isKnownGoal ? '' : goal,
    sender_name: campaign.sender_name ?? '',
    sender_company: campaign.sender_company ?? '',
    value_proposition: campaign.value_proposition ?? '',
    tone:
      (campaign.tone as WizardDraft['tone']) ||
      INITIAL_DRAFT.tone,

    industries: (icp.industries as string[]) ?? [],
    company_sizes: (icp.company_sizes as string[]) ?? [],
    countries: (icp.countries as string[]) ?? [],
    titles: (icp.titles as string[]) ?? [],
    intent_keywords:
      (icp.intent_keywords as string[]) ??
      (icp.apollo_keywords as string[]) ??
      [],

    channels_enabled:
      channelsEnabled.length > 0
        ? channelsEnabled
        : INITIAL_DRAFT.channels_enabled,
    sequence:
      steps.length > 0
        ? steps
            .slice()
            .sort((a, b) => a.step_number - b.step_number)
            .map((s) => ({
              // delay_days = days FROM launch; the wizard tracks `day`
              // as a 1-indexed campaign day, so day = delay_days + 1.
              day: (s.delay_days ?? 0) + 1,
              channel: s.channel,
              action: s.action || 'send',
            }))
        : INITIAL_DRAFT.sequence,
    daily_limits: {
      email: limits.email ?? INITIAL_DRAFT.daily_limits.email,
      linkedin: limits.linkedin ?? INITIAL_DRAFT.daily_limits.linkedin,
      whatsapp: limits.whatsapp ?? INITIAL_DRAFT.daily_limits.whatsapp,
    },
    batch_size: campaign.batch_size ?? INITIAL_DRAFT.batch_size,
    heyreach_campaign_id: campaign.heyreach_campaign_id ?? null,
  };
}
