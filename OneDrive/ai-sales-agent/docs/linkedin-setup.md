# LinkedIn Sales Navigator API — OAuth2 setup

This guide walks you through everything the AI Sales Agent's
`LinkedInChannel` needs in production: a long-lived OAuth2 access token,
your **person URN**, the right scopes, and a refresh routine for the
60-day expiry.

> ⚠️  LinkedIn's partner APIs are gated. You must already have an approved
> LinkedIn Marketing Developer Platform application *and* explicit access
> to the Sales Navigator API surface. If you don't, request access at
> <https://www.linkedin.com/developers/> first — review takes 2–4 weeks.

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
