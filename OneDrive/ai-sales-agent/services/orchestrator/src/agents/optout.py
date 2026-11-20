"""Opt-out detection in every language we write in (SaaS phase 2, slice 2.4).

Compliance, not polish: a prospect who asks to stop must be suppressed on
every channel, whatever language they answer in. Deterministic and
conservative by design:

* The WHOLE reply is a stop word ("STOP", "Alto", "Baja", "توقف", "रुको")
  → opt-out.
* An explicit opt-out PHRASE appears anywhere ("unsubscribe", "darme de
  baja", "ne plus me contacter", "لا تراسلني") → opt-out.
* A stray "stop" inside a longer message ("we can't stop growing") is NOT,
  and neither is a polite "no thanks" (that is a reply, handled as one).

Matching is on a normalised form: lower-case, accents/marks stripped,
punctuation removed, whitespace collapsed, so "¡ALTO!" and "alto" match.
Each word/phrase is tagged with its language, so the opt-out confirmation
can answer in the language the person used.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


def normalize(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "")
    t = "".join(ch for ch in t if not unicodedata.category(ch).startswith("M"))
    t = t.lower()
    t = re.sub(r"[^\w\s']", " ", t)       # punctuation → space (keeps all scripts' letters)
    return re.sub(r"\s+", " ", t).strip()


# Replies that are nothing but one of these mean "stop".
_STOP_WORDS: dict[str, list[str]] = {
    "en": ["stop", "stop please", "please stop", "unsubscribe", "opt out", "optout", "remove",
           "remove me", "cancel", "end", "quit", "stopall", "stop all"],
    "es": ["alto", "baja", "parar", "para", "basta", "cancelar", "detener", "darme de baja", "no mas"],
    "pt": ["pare", "sair", "descadastrar", "cancelar inscricao"],
    "fr": ["arret", "arreter", "desabonner", "desinscrire"],
    "de": ["stopp", "abmelden", "austragen", "abbestellen"],
    "it": ["basta cosi", "fermati", "disiscrivi", "cancellami"],
    "ar": ["توقف", "ايقاف", "الغاء", "الغاء الاشتراك", "قف"],
    "hi": ["रुको", "बंद", "बंद करो", "स्टॉप", "सदस्यता रद्द"],
    "id": ["berhenti"],
    "zh": ["退订", "停止", "取消订阅"],
    "ja": ["配信停止", "やめて"],
}

# Phrases that mean "stop" wherever they appear in a reply.
_PHRASES: dict[str, list[str]] = {
    "en": ["unsubscribe", "remove me", "take me off", "opt me out", "opt out", "stop emailing",
           "stop messaging", "stop contacting", "stop sending", "stop texting", "do not contact",
           "don't contact", "dont contact", "do not email", "don't email", "do not message",
           "no more emails", "no more messages", "never contact me",
           # phone calls (voice channel): the same promise, said the way people say it on a call
           "stop calling", "do not call", "don't call", "dont call", "never call me", "no more calls",
           "take me off your list", "take me off the list", "remove me from your list", "put me on your do not call"],
    "es": ["darme de baja", "dar de baja", "darse de baja", "no me escriba", "no me escribas",
           "no me contacte", "no me contactes", "no me vuelva a", "no me vuelvas a", "quitarme de",
           "eliminarme de", "borrarme de", "no quiero recibir", "dejen de escribir", "deje de escribir",
           "no me envien", "no me envies",
           "no me llame", "no me llames", "no me llamen", "no me vuelvan a llamar", "no vuelvan a llamar",
           "no vuelva a llamar", "dejen de llamar", "deje de llamar", "no me llamen mas", "quitenme de su lista"],
    "pt": ["descadastrar", "descadastre", "nao quero receber", "remova meu", "remover meu",
           "parem de enviar", "pare de enviar", "nao me envie", "nao me contate",
           "nao me ligue", "nao me liguem", "parem de ligar", "pare de ligar", "nao ligue mais", "nao liguem mais"],
    "fr": ["desabonner", "desinscrire", "ne plus me contacter", "ne me contactez plus",
           "ne m'ecrivez plus", "retirez moi", "ne plus recevoir",
           "ne m'appelez plus", "ne plus m'appeler", "arretez de m'appeler"],
    "de": ["abmelden", "austragen", "abbestellen", "nicht mehr kontaktieren", "keine weiteren",
           "kontaktieren sie mich nicht", "schreiben sie mir nicht",
           "rufen sie mich nicht", "nicht mehr anrufen", "hoeren sie auf mich anzurufen"],
    "it": ["disiscrivermi", "cancellatemi", "non contattarmi", "non contattatemi", "non scrivetemi",
           "non voglio ricevere", "non chiamarmi", "non chiamatemi", "smettete di chiamare"],
    "ar": ["الغاء الاشتراك", "توقف عن مراسلتي", "توقفوا عن مراسلتي", "لا تراسلني", "لا تتواصل معي",
           "ازالتي", "احذفني", "لا اريد استلام", "لا تتصل بي", "لا تتصلوا بي", "توقف عن الاتصال"],
    "hi": ["सदस्यता रद्द", "मुझे संदेश मत", "संपर्क मत करो", "संपर्क न करें", "मैसेज मत भेजो", "फोन मत करो", "कॉल मत करो", "फोन न करें"],
    "zh": ["退订", "取消订阅", "不要再联系"],
    "ja": ["配信停止"],
}

_STOP_MAP: dict[str, str] = {}
for _lang, _words in _STOP_WORDS.items():
    for _w in _words:
        _STOP_MAP.setdefault(normalize(_w), _lang)

_PHRASE_LIST: list[tuple[str, str]] = sorted(
    {(normalize(p), lang) for lang, ps in _PHRASES.items() for p in ps},
    key=lambda x: len(x[0]),
    reverse=True,
)

# Keywords used the same way worldwide (Twilio/carrier conventions): a bare
# "STOP" says nothing about the person's language, so report none.
_UNIVERSAL = {normalize(w) for w in ("stop", "stopall", "stop all", "unsubscribe", "cancel",
                                     "end", "quit", "opt out", "optout")}

_URL = re.compile(r"https?://|www\.", re.IGNORECASE)
_CJK = re.compile(r"[぀-鿿]")


@dataclass(frozen=True)
class OptOut:
    is_opt_out: bool
    matched: str | None = None
    kind: str | None = None      # 'stop_word' | 'phrase'
    language: str | None = None  # language of what matched ('en' for STOP etc.)


def detect_opt_out(text: str) -> OptOut:
    """Is this reply a request to stop being contacted?

    Lines containing a link are ignored, so a quoted signature line such
    as "Unsubscribe: https://…/unsubscribe?token=…" can never trigger it.
    """
    text = "\n".join(ln for ln in (text or "").splitlines() if not _URL.search(ln))
    n = normalize(text)
    if not n:
        return OptOut(False)
    if n in _STOP_MAP:
        return OptOut(True, n, "stop_word", None if n in _UNIVERSAL else _STOP_MAP[n])
    # Short replies whose first line is a stop word ("STOP\n\nSent from my iPhone").
    first = normalize(text.strip().splitlines()[0]) if text.strip() else ""
    if first in _STOP_MAP:
        return OptOut(True, first, "stop_word", None if first in _UNIVERSAL else _STOP_MAP[first])
    padded = f" {n} "
    for p, lang in _PHRASE_LIST:
        # Word-boundary match; plain substring for CJK (no spaces between words).
        if f" {p} " in padded or (_CJK.search(p) and p in n):
            return OptOut(True, p, "phrase", lang)
    return OptOut(False)
