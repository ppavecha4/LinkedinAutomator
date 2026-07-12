-- V15__inbound_events.sql
-- Durable inbound-webhook queue (replaces the SQS path on non-AWS deploys).
--
-- The WhatsApp (Twilio) and LinkedIn (Heyreach) webhook handlers write
-- the raw event here instead of publishing to SQS. A Python cron
-- processor (process_inbound_events.py) drains unprocessed rows, matches
-- each to a contact, and records the reply / acceptance. Decoupling
-- receipt from processing means a slow match never blocks the webhook
-- response (Twilio/Heyreach need a fast 200).

CREATE TABLE IF NOT EXISTS inbound_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source        varchar(40)  NOT NULL,   -- whatsapp.inbound | whatsapp.status | linkedin | heyreach
    payload       jsonb        NOT NULL DEFAULT '{}',
    processed_at  timestamptz,             -- NULL until the processor handles it
    process_note  text,                    -- matched contact / skip reason
    received_at   timestamptz  NOT NULL DEFAULT now()
);

-- Processor scans for the oldest unprocessed rows.
CREATE INDEX IF NOT EXISTS idx_inbound_events_unprocessed
  ON inbound_events (received_at)
  WHERE processed_at IS NULL;
