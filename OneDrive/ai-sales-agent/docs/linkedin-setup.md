# LinkedIn — channel setup

The AI Sales Agent supports **two** LinkedIn modes. Pick one based on
what you have today.

| Mode | Requires | Volume | Operator effort |
|---|---|---|---|
| **Draft (default)** | Any LinkedIn account (free, premium, or business) | up to ~30/day | 5–10 min/day to copy + paste |
| **API (advanced)** | Approved Marketing Developer Platform partner + Sales Navigator | 50–200+/day | none (full automation) |

The toggle is the env var `LINKEDIN_MODE`:

```bash
LINKEDIN_MODE=draft   # default — works with any account
LINKEDIN_MODE=api     # only flip this once Sales Nav OAuth is set up
```

If you only have a standard business/premium account, **stop here and
follow Part A**. Part B is the gated Sales Nav route, kept for the day
you outgrow draft mode.

---

## Part A — Draft mode (recommended for new operators)

This is the default. The orchestrator runs the full personalisation
pipeline (suppression → rate limit → message validator → AI draft) but
does **not** send through any LinkedIn API. Each generated message
lands in the dashboard's **LinkedIn Drafts** queue with status
`DRAFTED`. The operator clicks **Copy + open profile**, the message
text is copied to clipboard and the prospect's LinkedIn profile opens
in a new tab. The operator pastes inside LinkedIn, sends, then clicks
**Mark sent** — which flips the row to `OPERATOR_SENT`. Downstream
(funnel, replies, analytics) treats `OPERATOR_SENT` identically to
`SENT`.

### Setup (10 minutes)

1. Open `.env` and set:
   ```bash
   LINKEDIN_MODE=draft
   ```
   (or leave it unset — `draft` is the default).

2. Optionally set your own profile URN so the dashboard can display
   "From: <your name>" on each draft. Find it by visiting
   <https://www.linkedin.com/in/me/> when logged in — the URN appears
   in page source as `urn:li:person:<id>`. Set:
   ```bash
   LINKEDIN_PERSON_URN=urn:li:person:236443341
   ```

3. Restart the orchestrator and outreach-worker:
   ```bash
   docker compose up -d --force-recreate orchestrator outreach-worker
   ```

4. Open the dashboard → **LinkedIn Drafts** in the sidebar. New drafts
   appear within seconds of the orchestrator generating them.

### Daily operator routine (~5–10 min)

1. Open the dashboard's LinkedIn Drafts page.
2. For each card:
   - Read the message body. Tweak the copy inline if it doesn't sound
     like you.
   - Click **Copy + open profile**. The message is now on your
     clipboard and the LinkedIn profile is open in a new tab.
   - In LinkedIn, click **Connect** (for connection requests) or
     **Message** (for follow-ups), paste, send.
   - Come back to the dashboard, click **Mark sent**.

Stay under 25–30 sends/day to avoid LinkedIn's anti-spam heuristics —
the rate limiter on the orchestrator already enforces this, but
human-pacing of one every ~2 minutes is a good guardrail too.

### Why drafts and not auto-send?

LinkedIn deliberately gates its outbound messaging API. Standard and
premium business accounts cannot programmatically send DMs or
connection requests — only Sales Navigator + Marketing Developer
Platform partners can. Draft mode keeps the AI personalisation
benefit while staying inside LinkedIn's terms of service.

When you outgrow draft mode (~30/day), you have two options:

- **Use a third-party LinkedIn automation SaaS** — Heyreach, Expandi,
  Lemlist, We-Connect, Phantombuster. They manage the browser
  automation behind a paid REST API. Plug into `LinkedInChannel.send_*`
  instead of the Sales Nav endpoints.
- **Apply for Sales Nav API access (Part B below)** and set
  `LINKEDIN_MODE=api`. 4–8 week review, ~70% rejection on first pass;
  subscribe to Sales Nav Advanced ($149/mo) before applying.

---

## Part B — Sales Navigator API mode (advanced)

> ⚠️  LinkedIn's partner APIs are gated. You must already have an approved
> LinkedIn Marketing Developer Platform application *and* explicit access
> to the Sales Navigator API surface. If you don't, request access at
> <https://www.linkedin.com/developers/> first — review takes 2–4 weeks.

This part covers what the orchestrator's `LinkedInChannel` (auto-send
mode) needs in production: a long-lived OAuth2 access token, your
**person URN**, the right scopes, and a refresh routine for the 60-day
expiry.

---

## 1. Create the developer app

1. Go to <https://www.linkedin.com/developers/apps> → **Create app**.
2. Fill in the form:
   - **App name:** `AI Sales Agent`
   - **LinkedIn Page:** select your company page (required)
   - **App logo:** any PNG ≥ 100×100
3. After creation, open the **Auth** tab. Note the **Client ID** and
   **Client Secret** — you'll need them in step 3.
4. In **OAuth 2.0 settings → Authorized redirect URLs**, add:
   ```
   https://localhost:8000/auth/linkedin/callback
   ```
   (Localhost is fine — you only need to complete the flow once to mint
   the access token; production never hits this URL.)

## 2. Request the right scopes

In the **Products** tab, request access to:

- **Sign In with LinkedIn using OpenID Connect** — `openid profile email`
- **Share on LinkedIn** — `w_member_social`
- **Marketing Developer Platform** — `r_liteprofile r_emailaddress rw_nus`

The full scope string we need is:

```
r_liteprofile r_emailaddress w_member_social rw_nus
```

> Some of these scopes (`rw_nus`, the news/updates write scope) require
> manual approval from LinkedIn. The product request is a one-line form;
> review takes 1–3 business days.

## 3. Run the OAuth2 authorization-code flow once

LinkedIn does not issue access tokens server-side; you have to walk
through the user authorization flow once and capture the code.

### 3a. Build the authorization URL

```bash
CLIENT_ID="your-client-id"
REDIRECT_URI="https://localhost:8000/auth/linkedin/callback"
SCOPES="r_liteprofile r_emailaddress w_member_social rw_nus"
STATE="$(openssl rand -hex 16)"

# URL-encode the scopes
SCOPES_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$SCOPES")

echo "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&state=${STATE}&scope=${SCOPES_ENC}"
```

Open the printed URL in your browser, log in as the user who will be
sending outreach (typically your sender persona), and click **Allow**.
LinkedIn will redirect to:

```
https://localhost:8000/auth/linkedin/callback?code=AQT...&state=...
```

The browser will throw a "site can't be reached" error — that's fine.
Copy the `code=` query parameter from the URL bar.

### 3b. Exchange the code for an access token

```bash
CODE="AQT...paste the code here..."

curl -X POST https://www.linkedin.com/oauth/v2/accessToken \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code" \
  -d "code=${CODE}" \
  -d "redirect_uri=${REDIRECT_URI}" \
  -d "client_id=${CLIENT_ID}" \
  -d "client_secret=${CLIENT_SECRET}"
```

Response:

```json
{
  "access_token": "AQX...long...",
  "expires_in": 5184000,
  "scope": "r_liteprofile,r_emailaddress,w_member_social,rw_nus"
}
```

`expires_in: 5184000` = **60 days**. Store this token in Secrets Manager
(see `docs/secrets-setup.md`) under `/sales-agent/linkedin-access-token`.

## 4. Find your Person URN

The orchestrator needs your numeric Person URN to author posts and
attribute outbound DMs. Get it with:

```bash
ACCESS_TOKEN="AQX...the token from step 3b..."

curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
       https://api.linkedin.com/v2/me | jq .id
```

Response:

```json
"abc123XYZ"
```

Your Person URN is `urn:li:person:abc123XYZ`. Store it in
`/sales-agent/linkedin-person-urn` (or as the `LINKEDIN_PERSON_URN` env
var on the orchestrator).

## 5. Smoke-test the token

```bash
# Profile read (uses r_liteprofile)
curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
       https://api.linkedin.com/v2/me

# Connection list (uses Sales Navigator scope)
curl -s -H "Authorization: Bearer ${ACCESS_TOKEN}" \
       "https://api.linkedin.com/v2/connections?q=member&start=0&count=5"
```

Both should return JSON. If either returns 401, the scopes weren't
granted; if either returns 403, the partner API access is missing.

## 6. Token refresh procedure (60-day expiry)

LinkedIn does **not** issue refresh tokens for the standard flow. Tokens
expire 60 days after issue and you must re-run the authorization-code
flow to mint a new one. To stay ahead of expiry:

1. Set a calendar reminder for **day 50** after each new token.
2. Re-run steps 3a + 3b above with the same redirect URL.
3. Update Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id /sales-agent/linkedin-access-token \
     --secret-string "AQX...new-token..."
   ```
4. The orchestrator + outreach-worker pick up the new token within
   ~60 seconds (Secrets Manager cache TTL). No restart required.

> **Long-term plan:** if LinkedIn approves your app for the *3-legged
> OAuth refresh* extension (only granted to high-volume partners), you
> can swap to refresh tokens that last 365 days. Until then, the 60-day
> manual rotation is the supported path.

## 7. Common errors

| Status | Meaning | Fix |
|---|---|---|
| `401 unauthorized` | Token expired | Re-run flow + update secret |
| `403 not enough permissions` | Scope not granted | Check Products tab + re-request |
| `429 throttle` | Rate limit hit | Built-in backoff in `LinkedInChannel`; check daily quota |
| `Validation Error` on `/socialActions/{urn}/invitations` | Connection note > 280 chars | Validator should catch this — file a bug |

---

**See also:** `docs/secrets-setup.md` for how the orchestrator and
outreach-worker read this token at runtime.
