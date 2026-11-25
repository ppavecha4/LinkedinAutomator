"""Credential vault (src/db/vault.py).

VECTOR is shared with services/api/tests/vault.test.ts: Node and Python
must produce and accept exactly these bytes. Live tests need DATABASE_URL
(V1–V17) and run as the current DB role; RLS checks are meaningful as the
non-superuser sales_app login.
"""
from __future__ import annotations

import base64
import os

import pytest

pytest.importorskip("cryptography")

from db import tenant as t  # noqa: E402
from db import vault as v  # noqa: E402

VECTOR = {
    "key_b64": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    "iv_hex": "a0a1a2a3a4a5a6a7a8a9aaab",
    "org": "00000000-0000-0000-0000-0000000000a1",
    "provider": "twilio",
    "label": "default",
    "secret": {"auth_token": "tok_123", "api_key": "k-é✓"},
    "blob_hex": (
        "01a0a1a2a3a4a5a6a7a8a9aaabe28c7a0b20d621af275d033e0f3d23ed9d3a1d"
        "5831a35dcb0d0ee2bd2540e2aa1fc70621a0846040be6f56ef20c01078f04c65"
        "9482e1fadfc30f26b5"
    ),
}
KEY = base64.b64decode(VECTOR["key_b64"])
AAD = v.aad_for(VECTOR["org"], VECTOR["provider"], VECTOR["label"])


def test_decrypts_the_node_vector():
    assert v.decrypt_secret(bytes.fromhex(VECTOR["blob_hex"]), AAD, KEY) == VECTOR["secret"]


def test_encrypts_identically_to_node():
    blob = v.encrypt_with_iv(VECTOR["secret"], AAD, KEY, bytes.fromhex(VECTOR["iv_hex"]))
    assert blob.hex() == VECTOR["blob_hex"]


def test_refuses_other_row_tamper_and_wrong_key():
    blob = bytes.fromhex(VECTOR["blob_hex"])
    with pytest.raises(v.VaultError):
        v.decrypt_secret(blob, v.aad_for("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "twilio", "default"), KEY)
    tampered = blob[:-1] + bytes([blob[-1] ^ 1])
    with pytest.raises(v.VaultError):
        v.decrypt_secret(tampered, AAD, KEY)
    with pytest.raises(v.VaultError):
        v.decrypt_secret(blob, AAD, b"\x07" * 32)


def test_key_validation():
    assert v.vault_key("") is None
    with pytest.raises(v.VaultError):
        v.vault_key(base64.b64encode(b"short").decode())
    assert v.vault_key(VECTOR["key_b64"]) == KEY


def test_credential_repr_hides_the_secret():
    c = v.Credential("twilio", "default", {"auth_token": "s3cr3t"}, {}, "VERIFIED")
    assert "s3cr3t" not in repr(c)


async def test_load_credential_requires_a_tenant():
    with pytest.raises(v.VaultError, match="inside a tenant"):
        await v.load_credential(object(), "twilio")


# ── live ────────────────────────────────────────────────────────────────

live = pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL (V1–V17)")
ORG_G = "99999999-9999-4999-8999-999999999999"


@live
async def test_live_store_and_load_per_tenant():
    pool = await t.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=1)
    key = os.urandom(32)
    try:
        with t.tenant(ORG_G):
            async with pool.acquire() as conn:
                await conn.execute(
                    "INSERT INTO organizations (id, name, slug) VALUES ($1, 'Tenant G', 'tenant-g-py')"
                    " ON CONFLICT (id) DO NOTHING", ORG_G)
                blob = v.encrypt_secret({"api_key": "g-key"}, v.aad_for(ORG_G, "apollo", "vault-py"), key)
                await conn.execute(
                    "INSERT INTO org_credentials (provider, label, secret_enc) VALUES ('apollo', 'vault-py', $1)",
                    blob)
                cred = await v.load_credential(conn, "apollo", "vault-py", key=key)
        assert cred is not None and cred.secret == {"api_key": "g-key"}

        # Another tenant sees nothing (RLS), so it is "not connected".
        with t.tenant(t.LEGACY_ORG_ID):
            async with pool.acquire() as conn:
                bypasses = await conn.fetchval(
                    "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
                other = await v.load_credential(conn, "apollo", "vault-py", key=key)
        if not bypasses:
            assert other is None
    finally:
        with t.tenant(ORG_G):
            async with pool.acquire() as conn:
                await conn.execute("DELETE FROM org_credentials WHERE label = 'vault-py'")
                await conn.execute("DELETE FROM organizations WHERE id = $1", ORG_G)
        await pool.close()
