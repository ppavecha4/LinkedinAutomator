/**
 * The org's workspace: entitlement (channels), connected accounts and the
 * provider catalogue the Connect page renders (SaaS phase 2, slice 2.5).
 *
 * Secret/meta field names here are the contract with the senders that
 * will read them (orchestrator db/provider_keys.py → provider_secret()):
 * anthropic/apollo use secret.api_key today; email and WhatsApp senders
 * switch to these fields when sending from customer accounts ships.
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
    subtitle: 'Google Workspace, any SMTP server, or Amazon SES',
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
          { key: 'port', label: 'Port', type: 'number', placeholder: '587' },
          { key: 'username', label: 'Username' },
          { key: 'password', label: 'Password', secret: true, type: 'password' },
        ],
      },
      {
        id: 'ses',
        name: 'Amazon SES',
        summary: 'from_email',
        fields: [
          { key: 'from_email', label: 'Verified sending address', type: 'email' },
          { key: 'from_name', label: 'Sender name', optional: true },
          { key: 'region', label: 'AWS region', placeholder: 'eu-west-1' },
          { key: 'access_key_id', label: 'Access key ID', secret: true },
          { key: 'secret_access_key', label: 'Secret access key', secret: true, type: 'password' },
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
          { key: 'whatsapp_from', label: 'WhatsApp number', placeholder: '+51 987 654 321' },
          { key: 'auth_token', label: 'Auth token', secret: true, type: 'password' },
        ],
      },
    ],
  },
  {
    id: 'voice',
    title: 'AI phone calls',
    subtitle: 'A phone number from your carrier',
    why: 'Calls will use our own voice engine with your number.',
    channel: 'voice',
    providers: [],
    comingSoon: true,
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
  voice: ['voice'],
};

/** The live (not revoked) credential for any of these providers. */
export function connectedFor(creds: Credential[] | undefined, providers: string[]): Credential | undefined {
  return (creds ?? []).find((c) => providers.includes(c.provider) && c.has_secret && c.status !== 'REVOKED');
}
