/**
 * Slice 3.4 — checking connected accounts against the provider. The
 * network is faked; nothing leaves the machine.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { checkCredential, setCredentialCheckHooks, type SmtpTarget } from '../src/lib/credentialCheck';

const SID = 'AC' + 'a'.repeat(32);
const respond = (status: number, body: unknown = {}) =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

afterEach(() => setCredentialCheckHooks({}));

describe('API-key providers', () => {
  it('anthropic: accepted key, rejected key, provider trouble', async () => {
    setCredentialCheckHooks({ fetch: respond(200, { data: [] }) });
    expect(await checkCredential('anthropic', { api_key: 'k' }, {})).toEqual({ ok: true });
    setCredentialCheckHooks({ fetch: respond(401) });
    expect(await checkCredential('anthropic', { api_key: 'k' }, {})).toEqual({ ok: false, error: 'Anthropic rejected this API key.' });
    setCredentialCheckHooks({ fetch: respond(529) });
    expect((await checkCredential('anthropic', { api_key: 'k' }, {}))?.error).toMatch(/answered 529/);
  });

  it('apollo: needs is_logged_in', async () => {
    setCredentialCheckHooks({ fetch: respond(200, { is_logged_in: true }) });
    expect(await checkCredential('apollo', { api_key: 'k' }, {})).toEqual({ ok: true });
    setCredentialCheckHooks({ fetch: respond(200, { is_logged_in: false }) });
    expect((await checkCredential('apollo', { api_key: 'k' }, {}))?.ok).toBe(false);
  });

  it('sends the key to the right place, never anywhere else', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    setCredentialCheckHooks({ fetch: (async (u: string, init?: RequestInit) => { calls.push([u, init]); return new Response('{}', { status: 200 }); }) as typeof fetch });
    await checkCredential('anthropic', { api_key: 'sk-test' }, {});
    expect(calls[0][0]).toBe('https://api.anthropic.com/v1/models?limit=1');
    expect((calls[0][1]?.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(calls[0][1]?.redirect).toBe('error');
  });

  it('a timeout reads as a timeout', async () => {
    setCredentialCheckHooks({ fetch: (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as typeof fetch });
    expect((await checkCredential('apollo', { api_key: 'k' }, {}))?.error).toMatch(/did not answer in time/);
  });

  it('providers without a check return null', async () => {
    expect(await checkCredential('heyreach', { api_key: 'k' }, {})).toBeNull();
  });
});

describe('twilio', () => {
  const meta = { account_id: SID, whatsapp_from: '+51 987 654 321' };

  it('checks the SID and number before calling Twilio', async () => {
    expect((await checkCredential('twilio', { auth_token: 't' }, { ...meta, account_id: 'AC1' }))?.error).toMatch(/Account SID/);
    expect((await checkCredential('twilio', { auth_token: 't' }, { ...meta, whatsapp_from: '987654321' }))?.error).toMatch(/international format/);
  });

  it('active account → ok; suspended or rejected → why', async () => {
    let url = '';
    setCredentialCheckHooks({ fetch: (async (u: string) => { url = u; return new Response(JSON.stringify({ status: 'active' }), { status: 200 }); }) as typeof fetch });
    expect(await checkCredential('twilio', { auth_token: 't' }, meta)).toEqual({ ok: true });
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}.json`);
    setCredentialCheckHooks({ fetch: respond(200, { status: 'suspended' }) });
    expect((await checkCredential('twilio', { auth_token: 't' }, meta))?.error).toBe('This Twilio account is suspended.');
    setCredentialCheckHooks({ fetch: respond(401) });
    expect((await checkCredential('twilio', { auth_token: 't' }, meta))?.error).toMatch(/rejected/);
  });
});

describe('email', () => {
  it('google workspace logs in to smtp.gmail.com with the app password', async () => {
    const seen: SmtpTarget[] = [];
    setCredentialCheckHooks({ smtpVerify: async (t) => { seen.push(t); } });
    expect(await checkCredential('google_workspace', { app_password: 'abcd efgh' }, { email: 'ana@acme.test' })).toEqual({ ok: true });
    expect(seen[0]).toEqual({ host: 'smtp.gmail.com', servername: 'smtp.gmail.com', port: 587, user: 'ana@acme.test', pass: 'abcd efgh' });
  });

  it('a rejected login says to use an app password', async () => {
    setCredentialCheckHooks({ smtpVerify: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }); } });
    expect((await checkCredential('google_workspace', { app_password: 'x' }, { email: 'ana@acme.test' }))?.error).toMatch(/app password/);
  });

  it('custom SMTP: connects to the address that was checked, verifies TLS by name', async () => {
    const seen: SmtpTarget[] = [];
    setCredentialCheckHooks({ resolve: async () => ['93.184.216.34'], smtpVerify: async (t) => { seen.push(t); } });
    const r = await checkCredential('smtp', { password: 'pw' }, { host: 'Mail.Acme.test', port: 465, username: 'ana' });
    expect(r).toEqual({ ok: true });
    expect(seen[0]).toEqual({ host: '93.184.216.34', servername: 'mail.acme.test', port: 465, user: 'ana', pass: 'pw' });
  });

  it.each([
    [{ host: 'mail.acme.test', port: 587 }, ['10.0.0.5'], /not a public mail server/],
    [{ host: 'mail.acme.test', port: 587 }, ['93.184.216.34', '127.0.0.1'], /not a public mail server/],
    [{ host: 'mail.acme.test', port: 8080 }, ['93.184.216.34'], /port/],
    [{ host: '10.0.0.5', port: 587 }, ['10.0.0.5'], /as a name/],
    [{ host: 'localhost', port: 587 }, ['127.0.0.1'], /as a name/],
  ])('refuses %o', async (meta, ips, msg) => {
    let connected = false;
    setCredentialCheckHooks({ resolve: async () => ips, smtpVerify: async () => { connected = true; } });
    expect((await checkCredential('smtp', { password: 'pw' }, meta))?.error).toMatch(msg);
    expect(connected).toBe(false);
  });

  it('never echoes the secret in an error', async () => {
    setCredentialCheckHooks({
      resolve: async () => ['93.184.216.34'],
      smtpVerify: async () => { throw new Error('auth failed for password s3cret-pass'); },
    });
    const r = await checkCredential('smtp', { password: 's3cret-pass' }, { host: 'mail.acme.test', port: 587, username: 'ana' });
    expect(r?.error).not.toContain('s3cret-pass');
    expect(r?.error).toContain('•••');
  });
});


describe('voice accounts (slice 7.1)', () => {
  it('elevenlabs: sends the key to ElevenLabs only, checks every named voice, explains each failure', async () => {
    const urls: string[] = [];
    setCredentialCheckHooks({ fetch: (async (u: string, init?: RequestInit) => {
      urls.push(u);
      expect((init?.headers as Record<string, string>)['xi-api-key']).toBe('el-key');
      return new Response('{}', { status: 200 });
    }) as typeof fetch });
    expect(await checkCredential('elevenlabs', { api_key: 'el-key' }, { voice_id: 'v1', voice_id_es: 'v2', voice_id_pt: 'v1' })).toEqual({ ok: true });
    expect(urls).toEqual(['https://api.elevenlabs.io/v1/voices/v1', 'https://api.elevenlabs.io/v1/voices/v2']);   // each voice once
    urls.length = 0;
    await checkCredential('elevenlabs', { api_key: 'el-key' }, {});
    expect(urls).toEqual(['https://api.elevenlabs.io/v1/user']);                                            // no voice yet: just the key

    setCredentialCheckHooks({ fetch: respond(401) });
    expect((await checkCredential('elevenlabs', { api_key: 'x' }, {}))?.error).toBe('ElevenLabs rejected this API key.');
    setCredentialCheckHooks({ fetch: respond(404) });
    expect((await checkCredential('elevenlabs', { api_key: 'x' }, { voice_id: 'nope' }))?.error).toMatch(/voice ID .* not found/);
    setCredentialCheckHooks({ fetch: respond(403) });
    expect((await checkCredential('elevenlabs', { api_key: 'x' }, {}))?.error).toMatch(/not allowed to use voices/);
    setCredentialCheckHooks({ fetch: respond(503) });
    expect(await checkCredential('elevenlabs', { api_key: 'x' }, {})).toMatchObject({ ok: false, transient: true });
  });

  it('twilio: a phone number for calls must belong to the account; WhatsApp alone or calls alone are both fine', async () => {
    const owned = new Set<string>();
    setCredentialCheckHooks({ fetch: (async (u: string) => {
      if (/IncomingPhoneNumbers/.test(u)) return new Response(JSON.stringify({ incoming_phone_numbers: owned.has(decodeURIComponent(u.split('PhoneNumber=')[1])) ? [{}] : [] }), { status: 200 });
      if (/OutgoingCallerIds/.test(u)) return new Response(JSON.stringify({ outgoing_caller_ids: [] }), { status: 200 });
      return new Response(JSON.stringify({ status: 'active' }), { status: 200 });
    }) as typeof fetch });
    const base = { account_id: SID };
    expect((await checkCredential('twilio', { auth_token: 't' }, base))?.error).toMatch(/WhatsApp number, a phone number for calls, or both/);
    expect(await checkCredential('twilio', { auth_token: 't' }, { ...base, whatsapp_from: '+51987654321' })).toEqual({ ok: true });
    expect((await checkCredential('twilio', { auth_token: 't' }, { ...base, voice_from: '900000001' }))?.error).toMatch(/international format/);
    expect((await checkCredential('twilio', { auth_token: 't' }, { ...base, voice_from: '+51 900 000 001' }))?.error).toMatch(/not a number in this Twilio account/);
    owned.add('+51900000001');
    expect(await checkCredential('twilio', { auth_token: 't' }, { ...base, voice_from: '+51 900 000 001' })).toEqual({ ok: true });
  });
});
