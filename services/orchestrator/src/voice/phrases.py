"""The fixed sentences of a call, per language.

These are NOT written by the AI: the AI disclosure, the recording / transcript
notice and the opt-out confirmation are compliance text, so they are exact,
reviewed, and the same every time. English is the fallback for any language
without a fixed text (the conversation itself is in the contact's language;
add a language here before launching calls in it).
"""
from __future__ import annotations

from agents.language import primary


def _pick(table: dict[str, str], lang: str | None) -> str:
    return table.get(primary(lang or "en")) or table["en"]


GREETING = {
    "en": "Hi{name}, this is an automated assistant calling on behalf of {company}. This call may be transcribed. Do you have a minute?",
    "es": "Hola{name}, soy un asistente automático y llamo de parte de {company}. Esta llamada puede transcribirse. ¿Tiene un minuto?",
    "pt": "Olá{name}, sou um assistente automático e estou ligando em nome da {company}. Esta ligação pode ser transcrita. Você tem um minuto?",
}

STILL_THERE = {
    "en": "Hello? Are you still there?",
    "es": "¿Hola? ¿Sigue ahí?",
    "pt": "Alô? Você ainda está aí?",
}

GOODBYE = {
    "en": "Thank you for your time. Goodbye.",
    "es": "Gracias por su tiempo. Hasta luego.",
    "pt": "Obrigado pelo seu tempo. Até logo.",
}

# A person asked us to stop: confirm, never call again, hang up. No selling.
OPT_OUT = {
    "en": "Understood. We won't call you again. Goodbye.",
    "es": "Entendido. No volveremos a llamarle. Hasta luego.",
    "pt": "Entendido. Não ligaremos novamente. Até logo.",
}

# Answered by the wrong person / a machine: nothing more is said.
NO_TIME = {
    "en": "Sorry to have bothered you. Goodbye.",
    "es": "Disculpe la molestia. Hasta luego.",
    "pt": "Desculpe o incômodo. Até logo.",
}


def greeting(lang: str | None, company: str, first_name: str | None = None) -> str:
    name = f" {first_name.strip()}" if first_name and first_name.strip() else ""
    return _pick(GREETING, lang).format(name=name, company=company or "our company")


def still_there(lang: str | None) -> str:
    return _pick(STILL_THERE, lang)


def goodbye(lang: str | None) -> str:
    return _pick(GOODBYE, lang)


def opt_out(lang: str | None) -> str:
    return _pick(OPT_OUT, lang)


def no_time(lang: str | None) -> str:
    return _pick(NO_TIME, lang)


SUPPORTED = tuple(GREETING)   # languages with a reviewed fixed text
