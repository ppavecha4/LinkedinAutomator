"""enrichment_waterfall.py — provider-agnostic contact enrichment.

The problem this solves: no single data provider has good coverage
everywhere. Apollo is strong in the US, weak in LATAM/APAC mobile.
Rather than bet the whole tool on one vendor, we run each contact
through an ORDERED CHAIN of providers and stop as soon as we have the
fields we need. Add/remove/reorder providers via env — no pipeline
code changes.

Design:
  - A `Provider` is any object with:
        name: str
        fields: set[str]          # which fields it can supply
        async enrich(contact) -> dict   # returns {field: value, ...}
  - `enrich_contact()` walks the configured chain, merging results,
    short-circuiting once all `want` fields are filled.
  - Every provider is wrapped so a failure never breaks the chain — a
    dead provider is skipped, the next one tries.

Configuration (env):
    ENRICHMENT_PROVIDERS=fullenrich,prospeo,apollo
        Ordered, comma-separated. First provider that returns a field
        wins for that field. Unknown names are skipped with a warning.
    FULLENRICH_API_KEY / PROSPEO_API_KEY / DATAGMA_API_KEY / ...
        Per-provider credentials. A provider with no key auto-disables.

The adapters below are thin. When you sign up for a provider, fill in
its request/response mapping in the matching adapter and set its key —
nothing else changes.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Awaitable, Callable, Optional

import httpx

log = logging.getLogger("orchestrator.enrichment")


# ─── Contact shape ──────────────────────────────────────────────────────
# We pass a plain dict around. Canonical keys:
#   first_name, last_name, full_name, company_name, company_domain,
#   linkedin_url, email, mobile, country
# Providers fill whatever they can. `want` names the fields we still need.


ProviderFn = Callable[[httpx.AsyncClient, dict], Awaitable[dict]]


class Provider:
    def __init__(self, name: str, fields: set[str], fn: ProviderFn,
                 enabled: bool):
        self.name = name
        self.fields = fields
        self.fn = fn
        self.enabled = enabled

    async def enrich(self, client: httpx.AsyncClient, contact: dict) -> dict:
        try:
            return await self.fn(client, contact) or {}
        except Exception as e:  # noqa: BLE001 — never break the chain
            log.warning("provider %s failed: %s", self.name, e)
            return {}


# ─── Adapters ───────────────────────────────────────────────────────────
# Each returns a dict of the fields it found. Thin, env-keyed. Fill the
# request/response mapping when you activate a provider.

_FE_BASE = "https://app.fullenrich.com/api/v1"
_FE_POLL_ATTEMPTS = int(os.environ.get("FULLENRICH_POLL_ATTEMPTS", "30"))
_FE_POLL_INTERVAL = float(os.environ.get("FULLENRICH_POLL_INTERVAL", "4"))


async def _fullenrich(client: httpx.AsyncClient, contact: dict) -> dict:
    """FullEnrich — waterfall-as-a-service across 15+ vendors.

    Async flow (verified against the live API June 2026):
      1. POST /contact/enrich/bulk {name, datas:[{firstname, lastname,
         company_name, domain, linkedin_url, enrich_fields}]}
         → {enrichment_id}
      2. GET /contact/enrich/bulk/{id} until status == FINISHED
         → datas[0].contact.{most_probable_phone, phones[], ...}

    We request phones ONLY (enrich_fields=["contact.phones"]) because
    Apollo already supplies the email — this halves the credit cost.
    Returns {"mobile": "+..."} on a hit, {} otherwise. Never raises.
    """
    key = (os.environ.get("FULLENRICH_API_KEY") or "").strip()
    if not key:
        return {}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    lead = {
        "firstname": contact.get("first_name") or "",
        "lastname": contact.get("last_name") or "",
        "company_name": contact.get("company_name") or "",
        "domain": contact.get("company_domain") or "",
        "linkedin_url": contact.get("linkedin_url") or "",
        "enrich_fields": ["contact.phones"],
    }
    # 1. submit
    r = await client.post(
        f"{_FE_BASE}/contact/enrich/bulk",
        headers=headers,
        json={"name": "sa", "datas": [lead]},
        timeout=30.0,
    )
    if r.status_code >= 400:
        log.warning("fullenrich submit %s: %s", r.status_code, r.text[:160])
        return {}
    eid = (r.json() or {}).get("enrichment_id")
    if not eid:
        return {}

    # 2. poll
    for _ in range(_FE_POLL_ATTEMPTS):
        await asyncio.sleep(_FE_POLL_INTERVAL)
        pr = await client.get(
            f"{_FE_BASE}/contact/enrich/bulk/{eid}", headers=headers, timeout=20.0,
        )
        if pr.status_code >= 400:
            continue
        body = pr.json() or {}
        status = body.get("status")
        if status == "FINISHED":
            datas = body.get("datas") or []
            if not datas:
                return {}
            c = (datas[0] or {}).get("contact") or {}
            phone = c.get("most_probable_phone")
            if not phone:
                phones = c.get("phones") or []
                phone = phones[0].get("number") if phones else None
            return {"mobile": phone} if phone else {}
        if status in ("FAILED", "ERROR", "CANCELLED"):
            return {}
    log.warning("fullenrich poll timeout for %s", contact.get("company_name"))
    return {}


async def _prospeo(client: httpx.AsyncClient, contact: dict) -> dict:
    """Prospeo — cheap sync mobile finder. Best when a LinkedIn URL is
    present (its highest-accuracy path)."""
    key = (os.environ.get("PROSPEO_API_KEY") or "").strip()
    if not key:
        return {}
    li = contact.get("linkedin_url")
    if li:
        body = {"url": li}
        endpoint = "https://api.prospeo.io/mobile-finder"
    else:
        body = {
            "first_name": contact.get("first_name") or "",
            "last_name": contact.get("last_name") or "",
            "company": contact.get("company_name") or "",
        }
        endpoint = "https://api.prospeo.io/mobile-finder"
    r = await client.post(
        endpoint,
        headers={"Content-Type": "application/json", "X-KEY": key},
        json=body,
        timeout=25.0,
    )
    if r.status_code >= 400:
        log.warning("prospeo %s: %s", r.status_code, r.text[:160])
        return {}
    data = (r.json() or {}).get("response") or {}
    mobile = data.get("raw_format") or data.get("international_format")
    return {"mobile": mobile} if mobile else {}


async def _datagma(client: httpx.AsyncClient, contact: dict) -> dict:
    """Datagma — cheap international phone enrichment."""
    key = (os.environ.get("DATAGMA_API_KEY") or "").strip()
    if not key:
        return {}
    params = {
        "apiId": key,
        "firstName": contact.get("first_name") or "",
        "lastName": contact.get("last_name") or "",
        "company": contact.get("company_name") or "",
    }
    if contact.get("linkedin_url"):
        params["linkedinUrl"] = contact["linkedin_url"]
    r = await client.get(
        "https://gateway.datagma.net/api/ingress/v2/full",
        params=params, timeout=25.0,
    )
    if r.status_code >= 400:
        log.warning("datagma %s: %s", r.status_code, r.text[:160])
        return {}
    body = r.json() or {}
    phone = (body.get("phone") or {}).get("phone") if isinstance(
        body.get("phone"), dict) else body.get("phone")
    return {"mobile": phone} if phone else {}


# ─── Registry ───────────────────────────────────────────────────────────

def _build_registry() -> dict[str, Provider]:
    return {
        "fullenrich": Provider(
            "fullenrich", {"email", "mobile"}, _fullenrich,
            bool((os.environ.get("FULLENRICH_API_KEY") or "").strip()),
        ),
        "prospeo": Provider(
            "prospeo", {"mobile"}, _prospeo,
            bool((os.environ.get("PROSPEO_API_KEY") or "").strip()),
        ),
        "datagma": Provider(
            "datagma", {"mobile"}, _datagma,
            bool((os.environ.get("DATAGMA_API_KEY") or "").strip()),
        ),
    }


def configured_chain() -> list[Provider]:
    """Ordered list of enabled providers from ENRICHMENT_PROVIDERS."""
    registry = _build_registry()
    order = [
        p.strip().lower()
        for p in (os.environ.get("ENRICHMENT_PROVIDERS") or "").split(",")
        if p.strip()
    ]
    chain: list[Provider] = []
    for name in order:
        prov = registry.get(name)
        if prov is None:
            log.warning("unknown enrichment provider '%s' — skipping", name)
            continue
        if not prov.enabled:
            log.info("provider '%s' has no API key — skipping", name)
            continue
        chain.append(prov)
    return chain


async def enrich_contact(
    contact: dict,
    *,
    want: Optional[set[str]] = None,
    client: Optional[httpx.AsyncClient] = None,
) -> dict:
    """Run `contact` through the configured provider chain.

    Merges results, first-provider-wins per field, stops once every
    `want` field is present. Returns the enriched contact dict (a copy).
    Providers that aren't configured / have no key are silently skipped,
    so this is safe to call even before any provider is set up (returns
    the contact unchanged).
    """
    want = want or {"mobile"}
    out = dict(contact)
    chain = configured_chain()
    if not chain:
        return out

    owns_client = client is None
    client = client or httpx.AsyncClient()
    try:
        for prov in chain:
            missing = {f for f in want if not out.get(f)}
            if not missing:
                break
            if not (prov.fields & missing):
                continue  # this provider can't supply anything we still need
            found = await prov.enrich(client, out)
            for field, value in found.items():
                if value and not out.get(field):
                    out[field] = value
                    out.setdefault("_enrich_source", {})[field] = prov.name
    finally:
        if owns_client:
            await client.aclose()
    return out
