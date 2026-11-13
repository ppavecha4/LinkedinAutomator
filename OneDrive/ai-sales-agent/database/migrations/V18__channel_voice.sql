-- V18__channel_voice.sql
-- AI voice calls become a channel (SaaS phase 2). See
-- docs/saas-architecture.md, "Channel selection" / "Voice channel".
--
-- On its own because a new enum value cannot be USED in the transaction
-- that adds it; V19 uses 'voice' in column defaults.
ALTER TYPE channel_type ADD VALUE IF NOT EXISTS 'voice';
