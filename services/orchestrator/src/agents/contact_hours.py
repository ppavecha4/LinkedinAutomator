"""Contact hours: only message people during their working day.

The business profile (rules.contact_hours, V21; edited in the dashboard)
holds {start: "09:00", end: "19:00", weekdays_only: true}. The window is
the PROSPECT's local time, so a message to Lima and one to Dubai go out at
different moments. The recipient's zone comes from their country (the
contact's own, else the company's); when we don't know it, the sending
company's own time zone is used rather than guessing. "weekdays_only" skips
the recipient's weekend, which is Friday and Saturday in some countries.

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

# date.weekday() numbers: Monday is 0, Sunday is 6.
SATURDAY_SUNDAY = frozenset({5, 6})
FRIDAY_SATURDAY = frozenset({4, 5})

# Countries whose weekend is not Saturday and Sunday (checked 2026-11-27).
# The UAE moved to Saturday-Sunday in 2022; Morocco and Lebanon use it too.
# Countries not listed here are treated as Saturday-Sunday.
OTHER_WEEKENDS: dict[str, frozenset[int]] = {
    "SA": FRIDAY_SATURDAY,  # Saudi Arabia
    "QA": FRIDAY_SATURDAY,  # Qatar
    "KW": FRIDAY_SATURDAY,  # Kuwait
    "BH": FRIDAY_SATURDAY,  # Bahrain
    "OM": FRIDAY_SATURDAY,  # Oman
    "EG": FRIDAY_SATURDAY,  # Egypt
    "JO": FRIDAY_SATURDAY,  # Jordan
}
_WEEKEND_BY_ZONE = {COUNTRY_TIMEZONE[iso]: days for iso, days in OTHER_WEEKENDS.items()}


def _minutes(hhmm: str) -> Optional[int]:
    try:
        h, m = hhmm.split(":")
        h, m = int(h), int(m)
    except (ValueError, AttributeError):
        return None
    return h * 60 + m if 0 <= h < 24 and 0 <= m < 60 else None


def _recipient_country(countries: tuple[Optional[str], ...]) -> Optional[str]:
    """The first country we recognise, as its ISO code."""
    for c in countries:
        iso = country_iso2(c)
        if iso and iso in COUNTRY_TIMEZONE:
            return iso
    return None


def recipient_timezone(*countries: Optional[str], org_timezone: Optional[str] = None) -> str:
    """The first known country's zone, else the org's own, else UTC."""
    iso = _recipient_country(countries)
    return COUNTRY_TIMEZONE[iso] if iso else org_timezone or "UTC"


def weekend_days(*countries: Optional[str], org_timezone: Optional[str] = None) -> frozenset[int]:
    """The recipient's weekend as date.weekday() numbers. Like the time zone,
    it comes from their country; when we don't know it, from where the sending
    company is."""
    iso = _recipient_country(countries)
    if iso:
        return OTHER_WEEKENDS.get(iso, SATURDAY_SUNDAY)
    return _WEEKEND_BY_ZONE.get(org_timezone or "", SATURDAY_SUNDAY)


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
    if hours.get("weekdays_only", True) and local.weekday() in weekend_days(*countries, org_timezone=org_timezone):
        return False, f"outside contact hours (weekend in {tz})"
    minute = local.hour * 60 + local.minute
    if not (start <= minute < end):
        return False, (f"outside contact hours ({local:%H:%M} in {tz}; "
                       f"allowed {hours['start']}–{hours['end']})")
    return True, ""
