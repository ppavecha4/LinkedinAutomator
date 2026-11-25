"""Slice 10.1: a company's WhatsApp connected straight through Meta (V35).

No database: a fake connection answers the "which accounts are verified" query. Checks that the
account is built from the vault's fields only when complete, that the secret never shows up in
logs, and that the chooser picks Meta over Twilio, and Twilio when Meta is not connected.
"""
from __future__ import annotations

import pytest

from db.accounts import AccountError, whatsapp_meta_account_from, whatsapp_provider

META = {"waba_id": "104996122399160", "phone_number_id": "106540352242922", "display_phone_number": "+91 98765 43210"}
SECRET = {"access_token": "EAAG-secret-token"}


class FakeConn:
    """Answers `SELECT provider, label FROM org_credentials WHERE provider = ANY($1) ...`."""

    def __init__(self, *verified: str) -> None:
        self.verified = set(verified)

    async def fetchrow(self, sql: str, providers: list[str]):
        for p in providers:
            if p in self.verified:
                return {"provider": p, "label": "default"}
        return None


def test_the_account_is_built_from_the_connection_fields():
    a = whatsapp_meta_account_from("default", SECRET, META)
    assert (a.waba_id, a.phone_number_id, a.display_phone) == ("104996122399160", "106540352242922", "+91 98765 43210")
    assert a.access_token == "EAAG-secret-token"


def test_the_token_never_shows_up_in_logs():
    assert "EAAG-secret-token" not in repr(whatsapp_meta_account_from("default", SECRET, META))


@pytest.mark.parametrize("meta,secret", [
    ({**META, "waba_id": ""}, SECRET),
    ({**META, "phone_number_id": "not-a-number"}, SECRET),
    ({k: v for k, v in META.items() if k != "phone_number_id"}, SECRET),
    (META, {}),
    (META, {"access_token": ""}),
])
def test_an_incomplete_connection_is_refused_with_a_plain_message(meta, secret):
    with pytest.raises(AccountError, match="Connect WhatsApp"):
        whatsapp_meta_account_from("default", secret, meta)


async def test_meta_wins_when_both_are_connected():
    assert await whatsapp_provider(FakeConn("whatsapp_meta", "twilio")) == "meta"


async def test_twilio_is_used_when_meta_is_not_connected():
    assert await whatsapp_provider(FakeConn("twilio")) == "twilio"


async def test_meta_alone_is_enough():
    assert await whatsapp_provider(FakeConn("whatsapp_meta")) == "meta"


async def test_nothing_verified_means_no_whatsapp():
    assert await whatsapp_provider(FakeConn()) is None
