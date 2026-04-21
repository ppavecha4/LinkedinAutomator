# Secrets Manager — populate after `cdk deploy`

The CDK `AiStack` creates 6 Secrets Manager entries with **placeholder
random strings**. Before the orchestrator and outreach-worker can do
anything live, you have to overwrite each placeholder with a real
credential.

This doc lists the exact `aws secretsmanager put-secret-value` commands
plus a verification step.

---

## 1. Prerequisites

- AWS CLI configured (`aws sts get-caller-identity` returns your account)
- IAM permissions for `secretsmanager:PutSecretValue` on
  `/sales-agent/*`
- The CDK stacks are already deployed (`./infrastructure/scripts/deploy.sh`)
- You have collected the actual credentials (see the per-service docs:
  `docs/linkedin-setup.md`, `docs/whatsapp-setup.md`, etc.)

```bash
export AWS_REGION=ap-south-1
```

## 2. List the secrets that need values

```bash
aws secretsmanager list-secrets \
  --filters Key=name,Values=/sales-agent \
  --query 'SecretList[].Name' \
  --output table
```

You should see:

| Name |
|---|
| `/sales-agent/anthropic-api-key` |
| `/sales-agent/apollo-api-key` |
| `/sales-agent/twilio-account-sid` |
| `/sales-agent/twilio-auth-token` |
| `/sales-agent/linkedin-access-token` |
| `/sales-agent/calendly-api-key` |

If you're missing any, the CDK stack hasn't deployed cleanly — re-run
`cdk deploy SalesAgent-Ai`.

## 3. Set each secret value

> **Tip:** all six are stored as `SecretString` (plain string, not
> SecretBinary). Use single quotes around the value to avoid shell
> expansion of `$` and `!` characters in the keys.

### Anthropic

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/anthropic-api-key \
  --secret-string 'sk-ant-api03-...your-real-key...'
```

### Apollo.io

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/apollo-api-key \
  --secret-string 'your-apollo-api-key'
```

### Twilio (WhatsApp)

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/twilio-account-sid \
  --secret-string 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

aws secretsmanager put-secret-value \
  --secret-id /sales-agent/twilio-auth-token \
  --secret-string 'your-twilio-auth-token'
```

### LinkedIn

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/linkedin-access-token \
  --secret-string 'AQX...your-60-day-oauth-token...'
```

> Schedule a calendar reminder for **day 50** to rotate this — see
> `docs/linkedin-setup.md` § 6.

### Calendly

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/calendly-api-key \
  --secret-string 'eyJraWQ...your-calendly-pat...'
```

The Calendly **webhook signing key** is a separate value used by the
API service's `/webhooks/calendly` route. Store it as a regular env var
on the API task definition (`CALENDLY_WEBHOOK_SIGNING_KEY`) — it does
not need to live in Secrets Manager.

## 4. Verify the services pick up the new values

ECS injects secrets at task start time, so for the change to take
effect you need to **force a new deployment**:

```bash
for svc in sales-agent-api sales-agent-orchestrator sales-agent-outreach-worker sales-agent-reply-processor; do
  aws ecs update-service \
    --cluster sales-agent \
    --service "${svc}" \
    --force-new-deployment
done
```

Each service rolls in 1–2 minutes (Fargate). Watch the deployment with:

```bash
aws ecs describe-services \
  --cluster sales-agent \
  --services sales-agent-api sales-agent-orchestrator sales-agent-outreach-worker sales-agent-reply-processor \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,deployments:deployments[].status}' \
  --output table
```

You want every row to show `running == desired` with one `PRIMARY`
deployment in `STEADY_STATE`.

## 5. Smoke-test that secrets are loaded

The simplest end-to-end test is to hit the API's `/health` endpoint
once the new task is steady. The enhanced health check returns the DB
+ Redis status; if the DB password secret is wrong the task won't even
become healthy.

```bash
curl -s "$(aws elbv2 describe-load-balancers \
  --query 'LoadBalancers[?starts_with(LoadBalancerName,`SalesAgent-Compute`)].DNSName' \
  --output text)/health" | jq .
```

Expected:

```json
{
  "data": {
    "status": "ok",
    "db": "connected",
    "redis": "connected",
    "version": "0.1.0",
    "timestamp": "2026-04-15T08:30:00.000Z"
  }
}
```

If `db` says `disconnected`, the database password secret is wrong or
the Aurora SG hasn't been opened to the API SG (check
`compute-stack.ts::AuroraIngressFromServices`).

## 6. Rotation

For routine rotation (e.g. LinkedIn token every 50 days), you only need
the `put-secret-value` step. Secrets Manager creates a **new version**
and ECS picks it up via the next task restart (or the
`secretsmanager:GetSecretValue` cache TTL, ~10 min).

If you want zero-downtime rotation:

```bash
aws secretsmanager put-secret-value \
  --secret-id /sales-agent/linkedin-access-token \
  --secret-string 'new-token' \
  --version-stages AWSCURRENT
```

Then force a rolling deployment as in step 4.

## 7. Audit

To see who set what, when:

```bash
aws secretsmanager list-secret-version-ids \
  --secret-id /sales-agent/anthropic-api-key
```

Each `put-secret-value` creates a new `VersionId` that's never deleted
unless you explicitly remove it. CloudTrail also records every
`PutSecretValue` call — useful for audit reviews.

---

**See also:**
- `infrastructure/cdk/lib/ai-stack.ts` — where the secrets are declared
- `infrastructure/cdk/lib/compute-stack.ts` — where they're injected as
  `Secret.fromSecretsManager(...)` env on each ECS task
