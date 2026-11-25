"""Suppression service — Redis fast-path with Postgres fallback.

Per CLAUDE.md principle 1: every outgoing message MUST pass a suppression
check before anything else. ComplianceError is raised on violations and
MUST NOT be silently swallowed.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)


class ComplianceError(Exception):
    """Base compliance violation. Never silently swallow."""


class SuppressionService:
    """Async suppression checker backed by Redis (hot) and Postgres (truth).

    Redis keys:
        suppression:email:{sha256(lowercased email)}
        suppression:phone:{whatsapp_number}
        suppression:li:{linkedin_urn}

    - Hits read from Postgres are cached in Redis with TTL=3600s.
    - Writes from suppress() are permanent (no TTL).
    """

    CACHE_TTL_SECONDS = 3600

    def __init__(self, redis_client, pg_pool) -> None:
        self._redis = redis_client
        self._pg = pg_pool

    # ---------- keys ----------

    @staticmethod
    def _redis_key(field: str, value: str) -> str:
        return f"suppression:{field}:{value.lower().strip()}"

    @staticmethod
    def _hash_email(email: str) -> str:
        return hashlib.sha256(email.lower().strip().encode("utf-8")).hexdigest()

    # ---------- reads ----------

    async def is_suppressed(
        self,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        linkedin_urn: Optional[str] = None,
        linkedin_url: Optional[str] = None,  # reserved, not used for lookup
    ) -> bool:
        """Return True if ANY of the supplied identities is suppressed."""
        # (redis_field, redis_value, pg_column, pg_value)
        identities: list[tuple[str, str, str, str]] = []
        if email:
            identities.append(
                ("email", self._hash_email(email), "email", email.lower().strip())
            )
        if phone:
            identities.append(("phone", phone.strip(), "whatsapp_number", phone.strip()))
        if linkedin_urn:
            identities.append(
                ("li", linkedin_urn.strip(), "linkedin_urn", linkedin_urn.strip())
            )

        if not identities:
            return False

        # ---- Redis fast path ----
        for field, redis_val, _, _ in identities:
            key = self._redis_key(field, redis_val)
            hit = await self._redis.get(key)
            if hit:
                logger.info("suppression redis hit key=%s", key)
                return True

        # ---- Postgres fallback ----
        async with self._pg.acquire() as conn:
            for field, redis_val, pg_col, pg_val in identities:
                if pg_col == "email":
                    row = await conn.fetchrow(
                        "SELECT id FROM suppression_list "
                        "WHERE lower(email) = $1 AND expires_at IS NULL LIMIT 1",
                        pg_val,
                    )
                elif pg_col == "whatsapp_number":
                    row = await conn.fetchrow(
                        "SELECT id FROM suppression_list "
                        "WHERE whatsapp_number = $1 AND expires_at IS NULL LIMIT 1",
                        pg_val,
                    )
                elif pg_col == "linkedin_urn":
                    row = await conn.fetchrow(
                        "SELECT id FROM suppression_list "
                        "WHERE linkedin_urn = $1 AND expires_at IS NULL LIMIT 1",
                        pg_val,
                    )
                else:
                    row = None

                if row:
                    key = self._redis_key(field, redis_val)
                    await self._redis.set(key, "1", ex=self.CACHE_TTL_SECONDS)
                    logger.info(
                        "suppression pg hit cached key=%s ttl=%ds",
                        key,
                        self.CACHE_TTL_SECONDS,
                    )
                    return True

        return False

    # ---------- writes ----------

    async def suppress(
        self,
        contact_id: Optional[str],
        reason: str,
        email: Optional[str] = None,
        phone: Optional[str] = None,
        linkedin_urn: Optional[str] = None,
        linkedin_url: Optional[str] = None,
        expires_at: Optional[dt.datetime] = None,
    ) -> None:
        """Suppress all supplied identities.

        If ``expires_at`` is provided the suppression is a *pause* — a temporary
        hold until that timestamp (e.g. while a meeting sits on the calendar).
        Without ``expires_at`` the suppression is permanent.
        """
        norm_email = email.lower().strip() if email else None
        norm_phone = phone.strip() if phone else None
        norm_urn = linkedin_urn.strip() if linkedin_urn else None
        norm_url = linkedin_url.strip() if linkedin_url else None

        async with self._pg.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    """
                    INSERT INTO suppression_list
                        (email, whatsapp_number, linkedin_urn, linkedin_url,
                         reason, contact_id, expires_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    """,
                    norm_email,
                    norm_phone,
                    norm_urn,
                    norm_url,
                    reason,
                    contact_id,
                    expires_at,
                )
                await conn.execute(
                    """
                    INSERT INTO compliance_log (action, contact_id, data)
                    VALUES ('SUPPRESSED', $1, $2::jsonb)
                    """,
                    contact_id,
                    json.dumps(
                        {
                            "reason": reason,
                            "email": norm_email,
                            "phone": norm_phone,
                            "linkedin_urn": norm_urn,
                            "expires_at": expires_at.isoformat() if expires_at else None,
                        }
                    ),
                )

        # Redis writes — TTL only if expires_at is set, otherwise permanent.
        redis_ttl: Optional[int] = None
        if expires_at is not None:
            tz = expires_at.tzinfo or dt.timezone.utc
            seconds = int((expires_at - dt.datetime.now(tz=tz)).total_seconds())
            redis_ttl = max(seconds, 1)

        if norm_email:
            await self._redis.set(
                self._redis_key("email", self._hash_email(norm_email)),
                "1",
                ex=redis_ttl,
            )
        if norm_phone:
            await self._redis.set(
                self._redis_key("phone", norm_phone), "1", ex=redis_ttl
            )
        if norm_urn:
            await self._redis.set(
                self._redis_key("li", norm_urn), "1", ex=redis_ttl
            )

        logger.warning(
            "SUPPRESSED contact_id=%s reason=%s email=%s phone=%s linkedin_urn=%s expires_at=%s",
            contact_id,
            reason,
            norm_email,
            norm_phone,
            norm_urn,
            expires_at,
        )
