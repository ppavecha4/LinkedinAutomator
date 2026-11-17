"""Contact hours: only message people during their working day.

The business profile (rules.contact_hours, V21; edited in the dashboard)
holds {start: "09:00", end: "19:00", weekdays_only: true}. The window is
the PROSPECT's local time, so a message to Lima and one to Dubai go out at
different moments. The recipient's zone comes from their country (the
contact's own, else the company's); when we don't know it, the sending
company's own time zone is used rather than guessing.

A message outside the window is DEFERRED, not blocked: it stays queued and
the next send run picks it up once the window opens. start is inclusive,
end exclusive.
"""
from __future__ import annotations

import datetime as dt
from typing import Any, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

try:
    from agents.country_timezones import COUNTRY_TIMEZONE
    from agents.language import country_iso2
except ImportError:  # imported as src.agents.contact_hours
    from src.agents.country_timezones import COUNTRY_TIMEZONE  # type: ignore
    from src.agents.language import country_iso2  # type: ignore


def _minutes(hhmm: str) -> Optional[int]:
    try:
        h, m = hhmm.split(":")
        h, m = int(h), int(m)
    except (ValueError, AttributeError):
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def recipient_timezone(*countries: Optional[str], org_timezone: Optional[str] = None) -> str:
    """The first known country's zone, else the org's own, else UTC."""
    for c in countries:
        iso = country_iso2(c)
        if iso and iso in COUNTRY_TIMEZONE:
            return COUNTRY_TIMEZONE[iso]
    return org_timezone or "UTC"


def _zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def within_contact_hours(
    hours: Optional[dict[str, Any]],
    *,
    countries: tuple[Optional[str], ...] = (),
    org_timezone: Optional[str] = None,
    now: Optional[dt.datetime] = None,
) -> tuple[bool, str]:
    """(allowed now?, why not). No hours set → always allowed."""
    if not hours:
        return True, ""
    start, end = _minutes(str(hours.get("start", ""))), _minutes(str(hours.get("end", "")))
    if start is None or end is None or start >= end:
        return True, ""  # a malformed rule must never silence the whole account
    tz = recipient_timezone(*countries, org_timezone=org_timezone)
    local = (now or dt.datetime.now(dt.timezone.utc)).astimezone(_zone(tz))
    if hours.get("weekdays_only", True) and local.weekday() >= 5:
        return False, f"outside contact hours (weekend in {tz})"
    minute = local.hour * 60 + local.minute
    if not (start <= minute < end):
        return False, (f"outside contact hours ({local:%H:%M} in {tz}; "
                       f"allowed {hours['start']}–{hours['end']})")
    return True, ""
