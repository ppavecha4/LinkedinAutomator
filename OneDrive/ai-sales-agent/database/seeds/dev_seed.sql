-- dev_seed.sql
-- Minimal local development seed. Idempotent — safe to re-run.

-- Sample campaign
INSERT INTO campaigns (
    id, name, status, goal, tone,
    sender_company, sender_name, value_proposition,
    icp_criteria, created_by
) VALUES (
    '00000000-0000-0000-0000-000000000001',
    'Sample — AI Agents for B2B SaaS',
    'DRAFT',
    'Book qualified discovery calls with VP Eng / CTO at mid-market B2B SaaS companies.',
    'professional',
    'Acme AI',
    'Alex Example',
    'We help B2B SaaS teams automate internal ops with autonomous agents — cutting ops cost 30%+.',
    '{"industries":["Software","SaaS"],"employees":"51-500","regions":["US","EU"]}'::jsonb,
    '00000000-0000-0000-0000-000000000000'
) ON CONFLICT (id) DO NOTHING;

-- Three-step sequence: email → LinkedIn connect → follow-up email
INSERT INTO sequence_steps (
    campaign_id, step_number, channel, action, delay_days, template_subject, template_body
) VALUES
    (
        '00000000-0000-0000-0000-000000000001',
        1, 'email', 'send', 0,
        '{{first_name}} — quick question on {{company}}',
        'Hi {{first_name}}, noticed {{company}} is scaling {{team}}. Quick question...'
    ),
    (
        '00000000-0000-0000-0000-000000000001',
        2, 'linkedin', 'connect', 2,
        NULL,
        '{{first_name}}, would love to connect — I work with teams on autonomous ops agents.'
    ),
    (
        '00000000-0000-0000-0000-000000000001',
        3, 'email', 'send', 4,
        'Following up: {{company}} + AI agents',
        'Circling back on my earlier note — worth a 20-min chat next week?'
    )
ON CONFLICT (campaign_id, step_number) DO NOTHING;
