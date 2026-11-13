"""Phase 2 slice 1 — message generation follows the campaign's channels."""
from __future__ import annotations

import pytest

smoke = pytest.importorskip("scripts.smoke_test_campaign")


def test_customer_whatsapp_email_campaign_never_gets_linkedin():
    assert smoke.campaign_text_channels(["whatsapp", "email"]) == ["email", "whatsapp"]


def test_appson_keeps_its_full_text_mix():
    assert smoke.campaign_text_channels(["linkedin", "email", "whatsapp", "voice"]) == [
        "linkedin", "email", "whatsapp",
    ]


def test_voice_only_campaign_generates_no_text():
    assert smoke.campaign_text_channels(["voice"]) == []


def test_rows_read_before_v19_keep_the_old_behaviour():
    assert smoke.campaign_text_channels(None) == ["linkedin", "email", "whatsapp"]
