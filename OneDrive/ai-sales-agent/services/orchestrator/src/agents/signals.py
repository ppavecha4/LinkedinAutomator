"""Signal derivation — maps raw enrichment/contact/company data to the
signal-name vocabulary that PitchSelector scores against.

Pure and deterministic. Callable from the graph's `score_and_select_pitch`
node AND from ad-hoc analysis / backfills. If upstream enrichment already
provides an explicit `signals_detected` dict, those are always honoured —
the observation layer is the source of truth when it says so explicitly.
"""

from __future__ import annotations

from typing import Any, Iterable, List


def _get(obj: Any, attr: str, default: str = "") -> Any:
    """Read an attribute off either a dict or a dataclass/object."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(attr, default)
    return getattr(obj, attr, default)


def _lower_list(items: Iterable[Any]) -> List[str]:
    return [str(x).lower() for x in (items or [])]


def derive_signals(
    enrichment: dict,
    contact: Any,
    company: Any,
) -> List[str]:
    """Return a sorted list of signal names present for this contact/company.

    Steps:
      1. Honour any explicit `enrichment["signals_detected"]` dict first.
      2. Derive from company industry string.
      3. Derive from contact title string.
      4. Derive from enrichment technology stack.
      5. Derive from enrichment job postings.
      6. Derive from enrichment funding stage.
      7. If nothing matched, emit the fallback `no_tech_signals`.
    """
    signals: set[str] = set()
    enrichment = enrichment or {}

    # 1) Upstream-supplied explicit signals (source of truth when present)
    explicit = enrichment.get("signals_detected") or {}
    if isinstance(explicit, dict):
        for name, value in explicit.items():
            if value:
                signals.add(name)
    elif isinstance(explicit, (list, tuple, set)):
        signals.update(str(x) for x in explicit)

    # 2) Company industry
    industry = str(_get(company, "industry", "")).lower()
    if "manufactur" in industry:
        signals.add("industry_manufacturing")
    if "logistic" in industry or "supply chain" in industry or "freight" in industry:
        signals.add("industry_logistics")
    if (
        "fintech" in industry
        or "saas" in industry
        or "software" in industry
        or "b2b tech" in industry
    ):
        signals.add("industry_fintech_saas")
    if "health" in industry or "medical" in industry or "pharma" in industry:
        signals.add("industry_healthcare")
    if any(k in industry for k in ("legal services", "accounting", "real estate", "traditional")):
        signals.add("industry_traditional")

    # 3) Contact title
    title = str(_get(contact, "title", "")).lower()
    if any(k in title for k in ("cto", "vp engineering", "vp of engineering", "head of engineering")):
        signals.add("title_cto_vp_engineering")
    if any(
        k in title for k in ("coo", "vp operations", "vp of operations", "head of operations", "chief operating")
    ):
        signals.add("title_coo_vp_operations")
    if any(
        k in title
        for k in ("ceo", "chief executive", "managing director", "founder", " md ", "md,", "md ")
    ) or title.endswith(" md") or title == "md":
        signals.add("title_ceo_md")
    if any(k in title for k in ("cio", "head of it", "it director", "chief information")):
        signals.add("title_cio_head_it")
    if "digital" in title or "innovation" in title or "transformation" in title:
        signals.add("title_digital_innovation")

    # 4) Technology stack
    techs = _lower_list(enrichment.get("technologies", []))
    if any(
        "sap" in t or "oracle ebs" in t or "peoplesoft" in t or "mainframe" in t or "as/400" in t
        for t in techs
    ):
        signals.add("uses_legacy_erp")
    if any(t in {"aws", "gcp", "azure"} or "cloud" in t for t in techs):
        signals.add("uses_cloud_platform")
    if any("zapier" in t or "make.com" in t or "integromat" in t or "n8n" in t for t in techs):
        signals.add("uses_zapier_or_make")
    if any(t in {"salesforce", "hubspot", "pipedrive"} for t in techs):
        signals.add("uses_modern_crm")

    # 5) Job postings
    postings = _lower_list(enrichment.get("job_postings", []))
    for p in postings:
        if "ml engineer" in p or "machine learning" in p or "ai engineer" in p:
            signals.add("hiring_ai_ml_engineer")
        if "digital transformation" in p:
            signals.add("hiring_digital_transformation")
        if "operations analyst" in p or "ops analyst" in p:
            signals.add("hiring_operations_analyst")
        if "rpa" in p or "automation developer" in p:
            signals.add("hiring_rpa_developer")
        if "data scientist" in p:
            signals.add("hiring_data_scientist")

    # 6) Funding stage
    funding = str(enrichment.get("latest_funding_stage") or "").lower()
    if "series b" in funding or "series c" in funding:
        signals.add("recently_funded_series_b_c")

    # 7) Fallback
    if not signals:
        signals.add("no_tech_signals")

    return sorted(signals)


__all__ = ["derive_signals"]
