/**
 * Credential vault crypto (SaaS phase 1). See docs/saas-architecture.md,
 * "Credentials".
 *
 * Tenant secrets (API keys, passwords) are encrypted HERE, before they
 * reach Postgres; the database only stores `org_credentials.secret_enc`.
 *
 * Format of `secret_enc` (all binary):
 *
 *   version (1 byte, 0x01) | iv (12 bytes) | auth tag (16 bytes) | ciphertext
 *
 * - AES-256-GCM, key = base64 `CREDENTIALS_KEY` (exactly 32 bytes).
 * - Plaintext is the JSON of the secret object.
 * - Additional authenticated data (AAD) = "<org_id>:<provider>:<label>",
 *   so a ciphertext only decrypts for the row it was written for. Copying
 *   it into another org's row (or another provider/label) fails.
 *
 * The Python side (services/orchestrator/src/db/vault.py) implements the
 * same format; both are pinned to one shared test vector.
 */

import crypto from 'crypto';

import { env } from '../env';

export const VAULT_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type Secret = Record<string, string>;

export class VaultError extends Error {}

/** The 32-byte key from CREDENTIALS_KEY, or null when not configured. */
export function vaultKey(raw: string = env.credentialsKey): Buffer | null {
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new VaultError('CREDENTIALS_KEY must be base64 of exactly 32 bytes');
  }
  return key;
}

export function aadFor(orgId: string, provider: string, label: string): Buffer {
  return Buffer.from(`${orgId}:${provider}:${label}`, 'utf8');
}

/** Encrypt with an explicit IV. Exported for the shared test vector only. */
export function encryptWithIv(secret: Secret, aad: Buffer, key: Buffer, iv: Buffer): Buffer {
  if (iv.length !== IV_BYTES) throw new VaultError('iv must be 12 bytes');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VAULT_VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function encryptSecret(secret: Secret, aad: Buffer, key: Buffer): Buffer {
  return encryptWithIv(secret, aad, key, crypto.randomBytes(IV_BYTES));
}

export function decryptSecret(blob: Buffer, aad: Buffer, key: Buffer): Secret {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VAULT_VERSION) {
    throw new VaultError('unsupported or corrupt secret');
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as Secret;
  } catch {
    // Wrong key, wrong row (AAD) or tampered data. Never echo details.
    throw new VaultError('secret could not be decrypted');
  }
}
