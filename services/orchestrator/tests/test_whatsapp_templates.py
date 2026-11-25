"""Slice 9.1: the sender uses the WhatsApp templates the AI wrote and Meta approved
(src/db/accounts.py with_approved_templates). No database: a fake connection answers the query.
"""
from __future__ import annotations

import pytest

from db.accounts import WhatsAppAccount, with_approved_templates

SID_FIRST_EN = "HX" + "1" * 32
SID_FOLLOWUP_EN = "HX" + "2" * 32
SID_FIRST_ES = "HX" + "3" * 32
SID_MANUAL_EN = "HX" + "9" * 32


class FakeConn:
    def __init__(self, rows=None, fail: Exception | None = None) -> None:
        self.rows, self.fail, self.sql = rows or [], fail, ""

    async def fetch(self, sql: str, *args):
        self.sql = sql
        if self.fail:
            raise self.fail
        return self.rows


def account(**kw) -> WhatsAppAccount:
    return WhatsAppAccount("default", "AC" + "a" * 32, "token", "+15551230000", **kw)


async def test_approved_templates_fill_the_languages_the_company_has_no_template_for():
    conn = FakeConn([
        {"kind": "first", "language": "en", "content_sid": SID_FIRST_EN},
        {"kind": "followup", "language": "en", "content_sid": SID_FOLLOWUP_EN},
        {"kind": "first", "language": "es", "content_sid": SID_FIRST_ES},
    ])
    acct = await with_approved_templates(conn, account())
    assert acct.template_for("en") == SID_FIRST_EN
    assert acct.template_for("es-MX") == SID_FIRST_ES                 # a regional code finds the language
    assert acct.followup_template_for("en") == SID_FOLLOWUP_EN
    assert acct.followup_template_for("es") is None                   # no approved Spanish follow-up: it waits
    assert "status = 'APPROVED'" in conn.sql                          # only approved ones are ever asked for


async def test_a_template_pasted_by_hand_wins_over_an_approved_one_for_its_language():
    conn = FakeConn([{"kind": "first", "language": "en", "content_sid": SID_FIRST_EN}])
    acct = await with_approved_templates(conn, account(templates={"en": SID_MANUAL_EN}))
    assert acct.template_for("en") == SID_MANUAL_EN


async def test_a_default_template_still_covers_languages_without_their_own():
    conn = FakeConn([{"kind": "first", "language": "en", "content_sid": SID_FIRST_EN}])
    acct = await with_approved_templates(conn, account(templates={"": SID_MANUAL_EN}))
    assert acct.template_for("en") == SID_FIRST_EN                    # its own language first
    assert acct.template_for("fr") == SID_MANUAL_EN                   # then the default


async def test_no_approved_templates_leaves_the_account_as_it_was():
    base = account(templates={"en": SID_MANUAL_EN})
    assert await with_approved_templates(FakeConn([]), base) == base


@pytest.mark.parametrize("error", [RuntimeError("relation \"whatsapp_templates\" does not exist"), AttributeError("no fetch")])
async def test_before_the_templates_table_exists_nothing_breaks(error):
    base = account(templates={"en": SID_MANUAL_EN})
    assert await with_approved_templates(FakeConn(fail=error), base) == base
