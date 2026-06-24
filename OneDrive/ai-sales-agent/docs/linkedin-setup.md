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

## Part C — Heyreach mode (recommended for 30–200 sends/day)

This is the pragmatic middle path: real LinkedIn automation without
the MDP partner review. The orchestrator handles everything up to
the send (Apollo discovery → enrichment → Claude personalisation →
compliance gate), then pushes each lead into a Heyreach campaign via
their REST API. Heyreach's browser automation does the actual
connect / DM. Their software manages browser fingerprint, proxy,
LinkedIn pacing, and dispatch — the things that get unmanaged
automation accounts banned.

### Setup (30 minutes)

1. Sign up at <https://heyreach.io> and connect your LinkedIn account
   (free trial is enough to validate the integration end-to-end).
2. Heyreach → **Settings → API & Webhooks** → copy your **public API key**.
3. Heyreach → **Campaigns → New Campaign**. Pick a name. For the
   message template use **just** `{{customField1}}` — that's it. We
   pre-personalise the full body in our orchestrator; Heyreach will
   substitute our exact text without further templating.
   - Sequence: pick "Connection request only" if you want one-touch,
     or add a follow-up DM step that uses `{{customField2}}` if you
     want our follow-up bodies too.
4. Copy the **campaign id** from the URL bar
   (`heyreach.io/campaigns/<UUID>`).
5. Add to `.env`:
   ```bash
   LINKEDIN_MODE=heyreach
   HEYREACH_API_KEY=hr_xxxxxxxxxxxxxxxxxxxx
   HEYREACH_CAMPAIGN_ID=<campaign uuid from step 4>
   # Optional — only if you have a separate Heyreach campaign for
   # follow-up DMs (the orchestrator's send_message() uses this).
   HEYREACH_CAMPAIGN_ID_FOLLOWUP=
   ```
6. Restart the outreach-worker so it picks up the new mode:
   ```bash
   docker compose up -d --force-recreate outreach-worker
   ```

### Linking platform campaigns to Heyreach campaigns

We don't auto-create Heyreach campaigns. Heyreach's public API exposes
a `/campaign/Create` endpoint, but the required payload couples to
internal resources (sequence templates, list types, LinkedIn account
assignments) that aren't reliably settable from outside their UI —
even a 200 response often produces a campaign that can't accept leads
until the operator finalises setup in Heyreach. We learned this the
hard way on June 2026.

What works much better in practice: **create the campaign in Heyreach
UI once, then bind it to a platform campaign in 2 clicks.**

The dashboard's campaign editor shows a Heyreach link panel above the
form:

1. **Dropdown of your Heyreach campaigns** — populated by
   `GET /api/heyreach/campaigns` (which proxies to Heyreach's
   `/campaign/GetAll`). Pick one to bind; the panel shows its name +
   status + connected-account count so you can avoid empty / paused
   campaigns.
2. **Refresh** — re-fetches from Heyreach. Useful after you've just
   created a new one in Heyreach UI.
3. **Create in Heyreach →** — deeplinks to <https://app.heyreach.io/campaigns>
   so you can spin up a new Heyreach campaign without leaving the flow.
4. **Paste id manually** — fallback when the operator prefers typing.

Once a Heyreach campaign is picked, `campaigns.heyreach_campaign_id`
gets set. From that point on:
- The orchestrator's `LinkedInHeyreachChannel` reads the per-campaign
  id when sending automatically (when you create new campaigns and the
  poller picks them up).
- The standalone push script (`send_drafts_to_heyreach.py`) reads it
  to know which Heyreach campaign to push backlogged drafts into.

### How to set up a Heyreach campaign for first-touch outreach

In Heyreach UI:

1. **Campaigns → New Campaign**.
2. Pick the LinkedIn account that should send (the operator's).
3. Create or pick a lead list (we push our prospects into it).
4. **Sequence**: add one step "Send connection request" with body
   template `{{customField1}}` — that's it. We pre-personalise the
   full body in our orchestrator; Heyreach substitutes our exact text
   verbatim.
5. (Optional) Add a follow-up DM step using `{{customField2}}` if you
   want our follow-up bodies.
6. Save the campaign. Copy the campaign id from the URL bar.
7. Back in our dashboard, pick the campaign from the dropdown on the
   edit page.

### How to push existing drafts

For LinkedIn drafts that were generated BEFORE you turned on Heyreach
mode (e.g. the 33 drafts on `CTO Out Reach` + `Outreach for Logistic
Companies in UK`), use the standalone driver:

```bash
docker exec ai-sales-agent-orchestrator-1 sh -c \
  'python3 /app/src/scripts/send_drafts_to_heyreach.py <CAMPAIGN_ID>'
```

Flags:
- `--dry-run` — show what would be pushed, no API calls
- `--limit N` — cap pushes per run
- `--campaign <heyreach_id>` — override `HEYREACH_CAMPAIGN_ID` for
  this run (e.g. push to a follow-up campaign instead)

On success each row flips `DRAFTED → OPERATOR_SENT` and writes a
`message_sent` event with `source=system, via=heyreach_script` so the
dashboard's prospect timeline reflects the actual send.

### Cost note

- Heyreach: $50–$200/mo per LinkedIn account (depends on plan + seats)
- Sales Nav: $99–$149/mo (gives Heyreach access to richer lead data +
  more InMail credits; not strictly required but recommended)
- ~$250/mo total for one operator + 100 daily sends

### TOS reality check

LinkedIn doesn't endorse third-party browser-automation tools, but at
sane volumes (<30 sends/day per LinkedIn account, no scraping at
scale, no fake-account farms) Heyreach's risk-management is good
enough that account bans for normal use are rare. The mainline risk
is "growth-hack" usage — 100+ sends/day or aggressive scraping. The
orchestrator's per-channel rate limiter already enforces a 20/day
default cap; bump it if you need more, but warming the account up
gradually matters more than headline volume.

### Webhook integration (optional, recommended)

Heyreach can webhook into your dashboard when:
- A connection request is accepted
- A reply lands on a DM
- A bounce / decline occurs

Configure the webhook URL inside Heyreach's settings, pointing it at
your public API base + `/webhooks/heyreach`. We don't ship that route
yet — it's a follow-up. Until then, manual "Mark connection accepted"
and "Mark replied" buttons on the dashboard's prospect detail capture
those events.

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
