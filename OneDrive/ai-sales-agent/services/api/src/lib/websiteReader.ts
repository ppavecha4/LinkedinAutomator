/**
 * "Read my website" (onboarding): fetch a customer's homepage (+ one
 * about page), reduce it to text, and have the AI draft profile fields
 * from that text only.
 *
 * The URL is user input fetched by OUR server, so it is an SSRF vector.
 * Defences:
 *   - http/https only, default ports only, no credentials in the URL;
 *   - the hostname is resolved first and EVERY address must be public
 *     (no loopback, private, link-local/metadata, CGNAT, multicast,
 *     IPv6 ULA/link-local, IPv4-mapped private);
 *   - redirects are followed by hand (max 3), each hop re-checked;
 *   - HTML/text responses only, 1 MB cap, 8 s timeout, 2 pages max.
 * Residual risk: DNS rebinding between our lookup and fetch's own lookup;
 * acceptable for a public-website reader, revisit with a pinned-IP agent
 * if the API ever runs next to sensitive internal services.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { Agent, fetch as undiciFetch } from 'undici';

import { z } from 'zod';

import type { CallModel } from './offering';
import { extractJson } from './offering';
import { companySchema, offerSchema } from './profile';

export class WebsiteError extends Error {}

const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 15_000;

function ipv4Private(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||        // CGNAT
    (a === 169 && b === 254) ||                  // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||     // benchmarking
    a >= 224                                     // multicast / reserved
  );
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return ipv4Private(ip);
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  if (v6.startsWith('fc') || v6.startsWith('fd')) return true;          // ULA
  if (/^fe[89ab]/.test(v6)) return true;                                // link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return ipv4Private(mapped[1]);
  return false;
}

type Resolver = (host: string) => Promise<string[]>;
const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Validate a URL AND return the address we checked. The connection is then
 * pinned to that address (pinnedFetch), so a DNS answer that changes between
 * our check and the connection ("DNS rebinding": public when checked, the
 * metadata service when connected) cannot redirect the request.
 */
export async function resolveChecked(raw: string, resolve: Resolver = defaultResolver): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebsiteError('that is not a valid web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebsiteError('only http and https addresses');
  if (url.username || url.password) throw new WebsiteError('addresses with credentials are not allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new WebsiteError('only standard web ports');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new WebsiteError('that address is not a public website');
  }
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => {
    throw new WebsiteError('could not find that website');
  });
  if (addrs.length === 0 || addrs.some(isPrivateAddress)) throw new WebsiteError('that address is not a public website');
  return { url, address: addrs[0] };
}

export async function assertPublicUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  return (await resolveChecked(raw, resolve)).url;
}

/** Fetch a URL over a connection pinned to `address` (TLS is still verified against the URL's host name). */
export async function pinnedFetch(url: URL, init: RequestInit, address: string): Promise<Response> {
  const family = isIP(address) === 6 ? 6 : 4;
  const agent = new Agent({
    keepAliveTimeout: 1,
    connect: {
      lookup: (_host, options, cb) => {
        // Node passes {all: true} on some paths and expects a list back.
        if ((options as { all?: boolean } | undefined)?.all) (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
        else (cb as (e: null, a: string, f: number) => void)(null, address, family);
      },
    },
  });
  // The body is read after this returns; close the agent later, not now.
  setTimeout(() => void agent.close().catch(() => undefined), 60_000).unref();
  return (await undiciFetch(url.toString(), { ...(init as object), dispatcher: agent } as never)) as unknown as Response;
}

/** What safeFetch calls: `address` is the checked address to connect to. */
type Fetcher = (url: URL, init: RequestInit, address: string) => Promise<Response>;

/** Fetch one page safely; returns its HTML/text and final URL. */
export async function safeFetch(raw: string, opts: { fetchImpl?: Fetcher; resolve?: Resolver } = {}): Promise<{ url: URL; body: string }> {
  const fetchImpl = opts.fetchImpl ?? pinnedFetch;
  let { url, address } = await resolveChecked(raw, opts.resolve);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(url, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ProfileReader/1.0)', accept: 'text/html,text/plain' },
      }, address);
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new WebsiteError('the website redirected nowhere');
        // Every redirect hop is checked and pinned afresh.
        ({ url, address } = await resolveChecked(new URL(loc, url).toString(), opts.resolve));
        continue;
      }
      if (!r.ok) throw new WebsiteError(`the website answered ${r.status}`);
      const type = r.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new WebsiteError('that address is not a web page');
      const body = await readCapped(r);
      return { url, body };
    } catch (e) {
      if (e instanceof WebsiteError) throw e;
      if ((e as Error).name === 'AbortError') throw new WebsiteError('the website took too long to answer');
      throw new WebsiteError('could not read that website');
    } finally {
      clearTimeout(timer);
    }
  }
  throw new WebsiteError('too many redirects');
}

async function readCapped(r: Response): Promise<string> {
  if (!r.body) return '';
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break; // keep what we have; a homepage's first MB is plenty
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Visible text + title + meta description; about-page links. */
export function htmlToText(html: string, base: URL): { title: string; text: string; aboutLinks: string[] } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();
  const meta = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(html)?.[1] ?? '';
  const aboutLinks: string[] = [];
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = `${m[1]} ${m[2]}`.toLowerCase();
    if (/about|nosotros|quienes|empresa|qui-sommes|ueber-uns|uber-uns|sobre|company|من نحن|हमारे बारे/.test(label)) {
      try {
        const u = new URL(m[1], base);
        if (u.hostname === base.hostname && !aboutLinks.includes(u.toString())) aboutLinks.push(u.toString());
      } catch { /* ignore bad links */ }
    }
  }
  const body = html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|section|article|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (_m, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
        : ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title, text: [title, meta, body].filter(Boolean).join('\n'), aboutLinks: aboutLinks.slice(0, 3) };
}

/** Homepage + first about page as text, capped. */
export async function readWebsite(raw: string, opts: { fetchImpl?: Fetcher; resolve?: Resolver } = {}) {
  const home = await safeFetch(raw, opts);
  const page = htmlToText(home.body, home.url);
  const sources = [home.url.toString()];
  let text = page.text;
  if (page.aboutLinks[0]) {
    try {
      const about = await safeFetch(page.aboutLinks[0], opts);
      text += `\n\n${htmlToText(about.body, about.url).text}`;
      sources.push(about.url.toString());
    } catch { /* the about page is optional */ }
  }
  return { url: home.url.toString(), sources, text: text.slice(0, MAX_TEXT) };
}

const draftSchema = z.object({
  company: companySchema.partial().optional(),
  offer: offerSchema.partial().optional(),
});
export type ProfileDraft = z.infer<typeof draftSchema>;

export function websitePrompt(url: string, text: string): string {
  return [
    `Below is the text of the website ${url}. Draft parts of the company's business profile.`,
    'Use ONLY facts stated in the text. If something is not stated, leave it out. Never',
    'invent customers, numbers or certifications. Write values in English except product',
    'and company names. hq_country is an ISO-3166 alpha-2 code. languages_handled are',
    'BCP 47 codes of languages the site is published in. Proof points: only explicit,',
    'verifiable statements on the site (certifications, named results), all with',
    'may_mention false — the customer decides what may be cited.',
    'Return ONE JSON object:',
    JSON.stringify({
      company: { name: '', industry: '', hq_country: '', description: 'one or two sentences', languages_handled: [] },
      offer: { offers: [{ name: '', description: '', typical_buyer: '' }], value_proposition: '', proof: [{ text: '', may_mention: false }] },
    }),
    'Website text:',
    '"""',
    text,
    '"""',
  ].join('\n');
}

/** Ask the model for a draft; keep only what validates. */
export async function draftProfileFromWebsite(url: string, text: string, apiKey: string, callModel: CallModel): Promise<ProfileDraft> {
  const raw = extractJson(await callModel(apiKey, websitePrompt(url, text))) as Record<string, unknown>;
  const out: ProfileDraft = {};
  for (const key of ['company', 'offer'] as const) {
    const part = draftSchema.shape[key].safeParse(raw[key]);
    if (part.success && part.data) {
      // Drop empty strings/arrays the model returned as placeholders.
      const cleaned = Object.fromEntries(
        Object.entries(part.data).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== '' && v != null)),
      );
      if (Object.keys(cleaned).length) (out as Record<string, unknown>)[key] = cleaned;
    }
  }
  if (out.offer?.proof) out.offer.proof = out.offer.proof.map((p) => ({ ...p, may_mention: false }));
  return out;
}
