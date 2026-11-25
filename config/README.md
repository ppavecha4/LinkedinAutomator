# `config/` — runtime-mounted configuration

Files here are mounted **read-only** into the orchestrator and
outreach-worker containers at `/app/config/`. Edit the files on the
host, restart the relevant service (or just re-run the send script —
files are loaded fresh on every call). No image rebuild required.

## Files

### `email_signature.html`
HTML signature appended to every outbound email. References `cid:logo`
which is attached as an inline MIME part if `logo.png` is present
below.

### `email_signature.txt`
Plain-text equivalent of the signature, used in the multipart/alternative
text-part. Should mirror the HTML version's content. The leading `-- `
(two hyphens + space + newline) is the [RFC 3676 signature delimiter](https://datatracker.ietf.org/doc/html/rfc3676#section-4.3) —
keeps email clients from quoting the signature on reply.

### `logo.png` (optional)
Your company logo. If present, attached to every outbound email as
an inline MIME part with `Content-ID: <logo>` so the signature's
`<img src="cid:logo">` resolves. If absent, the `<img>` simply doesn't
render — the rest of the signature still works.

**Image guidance:**
- **Format:** PNG with transparent background (best) or JPG
- **Dimensions:** 200×80 px or similar — kept proportional via the
  `width="86"` attribute in the signature HTML
- **File size:** keep under 50 KB; ideally under 20 KB. Heavy logos
  inflate every email.
- **Don't use SVG** — many email clients (Outlook, Yahoo) don't render it.

## Live editing

The orchestrator's `send_pending_emails.py` and the production
`GoogleWorkspaceEmailChannel` both load these files **on every send**.
Save changes, then either re-run the script or wait for the next
worker poll cycle — no restart needed.

## Where the path comes from

The default load path is `/app/config/email_signature.{html,txt}` and
`/app/config/logo.png`. Override per-service via env vars if you want
different signatures for different sender personas:

```bash
EMAIL_SIGNATURE_HTML_PATH=/app/config/personal_signature.html
EMAIL_SIGNATURE_TEXT_PATH=/app/config/personal_signature.txt
EMAIL_LOGO_PATH=/app/config/personal_logo.png
```

(Set those in `.env`; they're read by `send_pending_emails.py` and the
channel.)
