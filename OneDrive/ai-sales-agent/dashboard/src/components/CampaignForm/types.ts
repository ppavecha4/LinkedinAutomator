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
