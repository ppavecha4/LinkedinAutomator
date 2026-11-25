-- V8__user_settings.sql
-- Per-user profile defaults consumed by the dashboard Settings page and
-- prefilled into new campaigns.

CREATE TABLE user_settings (
    user_id                        uuid         PRIMARY KEY,
    sender_name                    varchar(255),
    sender_company                 varchar(255),
    default_value_proposition      text,
    default_daily_limit_email      integer      NOT NULL DEFAULT 100,
    default_daily_limit_linkedin   integer      NOT NULL DEFAULT 20,
    default_daily_limit_whatsapp   integer      NOT NULL DEFAULT 50,
    opt_out_confirmation_message   text         NOT NULL DEFAULT
        'Got it — you won''t hear from me again. Thanks for letting me know.',
    created_at                     timestamptz  NOT NULL DEFAULT now(),
    updated_at                     timestamptz  NOT NULL DEFAULT now()
);
