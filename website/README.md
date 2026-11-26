# Public website

One static page per language: English (default), Spanish, Portuguese (European), German and Dutch.
No framework, no tracking, no third-party files. The only cookie remembers a language the visitor picked.

```bash
python3 website/build.py --site-url https://your-website-domain
python3 -m unittest discover -s website
```

## Which language a visitor gets at "/"

1. The one they picked before in the language menu.
2. Their country, from the `Cf-Ipcountry` header that **Cloudflare** adds:
   Spain and Spanish-speaking countries → Spanish · Portugal, Brazil and Portuguese-speaking countries →
   Portuguese · Germany, Austria, Liechtenstein → German · Netherlands, Suriname → Dutch ·
   every other country → English.
   In Belgium (Dutch or German) and Switzerland (German) the browser's language decides, else English.
3. Without a country header: the browser's language, else English.

**Country detection needs Cloudflare in front of the website** (free plan: add the domain there, keep the
record "proxied", and leave Network > IP Geolocation on). Without it step 3 applies.
Every language also has its own address (`/es/`, `/de/`, ...), which search engines use.

## Changing things

| What | Where |
|---|---|
| Brand name, contact address, app address, country lists | `site.json` |
| Words | `locales/<language>.json` (same keys in every file) |
| Design | `src/styles.css` |
| Country routing on the server | `infrastructure/caddy/Caddyfile` (keep equal to `site.json`; a test checks) |

A new language: add `locales/<code>.json`, list it in `site.json`, add its routing to the Caddyfile.

## Publishing

- **On the app's server:** set `WEBSITE_DOMAIN=your-website-domain` in `.env`, point the domain at the
  server, and run `scripts/vps/deploy.sh` (or `scripts/server/first_start.sh` the first time). Both build
  the site.
- **On Netlify:** publish the folder `website/dist/`. The generated `_redirects` file picks the language by
  country (no Cloudflare needed) and `_headers` sets the security headers. Point the domain at Netlify in
  your DNS settings. Check the country rules on the live site, especially Belgium and Switzerland.
- **On ordinary web hosting (Apache, cPanel):** run
  `python3 website/build.py --zip website/amireach-website.zip`, upload the zip into the domain's web
  folder (usually `public_html`) and extract it there. It includes a hidden `.htaccess` file that picks the
  language (by browser; by country if Cloudflare is in front), forces HTTPS and sets security headers.
- **On other static hosting:** upload the contents of `website/dist/`. The front page then picks the
  language from the browser.

The legal pages (`/privacy/`, `/terms/`, `/data-deletion/`) are built from the app's
`dashboard/src/pages/Legal.tsx`: change the text there and rebuild. The sharing picture is `src/social.png`.

## Before launch

- Have a native speaker read each language, especially the front page and pricing.
- Prices are not published yet. Privacy policy, terms and the product's own screens are in English.
