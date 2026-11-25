"""Credential vault for the orchestrator and cron scripts (SaaS phase 1).

Python counterpart of ``services/api/src/lib/vault.ts``; the two are
pinned to one shared test vector. Format of ``org_credentials.secret_enc``:

    version (1 byte, 0x01) | iv (12) | auth tag (16) | ciphertext

AES-256-GCM, key = base64 ``CREDENTIALS_KEY`` (32 bytes), plaintext = the
secret object as compact UTF-8 JSON, AAD = "<org_id>:<provider>:<label>"
(a ciphertext only decrypts for the row it was written for).

Workers read a tenant's credentials with ``load_credential()`` inside that
tenant (``db.tenant.tenant()`` / ``use_campaign_org()``); row-level
security guarantees they can only ever see their own org's rows.
"""
from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from typing import Any

VAULT_VERSION = 0x01
_IV = 12
_TAG = 16


class VaultError(Exception):
    pass


def vault_key(raw: str | None = None) -> bytes | None:
    """The 32-byte key from CREDENTIALS_KEY, or None when not configured."""
    raw = os.environ.get("CREDENTIALS_KEY", "") if raw is None else raw
    if not raw:
        return None
    key = base64.b64decode(raw)
    if len(key) != 32:
        raise VaultError("CREDENTIALS_KEY must be base64 of exactly 32 bytes")
    return key


def aad_for(org_id: str, provider: str, label: str) -> bytes:
    return f"{org_id}:{provider}:{label}".encode("utf-8")


def _aesgcm(key: bytes):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # lazy: optional dep

    return AESGCM(key)


def encrypt_with_iv(secret: dict[str, str], aad: bytes, key: bytes, iv: bytes) -> bytes:
    """Encrypt with an explicit IV (shared test vector / tooling only)."""
    if len(iv) != _IV:
        raise VaultError("iv must be 12 bytes")
    # Same bytes as Node's JSON.stringify: compact, UTF-8, no escaping.
    pt = json.dumps(secret, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ct_and_tag = _aesgcm(key).encrypt(iv, pt, aad)  # ciphertext || tag
    ct, tag = ct_and_tag[:-_TAG], ct_and_tag[-_TAG:]
    return bytes([VAULT_VERSION]) + iv + tag + ct


def encrypt_secret(secret: dict[str, str], aad: bytes, key: bytes) -> bytes:
    return encrypt_with_iv(secret, aad, key, os.urandom(_IV))


def decrypt_secret(blob: bytes, aad: bytes, key: bytes) -> dict[str, str]:
    blob = bytes(blob)
    if len(blob) < 1 + _IV + _TAG or blob[0] != VAULT_VERSION:
        raise VaultError("unsupported or corrupt secret")
    iv = blob[1 : 1 + _IV]
    tag = blob[1 + _IV : 1 + _IV + _TAG]
    ct = blob[1 + _IV + _TAG :]
    try:
        pt = _aesgcm(key).decrypt(iv, ct + tag, aad)
    except Exception as e:  # InvalidTag: wrong key, wrong row, tampered
        raise VaultError("secret could not be decrypted") from e
    return json.loads(pt.decode("utf-8"))


@dataclass(frozen=True)
class Credential:
    provider: str
    label: str
    secret: dict[str, str]
    meta: dict[str, Any]
    status: str

    def __repr__(self) -> str:  # never print secrets in logs/tracebacks
        return (f"Credential(provider={self.provider!r}, label={self.label!r}, "
                f"status={self.status!r}, secret=<redacted>)")


async def load_credential(conn: Any, provider: str, label: str = "default",
                          key: bytes | None = None) -> Credential | None:
    """The current tenant's credential for ``provider``/``label``, or None.

    Must run inside a tenant: with row-level security an untenanted
    connection sees no rows, which would look like "not connected".
    """
    from db.tenant import current_org  # type: ignore

    if current_org() is None:
        raise VaultError("load_credential() must run inside a tenant")
    row = await conn.fetchrow(
        """
        SELECT org_id, secret_enc, meta, status FROM org_credentials
         WHERE provider = $1 AND label = $2 AND status <> 'REVOKED'
        """,
        provider, label,
    )
    if row is None or row["secret_enc"] is None:
        return None
    key = key or vault_key()
    if key is None:
        raise VaultError("credential vault not configured (CREDENTIALS_KEY)")
    secret = decrypt_secret(row["secret_enc"], aad_for(str(row["org_id"]), provider, label), key)
    meta = row["meta"]
    if isinstance(meta, str):
        meta = json.loads(meta or "{}")
    return Credential(provider, label, secret, dict(meta or {}), row["status"])
