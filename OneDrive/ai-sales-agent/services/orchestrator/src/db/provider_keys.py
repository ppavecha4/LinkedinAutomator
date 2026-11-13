"""Whose API key pays for a call (SaaS phase 2, slice 2.3).

Python counterpart of services/api/src/lib/providerKeys.ts. BYO-first: a
customer org's AI (Anthropic) and lead-search (Apollo) calls use the
accounts it connected in the credential vault; the env-configured
operator org (AUTH_ORG_ID, today's Appson deploy) keeps using `.env`.
A customer without a connected account gets None, and callers skip with a
reason instead of quietly spending the platform's credits.
"""
from __future__ import annotations

import os
from typing import Any

from db.tenant import LEGACY_ORG_ID, current_org  # type: ignore
from db.vault import VaultError, load_credential  # type: ignore

ENV_KEYS = {"anthropic": "ANTHROPIC_API_KEY", "apollo": "APOLLO_API_KEY"}


def operator_org() -> str:
    """The org that runs on `.env` keys (same default as the API)."""
    return (os.environ.get("AUTH_ORG_ID") or LEGACY_ORG_ID).strip()


def is_operator_org(org_id: str | None = None) -> bool:
    org = org_id if org_id is not None else current_org()
    return org == operator_org()


async def provider_secret(pool: Any, provider: str, field: str = "api_key") -> str | None:
    """The current org's secret, or None when it has not connected one.

    Must run inside a tenant (poller task / use_campaign_org).
    """
    org = current_org()
    if org is None:
        raise VaultError("provider_secret() must run inside a tenant")
    if is_operator_org(org):
        return (os.environ.get(ENV_KEYS[provider]) or "").strip() or None
    async with pool.acquire() as conn:
        label = await conn.fetchval(
            """
            SELECT label FROM org_credentials
             WHERE provider = $1 AND secret_enc IS NOT NULL
               AND status NOT IN ('REVOKED', 'FAILED')
             ORDER BY (label = 'default') DESC, (status = 'VERIFIED') DESC, updated_at DESC
             LIMIT 1
            """,
            provider,
        )
        if label is None:
            return None
        cred = await load_credential(conn, provider, label)
    return (cred.secret.get(field) or "").strip() or None if cred else None
