-- V22__credential_checks.sql — SaaS phase 3, slice 3.4: send from the
-- customer's own accounts.
--
-- 1. org_credentials records the last check against the provider
--    ("Verify"): when it ran and, if it failed, why (shown to the customer;
--    never contains the secret).
-- 2. customer_mailboxes(): the reply poller reads every verified customer
--    mailbox. It starts outside any tenant, so — like V17's lookups — this
--    is a SECURITY DEFINER function returning only (org, provider, label);
--    the poller then switches into each org to load and decrypt the
--    secret under row-level security.
--
-- Forward-only (CLAUDE.md principle 7).

ALTER TABLE org_credentials
    ADD COLUMN last_checked_at timestamptz,
    ADD COLUMN last_error      text CHECK (length(last_error) <= 500);

CREATE FUNCTION customer_mailboxes()
    RETURNS TABLE (org_id uuid, provider varchar, label varchar)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT c.org_id, c.provider, c.label
      FROM org_credentials c
      JOIN organizations o ON o.id = c.org_id AND o.status = 'ACTIVE'
     WHERE c.provider IN ('google_workspace', 'smtp')
       AND c.status = 'VERIFIED'
       AND c.secret_enc IS NOT NULL
     ORDER BY c.org_id, c.provider, c.label
$$;

REVOKE EXECUTE ON FUNCTION customer_mailboxes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customer_mailboxes() TO sales_app;   -- role created in V17
