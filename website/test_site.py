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
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

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
                if key not in ("footer_legal_note", "signup_form_note"):
                    self.assertTrue(value, f"{lang}.{key} is empty")
            if lang != "en":
                for key in ("hero_title", "hero_text", "cta_access", "example_body", "pricing_text", "final_title",
                            "about_text", "signup_title", "signup_text", "signup_closed", "signup_fee_text", "faq_cost_q",
                            "auto_title", "auto_text", "planned_text"):
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
                self.assertIn('<a class="button" href="signup/">', text)
                self.assertIsNone(re.search(r'<script(?![^>]*(\bsrc=|type="application/ld\+json"))', text),
                                  "no inline script (the security policy blocks it); data blocks are fine")
                ours = "|".join(re.escape(u.split("://", 1)[1]) for u in ("https://example.test", CFG["app_url"]) if u)
                self.assertNotRegex(text, rf'(?:src|href)="https?://(?!(?:{ours})[/"])', "no third-party files")
            sitemap = (out / "sitemap.xml").read_text(encoding="utf-8")
            self.assertEqual(sitemap.count("<loc>"), 2 * len(CFG["languages"]) + len(build.LEGAL_PAGES))
            ElementTree.fromstring(sitemap.encode("utf-8"))                  # well-formed
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

    def test_the_published_site_signs_in_on_the_app(self):
        self.assertRegex(CFG["app_url"], r"^https://[a-z0-9.-]+$")
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            build.build(None, out)
            for lang in CFG["languages"]:
                self.assertIn(f'href="{CFG["app_url"]}/login">', (out / lang / "index.html").read_text(encoding="utf-8"))

    def build_with(self, out: Path, **settings) -> None:
        original = build.load_config
        try:
            build.load_config = lambda: {**original(), **settings}
            build.build("https://example.test", out)
        finally:
            build.load_config = original

    def test_the_sign_up_page_asks_for_an_email_until_sign_up_is_open(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            for opened in (False, True):
                self.build_with(out, app_signup=opened, app_url="https://app.example.test")
                for lang in CFG["languages"]:
                    t = build.load_locale(lang, CFG["brand"], CFG["company"])
                    signup = unescape((out / lang / "signup" / "index.html").read_text(encoding="utf-8"))
                    home = unescape((out / lang / "index.html").read_text(encoding="utf-8"))
                    self.assertIn('<a class="button" href="signup/">', home, lang)
                    self.assertIn(f'<h1>{t["signup_title"]}</h1>', signup)
                    self.assertIn('href="https://app.example.test/login"', signup)
                    self.assertEqual('href="https://app.example.test/signup"' in signup, opened, lang)
                    self.assertEqual("mailto:" + CFG["contact_email"] + "?subject=" in signup, not opened, lang)
                    for page_text in (signup, home):                          # a price only once it can be paid
                        self.assertEqual(CFG["signup_fee"]["inr"] in page_text, opened, lang)
                    self.assertEqual(t["signup_closed"] in signup, not opened, lang)

    def test_the_published_fee_is_the_one_the_app_charges(self):
        env = (HERE.parent / "services" / "api" / "src" / "env.ts").read_text(encoding="utf-8")
        value = lambda name: int(re.search(rf"int\('{name}', (\d+)\)", env).group(1))        # noqa: E731
        paise = value("SIGNUP_FEE_INR_PAISE")
        total = paise + round(paise * value("SIGNUP_FEE_GST_PERCENT") / 100)
        self.assertEqual(CFG["signup_fee"], {"inr": f"₹{total / 100:.2f}", "usd": f"US${value('SIGNUP_FEE_USD_CENTS') // 100}"})

    def test_search_and_answer_engines_get_facts_that_match_the_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            self.build_with(out, app_signup=False)
            for path in [*CFG["languages"], *(f"{x}/signup" for x in CFG["languages"]), *build.LEGAL_PAGES]:
                text = (out / path / "index.html").read_text(encoding="utf-8")
                self.assertEqual(text.count("<h1>"), 1, path)
                self.assertRegex(text, r'<title>[^<]{10,90}</title>', path)
                self.assertRegex(text, r'<meta name="description" content="[^"]{50,200}">', path)
                self.assertIn(f'<link rel="canonical" href="https://example.test/{path}/">', text)
                blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S)
                self.assertEqual(len(blocks), 1, path)
                graph = {node["@type"]: node for node in json.loads(blocks[0])["@graph"]}
                self.assertTrue({"Organization", "WebSite", "WebPage"} <= set(graph), path)
                self.assertNotIn("offers", graph.get("SoftwareApplication", {}), path)
                if path in CFG["languages"]:
                    visible = [(unescape(q), unescape(a)) for q, a in re.findall(r"<summary>([^<]*)</summary><p>([^<]*)</p>", text)]
                    marked = [(q["name"], q["acceptedAnswer"]["text"]) for q in graph["FAQPage"]["mainEntity"]]
                    self.assertEqual(marked, visible, path)
                    self.assertGreaterEqual(len(marked), 8)
            robots = (out / "robots.txt").read_text(encoding="utf-8")
            for bot in ("*", *build.AI_CRAWLERS):
                self.assertIn(f"User-agent: {bot}\nAllow: /\n", robots)
            self.assertNotIn("Disallow", robots)
            llms = (out / "llms.txt").read_text(encoding="utf-8")
            self.assertTrue(llms.startswith(f"# {CFG['brand']}\n"))
            self.assertIn("https://example.test/en/signup/", llms)
            self.assertNotIn("{", llms)
            self.assertIn('<meta name="robots" content="noindex">', (out / "404.html").read_text(encoding="utf-8"))
            self.build_with(out, app_signup=True)
            graph = json.loads(re.search(r'ld\+json">(.*?)</script>', (out / "en" / "index.html").read_text(encoding="utf-8"), re.S).group(1))
            offers = next(n for n in graph["@graph"] if n["@type"] == "SoftwareApplication")["offers"]
            self.assertEqual([(o["price"], o["priceCurrency"]) for o in offers], [("218.30", "INR"), ("2", "USD")])

    def test_pictures_exist_have_words_and_need_nothing_from_elsewhere(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            build.build("https://example.test", out)
            for lang in CFG["languages"]:
                for path, depth in ((lang, 1), (f"{lang}/signup", 2)):
                    text = (out / path / "index.html").read_text(encoding="utf-8")
                    pictures = re.findall(r'<img class="art" src="((?:\.\./)+img/[a-z-]+\.svg)" alt="([^"]+)"', text)
                    self.assertTrue(pictures, path)
                    for src, alt in pictures:
                        self.assertEqual(src.count("../"), depth, path)
                        self.assertTrue((out / src.replace("../", "")).is_file(), src)
                    self.assertNotIn(' style="', text, "the security policy blocks inline styles")
            for picture in (HERE / "src" / "img").glob("*.svg"):
                art = picture.read_text(encoding="utf-8")
                ElementTree.fromstring(art)
                self.assertNotRegex(art, r'<script|<style| style="|href="(?!#)', picture.name)

    def test_what_is_not_built_yet_is_said_to_be_planned(self):
        # The app does not answer replies by itself. Remove this only when it does.
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            build.build("https://example.test", out)
            for lang in CFG["languages"]:
                t = build.load_locale(lang, CFG["brand"], CFG["company"])
                text = unescape((out / lang / "index.html").read_text(encoding="utf-8"))
                self.assertIn(f'<span class="who">{t["planned_label"]}</span><h3>{t["planned_title"]}</h3>', text)
                self.assertEqual(text.count('class="card stage-step'), 5)
                self.assertEqual(text.count('class="card stage-step auto"'), 3)
                for step in t["auto_steps"]:
                    self.assertNotIn(t["planned_title"], step["title"])
            llms = (out / "llms.txt").read_text(encoding="utf-8")
            self.assertIn("This is not available yet.", llms)
            self.assertIn("Does AmiReach answer replies for me?\nNot yet.", llms)

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
            wanted = {"index.html", "404.html", ".htaccess", "styles.css", "site.js", "icon.png", "social.png", "sitemap.xml",
                      "robots.txt", "llms.txt"}
            wanted |= {f"{x}/index.html" for x in [*CFG["languages"], *build.LEGAL_PAGES]}
            wanted |= {f"{x}/signup/index.html" for x in CFG["languages"]}
            wanted |= {f"img/{p.name}" for p in (HERE / "src" / "img").glob("*.svg")}
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
