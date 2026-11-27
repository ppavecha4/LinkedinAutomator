#!/usr/bin/env python3
"""Build the public website: one static page per language, from website/locales/*.json.

    python3 website/build.py [--site-url https://example.com]

Writes website/dist/ (not committed): /<lang>/ and /<lang>/signup/, a root page that picks a language, the
legal pages (/privacy, /terms, /data-deletion and /<lang>/privacy etc., taken from the app's own text), a
404 page, the stylesheet, script and images, the _redirects and _headers files static hosts such as
Netlify read, and, when the site has an address, what search and answer engines use: canonical and
hreflang links, social cards, schema.org data, sitemap.xml, robots.txt and llms.txt.

    python3 website/build.py --zip website/amireach-website.zip

also writes a zip to upload to ordinary web hosting (Apache / cPanel), with an .htaccess that picks the
language the same way.

The address and the app's address come from website/site.json. While "app_url" is empty there is no
"Sign in" button. "app_signup": true (only when the app's sign-up is open) turns the sign-up page's email
request into a "Create your account" button and shows the sign-up fee ("signup_fee": keep it equal to the
app's SIGNUP_FEE_* settings).

Only the standard library is used, so it runs on any server. To change the brand name, the contact
address or which countries get which language, edit website/site.json. To change words, edit the
language file; every file must have the same keys (website/test_site.py checks).
"""
from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import zipfile
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
ICON = HERE.parent / "assets" / "brand" / "app-icon-1024.png"
# The legal text is the app's own (one file per language), so the two never differ.
LEGAL_SOURCE = HERE.parent / "dashboard" / "src" / "legal"
LEGAL_PAGES = ("privacy", "terms", "data-deletion")
# The key of the footer link for each legal page, in the website's language files.
LEGAL_LINKS = {"privacy": "footer_privacy", "terms": "footer_terms", "data-deletion": "footer_deletion"}


def load_config() -> dict:
    return json.loads((HERE / "site.json").read_text(encoding="utf-8"))


def load_locale(lang: str, brand: str, company: str = "") -> dict:
    """The language's strings with the brand and company names filled in."""
    def fill(value):
        if isinstance(value, str):
            return value.replace("{brand}", brand).replace("{company}", company)
        if isinstance(value, list):
            return [fill(v) for v in value]
        if isinstance(value, dict):
            return {k: fill(v) for k, v in value.items()}
        return value

    return fill(json.loads((HERE / "locales" / f"{lang}.json").read_text(encoding="utf-8")))


def e(text: str) -> str:
    return html.escape(text, quote=True)


def legal_text(lang: str, source: Path = LEGAL_SOURCE) -> dict:
    return json.loads((source / f"{lang}.json").read_text(encoding="utf-8"))


def legal_path(cfg: dict, slug: str, lang: str) -> str:
    """English stays at the plain address (/privacy/), which other services already point to."""
    return slug if lang == cfg["default_language"] else f"{lang}/{slug}"


def signup_fee_text(t: dict, cfg: dict) -> str:
    return t["signup_fee_text"].replace("{inr}", cfg["signup_fee"]["inr"]).replace("{usd}", cfg["signup_fee"]["usd"])


def signup_is_open(cfg: dict) -> bool:
    return bool(cfg.get("app_signup") and cfg.get("app_url"))


def questions(t: dict, cfg: dict) -> list[dict]:
    """The questions shown on the page and given to answer engines: one list, so the two never differ."""
    cost = f'{signup_fee_text(t, cfg)} {t["pricing_open_text"]}' if signup_is_open(cfg) else t["pricing_text"]
    return [*t["faq"], {"q": t["faq_cost_q"], "a": cost}, *t["faq_more"]]


def structured_data(graph: list[dict]) -> str:
    """schema.org data. "<" is escaped so no text can close the script element."""
    data = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, separators=(",", ":"))
    return f'  <script type="application/ld+json">{data.replace("<", chr(92) + "u003c")}</script>\n'


def organisation(cfg: dict, site_url: str) -> list[dict]:
    return [
        {"@type": "Organization", "@id": f"{site_url}/#organization", "name": cfg["company"], "url": f"{site_url}/",
         "logo": f"{site_url}/icon.png", "email": cfg["contact_email"], "brand": {"@type": "Brand", "name": cfg["brand"]},
         "contactPoint": {"@type": "ContactPoint", "contactType": "customer support", "email": cfg["contact_email"],
                          "availableLanguage": ["en"]}},
        {"@type": "WebSite", "@id": f"{site_url}/#website", "url": f"{site_url}/", "name": cfg["brand"],
         "inLanguage": cfg["languages"], "publisher": {"@id": f"{site_url}/#organization"}},
    ]


def software(t: dict, cfg: dict, site_url: str) -> dict:
    app = {"@type": "SoftwareApplication", "@id": f"{site_url}/#software", "name": cfg["brand"],
           "applicationCategory": "BusinessApplication", "operatingSystem": "Web", "url": f"{site_url}/",
           "description": t["about_text"], "publisher": {"@id": f"{site_url}/#organization"},
           "featureList": [f["title"] for f in t["features"]]}
    if signup_is_open(cfg):          # a price is published only once it can be paid
        amount = lambda shown: re.sub(r"[^0-9.]", "", shown)                       # noqa: E731
        app["offers"] = [{"@type": "Offer", "price": amount(cfg["signup_fee"][key]), "priceCurrency": code,
                          "name": "One-time sign-up fee", "url": f'{cfg["app_url"].rstrip("/")}/signup'}
                         for key, code in (("inr", "INR"), ("usd", "USD"))]
    return app


def web_page(site_url: str, path: str, lang: str, title: str, description: str, trail: list[tuple[str, str]]) -> list[dict]:
    url = f"{site_url}/{path}/"
    graph = [{"@type": "WebPage", "@id": url, "url": url, "name": title, "description": description, "inLanguage": lang,
              "isPartOf": {"@id": f"{site_url}/#website"}, "about": {"@id": f"{site_url}/#software"}}]
    if len(trail) > 1:
        graph.append({"@type": "BreadcrumbList", "itemListElement": [
            {"@type": "ListItem", "position": i, "name": name, "item": f"{site_url}/{p}/"}
            for i, (name, p) in enumerate(trail, 1)]})
    return graph


def direction(cfg: dict, lang: str, always: bool = False) -> str:
    """The dir attribute: right-to-left languages need it; `always` also marks left-to-right text, for a
    sentence quoted inside a page written the other way."""
    if lang in cfg.get("rtl_languages", []):
        return ' dir="rtl"'
    return ' dir="ltr"' if always else ""


def head(cfg: dict, site_url: str, *, title: str, description: str, up: str, path: str, lang: str,
         alternates: str | None = None, locale: str = "en_US", other_locales: tuple = (), graph: list | None = None,
         addresses: dict | None = None) -> str:
    """The shared <head>. `up` leads back to the site root; `alternates` is the path after the language."""
    seo = ""
    if site_url:
        seo += f'  <link rel="canonical" href="{e(site_url)}/{path}/">\n'
        if alternates is not None:
            seo += "".join(f'  <link rel="alternate" hreflang="{c}" href="{e(site_url)}/{c}/{alternates}">\n' for c in cfg["languages"])
            seo += f'  <link rel="alternate" hreflang="x-default" href="{e(site_url)}/{cfg["default_language"]}/{alternates}">\n'
        if addresses:
            seo += "".join(f'  <link rel="alternate" hreflang="{c}" href="{e(site_url)}/{p}/">\n' for c, p in addresses.items())
            seo += f'  <link rel="alternate" hreflang="x-default" href="{e(site_url)}/{addresses[cfg["default_language"]]}/">\n'
        seo += f'  <meta property="og:url" content="{e(site_url)}/{path}/">\n'
        seo += f'  <meta property="og:image" content="{e(site_url)}/social.png">\n'
        seo += '  <meta property="og:image:width" content="1200">\n  <meta property="og:image:height" content="630">\n'
        seo += f'  <meta property="og:image:alt" content="{e(title)}">\n'
        seo += '  <meta name="twitter:card" content="summary_large_image">\n'
        seo += f'  <meta name="twitter:image" content="{e(site_url)}/social.png">\n'
    seo += "".join(f'  <meta property="og:locale:alternate" content="{c}">\n' for c in other_locales)
    return f"""<!doctype html>
<html lang="{lang}"{direction(cfg, lang)}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(title)}</title>
  <meta name="description" content="{e(description)}">
  <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="{e(cfg["brand"])}">
  <meta property="og:locale" content="{locale}">
  <meta property="og:title" content="{e(title)}">
  <meta property="og:description" content="{e(description)}">
  <meta name="twitter:title" content="{e(title)}">
  <meta name="twitter:description" content="{e(description)}">
{seo}  <link rel="icon" href="{up}icon.png" type="image/png">
  <link rel="stylesheet" href="{up}styles.css">
  <script src="{up}site.js" defer></script>
{structured_data(graph) if graph and site_url else ""}</head>"""


def top_bar(t: dict, cfg: dict, names: dict, lang: str, *, up: str, after: str = "") -> str:
    """Header of a language page. `after` is the path after the language ("" or "signup/")."""
    home = "../" if after else ""
    app = cfg["app_url"].rstrip("/")
    current = ' aria-current="true"'
    switcher = "".join(
        f'<li><a href="{up}{code}/{after}" lang="{code}" hreflang="{code}" data-lang="{code}"{current if code == lang else ""}>{e(names[code])}</a></li>'
        for code in cfg["languages"])
    signin = f'<a class="button ghost" href="{e(app)}/login?lang={lang}">{e(t["nav_signin"])}</a>' if app else ""
    join = "" if after else f'<a class="button" href="signup/">{e(t["cta_signup"] if signup_is_open(cfg) else t["cta_access"])}</a>'
    anchor = home if after else ""
    logo = home or "#main"
    return f"""  <a class="skip" href="#main">{e(t["skip"])}</a>
  <header class="top">
    <div class="wrap bar">
      <a class="logo" href="{logo}"><img src="{up}icon.png" alt="" width="32" height="32"><span>{e(cfg["brand"])}</span></a>
      <nav aria-label="{e(cfg["brand"])}">
        <a href="{anchor}#how">{e(t["nav_how"])}</a>
        <a href="{anchor}#features">{e(t["nav_features"])}</a>
        <a href="{anchor}#pricing">{e(t["nav_pricing"])}</a>
        <a href="{anchor}#faq">{e(t["nav_faq"])}</a>
      </nav>
      <div class="actions">
        <details class="lang"><summary aria-label="{e(t["nav_language"])}">{e(names[lang])}</summary><ul>{switcher}</ul></details>
        {signin}{join}
      </div>
    </div>
  </header>"""


def bottom(t: dict, cfg: dict, up: str, lang: str) -> str:
    legal_note = f'<p class="muted">{e(t["footer_legal_note"])}</p>' if t["footer_legal_note"] else ""
    links = "".join(f'\n        <a href="{up}{legal_path(cfg, slug, lang)}/">{e(t[key])}</a>' for slug, key in LEGAL_LINKS.items())
    return f"""  <footer>
    <div class="wrap">
      <p>&copy; 2026 {e(cfg["company"])}</p>
      <p class="links">{links}
        <a href="mailto:{e(cfg["contact_email"])}">{e(t["footer_contact"])}: {e(cfg["contact_email"])}</a>
      </p>
      {legal_note}
    </div>
  </footer>
</body>
</html>
"""


def legal_page(slug: str, lang: str, cfg: dict, names: dict, site_url: str) -> str:
    doc = legal_text(lang)
    title = doc[slug]["title"]
    # What is only true of this website is added here and not to the app's pages.
    sections = doc[slug]["sections"] + ([doc["website"]] if slug == "privacy" else [])
    body = "".join(f"<section><h2>{e(s['title'])}</h2>{''.join(f'<p>{e(p)}</p>' for p in s['body'])}</section>" for s in sections)
    path = legal_path(cfg, slug, lang)
    up = "../" * (path.count("/") + 1)
    home = f"{up}{lang}/"
    others = " ".join(f'<a href="{up}{legal_path(cfg, other, lang)}/">{e(doc[other]["title"])}</a>' for other in LEGAL_PAGES if other != slug)
    current = ' aria-current="true"'
    switcher = "".join(
        f'<li><a href="{up}{legal_path(cfg, slug, code)}/" lang="{code}" hreflang="{code}" data-lang="{code}"{current if code == lang else ""}>{e(names[code])}</a></li>'
        for code in cfg["languages"])
    note = f'<p class="notice">{e(doc["translation_note"])}</p>' if doc["translation_note"] else ""
    first = sections[0]["body"][0]
    description = first if len(first) <= 155 else first[:155].rsplit(" ", 1)[0] + "…"
    heading = f'{title} - {cfg["brand"]}'
    graph = None
    if site_url:
        graph = organisation(cfg, site_url) + web_page(site_url, path, lang, title, description, [(cfg["brand"], lang), (title, path)])
    top = head(cfg, site_url, title=heading, description=description, up=up, path=path, lang=lang, graph=graph,
               addresses={code: legal_path(cfg, slug, code) for code in cfg["languages"]})
    language = load_locale(lang, cfg["brand"], cfg["company"])["nav_language"]
    return f"""{top}
<body>
  <header class="top"><div class="wrap bar"><a class="logo" href="{home}"><img src="{up}icon.png" alt="" width="32" height="32"><span>{e(cfg["brand"])}</span></a>
    <div class="actions"><details class="lang"><summary aria-label="{e(language)}">{e(names[lang])}</summary><ul>{switcher}</ul></details></div></div></header>
  <main class="wrap narrow legal">
    <h1>{e(title)}</h1>
    <p class="muted">{e(doc["updated_label"])}</p>
    {note}
    {body}
    <p class="links">{others}</p>
  </main>
  <footer><div class="wrap"><p>&copy; 2026 {e(cfg["company"])}</p></div></footer>
</body>
</html>
"""


def netlify_redirects(cfg: dict, site_url: str) -> str:
    """The same language choice as the Caddyfile, for static hosting that reads a _redirects file.
    The first matching rule wins. "!" makes the rule apply although index.html exists."""
    default = cfg["default_language"]
    rules = []
    if site_url.startswith("https://"):
        host = site_url[len("https://"):]
        rules.append(f"https://www.{host}/* https://{host}/:splat 301!")
    rules += [f"/ /{code}/ 302! Cookie=pref_{code}" for code in cfg["languages"]]
    for country, langs in cfg["multilingual_countries"].items():
        rules += [f"/ /{code}/ 302! Country={country.lower()} Language={code}" for code in langs]
        rules.append(f"/ /{default}/ 302! Country={country.lower()}")
    rules += [f"/ /{code}/ 302! Country={','.join(c.lower() for c in countries)}" for code, countries in cfg["countries"].items()]
    rules.append(f"/ /{default}/ 302!")
    return "\n".join(rules) + "\n"


HEADERS = """/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
"""


# Small line icons for the feature cards, in the order of the language files' "features". Drawn inline so
# they take the page's colours.
ICONS = (
    '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4.5 4.5-6 8-6s6.5 1.5 8 6"/>',                      # personal
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',          # language
    '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 8l8 6 8-6"/>',                           # own accounts
    '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',                                        # follow-ups
    '<path d="M12 3l8 3v6c0 5-3.500 7.500-8 9-4.500-1.500-8-4-8-9V6z"/><path d="M9 12h6"/>',               # opt-outs
    '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',  # control
)
STEP_ART = ("step-business", "step-review", "step-launch")
CASE_ART = ("factory", "ship", "services")                          # the order of the language files' "cases"


def icon(paths: str) -> str:
    return (f'<span class="icon"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" '
            f'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{paths}</svg></span>')


def art(up: str, name: str, alt: str, width: int = 320, height: int = 220) -> str:
    return f'<img class="art" src="{up}img/{name}.svg" alt="{e(alt)}" width="{width}" height="{height}" loading="lazy" decoding="async">'


def first_sentence(text: str) -> str:
    return re.split(r"(?<=[.!?])\s", text, maxsplit=1)[0]


def page(lang: str, t: dict, cfg: dict, names: dict, site_url: str, locales: tuple = (), samples: dict | None = None) -> str:
    brand, opened = cfg["brand"], signup_is_open(cfg)
    cta = t["cta_signup"] if opened else t["cta_access"]
    faqs = questions(t, cfg)

    steps = "".join(f'<li class="card step">{art("../", STEP_ART[i % len(STEP_ART)], s["title"])}<h3>{e(s["title"])}</h3><p>{e(s["text"])}</p></li>'
                    for i, s in enumerate(t["steps"]))
    features = "".join(f'<li class="card">{icon(ICONS[i % len(ICONS)])}<h3>{e(f["title"])}</h3><p>{e(f["text"])}</p></li>'
                       for i, f in enumerate(t["features"]))
    audience = "".join(f"<li>{e(a)}</li>" for a in t["audience"])
    trust = "".join(f"<li>{e(x)}</li>" for x in t["trust"])
    faq = "".join(f'<details><summary>{e(q["q"])}</summary><p>{e(q["a"])}</p></details>' for q in faqs)
    badges = "".join(f"<li>{e(b)}</li>" for b in t["hero_badges"])
    cases = "".join(f'<li class="card case">{art("../", CASE_ART[i % len(CASE_ART)], c["title"])}<h3>{e(c["title"])}</h3><p>{e(c["text"])}</p></li>'
                    for i, c in enumerate(t["cases"]))
    codes = "".join(f'<li lang="{c}">{c.upper()}</li>' for c in cfg["languages"])
    # The same example message in the other languages: each is the text from that language's own file.
    spoken = "".join(f'<li class="sample" lang="{code}"{direction(cfg, code, always=True)}><span>{e(names[code])}</span><p>{e(first_sentence(body))}</p></li>'
                     for code, body in (samples or {}).items() if code != lang)
    pricing = f'<p class="price">{e(signup_fee_text(t, cfg))}</p><p>{e(t["pricing_open_text"])}</p>' if opened else f'<p>{e(t["pricing_text"])}</p>'
    join = f'<a class="button" href="signup/">{e(cta)}</a>'
    # Who does each part: the visitor's own steps are marked differently from the automatic ones.
    flow = "".join(f'<li class="card stage-step{" auto" if s["who"] == brand else ""}"><span class="who">{e(s["who"])}</span><h3>{e(s["title"])}</h3><p>{e(s["text"])}</p></li>'
                   for s in t["auto_steps"])

    graph = None
    if site_url:
        graph = [*organisation(cfg, site_url), software(t, cfg, site_url),
                 *web_page(site_url, lang, lang, t["meta_title"], t["meta_description"], [(brand, lang)]),
                 {"@type": "FAQPage", "@id": f"{site_url}/{lang}/#faq", "inLanguage": lang, "mainEntity": [
                     {"@type": "Question", "name": q["q"], "acceptedAnswer": {"@type": "Answer", "text": q["a"]}} for q in faqs]}]
    top = head(cfg, site_url, title=t["meta_title"], description=t["meta_description"], up="../", path=lang, lang=lang,
               alternates="", locale=t["og_locale"], other_locales=tuple(x for x in locales if x != t["og_locale"]), graph=graph)

    return f"""{top}
<body>
{top_bar(t, cfg, names, lang, up="../")}
  <main id="main">
    <section class="hero">
      <div class="wrap split">
        <div class="hero-copy">
          <h1>{e(t["hero_title"])}</h1>
          <p class="lead">{e(t["hero_text"])}</p>
          <p class="buttons">{join}<a class="button ghost" href="#how">{e(t["cta_how"])}</a></p>
          <ul class="badges">{badges}</ul>
        </div>
        <div class="stage">
          <ul class="chips" aria-hidden="true">{codes}</ul>
          <figure class="message main">
            <figcaption>{e(t["example_label"])}</figcaption>
            <p class="to">{e(t["example_to"])}</p>
            <blockquote>{e(t["example_body"])}</blockquote>
          </figure>
          <figure class="message reply">
            <figcaption>{e(t["example_reply_label"])}</figcaption>
            <blockquote>{e(t["example_reply"])}</blockquote>
          </figure>
        </div>
      </div>
    </section>
    <section class="strip"><div class="wrap"><h2>{e(t["audience_title"])}</h2><ul class="pills">{audience}</ul></div></section>
    <section id="about"><div class="wrap narrow center"><h2>{e(t["about_title"])}</h2><p class="statement">{e(t["about_text"])}</p></div></section>
    <section id="autopilot" class="tint"><div class="wrap"><div class="heading"><h2>{e(t["auto_title"])}</h2><p class="lead">{e(t["auto_text"])}</p></div>
      <ol class="flow">{flow}</ol>
      <div class="replies"><span class="who">{e(t["replies_label"])}</span><h3>{e(t["replies_title"])}</h3><p>{e(t["replies_text"])}</p></div>
    </div></section>
    <section><div class="wrap"><div class="heading"><h2>{e(t["compare_title"])}</h2><p class="lead">{e(t["compare_text"])}</p></div>
      <div class="two compare">
        <figure class="message plain"><figcaption>{e(t["generic_label"])}</figcaption><blockquote>{e(t["generic_body"])}</blockquote></figure>
        <figure class="message better"><figcaption>{e(t["personal_label"])}</figcaption><blockquote>{e(t["example_body"])}</blockquote></figure>
      </div></div></section>
    <section id="how"><div class="wrap"><div class="heading"><h2>{e(t["how_title"])}</h2></div><ol class="steps">{steps}</ol></div></section>
    <section id="features" class="tint"><div class="wrap"><div class="heading"><h2>{e(t["features_title"])}</h2></div><ul class="grid">{features}</ul></div></section>
    <section class="languages"><div class="wrap split">
      <div><h2>{e(t["languages_title"])}</h2><p class="lead">{e(t["languages_text"])}</p><ul class="samples">{spoken}</ul></div>
      {art("../", "globe", t["languages_title"], 480, 400)}
    </div></section>
    <section class="tint"><div class="wrap"><div class="heading"><h2>{e(t["cases_title"])}</h2></div><ul class="grid">{cases}</ul></div></section>
    <section><div class="wrap split">
      {art("../", "shield", t["trust_title"])}
      <div><h2>{e(t["trust_title"])}</h2><ul class="ticks">{trust}</ul></div>
    </div></section>
    <section id="pricing" class="tint"><div class="wrap narrow"><div class="panel center"><h2>{e(t["pricing_title"])}</h2>{pricing}<p class="buttons">{join}</p></div></div></section>
    <section id="faq"><div class="wrap narrow"><div class="heading"><h2>{e(t["faq_title"])}</h2></div>{faq}</div></section>
    <section class="final"><div class="wrap"><div class="banner"><h2>{e(t["final_title"])}</h2><p>{e(t["final_open_text"] if opened else t["final_text"])}</p><p class="buttons"><a class="button light" href="signup/">{e(cta)}</a></p></div></div></section>
  </main>
{bottom(t, cfg, "../", lang)}"""


def signup_page(lang: str, t: dict, cfg: dict, names: dict, site_url: str, locales: tuple = ()) -> str:
    """/<lang>/signup/: what signing up involves, and the way in (the app's form, or an email while closed)."""
    brand, app, opened = cfg["brand"], cfg["app_url"].rstrip("/"), signup_is_open(cfg)
    steps = "".join(f'<li><h3>{e(s["title"])}</h3><p>{e(s["text"])}</p></li>' for s in t["signup_steps"])
    if opened:
        note = f'<p class="price">{e(signup_fee_text(t, cfg))}</p>'
        button = f'<a class="button" href="{e(app)}/signup?lang={lang}">{e(t["cta_signup"])}</a>'
        extra = f'<p class="muted">{e(t["signup_form_note"])}</p>' if t["signup_form_note"] else ""
    else:
        note = f'<p role="status" class="notice">{e(t["signup_closed"])}</p>'
        mail = f"mailto:{cfg['contact_email']}?subject={quote(t['mail_subject'] + ' - ' + brand)}"
        button = f'<a class="button" href="{e(mail)}">{e(t["cta_access"])}</a>'
        extra = ""
    account = f'<p>{e(t["signup_have_account"])} <a href="{e(app)}/login?lang={lang}">{e(t["nav_signin"])}</a></p>' if app else ""
    legal = " · ".join(f'<a href="../../{legal_path(cfg, slug, lang)}/">{e(t[LEGAL_LINKS[slug]])}</a>' for slug in ("terms", "privacy"))

    path = f"{lang}/signup"
    graph = None
    if site_url:
        graph = [*organisation(cfg, site_url), software(t, cfg, site_url),
                 *web_page(site_url, path, lang, t["signup_meta_title"], t["signup_meta_description"],
                           [(brand, lang), (t["signup_title"], path)])]
    top = head(cfg, site_url, title=t["signup_meta_title"], description=t["signup_meta_description"], up="../../", path=path,
               lang=lang, alternates="signup/", locale=t["og_locale"],
               other_locales=tuple(x for x in locales if x != t["og_locale"]), graph=graph)
    return f"""{top}
<body>
{top_bar(t, cfg, names, lang, up="../../", after="signup/")}
  <main id="main">
    <section class="hero join"><div class="wrap split">
      <div class="panel">
        <h1>{e(t["signup_title"])}</h1>
        <p class="lead">{e(t["signup_text"])}</p>
        {note}
        <p class="buttons">{button}</p>
        {extra}
        {account}
        <p class="muted">{legal}</p>
      </div>
      <div>
        {art("../../", "step-launch", t["signup_steps_title"])}
        <h2>{e(t["signup_steps_title"])}</h2>
        <ol class="timeline">{steps}</ol>
      </div>
    </div></section>
  </main>
{bottom(t, cfg, "../../", lang)}"""


def not_found_page(cfg: dict, locales: dict) -> str:
    """Served for unknown addresses; links start at "/" because the missing address can be at any depth."""
    links = "".join(f'<li><a href="/{code}/" lang="{code}">{e(t["not_found_title"])} · {e(t["lang_name"])}</a></li>'
                    for code, t in locales.items())
    return f"""<!doctype html>
<html lang="{cfg["default_language"]}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 - {e(cfg["brand"])}</title>
  <meta name="robots" content="noindex">
  <link rel="icon" href="/icon.png" type="image/png">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <main class="wrap narrow chooser"><h1>{e(cfg["brand"])} · 404</h1><ul>{links}</ul></main>
</body>
</html>
"""


# AI assistants and AI search. All are welcome; change a group to "Disallow: /" to keep one out.
AI_CRAWLERS = ("OAI-SearchBot", "ChatGPT-User", "GPTBot", "Claude-SearchBot", "Claude-User", "ClaudeBot",
               "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended")


def robots_txt(site_url: str) -> str:
    groups = "".join(f"User-agent: {bot}\nAllow: /\n\n" for bot in ("*", *AI_CRAWLERS))
    return f"{groups}Sitemap: {site_url}/sitemap.xml\n"


def sitemap_xml(cfg: dict, site_url: str) -> str:
    urls = []
    for after in ("", "signup/"):
        links = "".join(f'<xhtml:link rel="alternate" hreflang="{c}" href="{e(site_url)}/{c}/{after}"/>' for c in cfg["languages"])
        links += f'<xhtml:link rel="alternate" hreflang="x-default" href="{e(site_url)}/{cfg["default_language"]}/{after}"/>'
        urls += [f"  <url><loc>{e(site_url)}/{c}/{after}</loc>{links}</url>\n" for c in cfg["languages"]]
    for slug in LEGAL_PAGES:
        paths = {c: legal_path(cfg, slug, c) for c in cfg["languages"]}
        links = "".join(f'<xhtml:link rel="alternate" hreflang="{c}" href="{e(site_url)}/{p}/"/>' for c, p in paths.items())
        links += f'<xhtml:link rel="alternate" hreflang="x-default" href="{e(site_url)}/{paths[cfg["default_language"]]}/"/>'
        urls += [f"  <url><loc>{e(site_url)}/{p}/</loc>{links}</url>\n" for p in paths.values()]
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
            f'xmlns:xhtml="http://www.w3.org/1999/xhtml">\n{"".join(urls)}</urlset>\n')


def llms_txt(t: dict, cfg: dict, names: dict, site_url: str) -> str:
    """A plain summary for AI assistants (llmstxt.org), made from the English page's own words."""
    lines = [f'# {cfg["brand"]}', "", f'> {t["about_text"]}', "", f'## {t["auto_title"]}', ""]
    lines += [f'{i}. {s["who"]}: {s["title"]}. {s["text"]}' for i, s in enumerate(t["auto_steps"], 1)]
    lines += ["", f'{t["replies_label"]}: {t["replies_title"]}. {t["replies_text"]}', "", f'## {t["features_title"]}', ""]
    lines += [f'- {f["title"]}: {f["text"]}' for f in t["features"]]
    lines += ["", f'## {t["how_title"]}', ""]
    lines += [f'{i}. {s["title"]}: {s["text"]}' for i, s in enumerate(t["steps"], 1)]
    lines += ["", f'## {t["faq_title"]}', ""]
    lines += [line for q in questions(t, cfg) for line in (f'### {q["q"]}', q["a"], "")]
    lines += ["## Pages", ""]
    lines += [f'- [{names[c]}]({site_url}/{c}/)' for c in cfg["languages"]]
    lines += [f'- [{t["signup_title"]}]({site_url}/{cfg["default_language"]}/signup/)']
    legal = legal_text(cfg["default_language"])
    lines += [f'- [{legal[slug]["title"]}]({site_url}/{slug}/)' for slug in LEGAL_PAGES]
    lines += ["", "## Company", "", f'{cfg["company"]}. Contact: {cfg["contact_email"]}', ""]
    return "\n".join(lines)


def root_page(cfg: dict, names: dict) -> str:
    """Used where the web server does not choose (any static hosting): site.js picks the language."""
    links = "".join(f'<li><a href="{code}/" lang="{code}" data-lang="{code}">{e(names[code])}</a></li>' for code in cfg["languages"])
    return f"""<!doctype html>
<html lang="{cfg["default_language"]}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(cfg["brand"])}</title>
  <link rel="icon" href="icon.png" type="image/png">
  <link rel="stylesheet" href="styles.css">
  <script src="site.js" defer></script>
</head>
<body data-chooser="{" ".join(cfg["languages"])}" data-default="{cfg["default_language"]}">
  <main class="wrap narrow chooser"><h1>{e(cfg["brand"])}</h1><ul>{links}</ul></main>
</body>
</html>
"""


def htaccess(cfg: dict, site_url: str) -> str:
    """Apache settings: HTTPS, one address, the language choice (as in the Caddyfile) and security headers.
    The country comes from Cloudflare's Cf-Ipcountry header when present, else the browser language decides."""
    default = cfg["default_language"]
    lines = ["# Written by website/build.py. Needs mod_rewrite (standard on cPanel hosting).",
             "DirectoryIndex index.html", "", "<IfModule mod_rewrite.c>", "RewriteEngine On", ""]
    if site_url.startswith("https://"):
        host = site_url[len("https://"):]
        pattern = host.replace(".", "\\.")
        lines += ["# Always https (switch the free SSL certificate on in your hosting first)",
                  "RewriteCond %{HTTPS} !=on", "RewriteCond %{HTTP:X-Forwarded-Proto} !https",
                  f"RewriteRule ^ https://{host}%{{REQUEST_URI}} [R=301,L]", "# www to the plain address",
                  f"RewriteCond %{{HTTP_HOST}} ^www\\.{pattern}$ [NC]",
                  f"RewriteRule ^ https://{host}%{{REQUEST_URI}} [R=301,L]", ""]

    def rule(target: str, *conditions: str) -> None:
        lines.extend([*conditions, f"RewriteRule ^$ /{target}/ [R=302,L]"])

    lines.append("# The front page only. 1. the language the visitor picked before")
    for code in cfg["languages"]:
        rule(code, f"RewriteCond %{{HTTP_COOKIE}} (^|;\\s*)lang={code}(;|$)")
    lines.append("# 2. countries with several languages: the browser decides among them")
    for country, langs in cfg["multilingual_countries"].items():
        for code in langs:
            rule(code, f"RewriteCond %{{HTTP:Cf-Ipcountry}} ^{country}$", f"RewriteCond %{{HTTP:Accept-Language}} ^\\s*{code}\\b [NC]")
    lines.append("# 2. the country")
    for code, countries in cfg["countries"].items():
        rule(code, f"RewriteCond %{{HTTP:Cf-Ipcountry}} ^({'|'.join(countries)})$")
    lines.append('# any other known country ("XX" means unknown)')
    rule(default, "RewriteCond %{HTTP:Cf-Ipcountry} ^[A-Z]{2}$", "RewriteCond %{HTTP:Cf-Ipcountry} !^XX$")
    lines.append("# 3. the browser language")
    for code in cfg["languages"]:
        if code != default:
            rule(code, f"RewriteCond %{{HTTP:Accept-Language}} ^\\s*{code}\\b [NC]")
    rule(default)
    lines += ["</IfModule>", "", "ErrorDocument 404 /404.html", "", "<IfModule mod_headers.c>"]
    for header in HEADERS.strip().splitlines()[1:]:
        name, value = header.strip().split(": ", 1)
        lines.append(f'Header always set {name} "{value}"')
    lines += ["</IfModule>", ""]
    return "\n".join(lines)


def package(target: Path, site_url: str | None = None, out: Path = DIST) -> list[str]:
    """Build the site and zip it for upload to ordinary web hosting."""
    cfg = load_config()
    url = (cfg.get("site_url", "") if site_url is None else site_url).rstrip("/")
    names = [n for n in build(site_url, out) if n not in ("_redirects", "_headers")]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for name in names:
            z.write(out / name, name)
        z.writestr(".htaccess", htaccess(cfg, url))
    return sorted([*names, ".htaccess"])


def build(site_url: str | None = None, out: Path = DIST) -> list[str]:
    """site_url None: the address in site.json; "": build without an address."""
    cfg = load_config()
    site_url = (cfg.get("site_url", "") if site_url is None else site_url).rstrip("/")
    locales = {lang: load_locale(lang, cfg["brand"], cfg["company"]) for lang in cfg["languages"]}
    names = {lang: t["lang_name"] for lang, t in locales.items()}

    # Overwrite in place: the web server mounts this folder, so the folder itself must stay.
    out.mkdir(parents=True, exist_ok=True)
    og = tuple(t["og_locale"] for t in locales.values())
    samples = {lang: t["example_body"] for lang, t in locales.items()}
    files = {f"{lang}/index.html": page(lang, t, cfg, names, site_url, og, samples) for lang, t in locales.items()}
    files.update({f"{lang}/signup/index.html": signup_page(lang, t, cfg, names, site_url, og) for lang, t in locales.items()})
    files["index.html"] = root_page(cfg, names)
    files["404.html"] = not_found_page(cfg, locales)
    files.update({f"{legal_path(cfg, slug, lang)}/index.html": legal_page(slug, lang, cfg, names, site_url)
                  for slug in LEGAL_PAGES for lang in cfg["languages"]})
    files["_redirects"] = netlify_redirects(cfg, site_url)
    files["_headers"] = HEADERS
    for asset in ("styles.css", "site.js"):
        files[asset] = (HERE / "src" / asset).read_text(encoding="utf-8")
    if site_url:
        english = locales[cfg["default_language"]]
        files["sitemap.xml"] = sitemap_xml(cfg, site_url)
        files["robots.txt"] = robots_txt(site_url)
        files["llms.txt"] = llms_txt(english, cfg, names, site_url)
    else:
        for stale in ("sitemap.xml", "robots.txt", "llms.txt"):
            (out / stale).unlink(missing_ok=True)

    for name, content in files.items():
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    shutil.copyfile(ICON, out / "icon.png")
    shutil.copyfile(HERE / "src" / "social.png", out / "social.png")
    (out / "img").mkdir(exist_ok=True)
    pictures = sorted((HERE / "src" / "img").glob("*.svg"))
    for picture in pictures:
        shutil.copyfile(picture, out / "img" / picture.name)
    return sorted([*files, "icon.png", "social.png", *(f"img/{p.name}" for p in pictures)])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site-url", default=None, help="public address of the website (default: site.json)")
    parser.add_argument("--zip", type=Path, help="also write this zip for upload to ordinary web hosting")
    args = parser.parse_args()
    if args.zip:
        packed = package(args.zip, args.site_url)
        print(f"upload package: {args.zip} ({len(packed)} files)")
    else:
        written = build(args.site_url)
        print(f"website built: {len(written)} files in {DIST}")
