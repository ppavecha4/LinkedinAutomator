/**
 * A small client for the parts of Meta's Graph API that connecting WhatsApp needs (slice 10.2):
 * swapping Embedded Signup's one-time code for a token, reading the company's WhatsApp Business
 * account and number, registering the number for the Cloud API, and subscribing our app to the
 * account's events. Templates and sending come in slices 10.3-10.4 and reuse `graph()`.
 *
 * Secrets: the app secret and every token are sent only to graph.facebook.com and are scrubbed from
 * any message that could reach a log or a screen.
 */

import { env } from '../env';

const TIMEOUT_MS = 15_000;

interface Hooks { fetch: typeof fetch }
let hooks: Hooks = { fetch: (...a) => fetch(...a) };
/** Tests replace the network; production never calls this. */
export function setMetaGraphHooks(h?: Partial<Hooks>): void {
  hooks = { fetch: (...a) => fetch(...a), ...h };
}

/** Embedded Signup is on only when the app, its secret and the sign-up configuration are all set. */
export function metaSignupEnabled(): boolean {
  return !!(env.metaAppId && env.metaAppSecret && env.metaEmbeddedSignupConfigId);
}

export class MetaGraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly transient = false) {
    super(message);
  }
}

interface GraphOptions { token?: string; query?: Record<string, string>; body?: Record<string, unknown> }

function scrub(text: string, ...secrets: Array<string | undefined>): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('•••');
  return out.slice(0, 300);
}

/** One call to the Graph API. Throws MetaGraphError with a message that is safe to show. */
export async function graph(method: 'GET' | 'POST' | 'DELETE', path: string, opts: GraphOptions = {}): Promise<Record<string, unknown>> {
  const url = new URL(`https://graph.facebook.com/${env.metaGraphVersion}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  let r: Response;
  try {
    r = await hooks.fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new MetaGraphError('Could not reach Meta: try again in a minute.', 0, undefined, true);
  }
  const text = await r.text();
  let data: Record<string, unknown> = {};
  try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
  if (r.ok) return data;

  const err = (data.error ?? {}) as { message?: string; code?: number; error_user_msg?: string };
  if (err.code === 190 && opts.token) {
    throw new MetaGraphError('Meta no longer accepts this WhatsApp connection: connect WhatsApp again in Connected accounts.', r.status, 190);
  }
  const detail = scrub(String(err.error_user_msg ?? err.message ?? ''), opts.token, env.metaAppSecret);
  if (r.status === 429 || r.status >= 500 || err.code === 4 || err.code === 17 || err.code === 80007) {
    throw new MetaGraphError('Meta is busy right now: try again in a minute.', r.status, err.code, true);
  }
  throw new MetaGraphError(detail || `Meta answered ${r.status}.`, r.status, err.code);
}

// ── Embedded Signup ──

/** The one-time code Embedded Signup hands the browser → the company's business token. */
export async function exchangeCode(code: string): Promise<string> {
  const d = await graph('GET', '/oauth/access_token', {
    query: { client_id: env.metaAppId, client_secret: env.metaAppSecret, code },
  });
  const token = typeof d.access_token === 'string' ? d.access_token : '';
  if (!token) throw new MetaGraphError('Meta did not return an access token: try connecting again.', 502);
  return token;
}

export interface PhoneNumberInfo { id: string; display_phone_number: string; verified_name: string; quality_rating?: string }

/** The numbers of a WhatsApp Business account (proves the account and number belong together). */
export async function listPhoneNumbers(token: string, wabaId: string): Promise<PhoneNumberInfo[]> {
  const d = await graph('GET', `/${wabaId}/phone_numbers`, { token, query: { fields: 'id,display_phone_number,verified_name,quality_rating' } });
  const rows = Array.isArray(d.data) ? (d.data as Array<Record<string, unknown>>) : [];
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    display_phone_number: String(r.display_phone_number ?? ''),
    verified_name: String(r.verified_name ?? ''),
    quality_rating: typeof r.quality_rating === 'string' ? r.quality_rating : undefined,
  })).filter((r) => r.id);
}

/** Registers the number for the Cloud API with a two-step PIN (kept in the vault to re-register later). */
export async function registerNumber(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await graph('POST', `/${phoneNumberId}/register`, { token, body: { messaging_product: 'whatsapp', pin } });
}

/** Subscribes our app to the account's events (replies, delivery, template status: slice 10.5). */
export async function subscribeApp(token: string, wabaId: string): Promise<void> {
  await graph('POST', `/${wabaId}/subscribed_apps`, { token });
}

// ── Message templates (slice 10.3) ──

export interface CreatedTemplate { id: string; status: string }

/** Sends one text template to Meta for approval. The sample values are required for the two variables. */
export async function createMessageTemplate(
  token: string, wabaId: string,
  t: { name: string; language: string; category: string; body: string },
): Promise<CreatedTemplate> {
  const d = await graph('POST', `/${wabaId}/message_templates`, {
    token,
    body: {
      name: t.name,
      language: t.language,
      category: t.category,
      // Let Meta file it under the category it thinks fits instead of rejecting a marketing/utility mismatch.
      allow_category_change: true,
      components: [{ type: 'BODY', text: t.body, example: { body_text: [['Ana', 'Acme']] } }],
    },
  });
  const id = d.id === undefined || d.id === null ? '' : String(d.id);
  if (!id) throw new MetaGraphError('Meta did not return a template id: try again.', 502, undefined, true);
  return { id, status: typeof d.status === 'string' ? d.status : 'PENDING' };
}

export interface TemplateState { status: string; rejected_reason: string | null }

export async function getMessageTemplate(token: string, templateId: string): Promise<TemplateState> {
  const d = await graph('GET', `/${templateId}`, { token, query: { fields: 'status,rejected_reason' } });
  return {
    status: typeof d.status === 'string' ? d.status : 'PENDING',
    rejected_reason: typeof d.rejected_reason === 'string' ? d.rejected_reason : null,
  };
}
