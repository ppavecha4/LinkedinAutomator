/**
 * The business profile (SaaS phase 3) — types and option lists for the
 * onboarding wizard and Settings › Business profile. The API validates
 * every section strictly (services/api/src/lib/profile.ts); these types
 * mirror it.
 */

import { languageName, locale, regionName, t } from '../i18n';

export const TONES = ['professional', 'consultative', 'direct', 'friendly'] as const;
export type Tone = (typeof TONES)[number];

export const COMPANY_SIZES = ['1-50', '51-200', '201-500', '501-1000', '1000+'] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export const SIGNALS = ['new_markets', 'trade_fairs', 'hiring', 'funding', 'new_product', 'tenders'] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_LABELS: Record<Signal, string> = {
  new_markets: t('Expanding to new export markets'),
  trade_fairs: t('Exhibiting at a trade fair'),
  hiring: t('Hiring relevant staff'),
  funding: t('Recent funding or a new plant'),
  new_product: t('Launching a new product'),
  tenders: t('Publishing tenders'),
};

export const TONE_LABELS: Record<Tone, string> = {
  professional: t('Professional'),
  consultative: t('Consultative'),
  direct: t('Direct'),
  friendly: t('Friendly'),
};

export interface OfferItem {
  name: string;
  description?: string;
  typical_buyer?: string;
}

export interface ProofItem {
  text: string;
  may_mention: boolean;
}

export interface CompanySection {
  name?: string;
  legal_name?: string;
  address?: string;
  website?: string | null;
  industry?: string;
  size?: CompanySize;
  hq_country?: string;
  description?: string;
  languages_handled?: string[];
}

export interface OfferSection {
  offers?: OfferItem[];
  value_proposition?: string;
  proof?: ProofItem[];
  price_policy?: 'never' | 'starting_price';
}

export interface CustomersSection {
  industries?: string[];
  roles?: string[];
  company_sizes?: CompanySize[];
  countries?: string[];
  problems?: string;
  signals?: Signal[];
  never_contact?: string[];
}

export interface VoiceSection {
  tone?: Tone;
  formality?: 'formal' | 'informal';
  sender_name?: string;
  sender_title?: string;
  meeting_link?: string;
  avoid?: string[];
  example?: string;
}

export interface RulesSection {
  blocked_countries?: string[];
  contact_hours?: { start: string; end: string; weekdays_only: boolean };
}

export interface Profile {
  company: CompanySection;
  offer: OfferSection;
  customers: CustomersSection;
  voice: VoiceSection;
  rules: RulesSection;
  website_read_at?: string | null;
  updated_at?: string | null;
}

export type Section = 'company' | 'offer' | 'customers' | 'voice' | 'rules';

export interface Completeness {
  score: number;
  missing: Array<{ section: Section; item: string; hint: string }>;
}

export interface ProfileResponse {
  profile: Profile;
  completeness: Completeness;
  onboarding: { completed_at: string | null; ai_calls_used: number; ai_calls_cap: number };
}

export interface AiUse {
  source: 'org' | 'platform';
  /** Platform-paid calls left (only when source is 'platform'). */
  remaining?: number;
}

export interface Offering {
  name: string;
  description?: string | null;
  value_proposition: string;
  tone: Tone;
  icp: { titles: string[]; industries: string[]; company_sizes: CompanySize[]; countries: string[]; keywords: string[] };
  routing: {
    angles: Array<{ label: string; fits: string; lead_with: string; proof_points: string[] }>;
    cta: string;
    guardrails: string[];
  };
}

export interface Understanding {
  offering: Offering;
  suggested_channels: string[];
  suggested_languages: string[];
  campaign_goal: string;
  ai: AiUse;
}

// ── Countries and languages (names from the browser, in English) ───────

const ISO_COUNTRIES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const englishRegionNames = new Intl.DisplayNames(['en'], { type: 'region' });

/** The country's name on screen. */
export const countryName = regionName;

/** The English name, for values the server stores and searches with (never the screen language). */
export function englishCountryName(code: string): string {
  try {
    return englishRegionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export const COUNTRIES: Array<{ code: string; name: string }> = ISO_COUNTRIES
  .map((code) => ({ code, name: countryName(code) }))
  .sort((a, b) => a.name.localeCompare(b.name, locale()));

/** Languages the engine writes well in (orchestrator agents/language.py). */
export const LANGUAGES = [
  'en', 'es', 'pt', 'fr', 'de', 'it', 'nl', 'ar', 'hi', 'pl', 'sv', 'nb', 'da', 'fi', 'tr', 'id', 'vi', 'th',
  'ja', 'ko', 'zh', 'he',
] as const;

export { languageName };

export const EMPTY_PROFILE: Profile = { company: {}, offer: {}, customers: {}, voice: {}, rules: {} };

/** Drop empty strings / empty lists so a PUT never sends "" for an optional field. */
export function clean<T extends object>(section: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(section)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = typeof v === 'string' ? v.trim() : v;
  }
  return out as T;
}
