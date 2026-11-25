-- V14__poller_state.sql
-- Tiny key/value store for stateful background pollers.
--
-- The email reply poller uses this to remember the last IMAP UID it
-- processed (plus the mailbox UIDVALIDITY) so each run only fetches
-- genuinely new messages — no reprocessing, no missed replies.

CREATE TABLE IF NOT EXISTS poller_state (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
