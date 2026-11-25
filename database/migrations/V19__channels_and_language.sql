-- V19__channels_and_language.sql
-- SaaS phase 2, slice 1: per-org channel entitlement, per-campaign channel
-- choice, and language / country / timezone fields. See
-- docs/saas-architecture.md, "Channel selection" and "Multi-language".

-- Channel lists are text[] (values checked against channel_type's labels)
-- rather than channel_type[]: node-postgres returns arrays of custom enums
-- as raw '{a,b}' strings, which would leak into every API response.

-- ── Org: entitlement + locale defaults ──────────────────────────────────
-- Which channels an org may use at all. Customers: email, WhatsApp, voice.
-- LinkedIn is Appson-internal only (decision 2026-11-13), so only the
-- legacy org gets it. Not editable through the API.
ALTER TABLE organizations
    ADD COLUMN channels text[] NOT NULL
        DEFAULT '{email,whatsapp,voice}'
        CHECK (cardinality(channels) >= 1
               AND channels <@ ARRAY['email','whatsapp','linkedin','voice']),
    ADD COLUMN default_language varchar(35) NOT NULL DEFAULT 'en'
        CHECK (default_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
    ADD COLUMN default_country char(2)
        CHECK (default_country ~ '^[A-Z]{2}$'),
    ADD COLUMN timezone varchar(64) NOT NULL DEFAULT 'UTC';

UPDATE organizations
   SET channels = '{email,whatsapp,linkedin,voice}'
 WHERE id = '00000000-0000-0000-0000-0000000000a1';

-- ── Campaign: chosen channels + language policy ─────────────────────────
ALTER TABLE campaigns
    ADD COLUMN channels text[] NOT NULL DEFAULT '{email}'
        CHECK (cardinality(channels) >= 1
               AND channels <@ ARRAY['email','whatsapp','linkedin','voice']),
    -- NULL = write to each contact in their own language.
    ADD COLUMN languages varchar(35)[],
    -- When a contact's language is unknown: guess from their country, or
    -- use the org's default language.
    ADD COLUMN language_fallback varchar(20) NOT NULL DEFAULT 'country'
        CHECK (language_fallback IN ('country', 'org_default'));

-- Existing campaigns keep exactly the channels they already use:
-- their sequence steps plus anything they have already sent on.
-- (Runs as the migration owner, which bypasses RLS: all orgs.)
UPDATE campaigns c
   SET channels = used.channels
  FROM (
        SELECT campaign_id, array_agg(DISTINCT channel::text) AS channels
          FROM (SELECT campaign_id, channel FROM sequence_steps
                UNION
                SELECT campaign_id, channel FROM messages) x
         GROUP BY campaign_id
       ) used
 WHERE used.campaign_id = c.id;

-- ── Contact + message language ──────────────────────────────────────────
ALTER TABLE contacts
    ADD COLUMN language varchar(35)
        CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
    ADD COLUMN country char(2) CHECK (country ~ '^[A-Z]{2}$'),
    ADD COLUMN timezone varchar(64);

ALTER TABLE messages
    ADD COLUMN language varchar(35);

-- ── Consistency, enforced by the database ───────────────────────────────
-- Deferred to COMMIT so the API can replace a campaign's channels and its
-- sequence steps in one transaction in any order.

-- A campaign may only use channels its org is entitled to.
CREATE FUNCTION check_campaign_channels() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    allowed text[];
    c campaigns%ROWTYPE;
BEGIN
    SELECT * INTO c FROM campaigns WHERE id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;  -- deleted later in the txn
    SELECT channels INTO allowed FROM organizations WHERE id = c.org_id;
    IF NOT (c.channels <@ allowed) THEN
        RAISE EXCEPTION 'campaign % uses channels % but its organization allows only %',
            c.id, c.channels, allowed
            USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM sequence_steps s
                WHERE s.campaign_id = c.id AND NOT (s.channel::text = ANY (c.channels))) THEN
        RAISE EXCEPTION 'campaign % has sequence steps on channels outside %',
            c.id, c.channels
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER campaigns_channels_allowed
    AFTER INSERT OR UPDATE OF channels, org_id ON campaigns
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_campaign_channels();

-- A sequence step may only use one of its campaign's channels.
CREATE FUNCTION check_step_channel() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    chans text[];
BEGIN
    SELECT channels INTO chans FROM campaigns WHERE id = NEW.campaign_id;
    IF chans IS NOT NULL AND NOT (NEW.channel::text = ANY (chans)) THEN
        RAISE EXCEPTION 'sequence step % uses channel % which campaign % does not use (%)',
            NEW.step_number, NEW.channel, NEW.campaign_id, chans
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER sequence_steps_channel_in_campaign
    AFTER INSERT OR UPDATE OF channel, campaign_id ON sequence_steps
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_step_channel();

-- Trigger functions run only as triggers; nobody calls them directly.
REVOKE EXECUTE ON FUNCTION check_campaign_channels(), check_step_channel() FROM PUBLIC;
