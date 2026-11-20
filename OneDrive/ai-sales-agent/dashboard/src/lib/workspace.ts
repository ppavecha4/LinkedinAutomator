/**
 * The org's workspace: entitlement (channels), connected accounts and the
 * provider catalogue the Connect page renders (SaaS phase 2, slice 2.5).
 *
 * Secret/meta field names here are the contract with the services that
 * read them: the API's "verify" (services/api/src/lib/credentialCheck.ts)
 * and the orchestrator's senders and reply poller
 * (services/orchestrator/src/db/accounts.py). Keep the three in step.
 */

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
    title: 'Email',
    subtitle: 'Google Workspace or your own mail server',
    why: 'Emails go out from your own mailbox, so replies come back to you.',
    channel: 'email',
    providers: [
      {
        id: 'google_workspace',
        name: 'Google Workspace',
        summary: 'email',
        fields: [
          { key: 'email', label: 'Sending address', type: 'email', placeholder: 'sales@yourcompany.com' },
          { key: 'from_name', label: 'Sender name', placeholder: 'Ana Torres', optional: true },
          { key: 'app_password', label: 'App password', secret: true, type: 'password', hint: 'Create one at myaccount.google.com › Security › App passwords (16 characters).' },
        ],
      },
      {
        id: 'smtp',
        name: 'Other mail server (SMTP)',
        summary: 'from_email',
        fields: [
          { key: 'from_email', label: 'Sending address', type: 'email', placeholder: 'sales@yourcompany.com' },
          { key: 'from_name', label: 'Sender name', optional: true },
          { key: 'host', label: 'SMTP server', placeholder: 'smtp.yourprovider.com' },
          { key: 'port', label: 'Port', type: 'number', placeholder: '587', hint: '587 (STARTTLS) or 465 (SSL).' },
          { key: 'username', label: 'Username' },
          { key: 'password', label: 'Password', secret: true, type: 'password' },
          { key: 'imap_host', label: 'IMAP server (to read replies)', placeholder: 'imap.yourprovider.com', optional: true,
            hint: 'Without it, replies and opt-outs sent to this mailbox are not picked up automatically.' },
        ],
      },
    ],
  },
  {
    id: 'whatsapp',
    title: 'WhatsApp',
    subtitle: 'Your Twilio WhatsApp sender',
    why: 'Messages come from your own WhatsApp business number.',
    channel: 'whatsapp',
    providers: [
      {
        id: 'twilio',
        name: 'Twilio',
        summary: 'whatsapp_from',
        fields: [
          { key: 'account_id', label: 'Account SID', placeholder: 'AC…', pattern: /^AC[0-9a-fA-F]{32}$/, patternMessage: 'An Account SID starts with AC and has 34 characters.' },
          { key: 'whatsapp_from', label: 'WhatsApp number', placeholder: '+51987654321', optional: true, hint: 'In international format, with the country code. Leave empty if you use Twilio only for calls.' },
          { key: 'voice_from', label: 'Phone number for calls', placeholder: '+51987654321', optional: true, hint: 'A number in your Twilio account that AI phone calls are made from. Leave empty if you do not use calls.' },
          { key: 'auth_token', label: 'Auth token', secret: true, type: 'password' },
          { key: 'template_sid', label: 'Approved first-message template (Content SID)', placeholder: 'HX…', optional: true,
            pattern: /^HX[0-9a-fA-F]{32}$/, patternMessage: 'A template Content SID starts with HX and has 34 characters.',
            hint: 'WhatsApp only lets businesses start a conversation with a Meta-approved template. Ours fills {{1}} with the first name and {{2}} with the company.' },
          { key: 'template_sids', label: 'Templates for other languages', placeholder: 'es=HX…, ar=HX…', optional: true, langPrefix: 'template_sid',
            hint: 'One per language your prospects get. Without a template for their language (and no default above), WhatsApp messages wait.' },
          { key: 'followup_template_sid', label: 'Follow-up template (Content SID)', placeholder: 'HX…', optional: true,
            pattern: /^HX[0-9a-fA-F]{32}$/, patternMessage: 'A template Content SID starts with HX and has 34 characters.',
            hint: 'A second approved template, used for WhatsApp follow-ups to people who have not replied (same {{1}} first name, {{2}} company). Without it, WhatsApp follow-ups wait.' },
          { key: 'followup_template_sids', label: 'Follow-up templates for other languages', placeholder: 'es=HX…, ar=HX…', optional: true, langPrefix: 'followup_template_sid' },
        ],
      },
    ],
  },
  {
    id: 'voice',
    title: 'AI phone calls',
    subtitle: 'An ElevenLabs voice and a Twilio number',
    why: 'An automated assistant calls people who agreed to calls or replied to you. It needs a voice (ElevenLabs), a phone number for calls (in your Twilio account, under WhatsApp above) and your AI key (below).',
    channel: 'voice',
    providers: [
      {
        id: 'elevenlabs',
        name: 'ElevenLabs',
        summary: 'voice_id',
        fields: [
          { key: 'api_key', label: 'API key', secret: true, type: 'password', hint: 'elevenlabs.io › Developers › API keys. Allow Text to Speech, Speech to Text and Voices.' },
          { key: 'voice_id', label: 'Voice ID', placeholder: 'e.g. 21m00Tcm4TlvDq8ikWAM', hint: 'The voice the assistant speaks with: copy its ID from your ElevenLabs voices.' },
          { key: 'voice_ids', label: 'Voices for other languages', placeholder: 'es=…, pt=…', optional: true, langPrefix: 'voice_id',
            hint: 'One voice per language, if you want a different voice for each. Others use the voice above.' },
        ],
      },
    ],
  },
  {
    id: 'linkedin',
    title: 'LinkedIn',
    subtitle: 'Heyreach',
    why: 'Connection requests and messages through your Heyreach workspace.',
    channel: 'linkedin',
    providers: [
      {
        id: 'heyreach',
        name: 'Heyreach',
        fields: [
          { key: 'linkedin_account_id', label: 'LinkedIn account ID (in Heyreach)', optional: true },
          { key: 'api_key', label: 'API key', secret: true, type: 'password' },
        ],
      },
    ],
  },
  {
    id: 'apollo',
    title: 'Lead search',
    subtitle: 'Apollo, for AI discovery',
    why: 'Only needed when the AI agent finds leads for you. Uploaded lists don’t use it.',
    providers: [{ id: 'apollo', name: 'Apollo', fields: [{ key: 'api_key', label: 'API key', secret: true, type: 'password', hint: 'app.apollo.io › Settings › Integrations › API keys.' }] }],
  },
  {
    id: 'anthropic',
    title: 'AI model',
    subtitle: 'Anthropic API key',
    why: 'Plans campaigns, researches prospects and writes every message.',
    providers: [{ id: 'anthropic', name: 'Anthropic', fields: [{ key: 'api_key', label: 'API key', secret: true, type: 'password', hint: 'console.anthropic.com › API keys.' }] }],
  },
];

export const CHANNEL_LABEL: Record<OrgChannel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  voice: 'AI phone calls',
  linkedin: 'LinkedIn',
};

/** Providers that make each channel usable (API lib/channels.ts CHANNEL_PROVIDERS). */
export const CHANNEL_PROVIDERS: Record<OrgChannel, string[]> = {
  email: ['google_workspace', 'smtp', 'ses'],
  whatsapp: ['twilio'],
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
