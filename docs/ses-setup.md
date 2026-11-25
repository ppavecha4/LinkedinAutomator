# Amazon SES setup — domain verification + production access

The AI Sales Agent's `EmailChannel` sends through SES in the
`ap-south-1` region (or whatever you set `AWS_REGION` to). Before any
outbound email leaves the system, you need to:

1. Verify your sending domain (DKIM + SPF + DMARC)
2. Exit the SES sandbox (production access)
3. Wire SNS topics for bounce + complaint notifications
4. Create the configuration set the API references

---

## 1. Verify your sending domain

Domain verification (not single-email verification) is required for any
campaign-style sending. SES will issue 3 DKIM CNAME records — you add
them to your DNS, SES polls until they resolve, then the domain flips
to **Verified**.

### 1a. Add the domain in SES

```bash
aws ses verify-domain-identity \
  --domain example.com \
  --region ap-south-1
```

Or, in the AWS console:
**SES → Configuration → Verified identities → Create identity → Domain →
example.com → Use a custom MAIL FROM domain (yes, `mail.example.com`)**.

### 1b. DNS records to add

SES will give you the exact CNAME values. The general shape is:

```
# DKIM (3 records — copy from SES console)
selector1._domainkey.example.com.   CNAME   selector1.dkim.amazonses.com.
selector2._domainkey.example.com.   CNAME   selector2.dkim.amazonses.com.
selector3._domainkey.example.com.   CNAME   selector3.dkim.amazonses.com.

# Custom MAIL FROM (for SPF alignment)
mail.example.com.                   MX 10   feedback-smtp.ap-south-1.amazonses.com.
mail.example.com.                   TXT     "v=spf1 include:amazonses.com -all"

# DMARC (recommended; not strictly required for SES, but inbox providers care)
_dmarc.example.com.                 TXT     "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; aspf=r; adkim=r"

# Top-level SPF (so transactional + marketing both pass)
example.com.                        TXT     "v=spf1 include:amazonses.com -all"
```

> **DMARC policy guidance.** Start with `p=none` while you're iterating,
> move to `p=quarantine` after a week of clean DMARC reports, and only
> graduate to `p=reject` once you're confident in alignment. SES sends
> with the MAIL FROM domain you set above — both SPF (via `mail.example.com`)
> and DKIM (via the three selectors) will then align with `example.com`.

### 1c. Wait for verification

SES polls DNS every ~60 seconds. From Route 53 it usually flips in 5
minutes; from slower DNS providers it can take an hour. Check with:

```bash
aws ses get-identity-verification-attributes \
  --identities example.com \
  --region ap-south-1
```

Status should be `Success`.

## 2. Exit the SES sandbox (request production access)

By default every new SES account is in the **sandbox**:
- You can only send to verified addresses
- Capped at 200 emails / 24h, 1 email / second

You **must** exit the sandbox before running a real campaign.

1. AWS console → **SES → Account dashboard → Request production access**.
2. Fill the form:
   - **Mail type:** `Transactional` if you only do 1:1 personalised
     outreach, `Marketing` if you also send broadcasts. The agent does
     1:1 only — pick `Transactional`.
   - **Website URL:** your real site (must be reachable)
   - **Use case description:** keep it crisp:
     > "B2B sales outreach. AI-personalised 1:1 emails to opted-in
     > prospects discovered via Apollo. Honour CAN-SPAM/GDPR with
     > one-click unsubscribe + 7-day suppression list. Expected volume:
     > ~5,000 emails/day, ~100 unique recipients/hour."
   - **Compliance:** describe how you handle bounces (auto-suppress),
     complaints (auto-suppress), and unsubscribes (HMAC-signed link in
     every message).
3. Submit. Review takes **24 hours**, sometimes 2–3 days. AWS may ask
   for clarification — answer same-day to keep the queue moving.

Once approved, your account flips to:
- Send to any address (no per-recipient verification)
- 50,000 emails / 24h (default) — request more later
- 14 emails / second (default)

## 3. SNS topics for bounce + complaint notifications

SES doesn't push delivery events directly to your service; it publishes
to SNS, and the API webhook routes (`/webhooks/ses/bounce` and
`/webhooks/ses/complaint`) subscribe to those topics.

### 3a. Create the topics

```bash
aws sns create-topic --name sales-agent-ses-bounce    --region ap-south-1
aws sns create-topic --name sales-agent-ses-complaint --region ap-south-1
```

Note the ARNs — you'll need them in step 3c.

### 3b. Subscribe the API to the topics

Once the API is deployed (ALB DNS name or custom domain):

```bash
API_BASE="https://api.example.com"   # your deployed API base URL

aws sns subscribe \
  --topic-arn arn:aws:sns:ap-south-1:ACCOUNT:sales-agent-ses-bounce \
  --protocol https \
  --notification-endpoint "${API_BASE}/webhooks/ses/bounce" \
  --region ap-south-1

aws sns subscribe \
  --topic-arn arn:aws:sns:ap-south-1:ACCOUNT:sales-agent-ses-complaint \
  --protocol https \
  --notification-endpoint "${API_BASE}/webhooks/ses/complaint" \
  --region ap-south-1
```

The first POST to your webhook URL is a **subscription confirmation** —
the API auto-confirms it (`handleSnsSubscriptionConfirmation` in
`services/api/src/routes/webhooks.ts`). Watch the API logs:

```
[sns] subscription confirmed
```

### 3c. Wire SES → SNS for the bounce + complaint event types

```bash
aws ses put-identity-notification-topic \
  --identity example.com \
  --notification-type Bounce \
  --sns-topic arn:aws:sns:ap-south-1:ACCOUNT:sales-agent-ses-bounce \
  --region ap-south-1

aws ses put-identity-notification-topic \
  --identity example.com \
  --notification-type Complaint \
  --sns-topic arn:aws:sns:ap-south-1:ACCOUNT:sales-agent-ses-complaint \
  --region ap-south-1
```

## 4. Create the SES configuration set

The API references a configuration set named `sales-agent` for tracking
opens, bounces, and rendering failures. Create it:

```bash
aws ses put-configuration-set \
  --configuration-set Name=sales-agent \
  --region ap-south-1

aws ses put-configuration-set-event-destination \
  --configuration-set-name sales-agent \
  --event-destination "Name=cloudwatch-events,Enabled=true,MatchingEventTypes=send,reject,bounce,complaint,delivery,open,click,renderingFailure,CloudWatchDestination={DimensionConfigurations=[{DimensionName=ses:campaign,DimensionValueSource=messageTag,DefaultDimensionValue=none}]}" \
  --region ap-south-1
```

The configuration set name is referenced in `.env.example` as
`SES_CONFIGURATION_SET=sales-agent`.

## 5. Verify the setup end-to-end

```bash
# Send a real email to yourself via SES
aws ses send-email \
  --from "no-reply@example.com" \
  --destination "ToAddresses=YOUR_EMAIL@gmail.com" \
  --message "Subject={Data=SES smoke test},Body={Text={Data=hello from SES}}" \
  --configuration-set-name sales-agent \
  --region ap-south-1
```

Check:
1. The email lands in your inbox (not spam).
2. CloudWatch metric `AWS/SES Send` ticks up.
3. If you mark it as spam, the API logs `[ses:complaint]` within ~30s.

## 6. Recommended pre-launch checklist

- [ ] Domain verified (Status: Success)
- [ ] DKIM / SPF / DMARC all passing on a test message (use mail-tester.com)
- [ ] Production access approved (NOT in sandbox)
- [ ] SNS topics created + API subscribed (subscription confirmed in API logs)
- [ ] SES → SNS bound for Bounce + Complaint
- [ ] Configuration set `sales-agent` exists with CloudWatch destination
- [ ] Send rate quota reviewed (default 14/s — request increase if launching big)
- [ ] Suppression list cleared if you're switching from a different sender
- [ ] First test send to your own inbox lands in the primary tab

---

**See also:**
- `docs/secrets-setup.md` — how the API picks up SES credentials
- `docs/first-campaign.md` — end-to-end smoke test once SES is live
