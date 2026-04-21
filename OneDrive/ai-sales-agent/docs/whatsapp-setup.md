# WhatsApp Business API — Twilio + Meta setup

This guide walks you through provisioning a WhatsApp Business sender via
Twilio (the BSP — Business Solution Provider that fronts the Meta API),
and getting your **first-contact templates** approved by Meta. The AI
Sales Agent's `WhatsAppChannel` requires three approved templates — one
per pitch angle — before any outreach can be sent.

---

## 1. Create a Meta Business Account (if you don't have one)

1. Go to <https://business.facebook.com/> → **Create account**.
2. Add your business name, your name, and your work email.
3. In **Business Settings → Accounts → WhatsApp Accounts**, click
   **Add → Create a WhatsApp Account**.
4. Provide:
   - **Business display name** — what users see (e.g. `WeBuildAgents`)
   - **Business category** — most B2B sellers pick `Professional Services`
   - **Business website** — required, must be reachable
5. **Verify your business.** Meta requires you to upload a tax document
   or business license. Approval takes 1–5 business days. **Skipping
   this step blocks template approval.**

## 2. Register through Twilio as your BSP

1. Sign up at <https://www.twilio.com/try-twilio>.
2. In the Twilio Console, go to **Messaging → Senders → WhatsApp senders**.
3. Click **+ New WhatsApp Sender**.
4. Twilio will prompt you to:
   - Connect your Meta Business Account (OAuth flow with Facebook)
   - Pick a phone number (you can use a Twilio number or bring your own)
   - Confirm the display name from step 1
5. Wait for Meta to approve the sender — typically 24 hours.
6. Once approved, note:
   - **Account SID** (`ACxxxx...`) — Twilio Console homepage
   - **Auth Token** (`xxxx...`) — Twilio Console homepage
   - **Sender phone number** in E.164 format (e.g. `+14155238886`)

Store these in Secrets Manager:
```
/sales-agent/twilio-account-sid     — ACxxxx...
/sales-agent/twilio-auth-token      — xxxx...
TWILIO_WHATSAPP_FROM (env var)      — whatsapp:+14155238886
```

## 3. Three first-contact templates (ready to submit)

WhatsApp requires **all** outbound messages to use a pre-approved
template until the user has replied within the last 24 hours
(the "24-hour customer service window"). Submit these three under the
**Utility** category (NOT Marketing — Marketing has lower deliverability
and stricter review).

> Replace `{{1}}`, `{{2}}` with the variable values you'll inject at
> send time. Meta requires variable count to match exactly between
> template and send call.

### Template 1 — AI Agents angle

- **Name:** `intro_ai_agents`
- **Category:** `UTILITY`
- **Language:** `en_US`
- **Body:**
  ```
  Hi {{1}} — saw your team is hiring an ML engineer at {{2}}. We've built an agent that already handles the work that hire would do first. 2-min Loom if useful?
  ```
- **Footer:** `Reply STOP to opt out`

### Template 2 — RPA / Workflow angle

- **Name:** `intro_rpa_workflow`
- **Category:** `UTILITY`
- **Language:** `en_US`
- **Body:**
  ```
  Hi {{1}} — most {{2}} ops teams hand-key invoices between SAP and their CRM. We automate that path in 5–8 weeks with no rip-and-replace. Worth a 20-minute audit call?
  ```
- **Footer:** `Reply STOP to opt out`

### Template 3 — Consulting angle

- **Name:** `intro_consulting`
- **Category:** `UTILITY`
- **Language:** `en_US`
- **Body:**
  ```
  Hi {{1}} — when your board next asks "what's our AI strategy?" most {{2}} CEOs don't yet have an answer. We help you decide WHERE to apply AI before you spend anything. Worth a 30-minute readiness chat?
  ```
- **Footer:** `Reply STOP to opt out`

## 4. Submit templates via Twilio Content API

Twilio's **Content API** is the supported path for template submission
(the older "Messaging Services Templates" endpoint is deprecated).

```bash
ACCOUNT_SID="AC..."
AUTH_TOKEN="..."

curl -X POST "https://content.twilio.com/v1/Content" \
  -u "${ACCOUNT_SID}:${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "friendly_name": "intro_ai_agents",
    "language": "en_US",
    "variables": { "1": "Jane", "2": "Acme" },
    "types": {
      "twilio/text": {
        "body": "Hi {{1}} — saw your team is hiring an ML engineer at {{2}}. We have an agent that already handles the work that hire would do first. 2-min Loom if useful?"
      }
    }
  }'
```

Response:
```json
{ "sid": "HXxxxxx...", "friendly_name": "intro_ai_agents", "..." }
```

Repeat for `intro_rpa_workflow` and `intro_consulting`.

Once you have the three Content SIDs (`HXxxxxx`), submit them for
WhatsApp approval:

```bash
CONTENT_SID="HXxxxxx..."

curl -X POST "https://content.twilio.com/v1/Content/${CONTENT_SID}/ApprovalRequests/whatsapp" \
  -u "${ACCOUNT_SID}:${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "intro_ai_agents",
    "category": "UTILITY"
  }'
```

## 5. What to expect during Meta review

| Stage | Expected | Action if blocked |
|---|---|---|
| **Submitted** | Immediately after the approval request | — |
| **In review** | 1–3 business days | Wait. Don't resubmit. |
| **Approved** | Template SID is now usable in `Messages.create(content_sid=...)` | Store the SID + use it |
| **Rejected** | Reason returned by Meta — usually a forbidden phrase or wrong category | Edit + resubmit |

Common rejection reasons:

- **"Threatening or aggressive language"** — usually false-positive on
  words like *risk*, *fail*, *crisis*. Soften and resubmit.
- **"Misleading information"** — claims the template body can't back up.
  Drop quantitative claims unless you can footnote them.
- **"Wrong category"** — `Marketing` got submitted for what's actually
  `Utility`. We deliberately use `Utility` to dodge this.

## 6. Store the approved SIDs

After all three templates are approved, store the SIDs as env vars on
the outreach-worker:

```
WHATSAPP_TEMPLATE_SID_AI_AGENTS    = HXxxx...
WHATSAPP_TEMPLATE_SID_RPA_WORKFLOW = HXyyy...
WHATSAPP_TEMPLATE_SID_CONSULTING   = HXzzz...
```

The orchestrator picks the right one based on the chosen pitch type at
generation time (see `services/orchestrator/src/agents/personalization_agent.py::PitchSelector`).

---

**See also:**
- `docs/secrets-setup.md` — how to wire the Twilio SID/token
- `docs/first-campaign.md` — end-to-end test once templates are live
