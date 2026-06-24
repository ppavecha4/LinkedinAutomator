# Google Workspace email — setup + deliverability

This guide gets your AI Sales Agent sending outbound through your
**existing Google Workspace mailbox** via SMTP relay
(`smtp.gmail.com:587` + App Password). It also covers the DNS records
and headers that keep the mail out of the spam folder — *that* part is
where most outbound goes wrong.

> **Why Workspace and not SES?**
> Workspace inherits the deliverability reputation of your existing
> mailbox — your domain has been sending business email for years, so
> Gmail/Outlook treat it as a trusted sender from day one. SES requires
> 2–4 weeks of warmup on a fresh sending domain before reaching the
> inbox reliably. For <2,000 sends/day per user, Workspace is the
> better choice.

---

## TL;DR — the 5 minute setup

1. Enable 2-step verification on your Workspace account: <https://myaccount.google.com/security>
2. Create an App Password: <https://myaccount.google.com/apppasswords>
   - Pick "Mail" → "Other (custom name)" → name it `AI Sales Agent`
   - Copy the 16-character password (shown once only — no spaces)
3. Add to `.env`:
   ```bash
   EMAIL_PROVIDER=google_workspace
   GOOGLE_WORKSPACE_EMAIL=you@your-workspace-domain.com
   GOOGLE_WORKSPACE_APP_PASSWORD=xxxxxxxxxxxxxxxx
   GOOGLE_WORKSPACE_FROM_NAME=Your Name
   ```
4. Restart the outreach-worker:
   ```bash
   docker compose up -d --force-recreate outreach-worker
   ```
5. Send a test from any QUEUED email:
   ```bash
   docker exec ai-sales-agent-orchestrator-1 sh -c \
     'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID> --to you@gmail.com --limit 1'
   ```

If that lands in your inbox (not spam), you're done. If it lands in
spam, see § 3 below.

---

## 1. Auth — App Password vs OAuth2

We use **App Password + SMTP** rather than the Gmail API + OAuth2.
Reasoning:

| Property | App Password | OAuth2 (Gmail API) |
|---|---|---|
| Setup time | 5 min | 2–3 hours |
| Refresh logic | None — long-lived | Refresh token rotation |
| Per-user quota | 10,000/day (Workspace) | 2,000 quota units/day |
| Multi-sender support | One mailbox per password | Easy with domain-wide delegation |
| Security | App-scoped, revocable | Same; finer-grained scopes |

If you ever need multi-sender (different operators sending under their
own names), swap the channel to OAuth2 — but for a single-operator
outbound flow, App Password wins on every dimension.

**Setup:**

1. Make sure 2-step verification is on for your Workspace account.
   App Passwords don't appear in the menu otherwise.
2. Go to <https://myaccount.google.com/apppasswords>.
3. **App:** "Mail". **Device:** "Other" → name it `ai-sales-agent`.
4. Click **Generate**. Copy the 16-character password (shown without
   spaces — `xxxxxxxxxxxxxxxx`).
5. Paste into `.env`:
   ```bash
   GOOGLE_WORKSPACE_APP_PASSWORD=xxxxxxxxxxxxxxxx
   ```

The password is tied to your Workspace user, not to the app — revoke
it any time from the same page.

> ⚠️  Some Workspace admins disable App Passwords org-wide. If the
> page says "App passwords aren't available for your account", ask
> your admin to enable them at **Admin Console → Security → Less
> secure apps and your Google Account**, or pivot to the OAuth2 path.

## 2. The five env vars

```bash
EMAIL_PROVIDER=google_workspace          # auto-picks the channel
GOOGLE_WORKSPACE_EMAIL=you@yourco.com    # the authenticated mailbox
GOOGLE_WORKSPACE_APP_PASSWORD=xxxxxxxxxxxxxxxx
GOOGLE_WORKSPACE_FROM_NAME=Your Name     # optional; display name
GOOGLE_WORKSPACE_REPLY_TO=               # optional; defaults to FROM
```

**Quote-and-space gotcha:** never wrap values in quotes, never put a
space after `=`. Docker compose's `env_file` is literal — it will
include the quotes / spaces in the value and SMTP auth will reject as
"invalid credentials." Same trap we hit on Apollo, Twilio, and the
Anthropic key — applies here too.

After editing `.env`:

```bash
docker compose up -d --force-recreate outreach-worker
```

## 3. Deliverability — the parts that actually matter

Personalization alone isn't enough. Gmail/Outlook score your mail on
authentication + content + reputation. Here's what to fix, ranked by
impact.

### 3a. DKIM signing (most common cause of spam-foldering)

Workspace can sign your outbound mail with DKIM, but it's **not
on by default for custom domains**. You enable it in the admin console
and publish the public key as a DNS record.

1. Go to **Admin Console** → **Apps** → **Google Workspace** → **Gmail**
   → **Authenticate email**.
2. Pick your sending domain → click **Generate new record**.
3. Copy the TXT record Google shows. It looks like:
   ```
   Host:  google._domainkey
   Type:  TXT
   Value: v=DKIM1; k=rsa; p=MIGfMA0GCSqG... (long base64)
   ```
4. Add the record to your DNS provider (Route 53, Cloudflare, GoDaddy,
   etc.). Propagation: typically 15 min to 1 hour.
5. Back in the admin console, click **Start authentication**.

Verify it's working — send yourself a test email and look at the
headers (Gmail → "..." menu → "Show original"). You should see:

```
DKIM:        'PASS' with domain yourco.com
SPF:         PASS with IP 209.85.220.41 (Google's mail servers)
DMARC:       PASS
```

If DKIM says `PASS`, you've cleared the biggest hurdle.

### 3b. SPF — usually already set

If you're using Workspace for email today, your domain almost
certainly has the SPF record already. Verify with:

```bash
dig +short TXT yourco.com | grep spf
```

You want something like:

```
"v=spf1 include:_spf.google.com ~all"
```

If it's missing, add a TXT record at the apex:

```
Host:  @  (or yourco.com)
Type:  TXT
Value: v=spf1 include:_spf.google.com ~all
```

`~all` (soft fail) is correct here. `-all` (hard reject) is more
aggressive but breaks any legitimate sender that forwards your mail
through their infrastructure (mailing lists, etc.).

### 3c. DMARC — the policy receivers honour

Add a DMARC TXT record at `_dmarc.yourco.com`. Start with `p=none`
(monitor only — receivers report failures back to you but don't act on
them) for the first week, then graduate to `p=quarantine` once the
reports look clean.

```
Host:  _dmarc
Type:  TXT
Value: v=DMARC1; p=none; rua=mailto:dmarc@yourco.com; aspf=r; adkim=r
```

Once you've watched a week of reports and seen >95% PASS:

```
Value: v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@yourco.com; aspf=r; adkim=r
```

### 3d. List-Unsubscribe headers (the channel adds these automatically)

The `GoogleWorkspaceEmailChannel` and `send_pending_emails.py` both
attach RFC 8058 one-click unsubscribe headers on every send:

```
List-Unsubscribe: <https://yourco.com/unsubscribe?token=...>, <mailto:unsubscribe@yourco.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

Gmail's bulk-sender requirements (Feb 2024 update) treat the absence
of these as a strong negative signal for senders >5k/day. They cost
nothing to include and you don't have to do anything — they're added
automatically once `UNSUBSCRIBE_BASE_URL` is set in `.env`.

### 3e. Multipart/alternative (the channel does this too)

Pure-HTML emails are ~3× more likely to be flagged. The channel sends
`multipart/alternative` with a plain-text part first and an HTML part
second. If your message body is plain text, the HTML alt is auto-built
from it. No action needed.

### 3f. Warmup curve

Sudden volume = spam folder. Even with perfect auth, sending 500
emails on day 1 from a domain that previously sent 0 outbound will
trip every reputation system. Recommended ramp:

| Day | Daily volume |
|---|---|
| 1–3 | 5–10 |
| 4–7 | 10–25 |
| 8–14 | 25–50 |
| 15–21 | 50–100 |
| 22+ | 100+ |

The orchestrator's `daily_limits.email` already caps you per campaign
— start at 25 and bump it up weekly.

### 3g. Personalization (already covered)

Generic templates are flagged regardless of auth. The orchestrator's
Anthropic-personalized copy referencing each prospect's company by
name passes Gmail's content heuristics easily. Avoid:

- ALL CAPS subject lines
- "FREE", "GUARANTEED", "$$$"
- Short bodies (<5 lines)
- Lots of links or images

## 4. Verify your headers — mail-tester.com

The fastest end-to-end check:

1. Go to <https://www.mail-tester.com/>
2. Copy the test address it gives you (looks like `test-abc123@srv1.mail-tester.com`)
3. Run a test send:
   ```bash
   docker exec ai-sales-agent-orchestrator-1 sh -c \
     'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID> \
      --to test-abc123@srv1.mail-tester.com --limit 1'
   ```
4. Click **"Then check your score"** on mail-tester.com.

Targets:
- **9.0+** → inbox-ready
- **8.0–9.0** → mostly fine, fix the called-out warnings
- **<8.0** → DKIM/SPF/DMARC issue, fix before any real campaign

## 5. The send script — `send_pending_emails.py`

Lives at `services/orchestrator/src/scripts/send_pending_emails.py`.
Drains QUEUED email messages for a campaign through Workspace SMTP.

### Common usage

```bash
# Dry-run (print what would happen, no SMTP calls):
docker exec ai-sales-agent-orchestrator-1 sh -c \
  'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID> --dry-run'

# Self-test (override every recipient with your own address):
docker exec ai-sales-agent-orchestrator-1 sh -c \
  'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID> \
   --to you@gmail.com --limit 1'

# Live send to all QUEUED emails on a campaign:
docker exec ai-sales-agent-orchestrator-1 sh -c \
  'python3 /app/src/scripts/send_pending_emails.py <CAMPAIGN_ID>'
```

After a real run, the rows flip to `status='SENT'` with `sent_at` and
`external_id` (the RFC-5322 Message-ID we minted). The dashboard's
analytics + funnel pick that up immediately.

## 6. Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `(535, 'Username and Password not accepted')` | Wrong app password OR 2-step verification disabled | Re-generate at myaccount.google.com/apppasswords |
| `(535, 'App-specific password required')` | 2-step is on but you used the regular Workspace password | Use the App Password, not your login password |
| `Connection unexpectedly closed` | Workspace blocked SMTP for the user | Check Admin Console → Security → SMTP relay service |
| Email lands in spam | DKIM not enabled or DNS not propagated | Run "Show original" in Gmail, look for DKIM line |
| `(550, 'Daily quota exceeded')` | Hit the 10k/day Workspace cap | Wait 24h, or rotate to a second user |
| All emails go to one prospect | You forgot `--to` was set | Drop the flag for live sends |

## 7. When to switch back to SES

Workspace is the right choice today. Switch to SES when any of:

- You exceed 10k/day per sender (Workspace's hard cap)
- You need to send from many users without each having a Workspace seat
- You want SNS-based bounce/complaint webhooks (Workspace doesn't
  expose those programmatically; you'd reconcile via reply parsing)
- Your AWS infrastructure is the centre of gravity and you want fewer
  moving parts

To switch: set `EMAIL_PROVIDER=ses`, populate the `SES_*` vars (see
`docs/ses-setup.md`), recreate the outreach-worker. The orchestrator
side doesn't change.

---

**See also:**
- `docs/ses-setup.md` — the SES alternative path
- `docs/first-campaign.md` — end-to-end smoke test
- `services/outreach-worker/src/channels/google_email_channel.py` — channel impl
- `services/orchestrator/src/scripts/send_pending_emails.py` — send driver
