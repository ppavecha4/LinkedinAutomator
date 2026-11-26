"""Whose accounts carry a call: Twilio (the line), ElevenLabs (the voice), Anthropic (the brain).

Bring-your-own, like every other channel: a customer's calls use the accounts
it connected in the credential vault, and only VERIFIED ones. The operator org
(AUTH_ORG_ID, the Appson deployment) uses .env.

  twilio       secret.auth_token, meta.account_id, meta.voice_from        (the number we call FROM)
  elevenlabs   secret.api_key, meta.voice_id, meta.voice_id_<lang>?, meta.model_id?
  anthropic    secret.api_key
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional

from db.ai_key import budget_used_up, platform_key  # type: ignore
from db.provider_keys import is_operator_org  # type: ignore
from db.vault import load_credential  # type: ignore


class VoiceConfigError(Exception):
    """Calls can't be placed for this company yet (said in plain words, never with secrets)."""


@dataclass
class VoiceConfig:
    twilio_sid: str = ""
    twilio_token: str = field(default="", repr=False)
    from_number: str = ""
    eleven_key: str = field(default="", repr=False)
    voice_id: str = ""
    voices: dict[str, str] = field(default_factory=dict)
    tts_model: str = ""
    anthropic_key: str = field(default="", repr=False)


def _e164(value: str) -> str:
    return re.sub(r"[\s()-]", "", value or "")


async def _verified(conn: Any, provider: str, where: str = "") -> Optional[Any]:
    label = await conn.fetchval(
        f"""
        SELECT label FROM org_credentials
         WHERE provider = $1 AND status = 'VERIFIED' AND secret_enc IS NOT NULL {where}
         ORDER BY (label = 'default') DESC, verified_at DESC NULLS LAST LIMIT 1
        """, provider)
    return await load_credential(conn, provider, label) if label else None


async def load_voice_config(conn: Any) -> VoiceConfig:
    """The current org's accounts for calls. Must run inside a tenant."""
    if is_operator_org():
        cfg = VoiceConfig(
            twilio_sid=os.environ.get("TWILIO_ACCOUNT_SID", "").strip(),
            twilio_token=os.environ.get("TWILIO_AUTH_TOKEN", "").strip(),
            from_number=_e164(os.environ.get("VOICE_FROM_NUMBER", "")),
            eleven_key=os.environ.get("ELEVENLABS_API_KEY", "").strip(),
            voice_id=os.environ.get("ELEVENLABS_VOICE_ID", "").strip(),
            tts_model=os.environ.get("ELEVENLABS_MODEL_ID", "").strip(),
            anthropic_key=os.environ.get("ANTHROPIC_API_KEY", "").strip(),
        )
    else:
        tw = await _verified(conn, "twilio", "AND meta->>'voice_from' IS NOT NULL AND meta->>'voice_from' <> ''")
        el = await _verified(conn, "elevenlabs")
        an = await _verified(conn, "anthropic")
        if tw is None:
            raise VoiceConfigError("connect and verify your Twilio account with a phone number for calls")
        if el is None:
            raise VoiceConfigError("connect and verify your ElevenLabs account")
        voices = {k[len("voice_id_"):].lower(): str(v).strip() for k, v in el.meta.items()
                  if k.startswith("voice_id_") and str(v).strip()}
        cfg = VoiceConfig(
            twilio_sid=str(tw.meta.get("account_id") or "").strip(), twilio_token=tw.secret.get("auth_token", ""),
            from_number=_e164(str(tw.meta.get("voice_from") or "")),
            eleven_key=el.secret.get("api_key", ""), voice_id=str(el.meta.get("voice_id") or "").strip(),
            voices=voices, tts_model=str(el.meta.get("model_id") or "").strip(),
            anthropic_key=(an.secret.get("api_key", "") if an else ""),
        )
        if not cfg.anthropic_key and platform_key():
            # Managed AI: the platform writes the words, within the plan's AI budget.
            if await budget_used_up(conn):
                raise VoiceConfigError("the AI included in your plan is used up: upgrade, connect your own Anthropic account, or on a paid plan wait for the new month")
            cfg.anthropic_key = platform_key()
    if not (cfg.twilio_sid and cfg.twilio_token and cfg.from_number):
        raise VoiceConfigError("Twilio is not set up for calls (account, token and a phone number)")
    if not cfg.eleven_key or not (cfg.voice_id or cfg.voices):
        raise VoiceConfigError("ElevenLabs needs an API key and a voice")
    if not cfg.anthropic_key:
        raise VoiceConfigError("connect your Anthropic account: it writes what the assistant says")
    if not cfg.voice_id:
        cfg.voice_id = next(iter(cfg.voices.values()))
    return cfg
