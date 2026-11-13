/**
 * Credential vault crypto + the credentials routes' pre-DB rules.
 *
 * The VECTOR below is shared with services/orchestrator/tests/test_vault.py:
 * both languages must produce and accept exactly these bytes.
 */

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { env } from '../src/env';
import {
  aadFor,
  decryptSecret,
  encryptSecret,
  encryptWithIv,
  vaultKey,
  VaultError,
} from '../src/lib/vault';
import { buildApp } from './app';

export const VECTOR = {
  key_b64: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
  iv_hex: 'a0a1a2a3a4a5a6a7a8a9aaab',
  org: '00000000-0000-0000-0000-0000000000a1',
  provider: 'twilio',
  label: 'default',
  secret: { auth_token: 'tok_123', api_key: 'k-é✓' },
  blob_hex:
    '01a0a1a2a3a4a5a6a7a8a9aaabe28c7a0b20d621af275d033e0f3d23ed9d3a1d5831a35dcb0d0ee2bd2540e2aa1fc70621a0846040be6f56ef20c01078f04c659482e1fadfc30f26b5',
};

const key = Buffer.from(VECTOR.key_b64, 'base64');
const aad = aadFor(VECTOR.org, VECTOR.provider, VECTOR.label);

describe('vault crypto', () => {
  it('reproduces the shared vector byte for byte', () => {
    const blob = encryptWithIv(VECTOR.secret, aad, key, Buffer.from(VECTOR.iv_hex, 'hex'));
    expect(blob.toString('hex')).toBe(VECTOR.blob_hex);
    expect(decryptSecret(Buffer.from(VECTOR.blob_hex, 'hex'), aad, key)).toEqual(VECTOR.secret);
  });

  it('round-trips with a random IV, never the same bytes twice', () => {
    const a = encryptSecret({ x: 'y' }, aad, key);
    const b = encryptSecret({ x: 'y' }, aad, key);
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, aad, key)).toEqual({ x: 'y' });
    expect(a.toString('utf8')).not.toContain('y"');
  });

  it('refuses another row (org / provider / label), a tampered blob, or a wrong key', () => {
    const blob = Buffer.from(VECTOR.blob_hex, 'hex');
    const otherOrg = aadFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'twilio', 'default');
    expect(() => decryptSecret(blob, otherOrg, key)).toThrow(VaultError);
    expect(() => decryptSecret(blob, aadFor(VECTOR.org, 'smtp', 'default'), key)).toThrow(VaultError);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decryptSecret(tampered, aad, key)).toThrow(VaultError);
    expect(() => decryptSecret(blob, aad, Buffer.alloc(32, 7))).toThrow(VaultError);
  });

  it('validates the key', () => {
    expect(vaultKey('')).toBeNull();
    expect(() => vaultKey(Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
    expect(vaultKey(VECTOR.key_b64)?.equals(key)).toBe(true);
  });
});

describe('credentials routes: rules checked before the database', () => {
  const original = { ...env };
  afterEach(() => Object.assign(env, original));
  const body = { secret: { auth_token: 't' }, meta: { account_id: 'AC' + 'a'.repeat(32) } };

  it('members and viewers cannot connect accounts', async () => {
    env.authMode = 'bypass';
    for (const role of ['member', 'viewer']) {
      const res = await request(buildApp()).put('/api/credentials/twilio').set('x-dev-role', role).send(body);
      expect(res.status).toBe(403);
    }
  });

  it('rejects unknown providers, extra fields and empty secrets', async () => {
    env.authMode = 'bypass';
    const app = buildApp();
    expect((await request(app).put('/api/credentials/myspace').send(body)).status).toBe(400);
    expect((await request(app).put('/api/credentials/smtp').send({ ...body, secret_enc: 'x' })).status).toBe(400);
    expect((await request(app).put('/api/credentials/smtp').send({ secret: {} })).status).toBe(400);
  });

  it('requires a valid Twilio Account SID (used to route webhooks)', async () => {
    env.authMode = 'bypass';
    const res = await request(buildApp())
      .put('/api/credentials/twilio')
      .send({ secret: { auth_token: 't' }, meta: { account_id: 'not-a-sid' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Account SID/);
  });

  it('refuses to store secrets when CREDENTIALS_KEY is not set', async () => {
    env.authMode = 'bypass';
    env.credentialsKey = '';
    const res = await request(buildApp()).put('/api/credentials/twilio').send(body);
    expect(res.status).toBe(500);
  });
});
