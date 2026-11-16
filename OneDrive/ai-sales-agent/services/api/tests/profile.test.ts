/**
 * Slice 3.1 — profile logic, website reader safety, auth rate limits.
 * No database.
 */

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import { completeness, customersSchema, profileDescription, type Profile } from '../src/lib/profile';
import {
  assertPublicUrl,
  draftProfileFromWebsite,
  htmlToText,
  isPrivateAddress,
  safeFetch,
  WebsiteError,
} from '../src/lib/websiteReader';
import { authRateLimit } from '../src/middleware/authRateLimit';
import { samplePrompt } from '../src/routes/profile';
import { buildApp } from './app';

const EMPTY: Profile = { company: {}, offer: {}, customers: {}, voice: {}, rules: {} };
const FULL: Profile = {
  company: { name: 'Acme', industry: 'Packaging', description: 'We make export packaging.', languages_handled: ['es', 'en'] },
  offer: {
    offers: [{ name: 'Fruit boxes' }],
    value_proposition: 'Clears customs first time.',
    proof: [{ text: 'ISO 22000 certified', may_mention: true }, { text: 'Client: Grupo Andino', may_mention: false }],
    price_policy: 'never',
  },
  customers: { roles: ['Head of Procurement'], industries: ['Fruit exporters'], countries: ['PE'], problems: 'Held shipments.' },
  voice: { sender_name: 'Ana', meeting_link: 'https://cal.com/ana', formality: 'formal', tone: 'consultative', avoid: ['cheapest'] },
  rules: {},
};

describe('profile', () => {
  it('scores completeness and says what is missing', () => {
    expect(completeness(EMPTY).score).toBe(0);
    expect(completeness(EMPTY).missing.map((m) => m.item)).toContain('value_proposition');
    expect(completeness(FULL)).toEqual({ score: 100, missing: [] });
  });

  it('never feeds proof the customer kept private to the AI', () => {
    const d = profileDescription(FULL);
    expect(d).toContain('ISO 22000 certified');
    expect(d).not.toContain('Grupo Andino');
    expect(d).toContain('Never mention prices.');
    expect(d).toContain('Never use these words or claims: cheapest.');
  });

  it('section schemas are strict and normalise never-contact entries', () => {
    expect(customersSchema.safeParse({ hacker: 1 }).success).toBe(false);
    expect(customersSchema.parse({ never_contact: ['GrupoAndino.PE'] }).never_contact).toEqual(['grupoandino.pe']);
    expect(customersSchema.safeParse({ countries: ['Peru'] }).success).toBe(false);
  });

  it('the sample prompt uses only allowed proof and asks for native language', () => {
    const p = samplePrompt(FULL, {
      channel: 'whatsapp',
      prospect: { name: 'Carla', company: 'Frutas del Sur', country: 'Peru' },
    });
    expect(p).toContain('ISO 22000 certified');
    expect(p).not.toContain('Grupo Andino');
    expect(p).toMatch(/main business language of Peru/);
    expect(p).toMatch(/STOP/);
  });
});

describe('website reader: SSRF guard', () => {
  const pub = async () => ['93.184.216.34'];

  it.each(['127.0.0.1', '10.0.0.5', '172.20.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1'])('%s is private', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::6810:85e5'])('%s is public', (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });

  it.each([
    'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data',
    'http://user:pw@acme.test/', 'ftp://acme.test/', 'http://acme.test:8080/', 'http://printer.local/',
  ])('refuses %s', async (url) => {
    await expect(assertPublicUrl(url, pub)).rejects.toBeInstanceOf(WebsiteError);
  });

  it('refuses a public name that resolves to a private address', async () => {
    await expect(assertPublicUrl('https://evil.test/', async () => ['93.184.216.34', '10.0.0.1']))
      .rejects.toThrow(/not a public website/);
  });

  it('re-checks redirects: a hop to the metadata address is refused', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })) as typeof fetch;
    await expect(safeFetch('https://acme.test/', { fetchImpl, resolve: pub })).rejects.toThrow(/not a public website/);
  });

  it('refuses non-HTML responses', async () => {
    const fetchImpl = (async () =>
      new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } })) as typeof fetch;
    await expect(safeFetch('https://acme.test/x.pdf', { fetchImpl, resolve: pub })).rejects.toThrow(/not a web page/);
  });
});

describe('website reader: text + draft', () => {
  it('keeps visible text, drops scripts, finds the about page', () => {
    const html = `<html><head><title>Acme Exports</title><meta name="description" content="Export packaging">
      <script>var secret = 1;</script><style>p{}</style></head>
      <body><p>We make boxes &amp; bags.</p><a href="/nosotros">Nosotros</a><a href="https://other.test/about">x</a></body></html>`;
    const r = htmlToText(html, new URL('https://acme.test/'));
    expect(r.text).toContain('We make boxes & bags.');
    expect(r.text).not.toContain('secret');
    expect(r.aboutLinks).toEqual(['https://acme.test/nosotros']);
  });

  it('keeps only valid fields and never lets the AI decide what may be cited', async () => {
    const reply = JSON.stringify({
      company: { name: 'Acme', industry: '', hq_country: 'PE', languages_handled: ['es'], description: 'Boxes.' },
      offer: { offers: [{ name: 'Boxes' }], proof: [{ text: 'ISO 22000', may_mention: true }], value_proposition: '' },
    });
    const draft = await draftProfileFromWebsite('https://acme.test', 'text', 'k', async () => reply);
    expect(draft.company).toEqual({ name: 'Acme', hq_country: 'PE', languages_handled: ['es'], description: 'Boxes.' });
    expect(draft.offer?.proof).toEqual([{ text: 'ISO 22000', may_mention: false }]);
    expect(draft.offer).not.toHaveProperty('value_proposition');
  });
});

describe('auth: limits and switches without a database', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));

  it('rate limiter answers 429 after the limit', () => {
    const lim = authRateLimit({ name: 't', windowMs: 60_000, max: 2, key: () => 'k' });
    const results: unknown[] = [];
    for (let i = 0; i < 3; i += 1) lim({} as never, {} as never, (e?: unknown) => results.push(e));
    expect(results.slice(0, 2)).toEqual([undefined, undefined]);
    expect((results[2] as { status: number }).status).toBe(429);
  });

  it('signup is closed unless SIGNUP_ENABLED, and validates input', async () => {
    env.authMode = 'local';
    env.authJwtSecret = 'test-secret';
    const app = buildApp();
    const good = { full_name: 'Ana', company: 'Acme', email: 'ana@acme.test', password: 'a-long-password-1', accept_terms: true };
    expect((await request(app).get('/api/auth/config')).body.data).toEqual({ mode: 'local', signup_enabled: false });
    expect((await request(app).post('/api/auth/signup').send(good)).status).toBe(404);
    env.signupEnabled = true;
    expect((await request(app).get('/api/auth/config')).body.data.signup_enabled).toBe(true);
    expect((await request(app).post('/api/auth/signup').send({ ...good, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/signup').send({ ...good, accept_terms: false })).status).toBe(400);
  });
});
