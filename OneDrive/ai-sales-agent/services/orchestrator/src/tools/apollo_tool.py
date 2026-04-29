"""Apollo.io v1 REST API integration.

Covers:
    - search_companies(icp_criteria)        — /mixed_companies/search
    - search_decision_makers(org_ids, ...)  — /mixed_people/api_search
    - enrich_contact(apollo_contact_id)     — /people/match (24h Redis cache)
    - Exponential backoff on 429 / 5xx (max 3 retries, respects Retry-After)
    - Daily credit counter in Redis (Apollo free = 300/day)

Reads APOLLO_API_KEY from env.

NOTE on endpoint paths (April 2026 audit):
  Apollo deprecated `/v1/people/search` and `/v1/organizations/search`. The
  current API base is `/api/v1` (NOT `/v1`). For programmatic prospecting
  use the dedicated API-only endpoints:
      POST /api/v1/mixed_companies/search        (companies)
      POST /api/v1/mixed_people/api_search       (people, API-only variant)
      POST /api/v1/people/match                  (enrichment)
  The legacy paths return HTTP 422 with a "deprecated for API callers"
  body, so we use the new ones.

NOTE on Cloudflare:
  api.apollo.io sits behind Cloudflare which blocks requests with the
  default Python `python-urllib`/`python-httpx` user agents (response is
  HTTP 403 with Cloudflare error code 1010). We send an explicit
  `User-Agent` header to bypass that filter.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


class ApolloError(Exception):
    """Raised when Apollo API calls fail after retries."""


class ApolloTool:
    BASE_URL = "https://api.apollo.io/api/v1"
    USER_AGENT = "AiSalesAgent-Orchestrator/0.1"
    DEFAULT_PER_PAGE = 25
    MAX_PAGES = 40          # defensive cap so pagination bugs don't burn credits
    MAX_RETRIES = 3
    CACHE_TTL_SECONDS = 86400
    DAILY_CREDIT_LIMIT = 300

    _EMPLOYEE_RANGE_MAP = {
        "1-10": "1,10",
        "11-20": "11,20",
        "21-50": "21,50",
        "51-100": "51,100",
        "101-200": "101,200",
        "201-500": "201,500",
        "501-1000": "501,1000",
        "1001-2000": "1001,2000",
        "2001-5000": "2001,5000",
        "5001-10000": "5001,10000",
    }

    def __init__(self, redis_client: Any, api_key: Optional[str] = None) -> None:
        self._redis = redis_client
        self._api_key = api_key or os.environ.get("APOLLO_API_KEY", "")
        if not self._api_key:
            logger.warning("APOLLO_API_KEY not set — ApolloTool will fail at call time")
        self._client = httpx.AsyncClient(timeout=30.0)

    async def close(self) -> None:
        await self._client.aclose()

    # ------------------------------------------------------------------ HTTP

    async def _post(self, path: str, json_body: dict) -> dict:
        url = f"{self.BASE_URL}{path}"
        headers = {
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Api-Key": self._api_key,
            # Cloudflare blocks the default httpx User-Agent (error 1010).
            "User-Agent": self.USER_AGENT,
        }

        for attempt in range(self.MAX_RETRIES):
            try:
                resp = await self._client.post(url, headers=headers, json=json_body)
                await self._bump_credit_counter()

                if resp.status_code == 429:
                    retry_after = _parse_retry_after(resp.headers.get("Retry-After"))
                    delay = retry_after if retry_after is not None else (2 ** attempt)
                    logger.warning(
                        "apollo 429 attempt=%d delay=%.1fs url=%s",
                        attempt + 1, delay, url,
                    )
                    if attempt == self.MAX_RETRIES - 1:
                        raise ApolloError(f"apollo 429 after {self.MAX_RETRIES} retries")
                    await asyncio.sleep(delay)
                    continue

                if 500 <= resp.status_code < 600:
                    logger.warning(
                        "apollo %d attempt=%d url=%s",
                        resp.status_code, attempt + 1, url,
                    )
                    if attempt == self.MAX_RETRIES - 1:
                        raise ApolloError(
                            f"apollo {resp.status_code}: {resp.text[:200]}"
                        )
                    await asyncio.sleep(2 ** attempt)
                    continue

                resp.raise_for_status()
                return resp.json()
            except httpx.RequestError as e:
                logger.warning("apollo request error attempt=%d err=%s", attempt + 1, e)
                if attempt == self.MAX_RETRIES - 1:
                    raise ApolloError(f"apollo network error: {e}") from e
                await asyncio.sleep(2 ** attempt)

        raise ApolloError("apollo retry loop exited unexpectedly")

    async def _bump_credit_counter(self) -> None:
        """Track daily Apollo credit usage in Redis (best-effort)."""
        try:
            day = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
            key = f"apollo:credits:{day}"
            current = await self._redis.incr(key)
            if current == 1:
                await self._redis.expire(key, 86400)
            if current >= self.DAILY_CREDIT_LIMIT:
                logger.warning(
                    "apollo daily credit cap reached: %d/%d",
                    current, self.DAILY_CREDIT_LIMIT,
                )
        except Exception:
            logger.exception("failed to bump apollo credit counter")

    # ------------------------------------------------------------- industry tags

    async def _get_industry_tag_ids(self, industries: list[str]) -> list[str]:
        """Resolve Apollo industry-tag IDs for human-readable industry names.

        Uses the typeahead endpoint as a best-effort resolver and caches the
        result per-industry in Redis for 24h.
        """
        if not industries:
            return []
        ids: list[str] = []
        for name in industries:
            cache_key = f"apollo:industry_tag:{name.lower().strip()}"
            cached = await self._redis.get(cache_key)
            if cached:
                ids.append(_decode(cached))
                continue
            try:
                resp = await self._post("/typeahead/industries", {"q": name})
                candidates = resp.get("industries") or resp.get("results") or []
                if candidates:
                    tag_id = str(candidates[0].get("id"))
                    await self._redis.set(
                        cache_key, tag_id, ex=self.CACHE_TTL_SECONDS
                    )
                    ids.append(tag_id)
            except Exception:
                logger.exception("industry tag lookup failed for %r", name)
        return ids

    # ------------------------------------------------------- public API: search

    async def search_companies(self, icp_criteria: dict) -> list[dict]:
        """Paginate /organizations/search and return normalised rows."""
        industries = icp_criteria.get("industries") or []
        sizes = icp_criteria.get("company_sizes") or []
        countries = icp_criteria.get("countries") or []
        keywords = icp_criteria.get("keywords") or []

        body: dict[str, Any] = {"per_page": self.DEFAULT_PER_PAGE}
        if industries:
            tag_ids = await self._get_industry_tag_ids(industries)
            if tag_ids:
                body["organization_industry_tag_ids"] = tag_ids
        if sizes:
            body["organization_num_employees_ranges"] = [
                self._EMPLOYEE_RANGE_MAP.get(s, s) for s in sizes
            ]
        if countries:
            body["organization_locations"] = countries
        if keywords:
            body["q_organization_keyword_tags"] = keywords

        results: list[dict] = []
        for page in range(1, self.MAX_PAGES + 1):
            body["page"] = page
            # `/mixed_companies/search` is Apollo's current company-search
            # endpoint. The legacy `/organizations/search` is gone.
            data = await self._post("/mixed_companies/search", body)
            orgs = data.get("organizations") or data.get("accounts") or []
            if not orgs:
                break
            results.extend(self._normalise_org(o) for o in orgs)
            pagination = data.get("pagination") or {}
            if page >= int(pagination.get("total_pages", page)):
                break

        logger.info("apollo search_companies returned %d orgs", len(results))
        return results

    async def search_decision_makers(
        self, org_ids: list[str], titles: list[str]
    ) -> list[dict]:
        if not org_ids:
            return []
        body: dict[str, Any] = {
            "organization_ids": org_ids,
            "person_titles": titles,
            "person_seniorities": ["c_suite", "vp", "director", "manager"],
            "per_page": self.DEFAULT_PER_PAGE,
        }
        results: list[dict] = []
        for page in range(1, self.MAX_PAGES + 1):
            body["page"] = page
            # `/mixed_people/api_search` is the API-only people-search
            # endpoint. The legacy `/people/search` returns 422 with a
            # "deprecated for API callers" body now — not 200 with a
            # silent migration, a hard error.
            data = await self._post("/mixed_people/api_search", body)
            people = data.get("people") or data.get("contacts") or []
            if not people:
                break
            results.extend(self._normalise_person(p) for p in people)
            pagination = data.get("pagination") or {}
            if page >= int(pagination.get("total_pages", page)):
                break
        return results

    # ------------------------------------------------------- public API: enrich

    async def enrich_contact(self, apollo_contact_id: str) -> dict:
        cache_key = f"apollo:contact:{apollo_contact_id}"
        cached = await self._redis.get(cache_key)
        if cached:
            try:
                return json.loads(_decode(cached))
            except (ValueError, TypeError):
                pass

        data = await self._post("/people/match", {"id": apollo_contact_id})
        person = data.get("person") or data.get("matched_person") or {}
        enriched = {
            "apollo_contact_id": apollo_contact_id,
            "email": person.get("email"),
            "email_status": person.get("email_status"),
            "phone_numbers": person.get("phone_numbers") or [],
            "linkedin_url": person.get("linkedin_url"),
            "title": person.get("title"),
            "full_name": person.get("name"),
            "organization_id": (person.get("organization") or {}).get("id"),
        }
        await self._redis.set(
            cache_key, json.dumps(enriched), ex=self.CACHE_TTL_SECONDS
        )
        return enriched

    # -------------------------------------------------------------- normalisers

    @staticmethod
    def _normalise_org(org: dict) -> dict:
        return {
            "apollo_org_id": org.get("id"),
            "company_name": org.get("name"),
            "domain": org.get("primary_domain") or org.get("website_url"),
            "industry": org.get("industry"),
            "employee_count": org.get("estimated_num_employees"),
            "country": org.get("country"),
            "linkedin_url": org.get("linkedin_url"),
            "technologies": [
                t.get("name")
                for t in (org.get("technologies") or [])
                if isinstance(t, dict) and t.get("name")
            ],
            "job_postings": org.get("current_open_jobs") or [],
            "funding_events": org.get("funding_events") or [],
            "latest_funding_stage": org.get("latest_funding_stage"),
            "funding_within_months": _months_since(
                org.get("latest_funding_round_date")
            ),
            "recent_leadership_change": bool(org.get("recent_leadership_change")),
        }

    @staticmethod
    def _normalise_person(p: dict) -> dict:
        # Apollo's API returns first_name + last_name separately and an
        # already-stitched `name` field. Prefer the stitched value when
        # present, fall back to building it from the parts so we don't
        # end up with `None None` if only one half is set.
        full_name = p.get("name")
        if not full_name:
            parts = [p.get("first_name") or "", p.get("last_name") or ""]
            full_name = " ".join(s for s in parts if s).strip() or None
        return {
            "apollo_contact_id": p.get("id"),
            "first_name": p.get("first_name"),
            "last_name": p.get("last_name"),
            "full_name": full_name,
            "title": p.get("title"),
            "email": p.get("email"),
            "email_status": p.get("email_status"),
            "linkedin_url": p.get("linkedin_url"),
            "phone_numbers": p.get("phone_numbers") or [],
            "organization_id": (p.get("organization") or {}).get("id"),
            "organization_name": (p.get("organization") or {}).get("name"),
        }


# -------------------------------------------------------------------- helpers


def _decode(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode()
    return str(value)


def _parse_retry_after(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _months_since(iso_date: Optional[str]) -> Optional[int]:
    if not iso_date:
        return None
    try:
        then = dt.datetime.fromisoformat(str(iso_date).replace("Z", "+00:00"))
    except ValueError:
        return None
    now = dt.datetime.now(then.tzinfo or dt.timezone.utc)
    return max(int((now - then).days / 30), 0)
