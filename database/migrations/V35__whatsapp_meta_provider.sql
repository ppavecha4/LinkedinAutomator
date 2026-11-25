-- V35__whatsapp_meta_provider.sql — slice 10.1: WhatsApp straight through Meta (Cloud API).
--
-- Until now a company's WhatsApp ran through its own Twilio account. This adds the
-- second way: the company connects the WhatsApp Business account and number it owns
-- with Meta's "Embedded Signup" (one click, no Twilio, no tokens to paste), and we send
-- through Meta's Cloud API. The two are alternatives: a company with a working Meta
-- connection uses it; otherwise it uses Twilio, as before.
--
-- The connection lives in the same encrypted credential vault as every other account,
-- as provider 'whatsapp_meta':
--     meta   (not secret): waba_id, phone_number_id, display_phone_number, verified_name,
--                          business_id?
--     secret (encrypted) : access_token
-- Only the Embedded Signup flow creates it (the token must come from Meta's own code
-- exchange), so the generic "connect an account" endpoint refuses this provider.
--
-- A WhatsApp number can be connected by ONE company at a time: Meta's webhooks name the
-- number, and we route every inbound message and status update to the company that owns
-- it. The partial unique index enforces that for connected (secret present) rows.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE org_credentials DROP CONSTRAINT org_credentials_provider_check;
ALTER TABLE org_credentials ADD CONSTRAINT org_credentials_provider_check
    CHECK (provider IN ('anthropic','google_workspace','smtp','ses',
                        'twilio','heyreach','apollo','fullenrich',
                        'prospeo','datagma','voice','calendly','elevenlabs',
                        'whatsapp_meta'));

CREATE UNIQUE INDEX ux_org_credentials_whatsapp_meta_number
    ON org_credentials ((meta->>'phone_number_id'))
 WHERE provider = 'whatsapp_meta' AND secret_enc IS NOT NULL;
