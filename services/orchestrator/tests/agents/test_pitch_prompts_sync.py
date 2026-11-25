"""Guardrail test — orchestrator and reply-processor PITCH_PROMPTS must
stay byte-identical.

The two services are in separate containers and don't share a Python
package, so the prompts are duplicated by design (see project memory item
#16). This test fails CI if anyone edits one without editing the other.
"""

from __future__ import annotations

import hashlib

# Both modules are added to sys.path by tests/conftest.py.
from agents.personalization_agent import PITCH_PROMPTS as ORCH_PROMPTS
from agents.personalization_agent import PitchType as OrchPitchType
from pitch_prompts import PITCH_PROMPTS as REPLY_PROMPTS  # type: ignore
from pitch_prompts import PitchType as ReplyPitchType  # type: ignore


def test_pitch_types_match():
    orch_values = {pt.value for pt in OrchPitchType}
    reply_values = {pt.value for pt in ReplyPitchType}
    assert orch_values == reply_values, (
        f"PitchType enum drift: orch={orch_values} reply={reply_values}"
    )


def test_pitch_prompts_byte_identical():
    mismatches = []
    for orch_pt in OrchPitchType:
        reply_pt = ReplyPitchType(orch_pt.value)
        orch_text = ORCH_PROMPTS[orch_pt]
        reply_text = REPLY_PROMPTS[reply_pt]
        if orch_text != reply_text:
            orch_hash = hashlib.sha256(orch_text.encode()).hexdigest()[:12]
            reply_hash = hashlib.sha256(reply_text.encode()).hexdigest()[:12]
            mismatches.append(
                f"{orch_pt.value}: orch={orch_hash} reply={reply_hash}"
            )
    assert not mismatches, (
        "PITCH_PROMPTS drift between orchestrator and reply-processor:\n"
        + "\n".join(mismatches)
        + "\n\nUpdate both files in lock-step. See memory item #16."
    )
