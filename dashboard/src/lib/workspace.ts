/**
 * The org's workspace: entitlement (channels), connected accounts and the
 * provider catalogue the Connect page renders (SaaS phase 2, slice 2.5).
 *
 * Secret/meta field names here are the contract with the services that
 * read them: the API's "verify" (services/api/src/lib/credentialCheck.ts)
 * and the orchestrator's senders and reply poller
 * (services/orchestrator/src/db/accounts.py). Keep the three in step.
 */

import { t } from '../i18n';

export type OrgChannel = 'email' | 'whatsapp' | 'voice' | 'linkedin';

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  channels: OrgChannel[];
  default_language: string;
  default_country: string | null;
  timezone: string;
  operator: boolean;
  /** How replies are answered (V40). */
  reply_mode?: 'off' | 'draft' | 'auto';
}

export type CredentialStatus = 'UNVERIFIED' | 'VERIFIED' | 'FAILED' | 'REVOKED';

export interface Credential {
  id: string;
  provider: string;
  label: string;
  meta: Record<string, string | number | boolean>;
  status: CredentialStatus;
  verified_at: string | null;
  last_checked_at: string | null;
  /** Why the last check failed, in words the customer can act on. */
  last_error: string | null;
  created_at: string;
  updated_at: string;
  has_secret: boolean;
}

export interface ProviderField {
  key: string;
  label: string;
  /** Secret fields are encrypted and never shown again. */
  secret?: boolean;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'email' | 'number' | 'password';
  optional?: boolean;
  /** Rarely needed: shown under "Advanced options" so the form stays short for most people. */
  advanced?: boolean;
  /**
   * "es=HX…, ar=HX…" in the form, stored as meta.<langPrefix>_es,
   * meta.<langPrefix>_ar (one Content SID per language).
   */
  langPrefix?: string;
  pattern?: RegExp;
  patternMessage?: string;
}

export interface Provider {
  id: string;
  name: string;
  fields: ProviderField[];
  /** meta field shown on the card once connected, e.g. the sender address. */
  summary?: string;
}

export interface AccountKind {
  id: string;
  title: string;
  subtitle: string;
  why: string;
  /** Channel this account serves (needs entitlement); none = always shown. */
  channel?: OrgChannel;
  providers: Provider[];
  comingSoon?: boolean;
}

export const ACCOUNT_KINDS: AccountKind[] = [
  {
    id: 'email',
    title: t('Email'),
    subtitle: t('Google Workspace or your own mail server'),
    why: t('Emails go out from your own mailbox, so replies come back to you.'),
    channel: 'email',
    providers: [
      {
        id: 'google_workspace',
        name: 'Google Workspace',
        summary: 'email',
        fields: [
          { key: 'email', label: t('Sending address'), type: 'email', placeholder: 'sales@yourcompany.com' },
          { key: 'from_name', label: t('Sender name'), placeholder: t('Ana Torres'), optional: true },
          { key: 'app_password', label: t('App password'), secret: true, type: 'password', hint: t('Create one at myaccount.google.com › Security › App passwords (16 characters).') },
        ],
      },
      {
        id: 'smtp',
        name: t('Other mail server (SMTP)'),
        summary: 'from_email',
        fields: [
          { key: 'from_email', label: t('Sending address'), type: 'email', placeholder: 'sales@yourcompany.com' },
          { key: 'from_name', label: t('Sender name'), optional: true },
          { key: 'host', label: t('SMTP server'), placeholder: 'smtp.yourprovider.com' },
          { key: 'port', label: t('Port'), type: 'number', placeholder: '587', hint: t('587 (STARTTLS) or 465 (SSL).') },
          { key: 'username', label: t('Username') },
          { key: 'password', label: t('Password'), secret: true, type: 'password' },
          { key: 'imap_host', label: t('IMAP server (to read replies)'), placeholder: 'imap.yourprovider.com', optional: true,
            hint: t('Without it, replies and opt-outs sent to this mailbox are not picked up automatically.') },
        ],
      },
    ],
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    subtitle: t('Your Twilio WhatsApp sender'),
    why: t('Messages come from your own WhatsApp business number. The messages themselves are written for you below, and approved by WhatsApp.'),
    channel: 'whatsapp',
    providers: [
      {
        id: 'twilio',
        name: 'Twilio',
        summary: 'whatsapp_from',
        fields: [
          { key: 'account_id', label: t('Account SID'), placeholder: 'AC…', pattern: /^AC[0-9a-fA-F]{32}$/, patternMessage: t('An Account SID starts with AC and has 34 characters.') },
          { key: 'whatsapp_from', label: t('WhatsApp number'), placeholder: '+51987654321', optional: true, hint: t('In international format, with the country code. Leave empty if you use Twilio only for calls.') },
          { key: 'voice_from', advanced: true, label: t('Phone number for calls'), placeholder: '+51987654321', optional: true, hint: t('A number in your Twilio account that AI phone calls are made from. Leave empty if you do not use calls.') },
          { key: 'auth_token', label: t('Auth token'), secret: true, type: 'password' },
          { key: 'template_sid', advanced: true, label: t('Approved first-message template (Content SID)'), placeholder: 'HX…', optional: true,
            pattern: /^HX[0-9a-fA-F]{32}$/, patternMessage: t('A template Content SID starts with HX and has 34 characters.'),
            hint: t('Optional. The AI writes these for you under “WhatsApp messages” and gets them approved: paste an ID here only if you already have your own approved template. Ours fills {{1}} with the first name and {{2}} with the company.') },
          { key: 'template_sids', advanced: true, label: t('Templates for other languages'), placeholder: t('es=HX…, ar=HX…'), optional: true, langPrefix: 'template_sid',
            hint: t('One per language your prospects get. Without a template for their language (and no default above), WhatsApp messages wait.') },
          { key: 'followup_template_sid', advanced: true, label: t('Follow-up template (Content SID)'), placeholder: 'HX…', optional: true,
            pattern: /^HX[0-9a-fA-F]{32}$/, patternMessage: t('A template Content SID starts with HX and has 34 characters.'),
            hint: t('Optional. The AI writes this too (under “WhatsApp messages”). Paste an ID only if you already have your own approved follow-up template ({{1}} first name, {{2}} company).') },
          { key: 'followup_template_sids', advanced: true, label: t('Follow-up templates for other languages'), placeholder: t('es=HX…, ar=HX…'), optional: true, langPrefix: 'followup_template_sid' },
        ],
      },
    ],
  },
  {
    id: 'voice',
    title: t('AI phone calls'),
    subtitle: t('An ElevenLabs voice and a Twilio number'),
    why: t('An automated assistant calls people who agreed to calls or replied to you. It needs a voice (ElevenLabs), a phone number for calls (in your Twilio account, under WhatsApp above) and your AI key (below).'),
    channel: 'voice',
    providers: [
      {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        summary: 'voice_id',
        fields: [
          { key: 'api_key', label: t('API key'), secret: true, type: 'password', hint: t('elevenlabs.io › Developers › API keys. Allow Text to Speech, Speech to Text and Voices.') },
          { key: 'voice_id', label: t('Voice ID'), placeholder: t('e.g. 21m00Tcm4TlvDq8ikWAM'), hint: t('The voice the assistant speaks with: copy its ID from your ElevenLabs voices.') },
          { key: 'voice_ids', label: t('Voices for other languages'), placeholder: t('es=…, pt=…'), optional: true, langPrefix: 'voice_id',
            hint: t('One voice per language, if you want a different voice for each. Others use the voice above.') },
        ],
      },
    ],
  },
  {
    id: 'linkedin',
    title: 'LinkedIn',
    subtitle: 'Heyreach',
    why: t('Connection requests and messages through your Heyreach workspace.'),
    channel: 'linkedin',
    providers: [
      {
        id: 'heyreach',
        name: 'Heyreach',
        fields: [
          { key: 'linkedin_account_id', label: t('LinkedIn account ID (in Heyreach)'), optional: true },
          { key: 'api_key', label: t('API key'), secret: true, type: 'password' },
        ],
      },
    ],
  },
  {
    id: 'apollo',
    title: t('Lead search'),
    subtitle: t('Apollo, for AI discovery'),
    why: t('Only needed when the AI agent finds leads for you. Uploaded lists don’t use it.'),
    providers: [{ id: 'apollo', name: 'Apollo', fields: [{ key: 'api_key', label: t('API key'), secret: true, type: 'password', hint: t('app.apollo.io › Settings › Integrations › API keys.') }] }],
  },
  {
    id: 'anthropic',
    title: t('AI model'),
    subtitle: t('Optional: your own Anthropic API key'),
    why: t('Writing is included in your plan. Connect your own account to go past the included AI, or to pay Anthropic directly: your usage then does not count against your plan.'),
    providers: [{ id: 'anthropic', name: 'Anthropic', fields: [{ key: 'api_key', label: t('API key'), secret: true, type: 'password', hint: t('console.anthropic.com › API keys.') }] }],
  },
];

export const CHANNEL_LABEL: Record<OrgChannel, string> = {
  email: t('Email'),
  whatsapp: 'WhatsApp',
  voice: t('AI phone calls'),
  linkedin: 'LinkedIn',
};

/** Providers that make each channel usable (API lib/channels.ts CHANNEL_PROVIDERS). */
export const CHANNEL_PROVIDERS: Record<OrgChannel, string[]> = {
  email: ['google_workspace', 'smtp', 'ses'],
  whatsapp: ['twilio', 'whatsapp_meta'],
  linkedin: ['heyreach'],
  voice: ['elevenlabs'],
};

/** The live (not revoked) credential for any of these providers — verified first. */
export function connectedFor(creds: Credential[] | undefined, providers: string[]): Credential | undefined {
  const live = (creds ?? []).filter((c) => providers.includes(c.provider) && c.has_secret && c.status !== 'REVOKED');
  return live.find((c) => c.status === 'VERIFIED') ?? live[0];
}

/** A verified account for any of these providers: what campaigns send through. */
export function verifiedFor(creds: Credential[] | undefined, providers: string[]): Credential | undefined {
  return (creds ?? []).find((c) => providers.includes(c.provider) && c.has_secret && c.status === 'VERIFIED');
}

/** Providers the API can check ("Verify"); others stay "saved, not checked". */
export const CHECKABLE = new Set(['anthropic', 'apollo', 'twilio', 'google_workspace', 'smtp', 'elevenlabs']);
