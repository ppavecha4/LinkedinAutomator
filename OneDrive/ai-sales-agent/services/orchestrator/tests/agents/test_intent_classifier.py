"""Tests for Session 4 Part C — IntentClassifier."""

from __future__ import annotations

from intent.classifier import MAX_TOKENS, MODEL, VALID_INTENTS, IntentClassifier

from .fakes import FakeLlmClient


def test_classifies_clean_single_word_reply():
    llm = FakeLlmClient(response="INTERESTED")
    clf = IntentClassifier(llm_client=llm)
    assert clf.classify("Yes, let's talk!") == "INTERESTED"


def test_strips_punctuation_from_model_reply():
    llm = FakeLlmClient(response="UNSUBSCRIBE.")
    clf = IntentClassifier(llm_client=llm)
    assert clf.classify("take me off this list") == "UNSUBSCRIBE"


def test_extracts_intent_from_verbose_response():
    llm = FakeLlmClient(
        response="The best classification here is OUT_OF_OFFICE because..."
    )
    clf = IntentClassifier(llm_client=llm)
    assert clf.classify("I'm on PTO until Monday") == "OUT_OF_OFFICE"


def test_falls_back_to_question_on_garbage():
    llm = FakeLlmClient(response="WHO KNOWS")
    clf = IntentClassifier(llm_client=llm)
    assert clf.classify("???") == "QUESTION"


def test_falls_back_on_llm_exception():
    class Boom:
        def create_message(self, **_):
            raise RuntimeError("api down")

    assert IntentClassifier(llm_client=Boom()).classify("hi") == "QUESTION"


def test_empty_reply_falls_back_to_question():
    llm = FakeLlmClient(response="")
    assert IntentClassifier(llm_client=llm).classify("hi") == "QUESTION"


def test_uses_spec_model_and_max_tokens():
    llm = FakeLlmClient(response="MEETING_BOOKED")
    IntentClassifier(llm_client=llm).classify("Thanks — booked")
    assert llm.calls[0]["model"] == MODEL == "claude-sonnet-4-20250514"
    assert llm.calls[0]["max_tokens"] == MAX_TOKENS == 50


def test_all_valid_intents_round_trip():
    for intent in VALID_INTENTS:
        llm = FakeLlmClient(response=intent)
        assert IntentClassifier(llm_client=llm).classify("msg") == intent


def test_conversation_history_is_included_in_prompt():
    llm = FakeLlmClient(response="QUESTION")
    IntentClassifier(llm_client=llm).classify(
        "what's the pricing?",
        conversation_history=[
            {"role": "agent", "body": "Hi Jane, quick idea…"},
            {"role": "prospect", "body": "tell me more"},
        ],
    )
    user = llm.calls[0]["user"]
    assert "Conversation history" in user
    assert "tell me more" in user
    assert "what's the pricing?" in user
