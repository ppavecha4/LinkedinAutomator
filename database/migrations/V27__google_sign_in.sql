-- Slice 3.10: Sign in with Google.
--
-- Google has verified the person's email, so signing in with it proves
-- they own the address. If the account was created with a password and
-- never verified, someone else may have registered it first: that
-- password could belong to a stranger, so it is removed and every older
-- session is ended. The rightful owner is now in; they can set their own
-- password later through "Forgot password".

CREATE FUNCTION google_adopt_account(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE users
       SET password_hash = NULL,
           sessions_revoked_at = now(),
           password_changed_at = now()
     WHERE id = p_user_id AND email_verified_at IS NULL AND password_hash IS NOT NULL;
    UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = p_user_id;
END $$;

REVOKE EXECUTE ON FUNCTION google_adopt_account(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION google_adopt_account(uuid) TO sales_app;
