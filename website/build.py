#!/usr/bin/env python3
"""Build the public website: one static page per language, from website/locales/*.json.

    python3 website/build.py [--site-url https://example.com]

Writes website/dist/ (not committed): /<lang>/index.html, a root page that picks a language, the
stylesheet, the small script, and, when the site's address is given, sitemap.xml, robots.txt and the
canonical / hreflang links search engines use to show each visitor their own language.

Only the standard library is used, so it runs on any server. To change the brand name, the contact
address or which countries get which language, edit website/site.json. To change words, edit the
language file; every file must have the same keys (website/test_site.py checks).
"""
from __future__ import annotations

import argparse
import html
import json
import shutil
from pathlib import Path
from urllib.parse import quote

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
ICON = HERE.parent / "assets" / "brand" / "app-icon-1024.png"


def load_config() -> dict:
    return json.loads((HERE / "site.json").read_text(encoding="utf-8"))


def load_locale(lang: str, brand: str) -> dict:
    """The language's strings with the brand name filled in."""
    def fill(value):
        if isinstance(value, str):
            return value.replace("{brand}", brand)
        if isinstance(value, list):
            return [fill(v) for v in value]
        if isinstance(value, dict):
            return {k: fill(v) for k, v in value.items()}
        return value

    return fill(json.loads((HERE / "locales" / f"{lang}.json").read_text(encoding="utf-8")))


def e(text: str) -> str:
    return html.escape(text, quote=True)


def page(lang: str, t: dict, cfg: dict, names: dict, site_url: str) -> str:
    brand, app = cfg["brand"], cfg["app_url"].rstrip("/")
    mail = f"mailto:{cfg['contact_email']}?subject={quote(t['mail_subject'] + ' - ' + brand)}"

    seo = ""
    if site_url:
        seo = f'  <link rel="canonical" href="{e(site_url)}/{lang}/">\n'
        seo += "".join(f'  <link rel="alternate" hreflang="{code}" href="{e(site_url)}/{code}/">\n' for code in cfg["languages"])
        seo += f'  <link rel="alternate" hreflang="x-default" href="{e(site_url)}/{cfg["default_language"]}/">\n'
        seo += f'  <meta property="og:url" content="{e(site_url)}/{lang}/">\n'
        seo += f'  <meta property="og:image" content="{e(site_url)}/icon.png">\n'

    current = ' aria-current="true"'
    switcher = "".join(
        f'<li><a href="../{code}/" lang="{code}" hreflang="{code}" data-lang="{code}"{current if code == lang else ""}>{e(names[code])}</a></li>'
        for code in cfg["languages"])
    steps = "".join(f'<li><h3>{e(s["title"])}</h3><p>{e(s["text"])}</p></li>' for s in t["steps"])
    features = "".join(f'<li class="card"><h3>{e(f["title"])}</h3><p>{e(f["text"])}</p></li>' for f in t["features"])
    audience = "".join(f"<li>{e(a)}</li>" for a in t["audience"])
    trust = "".join(f"<li>{e(x)}</li>" for x in t["trust"])
    faq = "".join(f'<details><summary>{e(q["q"])}</summary><p>{e(q["a"])}</p></details>' for q in t["faq"])
    legal_note = f'<p class="muted">{e(t["footer_legal_note"])}</p>' if t["footer_legal_note"] else ""

    return f"""<!doctype html>
<html lang="{lang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(t["meta_title"])}</title>
  <meta name="description" content="{e(t["meta_description"])}">
  <meta property="og:title" content="{e(t["meta_title"])}">
  <meta property="og:description" content="{e(t["meta_description"])}">
  <meta property="og:type" content="website">
{seo}  <link rel="icon" href="../icon.png" type="image/png">
  <link rel="stylesheet" href="../styles.css">
  <script src="../site.js" defer></script>
</head>
<body>
  <a class="skip" href="#main">{e(t["skip"])}</a>
  <header class="top">
    <div class="wrap bar">
      <a class="logo" href="#main"><img src="../icon.png" alt="" width="32" height="32"><span>{e(brand)}</span></a>
      <nav aria-label="{e(brand)}">
        <a href="#how">{e(t["nav_how"])}</a>
        <a href="#features">{e(t["nav_features"])}</a>
        <a href="#pricing">{e(t["nav_pricing"])}</a>
        <a href="#faq">{e(t["nav_faq"])}</a>
      </nav>
      <div class="actions">
        <details class="lang"><summary aria-label="{e(t["nav_language"])}">{e(names[lang])}</summary><ul>{switcher}</ul></details>
        <a class="button ghost" href="{e(app)}/login">{e(t["nav_signin"])}</a>
      </div>
    </div>
  </header>
  <main id="main">
    <section class="hero">
      <div class="wrap split">
        <div>
          <h1>{e(t["hero_title"])}</h1>
          <p class="lead">{e(t["hero_text"])}</p>
          <p class="buttons"><a class="button" href="{e(mail)}">{e(t["cta_access"])}</a><a class="button ghost" href="#how">{e(t["cta_how"])}</a></p>
        </div>
        <figure class="message">
          <figcaption>{e(t["example_label"])}</figcaption>
          <p class="to">{e(t["example_to"])}</p>
          <blockquote>{e(t["example_body"])}</blockquote>
        </figure>
      </div>
    </section>
    <section id="how"><div class="wrap"><h2>{e(t["how_title"])}</h2><ol class="steps">{steps}</ol></div></section>
    <section id="features" class="tint"><div class="wrap"><h2>{e(t["features_title"])}</h2><ul class="grid">{features}</ul></div></section>
    <section><div class="wrap two">
      <div><h2>{e(t["audience_title"])}</h2><ul class="ticks">{audience}</ul></div>
      <div><h2>{e(t["trust_title"])}</h2><ul class="ticks">{trust}</ul></div>
    </div></section>
    <section id="pricing" class="tint"><div class="wrap narrow"><h2>{e(t["pricing_title"])}</h2><p>{e(t["pricing_text"])}</p><p class="buttons"><a class="button" href="{e(mail)}">{e(t["cta_access"])}</a></p></div></section>
    <section id="faq"><div class="wrap narrow"><h2>{e(t["faq_title"])}</h2>{faq}</div></section>
    <section class="final"><div class="wrap narrow"><h2>{e(t["final_title"])}</h2><p>{e(t["final_text"])}</p><p class="buttons"><a class="button light" href="{e(mail)}">{e(t["cta_access"])}</a></p></div></section>
  </main>
  <footer>
    <div class="wrap">
      <p>&copy; 2026 {e(cfg["company"])}</p>
      <p class="links">
        <a href="{e(app)}/privacy">{e(t["footer_privacy"])}</a>
        <a href="{e(app)}/terms">{e(t["footer_terms"])}</a>
        <a href="{e(app)}/data-deletion">{e(t["footer_deletion"])}</a>
        <a href="mailto:{e(cfg["contact_email"])}">{e(t["footer_contact"])}: {e(cfg["contact_email"])}</a>
      </p>
      {legal_note}
    </div>
  </footer>
</body>
</html>
"""


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


def build(site_url: str = "", out: Path = DIST) -> list[str]:
    cfg = load_config()
    site_url = site_url.rstrip("/")
    locales = {lang: load_locale(lang, cfg["brand"]) for lang in cfg["languages"]}
    names = {lang: t["lang_name"] for lang, t in locales.items()}

    # Overwrite in place: the web server mounts this folder, so the folder itself must stay.
    out.mkdir(parents=True, exist_ok=True)
    files = {f"{lang}/index.html": page(lang, t, cfg, names, site_url) for lang, t in locales.items()}
    files["index.html"] = root_page(cfg, names)
    for asset in ("styles.css", "site.js"):
        files[asset] = (HERE / "src" / asset).read_text(encoding="utf-8")
    if site_url:
        urls = "".join(f"  <url><loc>{e(site_url)}/{lang}/</loc></url>\n" for lang in cfg["languages"])
        files["sitemap.xml"] = f'<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n'
        files["robots.txt"] = f"User-agent: *\nAllow: /\nSitemap: {site_url}/sitemap.xml\n"
    else:
        for stale in ("sitemap.xml", "robots.txt"):
            (out / stale).unlink(missing_ok=True)

    for name, content in files.items():
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
    shutil.copyfile(ICON, out / "icon.png")
    return sorted([*files, "icon.png"])


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--site-url", default="", help="public address of the website, e.g. https://example.com")
    args = parser.parse_args()
    written = build(args.site_url)
    print(f"website built: {len(written)} files in {DIST}")
