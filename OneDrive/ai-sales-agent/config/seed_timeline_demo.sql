DO $$
DECLARE
  cid uuid;
  pid uuid;
  cont uuid;
BEGIN
  SELECT id INTO cid FROM campaigns WHERE name = 'Timeline Demo' LIMIT 1;
  IF cid IS NULL THEN
    INSERT INTO campaigns (name, goal, sender_company, sender_name, value_proposition, created_by)
    VALUES ('Timeline Demo', 'Book discovery calls', 'Appson AI', 'Prateek Pavecha',
            'AI + automation for mid-market ops teams',
            '00000000-0000-0000-0000-000000000001')
    RETURNING id INTO cid;
  END IF;

  SELECT id INTO pid FROM prospects
   WHERE campaign_id = cid AND company_name = 'Demo Co' LIMIT 1;
  IF pid IS NULL THEN
    INSERT INTO prospects (campaign_id, company_name, company_domain, industry, country, status)
    VALUES (cid, 'Demo Co', 'demo-co.example', 'SaaS', 'United States', 'CONTACTED')
    RETURNING id INTO pid;
  END IF;

  SELECT id INTO cont FROM contacts
   WHERE prospect_id = pid AND full_name = 'Jane Doe' LIMIT 1;
  IF cont IS NULL THEN
    INSERT INTO contacts (prospect_id, campaign_id, full_name, title, email,
                          linkedin_url, enriched_at)
    VALUES (pid, cid, 'Jane Doe', 'CTO', 'jane@demo-co.example',
            'https://www.linkedin.com/in/janedoe', now())
    RETURNING id INTO cont;
  END IF;

  -- Clear any prior demo events on this contact so re-runs are idempotent.
  DELETE FROM prospect_events WHERE contact_id = cont;

  INSERT INTO prospect_events (campaign_id, prospect_id, contact_id, channel, event_type, source, payload, occurred_at) VALUES
    (cid, pid, cont, NULL,       'discovered',          'system',   '{"via":"apollo_search"}'::jsonb, now() - interval '4 days 1 hour'),
    (cid, pid, cont, NULL,       'enriched',            'system',   '{"linkedin_url_revealed":true,"email_revealed":true}'::jsonb, now() - interval '4 days 55 minutes'),
    (cid, pid, cont, 'linkedin', 'message_drafted',     'system',   '{"pitch_type":"ai_agents","body_chars":287}'::jsonb, now() - interval '4 days 50 minutes'),
    (cid, pid, cont, 'linkedin', 'message_sent',        'operator', '{"via":"dashboard_mark_sent"}'::jsonb, now() - interval '3 days'),
    (cid, pid, cont, 'linkedin', 'connection_accepted', 'operator', '{}'::jsonb, now() - interval '2 days 4 hours'),
    (cid, pid, cont, 'email',    'message_queued',      'system',   '{"pitch_type":"ai_agents","body_chars":712}'::jsonb, now() - interval '1 day 12 hours'),
    (cid, pid, cont, 'email',    'message_sent',        'system',   '{"to":"jane@demo-co.example"}'::jsonb, now() - interval '1 day'),
    (cid, pid, cont, 'email',    'message_opened',      'webhook',  '{"user_agent":"Mozilla/5.0 (Macintosh)"}'::jsonb, now() - interval '23 hours'),
    (cid, pid, cont, 'email',    'message_replied',     'operator', '{"sentiment":"positive","next_step":"book_meeting"}'::jsonb, now() - interval '4 hours');

  RAISE NOTICE 'seeded: campaign=% prospect=% contact=%', cid, pid, cont;
END
$$ LANGUAGE plpgsql;
