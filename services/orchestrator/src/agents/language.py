"""Which language to write to each prospect in (SaaS phase 2, slice 2.4).

Rules, in order (see docs/saas-architecture.md, "Multi-language"):

1. The contact's own language, when known (uploaded sheets, enrichment).
2. Otherwise the campaign's `language_fallback`:
     'country'     → the main business language of the contact's country
     'org_default' → the org's `default_language`
   An unknown country falls back to the org default.
3. If the campaign restricts `languages`, a candidate outside the list is
   replaced by the list's first entry.

Appson's own playbook campaigns (operator org, no offering) are written in
English unless the contact's language or the campaign's `languages` say
otherwise: the country inference is NOT applied to them, so their current
behaviour does not change.
"""
from __future__ import annotations

try:
    from agents.iso_countries import ISO_COUNTRY_NAMES
except ImportError:  # imported as src.agents.language
    from src.agents.iso_countries import ISO_COUNTRY_NAMES  # type: ignore

# ISO-3166 alpha-2 → (English name(s) as Apollo / imports spell them,
# main business language). Curated for the markets we sell into; unknown
# countries fall back to the org's default language.
_COUNTRIES: dict[str, tuple[tuple[str, ...], str]] = {
    "US": (("United States", "United States of America", "USA"), "en"),
    "GB": (("United Kingdom", "UK", "Great Britain", "England"), "en"),
    "IE": (("Ireland",), "en"), "CA": (("Canada",), "en"), "AU": (("Australia",), "en"),
    "NZ": (("New Zealand",), "en"), "ZA": (("South Africa",), "en"), "SG": (("Singapore",), "en"),
    "IN": (("India",), "en"),  # business correspondence is mostly English
    "PK": (("Pakistan",), "en"), "NG": (("Nigeria",), "en"), "KE": (("Kenya",), "en"),
    "PH": (("Philippines",), "en"), "MY": (("Malaysia",), "en"),
    "AE": (("United Arab Emirates", "UAE"), "ar"), "SA": (("Saudi Arabia",), "ar"),
    "QA": (("Qatar",), "ar"), "KW": (("Kuwait",), "ar"), "BH": (("Bahrain",), "ar"),
    "OM": (("Oman",), "ar"), "EG": (("Egypt",), "ar"), "JO": (("Jordan",), "ar"),
    "MA": (("Morocco",), "ar"), "LB": (("Lebanon",), "ar"),
    "ES": (("Spain",), "es"), "MX": (("Mexico",), "es"), "AR": (("Argentina",), "es"),
    "CO": (("Colombia",), "es"), "CL": (("Chile",), "es"), "PE": (("Peru",), "es"),
    "EC": (("Ecuador",), "es"), "UY": (("Uruguay",), "es"), "PY": (("Paraguay",), "es"),
    "BO": (("Bolivia",), "es"), "VE": (("Venezuela",), "es"), "CR": (("Costa Rica",), "es"),
    "PA": (("Panama",), "es"), "GT": (("Guatemala",), "es"), "DO": (("Dominican Republic",), "es"),
    "BR": (("Brazil",), "pt"), "PT": (("Portugal",), "pt"),
    "FR": (("France",), "fr"), "BE": (("Belgium",), "fr"), "LU": (("Luxembourg",), "fr"),
    "DE": (("Germany",), "de"), "AT": (("Austria",), "de"), "CH": (("Switzerland",), "de"),
    "IT": (("Italy",), "it"), "NL": (("Netherlands",), "nl"), "PL": (("Poland",), "pl"),
    "SE": (("Sweden",), "sv"), "NO": (("Norway",), "nb"), "DK": (("Denmark",), "da"),
    "FI": (("Finland",), "fi"), "TR": (("Turkey", "Türkiye"), "tr"),
    "ID": (("Indonesia",), "id"), "VN": (("Vietnam", "Viet Nam"), "vi"), "TH": (("Thailand",), "th"),
    "JP": (("Japan",), "ja"), "KR": (("South Korea", "Korea"), "ko"), "CN": (("China",), "zh"),
    "TW": (("Taiwan",), "zh"), "HK": (("Hong Kong",), "en"), "IL": (("Israel",), "he"),
}

# Every ISO country is recognised (blocked countries can be anywhere); the
# curated spellings above win where they differ.
_NAME_TO_ISO2 = {name.lower(): code for code, names in ISO_COUNTRY_NAMES.items() for name in names}
_NAME_TO_ISO2.update({name.lower(): code for code, (names, _l) in _COUNTRIES.items() for name in names})

LANGUAGE_NAMES = {
    "en": "English", "es": "Spanish", "pt": "Portuguese", "fr": "French", "de": "German",
    "it": "Italian", "ar": "Arabic", "hi": "Hindi", "nl": "Dutch", "pl": "Polish", "sv": "Swedish",
    "nb": "Norwegian", "da": "Danish", "fi": "Finnish", "tr": "Turkish", "id": "Indonesian",
    "vi": "Vietnamese", "th": "Thai", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "he": "Hebrew",
}


def country_iso2(country: str | None) -> str | None:
    """'PE' or 'Peru' → 'PE'; unknown → None."""
    if not country:
        return None
    c = country.strip()
    if len(c) == 2 and (c.upper() in _COUNTRIES or c.upper() in ISO_COUNTRY_NAMES):
        return c.upper()
    return _NAME_TO_ISO2.get(c.lower())


def country_language(country: str | None) -> str | None:
    iso = country_iso2(country)
    entry = _COUNTRIES.get(iso) if iso else None
    return entry[1] if entry else None


def primary(tag: str) -> str:
    return tag.split("-", 1)[0].lower()


def language_name(tag: str) -> str:
    """'es-PE' → 'Spanish (es-PE)'; unknown codes are returned as-is."""
    name = LANGUAGE_NAMES.get(primary(tag))
    return f"{name} ({tag})" if name else tag


def resolve_language(
    *,
    contact_language: str | None,
    country: str | None,
    campaign_languages: list[str] | None,
    fallback: str,
    org_default: str | None,
    operator_playbook: bool = False,
    languages_handled: list[str] | tuple[str, ...] | None = None,
) -> str:
    """The BCP 47 tag to write this contact's messages in.

    A campaign's explicit language list wins. Without one, the profile's
    `languages_handled` (the languages the team can answer replies in)
    limits the choice — writing in a language nobody can answer is worse
    than writing in English. Appson's playbook campaigns stay English."""
    org_default = org_default or "en"
    candidate = contact_language
    if not candidate:
        if operator_playbook:
            candidate = "en"  # keep Appson's playbook campaigns as they were
        elif fallback == "country":
            candidate = country_language(country) or org_default
        else:
            candidate = org_default
    if campaign_languages:
        allowed = {primary(l) for l in campaign_languages}
        if primary(candidate) not in allowed:
            candidate = campaign_languages[0]
    elif languages_handled and not operator_playbook:
        candidate = limit_to_handled(candidate, languages_handled)
    return candidate


def limit_to_handled(language: str, handled) -> str:
    """`language` if the team handles it, else the handled language to use
    instead: English when they handle it, otherwise their first one."""
    handled = [h for h in (handled or []) if h]
    if not handled:
        return language
    by_primary: dict[str, str] = {}
    for h in handled:
        by_primary.setdefault(primary(h), h)
    if primary(language) in by_primary:
        return language
    return by_primary.get("en") or handled[0]


# The WhatsApp opt-out line, per language. The keyword stays "STOP" in every
# language because our opt-out detector (agents/optout.py) always knows it.
OPT_OUT_LINES = {
    "en": "Reply STOP to opt out.",
    "es": "Responde STOP para no recibir más mensajes.",
    "pt": "Responda STOP para não receber mais mensagens.",
    "fr": "Répondez STOP pour ne plus recevoir de messages.",
    "de": "Antworten Sie STOP, um keine Nachrichten mehr zu erhalten.",
    "it": "Rispondi STOP per non ricevere più messaggi.",
    "ar": "أرسل STOP لإيقاف الرسائل.",
    "hi": "संदेश बंद करने के लिए STOP भेजें।",
}


# The opt-out CONFIRMATION (CLAUDE.md principle 1 exception): fixed,
# pre-translated, factual, no marketing. {company} = the sender company.
CONFIRMATIONS = {
    "en": ("You're unsubscribed", "Understood — you won't receive any more messages from {company}."),
    "es": ("Baja confirmada", "Entendido: no recibirás más mensajes de {company}."),
    "pt": ("Descadastro confirmado", "Entendido: você não receberá mais mensagens de {company}."),
    "fr": ("Désinscription confirmée", "C'est noté : vous ne recevrez plus de messages de {company}."),
    "de": ("Abmeldung bestätigt", "Verstanden – Sie erhalten keine weiteren Nachrichten von {company}."),
    "it": ("Disiscrizione confermata", "Ricevuto: non riceverai più messaggi da {company}."),
    "ar": ("تم إلغاء الاشتراك", "تم. لن تصلك أي رسائل أخرى من {company}."),
    "hi": ("सदस्यता रद्द हो गई", "ठीक है — अब आपको {company} से कोई संदेश नहीं मिलेगा।"),
}


# The unsubscribe sentence in the footer of every CUSTOMER email (slice 5.1),
# per language; English where we have no fixed text. {company} = the sender.
UNSUBSCRIBE_LINES = {
    "en": "If you no longer want emails from {company}, unsubscribe here:",
    "es": "Si ya no quieres recibir correos de {company}, date de baja aquí:",
    "pt": "Se você não quer mais receber e-mails de {company}, cancele a inscrição aqui:",
    "fr": "Si vous ne souhaitez plus recevoir d'e-mails de {company}, désinscrivez-vous ici :",
    "de": "Wenn Sie keine E-Mails von {company} mehr erhalten möchten, melden Sie sich hier ab:",
    "it": "Se non vuoi più ricevere email da {company}, annulla l'iscrizione qui:",
    "ar": "إذا لم تعد ترغب في تلقي رسائل من {company}، يمكنك إلغاء الاشتراك هنا:",
    "hi": "यदि आप {company} से ईमेल नहीं पाना चाहते, तो यहाँ सदस्यता रद्द करें:",
}


# Said at the foot of every answer the AI sends on its own: people are told when no person wrote it.
AUTO_REPLY_NOTES = {
    "en": "This reply was written automatically by {company}'s assistant. Reply here and a person can take over.",
    "es": "Esta respuesta la ha escrito automáticamente el asistente de {company}. Responde aquí y una persona puede continuar.",
    "pt": "Esta resposta foi escrita automaticamente pelo assistente da {company}. Responda aqui e uma pessoa pode continuar.",
    "fr": "Cette réponse a été rédigée automatiquement par l'assistant de {company}. Répondez ici et une personne pourra prendre le relais.",
    "de": "Diese Antwort wurde automatisch vom Assistenten von {company} verfasst. Antworten Sie hier, dann kann ein Mensch übernehmen.",
    "it": "Questa risposta è stata scritta automaticamente dall'assistente di {company}. Rispondi qui e una persona potrà continuare.",
    "nl": "Dit antwoord is automatisch geschreven door de assistent van {company}. Reageer hier en iemand kan het overnemen.",
    "ar": "كُتب هذا الرد تلقائياً بواسطة مساعد {company}. ردّ هنا ليتولى أحد موظفينا المتابعة.",
    "hi": "यह जवाब {company} के सहायक ने अपने-आप लिखा है। यहाँ जवाब दें तो कोई व्यक्ति आगे बात कर सकता है।",
}


def auto_reply_note(tag: str | None, company: str) -> str:
    return (AUTO_REPLY_NOTES.get(primary(tag or "en")) or AUTO_REPLY_NOTES["en"]).format(company=company or "us")


def unsubscribe_line(tag: str | None, company: str) -> str:
    """The footer's unsubscribe sentence (without the link) in `tag`."""
    return (UNSUBSCRIBE_LINES.get(primary(tag or "en")) or UNSUBSCRIBE_LINES["en"]).format(company=company or "us")


def confirmation_message(tag: str, company: str) -> tuple[str, str]:
    """(subject, body) of the opt-out confirmation in `tag`, English if we
    have no fixed text for that language."""
    subject, body = CONFIRMATIONS.get(primary(tag)) or CONFIRMATIONS["en"]
    return subject, body.format(company=company or "us")


def confirmation_language(*, contact_language: str | None, reply_language: str | None,
                          country: str | None, org_default: str | None) -> str:
    """Answer in: the contact's known language → the language they opted out
    in (None for a bare universal "STOP": agents/optout.py) → their
    country's → the org default → English. Only languages with fixed text
    are used."""
    for cand in (contact_language, reply_language, country_language(country), org_default):
        if cand and primary(cand) in CONFIRMATIONS:
            return primary(cand)
    return "en"


def opt_out_line(tag: str) -> str | None:
    """The fixed opt-out line for `tag`, or None (the writer translates the
    English line, keeping the word STOP)."""
    return OPT_OUT_LINES.get(primary(tag))
