/**
 * "Verify" for connected accounts (SaaS phase 3, slice 3.4): one real,
 * read-only call to the provider with the customer's credential.
 *
 *   anthropic         GET /v1/models               (API key accepted?)
 *   apollo            GET /v1/auth/health          (is_logged_in)
 *   twilio            GET /Accounts/{sid}.json     (SID + token, account active)
 *   google_workspace  SMTP login, smtp.gmail.com:587 STARTTLS
 *   smtp              SMTP login to the customer's server — only after its
 *                     name resolves exclusively to public addresses, and the
 *                     connection goes to the address we checked (no DNS
 *                     rebinding between check and connect). Ports 25, 465,
 *                     587, 2525 only.
 *
 * Nothing is sent. Error text shown to the customer never includes the
 * secret. Tests replace the network with setCredentialCheckHooks().
 */

import { lookup } from 'dns/promises';
import nodemailer from 'nodemailer';

import { isPrivateAddress } from './websiteReader';

export interface CheckResult {
  ok: boolean;
  /** Why it failed, in words the customer can act on. */
  error?: string;
}

export interface SmtpTarget {
  host: string;          // address to connect to (an IP for customer servers)
  servername: string;    // name to verify the TLS certificate against
  port: number;
  user: string;
  pass: string;
}

interface Hooks {
  fetch: typeof fetch;
  resolve: (host: string) => Promise<string[]>;
  smtpVerify: (t: SmtpTarget) => Promise<void>;
}

const defaults: Hooks = {
  fetch: (...a) => fetch(...a),
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address),
  smtpVerify: async (t) => {
    const transport = nodemailer.createTransport({
      host: t.host,
      port: t.port,
      secure: t.port === 465,
      requireTLS: t.port !== 465 && t.port !== 25,
      auth: { user: t.user, pass: t.pass },
      tls: { servername: t.servername },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  },
};
let hooks: Hooks = defaults;

export function setCredentialCheckHooks(h: Partial<Hooks>): void {
  hooks = { ...defaults, ...h };
}

/** Providers this module can check. */
export const CHECKABLE = new Set(['anthropic', 'apollo', 'twilio', 'google_workspace', 'smtp']);

export const SMTP_PORTS = new Set([25, 465, 587, 2525]);
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TIMEOUT_MS = 10_000;

type Strings = Record<string, string>;
type Meta = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Strip anything that could echo a secret back, and keep it short. */
function clean(message: string, secret: Strings): string {
  let m = message;
  for (const v of Object.values(secret)) if (v && v.length >= 4) m = m.split(v).join('•••');
  return m.replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function http(url: string, init: RequestInit): Promise<Response> {
  return hooks.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function checkAnthropic(secret: Strings): Promise<CheckResult> {
  const r = await http('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': secret.api_key ?? '', 'anthropic-version': '2023-06-01' },
  });
  if (r.ok) return { ok: true };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Anthropic rejected this API key.' };
  return { ok: false, error: `Anthropic answered ${r.status}; try again in a minute.` };
}

async function checkApollo(secret: Strings): Promise<CheckResult> {
  const r = await http('https://api.apollo.io/v1/auth/health', {
    headers: { 'X-Api-Key': secret.api_key ?? '', 'Cache-Control': 'no-cache' },
  });
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'Apollo rejected this API key.' };
  if (!r.ok) return { ok: false, error: `Apollo answered ${r.status}; try again in a minute.` };
  const body = (await r.json().catch(() => ({}))) as { is_logged_in?: boolean };
  return body.is_logged_in ? { ok: true } : { ok: false, error: 'Apollo did not accept this API key.' };
}

async function checkTwilio(secret: Strings, meta: Meta): Promise<CheckResult> {
  const sid = str(meta.account_id);
  if (!/^AC[0-9a-fA-F]{32}$/.test(sid)) return { ok: false, error: 'The Account SID must start with AC and have 34 characters.' };
  const from = str(meta.whatsapp_from).replace(/^whatsapp:/i, '').replace(/[\s()-]/g, '');
  if (!/^\+[1-9]\d{6,14}$/.test(from)) return { ok: false, error: 'Give the WhatsApp number in international format, e.g. +51987654321.' };
  const auth = Buffer.from(`${sid}:${secret.auth_token ?? ''}`).toString('base64');
  const r = await http(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    return { ok: false, error: 'Twilio rejected this Account SID and auth token.' };
  }
  if (!r.ok) return { ok: false, error: `Twilio answered ${r.status}; try again in a minute.` };
  const body = (await r.json().catch(() => ({}))) as { status?: string };
  if (body.status && body.status !== 'active') return { ok: false, error: `This Twilio account is ${body.status}.` };
  return { ok: true };
}

/** The customer's SMTP server, checked to be public before we connect. */
export async function resolvePublicSmtp(meta: Meta): Promise<{ host: string; ip: string; port: number } | CheckResult> {
  const host = str(meta.host).toLowerCase().replace(/\.$/, '');
  const port = Number(str(meta.port) || 587);
  if (!HOSTNAME.test(host)) return { ok: false, error: 'Give the mail server as a name, e.g. smtp.yourprovider.com.' };
  if (!SMTP_PORTS.has(port)) return { ok: false, error: 'Use port 587, 465, 2525 or 25.' };
  let ips: string[];
  try {
    ips = await hooks.resolve(host);
  } catch {
    return { ok: false, error: `Could not find the mail server ${host}.` };
  }
  if (!ips.length || ips.some(isPrivateAddress)) {
    return { ok: false, error: `${host} is not a public mail server.` };
  }
  return { host, ip: ips[0], port };
}

async function checkSmtp(provider: string, secret: Strings, meta: Meta): Promise<CheckResult> {
  let target: SmtpTarget;
  if (provider === 'google_workspace') {
    const email = str(meta.email);
    if (!email.includes('@')) return { ok: false, error: 'Give the sending address.' };
    target = { host: 'smtp.gmail.com', servername: 'smtp.gmail.com', port: 587, user: email, pass: secret.app_password ?? '' };
  } else {
    const r = await resolvePublicSmtp(meta);
    if ('ok' in r) return r;
    target = { host: r.ip, servername: r.host, port: r.port, user: str(meta.username), pass: secret.password ?? '' };
  }
  try {
    await hooks.smtpVerify(target);
    return { ok: true };
  } catch (e) {
    const err = e as { responseCode?: number; code?: string; message?: string };
    if (err.responseCode === 535 || err.code === 'EAUTH') {
      return {
        ok: false,
        error: provider === 'google_workspace'
          ? 'Google rejected the address or app password. Use an app password, not your normal password.'
          : 'The mail server rejected the username or password.',
      };
    }
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNECTION' || err.code === 'ESOCKET') {
      return { ok: false, error: 'Could not reach the mail server on that port.' };
    }
    return { ok: false, error: clean(`The mail server said: ${err.message ?? 'unknown error'}`, secret) };
  }
}

/** Check one credential. Returns null when the provider can't be checked. */
export async function checkCredential(provider: string, secret: Strings, meta: Meta): Promise<CheckResult | null> {
  try {
    switch (provider) {
      case 'anthropic': return await checkAnthropic(secret);
      case 'apollo': return await checkApollo(secret);
      case 'twilio': return await checkTwilio(secret, meta);
      case 'google_workspace':
      case 'smtp': return await checkSmtp(provider, secret, meta);
      default: return null;
    }
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: 'The provider did not answer in time; try again.' };
    return { ok: false, error: clean(`Could not check this account: ${(e as Error)?.message ?? 'unknown error'}`, secret) };
  }
}
