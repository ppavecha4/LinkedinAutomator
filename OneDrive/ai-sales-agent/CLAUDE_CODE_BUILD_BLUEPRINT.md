# CLAUDE_CODE_BUILD_BLUEPRINT.md — Campaign Definitions

A versioned catalogue of **campaign blueprints** ready to seed into the
AI Sales Agent platform. Each entry is the exact JSON payload you would
POST to `/api/campaigns` (plus `.launch`), aligned to the schema in
`services/api/src/routes/campaigns.ts` and the orchestrator's
`CampaignConfig` type.

> **How to use:** copy a block verbatim into the campaign wizard's
> "Paste JSON" affordance (or `curl -X POST /api/campaigns -d @file.json`
> and then `POST /api/campaigns/:id/launch`). The orchestrator picks up
> the launch event and drives the full pipeline:
> `fetch → enrich → score pitch → personalise → compliance → queue`.

---

## Campaign 1 — Global AI & Automation (Wave 1)

**Hypothesis.** Mid-market firms across logistics, manufacturing, finserv,
healthcare, retail, and professional services in English-speaking markets
have budget and mandate for AI + RPA initiatives and are actively hiring
automation-adjacent roles. We pitch a 90-day ROI frame and book discovery
calls with operational decision-makers (COO, CIO, CTO, VP Operations).

**Why this set of signals.**
- `201–500` / `501–1000` headcount buckets — big enough to have legacy
  ERP workflows, small enough that the CTO/COO personally owns the
  automation mandate.
- English-speaking countries only (US, CA, GB, IE, AU, NZ) keeps
  email/LinkedIn copy in-language without regional re-writes.
- `tech_signals` include legacy stack markers (SAP, Oracle ERP) because
  that pushes the `PitchSelector` toward `RPA_WORKFLOW` for the
  operations-heavy contacts.
- `funding_signals` Series B/C triggers the `recently_funded_series_b_c`
  signal, which tilts scoring toward `AI_AGENTS` and `CONSULTING` for
  technical buyers — producing a healthy mix across all three pitches.
- 6-step sequence spans **18 days** across all three channels. Day 1
  LinkedIn connect is the softest opener; day 18 email is the breakup.
- Daily limits follow the platform defaults (email 100 / LinkedIn 20 /
  WhatsApp 50) — well inside each channel's safe zone.
- `batch_size: 500` matches the orchestrator's default batching so the
  `fetch → enrich` pipeline doesn't exceed Apollo page limits.

```json
{
  "campaign_name": "Global AI & Automation — Wave 1",
  "goal": "Book 30-minute discovery calls to explore how we can help automate their operations",
  "tone": "consultative",
  "value_proposition": "We help mid-market companies implement AI and automation that reduces operational costs and manual work — typically delivering ROI within 90 days",
  "icp": {
    "industries": ["logistics", "manufacturing", "financial_services", "healthcare", "retail", "professional_services"],
    "company_sizes": ["201-500", "501-1000"],
    "countries": ["US", "CA", "GB", "IE", "AU", "NZ"],
    "titles": ["CEO", "COO", "CTO", "CIO", "VP Operations", "VP Engineering", "Head of Digital Transformation", "Head of IT", "Director of Operations"],
    "apollo_keywords": ["AI engineer", "automation specialist", "digital transformation", "RPA", "process improvement"],
    "tech_signals": ["Zapier", "SAP", "Oracle ERP", "legacy systems"],
    "funding_signals": ["Series B", "Series C", "growth stage"]
  },
  "sequence": [
    {"day": 1,  "channel": "linkedin", "action": "connection_request"},
    {"day": 3,  "channel": "email",    "action": "intro_email"},
    {"day": 5,  "channel": "linkedin", "action": "follow_up_message"},
    {"day": 8,  "channel": "email",    "action": "follow_up_2"},
    {"day": 12, "channel": "whatsapp", "action": "template_message"},
    {"day": 18, "channel": "email",    "action": "breakup_email"}
  ],
  "daily_limits": {"email": 100, "linkedin": 20, "whatsapp": 50},
  "batch_size": 500
}
```

**Expected pitch distribution** (based on the signal-weight table in
`services/orchestrator/src/agents/personalization_agent.py`):

| Pitch | Share | Typical persona |
|---|---|---|
| `ai_agents`    | ~40% | CTO/VP Engineering at funded SaaS + Financial Services |
| `rpa_workflow` | ~35% | COO/Director Operations at manufacturing + logistics with SAP |
| `consulting`   | ~25% | CEO + traditional professional services + retail |

**Compliance checklist before launch:**
- [ ] `ANTHROPIC_API_KEY` + `APOLLO_API_KEY` set in Secrets Manager
- [ ] SES production access approved, domain DKIM passing (`docs/ses-setup.md`)
- [ ] WhatsApp templates `intro_ai_agents` / `intro_rpa_workflow` / `intro_consulting` all **APPROVED** by Meta (`docs/whatsapp-setup.md`)
- [ ] LinkedIn OAuth token minted and less than 50 days old (`docs/linkedin-setup.md`)
- [ ] Suppression list reviewed — any known no-contact domains added
- [ ] Per-sender sending reputation not below 80 on Sender Score / Postmaster Tools

---

<!-- ┌───────────────────────────────────────────────────────┐
     │  Append new campaign blueprints below this line using  │
     │  the same structure (hypothesis → why → JSON → pitch  │
     │  distribution → compliance checklist).                │
     └───────────────────────────────────────────────────────┘ -->
