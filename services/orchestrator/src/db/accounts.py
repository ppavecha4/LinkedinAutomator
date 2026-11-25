"""A customer's own sending accounts, from the credential vault (slice 3.4).

The senders and the reply poller call these inside the campaign's (or
mailbox's) tenant. Only VERIFIED accounts are used: an account that never
passed "Verify" in the dashboard (POST /api/credentials/:id/verify) sends
nothing. The operator org keeps using its .env settings and never comes
through here.

Field names are the contract with the dashboard's Connect form
(dashboard/src/lib/workspace.ts):

  google_workspace  meta.email, meta.from_name?; secret.app_password
  smtp              meta.from_email, meta.from_name?, meta.host, meta.port,
                    meta.username, meta.imap_host?, meta.imap_port?;
                    secret.password
  twilio            meta.account_id, meta.whatsapp_from,
                    meta.template_sid?, meta.template_sid_<lang>?;
                    secret.auth_token

A customer-entered mail server is resolved and must be public; the
connection then goes to the address that was checked (`connect_ip`), with
TLS verified against the name — no DNS rebinding between check and use.
"""
from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass, field, replace
from typing import Any, Optional

try:
    from db.vault import load_credential
except ImportError:  # imported as src.db.accounts
    from src.db.vault import load_credential  # type: ignore

EMAIL_PROVIDERS = ("google_workspace", "smtp")
SMTP_PORTS = {25, 465, 587, 2525}
IMAP_PORTS = {993}
_HOSTNAME = re.compile(r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$", re.I)


class AccountError(Exception):
    """A connected account can't be used (shown in logs, never secrets)."""


def is_public_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return addr.is_global and not addr.is_multicast


def resolve_public(host: str, port: int, resolver=None) -> str:
    """The first address of `host`, if EVERY address is public."""
    host = (host or "").strip().lower().rstrip(".")
    if not _HOSTNAME.match(host):
        raise AccountError(f"mail server must be a name, got {host!r}")
    infos = (resolver or socket.getaddrinfo)(host, port, proto=socket.IPPROTO_TCP)
    ips = [i[4][0] for i in infos]
    if not ips or not all(is_public_ip(ip) for ip in ips):
        raise AccountError(f"{host} is not a public mail server")
    return ips[0]


@dataclass(frozen=True)
class EmailAccount:
    provider: str
    label: str
    from_email: str
    from_name: str
    smtp_host: str              # name: TLS is verified against it
    smtp_port: int
    username: str
    password: str = field(repr=False)
    connect_ip: Optional[str]   # pinned address for customer servers (None: by name)
    imap_host: Optional[str]
    imap_port: int = 993

    @property
    def implicit_tls(self) -> bool:
        return self.smtp_port == 465


@dataclass(frozen=True)
class WhatsAppAccount:
    label: str
    account_sid: str
    auth_token: str = field(repr=False)
    from_number: str = ""
    templates: dict = field(default_factory=dict)   # "" = default, else language → Content SID
    # The SECOND approved template, for follow-ups (slice 3.10); same shape.
    followup_templates: dict = field(default_factory=dict)

    def template_for(self, language: Optional[str]) -> Optional[str]:
        lang = (language or "").split("-", 1)[0].lower()
        return self.templates.get(lang) or self.templates.get("") or None

    def followup_template_for(self, language: Optional[str]) -> Optional[str]:
        lang = (language or "").split("-", 1)[0].lower()
        return self.followup_templates.get(lang) or self.followup_templates.get("") or None


async def _verified_label(conn: Any, providers: tuple[str, ...]) -> Optional[tuple[str, str]]:
    row = await conn.fetchrow(
        """
        SELECT provider, label FROM org_credentials
         WHERE provider = ANY($1::text[]) AND status = 'VERIFIED' AND secret_enc IS NOT NULL
         ORDER BY (label = 'default') DESC, verified_at DESC NULLS LAST
         LIMIT 1
        """,
        list(providers),
    )
    return (row["provider"], row["label"]) if row else None


def email_account_from(provider: str, label: str, secret: dict, meta: dict, *, resolver=None) -> EmailAccount:
    """Build the account from a decrypted credential (pure, testable)."""
    if provider == "google_workspace":
        addr = str(meta.get("email") or "").strip()
        if "@" not in addr or not secret.get("app_password"):
            raise AccountError("Google Workspace account is missing the address or app password")
        return EmailAccount(provider, label, addr, str(meta.get("from_name") or "").strip(),
                            "smtp.gmail.com", 587, addr, secret["app_password"], None, "imap.gmail.com")
    if provider == "smtp":
        addr = str(meta.get("from_email") or "").strip()
        host = str(meta.get("host") or "").strip().lower()
        port = int(meta.get("port") or 587)
        if "@" not in addr or not host or not secret.get("password"):
            raise AccountError("mail server account is incomplete")
        if port not in SMTP_PORTS:
            raise AccountError(f"port {port} is not allowed for sending mail")
        ip = resolve_public(host, port, resolver)
        imap_host = str(meta.get("imap_host") or "").strip().lower() or None
        imap_port = int(meta.get("imap_port") or 993)
        if imap_port not in IMAP_PORTS:
            imap_host = None
        return EmailAccount(provider, label, addr, str(meta.get("from_name") or "").strip(),
                            host, port, str(meta.get("username") or addr).strip(), secret["password"],
                            ip, imap_host, imap_port)
    raise AccountError(f"{provider} is not an email provider this sender supports")


async def email_account(conn: Any, *, resolver=None) -> Optional[EmailAccount]:
    """The current org's verified email account, or None."""
    found = await _verified_label(conn, EMAIL_PROVIDERS)
    if not found:
        return None
    cred = await load_credential(conn, found[0], found[1])
    if cred is None:
        return None
    return email_account_from(found[0], found[1], cred.secret, cred.meta, resolver=resolver)


def whatsapp_account_from(label: str, secret: dict, meta: dict) -> WhatsAppAccount:
    sid = str(meta.get("account_id") or "").strip()
    token = str(secret.get("auth_token") or "")
    from_number = re.sub(r"[\s()-]", "", str(meta.get("whatsapp_from") or "")).replace("whatsapp:", "")
    if not re.fullmatch(r"AC[0-9a-fA-F]{32}", sid) or not token or not re.fullmatch(r"\+[1-9]\d{6,14}", from_number):
        raise AccountError("Twilio account is incomplete (Account SID, auth token, WhatsApp number)")
    templates: dict[str, str] = {}
    followups: dict[str, str] = {}
    for k, v in meta.items():
        if not isinstance(v, str) or not v.strip():
            continue
        if k == "template_sid":
            templates[""] = v.strip()
        elif k.startswith("template_sid_"):
            templates[k[len("template_sid_"):].lower()] = v.strip()
        elif k == "followup_template_sid":
            followups[""] = v.strip()
        elif k.startswith("followup_template_sid_"):
            followups[k[len("followup_template_sid_"):].lower()] = v.strip()
    return WhatsAppAccount(label, sid, token, from_number, templates, followups)


async def with_approved_templates(conn: Any, account: WhatsAppAccount) -> WhatsAppAccount:
    """Add the templates the AI wrote and Meta approved (V34, slice 9.1) to the account.

    A template ID the company pasted by hand (Connected accounts) wins for its language;
    the approved ones fill the rest, so a non-technical company never has to paste anything.
    PENDING, REJECTED, PAUSED and DISABLED templates are never used.
    """
    try:
        rows = await conn.fetch(
            "SELECT kind, language, content_sid FROM whatsapp_templates WHERE status = 'APPROVED' AND content_sid IS NOT NULL")
    except Exception:  # noqa: BLE001 — before V34 there is no such table: nothing to add
        return account
    templates, followups = dict(account.templates), dict(account.followup_templates)
    for r in rows:
        target = followups if r["kind"] == "followup" else templates
        target.setdefault(str(r["language"]).lower(), str(r["content_sid"]).strip())
    return replace(account, templates=templates, followup_templates=followups)


async def whatsapp_account(conn: Any) -> Optional[WhatsAppAccount]:
    """The current org's verified Twilio WhatsApp account, or None."""
    found = await _verified_label(conn, ("twilio",))
    if not found:
        return None
    cred = await load_credential(conn, "twilio", found[1])
    if cred is None:
        return None
    return await with_approved_templates(conn, whatsapp_account_from(found[1], cred.secret, cred.meta))
