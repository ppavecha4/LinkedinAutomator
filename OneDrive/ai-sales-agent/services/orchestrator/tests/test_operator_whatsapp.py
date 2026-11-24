"""The operator's own WhatsApp campaigns: the cron's --customers-only flag must not leave them QUEUED
forever once the operator's WhatsApp is set up (scripts/send_pending_whatsapp.py operator_whatsapp_ready).

Found when an operator campaign's email went out normally while its WhatsApp messages stayed queued:
the cron passed --customers-only, which skipped every operator campaign unconditionally.
"""
from __future__ import annotations

import pytest

sender = pytest.importorskip("scripts.send_pending_whatsapp")

FULL = {
    "TWILIO_ACCOUNT_SID": "AC" + "a" * 32,
    "TWILIO_AUTH_TOKEN": "token",
    "TWILIO_WHATSAPP_FROM": "whatsapp:+15559134046",
    "WHATSAPP_TEMPLATE_SID_AI_AGENTS": "HX" + "1" * 32,
}


def test_the_operator_is_ready_with_a_twilio_account_a_number_and_one_approved_template():
    assert sender.operator_whatsapp_ready(FULL) is True


@pytest.mark.parametrize("missing", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM", "WHATSAPP_TEMPLATE_SID_AI_AGENTS"])
def test_anything_missing_keeps_it_dormant_so_nothing_half_configured_starts_sending(missing):
    env = {k: v for k, v in FULL.items() if k != missing}
    assert sender.operator_whatsapp_ready(env) is False


def test_any_one_of_the_three_pitch_templates_is_enough():
    env = {k: v for k, v in FULL.items() if k != "WHATSAPP_TEMPLATE_SID_AI_AGENTS"}
    env["WHATSAPP_TEMPLATE_SID_CONSULTING"] = "HX" + "3" * 32
    assert sender.operator_whatsapp_ready(env) is True


def test_blank_values_do_not_count():
    assert sender.operator_whatsapp_ready({**FULL, "TWILIO_AUTH_TOKEN": "   "}) is False
    assert sender.operator_whatsapp_ready({}) is False
