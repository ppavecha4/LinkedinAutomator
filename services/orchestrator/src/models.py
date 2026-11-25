"""Typed domain models used across orchestrator agents, graph nodes, and tools.

Kept intentionally minimal and dependency-free (stdlib `dataclasses` only).
These are the objects the PersonalizationAgent / CampaignGraph consume —
the actual DB rows are wider; these only carry the fields the AI layer needs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class Contact:
    id: str
    full_name: str
    first_name: str = ""
    title: str = ""
    email: Optional[str] = None
    phone_e164: Optional[str] = None
    linkedin_urn: Optional[str] = None
    apollo_contact_id: Optional[str] = None
    company_id: Optional[str] = None


@dataclass
class Company:
    id: str
    company_name: str
    industry: str = ""
    company_size: int = 0
    country: str = ""
    website: Optional[str] = None
    apollo_org_id: Optional[str] = None


@dataclass
class Campaign:
    id: str
    goal: str
    sender_company: str
    sender_name: str
    value_proposition: str
    icp_criteria: Dict[str, Any] = field(default_factory=dict)
    channels: List[str] = field(default_factory=lambda: ["email"])
    titles: List[str] = field(default_factory=list)


__all__ = ["Contact", "Company", "Campaign"]
