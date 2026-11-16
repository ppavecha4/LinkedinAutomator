"""The business profile's rules, as the engine applies them (SaaS slice 3.2).

The profile (org_profiles, V21; edited in the dashboard, validated by
services/api/src/lib/profile.ts) holds five JSONB sections. This module
turns the parts the engine must OBEY into checks:

  customers.never_contact   existing customers, competitors, partners —
                            never written to, at discovery, import or send.
  rules.blocked_countries   prospects in these countries are skipped.
  company.languages_handled the team can only answer replies in these
                            languages, so we only write in them.

and the parts the WRITER uses (voice, allowed proof, price policy, meeting
link) into a prompt block — see writer_rules().

Never-contact entries are matched the same way here and in the API
(services/api/src/lib/neverContact.ts — keep the two in step):
  - "jane@acme.com"  an exact email address;
  - "acme.com"       a domain: matches acme.com and any subdomain
                     (eu.acme.com), by email domain or company website;
  - "Grupo Andino"   a company name: matches after lowercasing, removing
                     accents and punctuation and a trailing legal form
                     ("Grupo Andino S.A.C." → "grupo andino").
"""
from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable

try:
    from agents.language import country_iso2, limit_to_handled
except ImportError:  # imported as src.agents.profile_rules
    from src.agents.language import country_iso2, limit_to_handled  # type: ignore

SECTIONS = ("company", "offer", "customers", "voice", "rules")

# Legal forms dropped from the END of a company name before comparing.
# Several words may trail ("Acme Holdings Pvt Ltd" → "acme holdings").
LEGAL_FORMS = frozenset("""
    sa sac saa sas sl slu srl sapi sab spa ltda eireli eirl cia
    ltd limited llc llp lp plc inc incorporated corp corporation co company
    gmbh ag kg ug ohg bv nv sarl sasu sprl oy ab as asa aps
    pvt private pte pty kk
""".split())

_DOMAIN_RE = re.compile(r"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$")


def normalize_domain(value: str | None) -> str | None:
    """'https://www.Acme.com/about' → 'acme.com'; not a domain → None."""
    if not value:
        return None
    v = value.strip().lower()
    v = re.sub(r"^[a-z][a-z0-9+.-]*://", "", v)
    v = v.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
    v = v.rsplit("@", 1)[-1].split(":", 1)[0].rstrip(".")
    if v.startswith("www."):
        v = v[4:]
    return v if _DOMAIN_RE.match(v) else None


def normalize_company_name(value: str | None) -> str:
    """'Grupo Andino S.A.C.' → 'grupo andino'. Empty when nothing is left."""
    if not value:
        return ""
    v = unicodedata.normalize("NFKD", value)
    v = "".join(ch for ch in v if not unicodedata.combining(ch)).lower()
    v = v.replace("&", " and ")
    v = re.sub(r"(?<=\w)\.(?=\w)", "", v)  # S.A.C. → SAC, keeps "acme. inc"
    v = re.sub(r"[^a-z0-9]+", " ", v).split()
    while len(v) > 1 and v[-1] in LEGAL_FORMS:
        v.pop()
    return " ".join(v)


@dataclass(frozen=True)
class NeverContact:
    emails: frozenset[str] = frozenset()
    domains: frozenset[str] = frozenset()
    names: frozenset[str] = frozenset()

    @classmethod
    def from_entries(cls, entries: Iterable[Any] | None) -> "NeverContact":
        emails, domains, names = set(), set(), set()
        for raw in entries or ():
            if not isinstance(raw, str) or not raw.strip():
                continue
            e = raw.strip().lower().lstrip("@")  # "@acme.com" means the domain
            if "@" in e and " " not in e:
                emails.add(e)
                continue
            d = normalize_domain(e) if " " not in e else None
            if d:
                domains.add(d)
                continue
            n = normalize_company_name(e)
            if n:
                names.add(n)
        return cls(frozenset(emails), frozenset(domains), frozenset(names))

    def __bool__(self) -> bool:
        return bool(self.emails or self.domains or self.names)

    def _domain_hit(self, domain: str | None) -> str | None:
        d = normalize_domain(domain)
        if not d:
            return None
        labels = d.split(".")
        for i in range(len(labels) - 1):
            cand = ".".join(labels[i:])
            if cand in self.domains:
                return cand
        return None

    def match(self, *, email: str | None = None, domain: str | None = None,
              company_name: str | None = None) -> str | None:
        """The never-contact entry this person/company hits, or None."""
        if email:
            e = email.strip().lower()
            if e in self.emails:
                return e
            hit = self._domain_hit(e.rsplit("@", 1)[-1])
            if hit:
                return hit
        hit = self._domain_hit(domain)
        if hit:
            return hit
        n = normalize_company_name(company_name)
        if n and n in self.names:
            return n
        return None


@dataclass(frozen=True)
class ProfileRules:
    never_contact: NeverContact = field(default_factory=NeverContact)
    blocked_countries: frozenset[str] = frozenset()
    languages_handled: tuple[str, ...] = ()

    @classmethod
    def from_profile(cls, profile: dict | None) -> "ProfileRules":
        p = profile or {}
        customers = p.get("customers") or {}
        rules = p.get("rules") or {}
        company = p.get("company") or {}
        blocked = {c.upper() for c in rules.get("blocked_countries") or [] if isinstance(c, str)}
        langs: list[str] = []
        for tag in company.get("languages_handled") or []:
            if isinstance(tag, str) and tag.strip() and tag.strip() not in langs:
                langs.append(tag.strip())
        return cls(NeverContact.from_entries(customers.get("never_contact")),
                   frozenset(blocked), tuple(langs))

    def country_blocked(self, country: str | None) -> bool:
        iso = country_iso2(country)
        return bool(iso and iso in self.blocked_countries)

    def skip_reason(self, *, email: str | None = None, domain: str | None = None,
                    company_name: str | None = None, country: str | None = None) -> str | None:
        """Why this prospect must not be contacted, or None if they may be."""
        hit = self.never_contact.match(email=email, domain=domain, company_name=company_name)
        if hit:
            return f"never-contact list ({hit})"
        if self.country_blocked(country):
            return f"blocked country ({country_iso2(country)})"
        return None


def skip_reason_for_prospect(rules: ProfileRules, prospect: dict) -> str | None:
    """skip_reason() for a discovery prospect dict ({company, contact})."""
    company = prospect.get("company") or {}
    contact = prospect.get("contact") or {}
    return rules.skip_reason(
        email=contact.get("email"),
        domain=company.get("domain"),
        company_name=company.get("company_name"),
        country=contact.get("country") or company.get("country"),
    )


async def load_profile(conn: Any, org_id: str) -> dict:
    """The org's profile sections ({} each when there is no row). Runs
    inside the org's tenant (RLS on org_profiles)."""
    row = await conn.fetchrow(
        "SELECT company, offer, customers, voice, rules FROM org_profiles WHERE org_id = $1",
        org_id,
    )
    out: dict[str, dict] = {}
    for s in SECTIONS:
        v = row[s] if row else None
        if isinstance(v, str):
            v = json.loads(v or "{}")
        out[s] = v if isinstance(v, dict) else {}
    return out


# ── The writer's block ───────────────────────────────────────────────────

_FORMALITY = {
    "formal": ("Address the prospect formally, as is polite in that language "
               "(for example usted in Spanish, Sie in German, vous in French)."),
    "informal": ("Address the prospect informally but professionally (for example "
                 "tú in Spanish, du in German, tu in French)."),
}
EXAMPLE_MAX_CHARS = 1500


def writer_rules(profile: dict | None, channel: str) -> str:
    """Prompt lines from the profile for a customer campaign's writer.
    Only proof the customer marked may_mention is ever included — the rest
    never reaches the model."""
    p = profile or {}
    offer = p.get("offer") or {}
    voice = p.get("voice") or {}
    lines: list[str] = []

    if voice.get("sender_title"):
        lines.append(f"The sender's role is {voice['sender_title']}; write as that person.")
    formality = _FORMALITY.get(voice.get("formality") or "")
    if formality:
        lines.append(formality)

    items = [x for x in offer.get("proof") or [] if isinstance(x, dict) and (x.get("text") or "").strip()]
    proof = [x["text"].strip() for x in items if x.get("may_mention") is True]
    if proof:
        lines.append("Proof you MAY cite (only these; at most one per message): " + "; ".join(proof[:15]) + ".")
    elif items:
        # They have proof but keep all of it private.
        lines.append("Do not cite any customer names, certifications, numbers or results.")

    if offer.get("price_policy") == "starting_price":
        lines.append("Do not state any price figure; you may offer to share pricing.")
    else:
        lines.append("Never mention prices, costs or discounts.")

    avoid = [a.strip() for a in voice.get("avoid") or [] if isinstance(a, str) and a.strip()]
    if avoid:
        lines.append("Never use these words or claims (or translations of them): " + ", ".join(avoid[:30]) + ".")

    link = (voice.get("meeting_link") or "").strip()
    if link and channel in ("email", "whatsapp"):
        lines.append(f"If you ask for a meeting, include this booking link once, exactly: {link}")
    elif channel == "linkedin":
        lines.append("Do not include any links.")

    out = "".join(f"  - {line}\n" for line in lines)
    example = (voice.get("example") or "").strip()
    if example:
        out += ("STYLE REFERENCE — a message that worked for them. Match its length, rhythm "
                "and tone only; do NOT reuse its facts, names, numbers or claims:\n"
                "<example>\n" + example[:EXAMPLE_MAX_CHARS] + "\n</example>\n")
    return out


def sender_name(campaign: dict, profile: dict | None) -> str:
    """The campaign's sender, else the profile's."""
    return (campaign.get("sender_name") or ((profile or {}).get("voice") or {}).get("sender_name") or "").strip()


def handled_languages(profile: dict | None) -> list[str]:
    return list(ProfileRules.from_profile(profile).languages_handled)


__all__ = [
    "NeverContact", "ProfileRules", "load_profile", "limit_to_handled", "normalize_company_name",
    "normalize_domain", "sender_name", "skip_reason_for_prospect", "writer_rules", "handled_languages",
]

