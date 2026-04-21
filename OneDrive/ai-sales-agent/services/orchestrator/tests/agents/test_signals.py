"""Tests for agents.signals.derive_signals."""

from __future__ import annotations

from agents.signals import derive_signals
from models import Company, Contact


def test_explicit_signals_are_honoured_first():
    enrichment = {
        "signals_detected": {"hiring_ai_ml_engineer": True, "irrelevant": False},
    }
    company = Company(id="co", company_name="Acme")
    contact = Contact(id="ct", full_name="Jane")
    out = derive_signals(enrichment, contact, company)
    assert "hiring_ai_ml_engineer" in out
    assert "irrelevant" not in out


def test_industry_fintech_saas_detected():
    company = Company(id="co", company_name="A", industry="B2B Tech / SaaS")
    contact = Contact(id="ct", full_name="x")
    out = derive_signals({}, contact, company)
    assert "industry_fintech_saas" in out


def test_title_cto_bucket():
    company = Company(id="co", company_name="A")
    contact = Contact(id="ct", full_name="x", title="Chief Technology Officer (CTO)")
    out = derive_signals({}, contact, company)
    assert "title_cto_vp_engineering" in out


def test_title_ceo_bucket():
    company = Company(id="co", company_name="A")
    contact = Contact(id="ct", full_name="x", title="Founder & CEO")
    out = derive_signals({}, contact, company)
    assert "title_ceo_md" in out


def test_legacy_erp_detected_from_tech_stack():
    company = Company(id="co", company_name="A", industry="manufacturing")
    contact = Contact(id="ct", full_name="x", title="COO")
    enrichment = {"technologies": ["SAP ECC", "Salesforce"]}
    out = derive_signals(enrichment, contact, company)
    assert "uses_legacy_erp" in out
    assert "industry_manufacturing" in out
    assert "title_coo_vp_operations" in out
    assert "uses_modern_crm" in out


def test_hiring_ai_ml_engineer_from_postings():
    company = Company(id="co", company_name="A")
    contact = Contact(id="ct", full_name="x")
    enrichment = {"job_postings": ["Senior ML Engineer (LLMs)"]}
    out = derive_signals(enrichment, contact, company)
    assert "hiring_ai_ml_engineer" in out


def test_series_b_funding_detected():
    company = Company(id="co", company_name="A")
    contact = Contact(id="ct", full_name="x")
    out = derive_signals(
        {"latest_funding_stage": "Series B - $40M"}, contact, company
    )
    assert "recently_funded_series_b_c" in out


def test_no_tech_signals_fallback():
    company = Company(id="co", company_name="A")
    contact = Contact(id="ct", full_name="x")
    out = derive_signals({}, contact, company)
    assert out == ["no_tech_signals"]


def test_result_is_sorted_and_deduped():
    company = Company(id="co", company_name="A", industry="SaaS")
    contact = Contact(id="ct", full_name="x", title="CTO")
    out = derive_signals(
        {"signals_detected": {"industry_fintech_saas": True}}, contact, company
    )
    assert out == sorted(set(out))
    assert out.count("industry_fintech_saas") == 1
