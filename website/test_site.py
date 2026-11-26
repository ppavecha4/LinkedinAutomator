"""Checks for the public website:  python -m unittest discover -s website

Every language has the same content, pages build cleanly, search engines get the language links, and the
web server's country lists match website/site.json.
"""
from __future__ import annotations

import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path

import build

HERE = Path(__file__).resolve().parent
CFG = build.load_config()


def shape(value):
    """The structure of a language file: keys and list lengths, not the words."""
    if isinstance(value, dict):
        return {k: shape(v) for k, v in value.items()}
    if isinstance(value, list):
        return [shape(v) for v in value]
    return type(value).__name__


def raw(lang: str) -> dict:
    return json.loads((HERE / "locales" / f"{lang}.json").read_text(encoding="utf-8"))


class SiteTest(unittest.TestCase):
    def test_every_language_has_the_same_content(self):
        english = shape(raw("en"))
        for lang in CFG["languages"]:
            self.assertEqual(shape(raw(lang)), english, lang)

    def test_nothing_is_left_untranslated_or_empty(self):
        english = raw("en")
        for lang in CFG["languages"]:
            t = raw(lang)
            for key, value in t.items():
                if key != "footer_legal_note":
                    self.assertTrue(value, f"{lang}.{key} is empty")
            if lang != "en":
                for key in ("hero_title", "hero_text", "cta_access", "example_body", "pricing_text", "final_title"):
                    self.assertNotEqual(t[key], english[key], f"{lang}.{key} is still English")
                self.assertTrue(t["footer_legal_note"], f"{lang}: say that the legal pages are in English")

    def test_pages_build_with_the_right_language_and_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            build.build("https://example.test/", out)
            for lang in CFG["languages"]:
                text = (out / lang / "index.html").read_text(encoding="utf-8")
                self.assertIn(f'<html lang="{lang}">', text)
                self.assertNotIn("{brand}", text)
                self.assertIn(CFG["brand"], text)
                self.assertIn(f'<link rel="canonical" href="https://example.test/{lang}/">', text)
                for other in CFG["languages"]:
                    self.assertIn(f'hreflang="{other}" href="https://example.test/{other}/"', text)
                self.assertIn('hreflang="x-default" href="https://example.test/en/"', text)
                self.assertIn(f"mailto:{CFG['contact_email']}?subject=", text)
                self.assertIsNone(re.search(r"<script(?![^>]*\bsrc=)", text), "no inline script (the security policy blocks it)")
                self.assertNotRegex(text, r'(?:src|href)="https?://(?!example\.test|sales\.appsontechnologies\.com)', "no third-party files")
            self.assertEqual((out / "sitemap.xml").read_text().count("<loc>"), len(CFG["languages"]) + len(build.LEGAL_PAGES))
            build.build("", out)                                            # without an address: no search files
            self.assertFalse((out / "sitemap.xml").exists())
            self.assertNotIn("canonical", (out / "en" / "index.html").read_text(encoding="utf-8"))

    def test_legal_pages_carry_every_section_of_the_apps_own_text(self):
        source = build.LEGAL_SOURCE.read_text(encoding="utf-8")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            build.build("https://example.test", out)
            total = 0
            for slug, (name, title) in build.LEGAL_PAGES.items():
                sections = build.legal_sections(name)
                total += len(sections)
                self.assertTrue(sections and all(paragraphs for _, paragraphs in sections), name)
                text = (out / slug / "index.html").read_text(encoding="utf-8")
                self.assertIn(f"<h1>{title}</h1>", text)
                for heading, _ in sections:
                    self.assertIn(f"<h2>{build.e(heading)}</h2>", text)
                self.assertNotIn("\\'", text)
            self.assertEqual(total, source.count("{ title:"))
            privacy = (out / "privacy" / "index.html").read_text(encoding="utf-8")
            self.assertIn("Ritik Technologie Private Limited", privacy)
            self.assertIn("Customers&#x27; own accounts", privacy)             # an escaped quote came through whole
            self.assertIn("This website", privacy)
            self.assertIn('href="../privacy/"', (out / "es" / "index.html").read_text(encoding="utf-8"))

    def test_sign_in_shows_only_when_the_app_has_an_address(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            original = build.load_config
            try:
                for app, shown in (("", False), ("https://app.example.test", True)):
                    build.load_config = lambda: {**original(), "app_url": app}
                    build.build("https://example.test", out)
                    self.assertEqual("/login" in (out / "en" / "index.html").read_text(encoding="utf-8"), shown)
            finally:
                build.load_config = original

    def test_static_hosting_rules_choose_the_language_the_same_way(self):
        rules = build.netlify_redirects(CFG, "https://example.test").splitlines()
        self.assertEqual(rules[0], "https://www.example.test/* https://example.test/:splat 301!")
        self.assertEqual(rules[-1], "/ /en/ 302!")
        order = lambda start: next(i for i, r in enumerate(rules) if r.startswith(start))          # noqa: E731
        saved, mixed, country = order("/ /en/ 302! Cookie="), order("/ /nl/ 302! Country=be"), order("/ /es/ 302! Country=es")
        self.assertTrue(saved < mixed < country)
        self.assertLess(order("/ /de/ 302! Country=be Language=de"), rules.index("/ /en/ 302! Country=be"))
        for lang, countries in CFG["countries"].items():
            self.assertIn(f"/ /{lang}/ 302! Country={','.join(c.lower() for c in countries)}", rules)
        script = (HERE / "src" / "site.js").read_text(encoding="utf-8")
        self.assertEqual(re.search(r"var all = \[(.*?)\];", script).group(1).replace("'", "").split(", "), CFG["languages"])

    def test_the_upload_package_holds_the_whole_site_and_its_server_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "site.zip"
            build.package(target, "https://example.test", Path(tmp) / "dist")
            with zipfile.ZipFile(target) as z:
                names = set(z.namelist())
                rules = z.read(".htaccess").decode()
            wanted = {"index.html", ".htaccess", "styles.css", "site.js", "icon.png", "social.png", "sitemap.xml", "robots.txt"}
            wanted |= {f"{x}/index.html" for x in [*CFG["languages"], *build.LEGAL_PAGES]}
            self.assertEqual(names, wanted)
            self.assertIn("RewriteRule ^ https://example.test%{REQUEST_URI} [R=301,L]", rules)
            for countries in CFG["countries"].values():
                self.assertIn(f"^({'|'.join(countries)})$", rules)

    def test_the_web_server_uses_the_same_countries(self):
        caddy = (HERE.parent / "infrastructure" / "caddy" / "Caddyfile").read_text(encoding="utf-8")
        for lang, countries in CFG["countries"].items():
            found = re.search(rf"@country_{lang} header_regexp Cf-Ipcountry \^\(([A-Z|]+)\)\$", caddy)
            self.assertIsNotNone(found, lang)
            self.assertEqual(found.group(1).split("|"), countries, lang)
        every = [c for group in CFG["countries"].values() for c in group]
        self.assertEqual(len(every), len(set(every)), "a country is listed twice")
        self.assertFalse(set(every) & set(CFG["multilingual_countries"]))


if __name__ == "__main__":
    unittest.main()
