-- ============================================================================
-- ASB PIPELINE — migration 015: phone notifications for the inbox
--
-- AiSensy's phone app pinged Waqas the moment a customer wrote. The ASB
-- inbox is a web page, so it uses Web Push to do the same: each phone or
-- laptop that taps "Notifications on" is stored here, and every inbound
-- WhatsApp message is pushed to all of them.
--
--   push_subscriptions  one row per device/browser. `endpoint` is the
--                       browser vendor's push address; p256dh + auth are the
--                       keys that encrypt the message for that device only.
--   app_settings        small key/value store. Holds the VAPID key pair the
--                       server generates for itself on first start, so no
--                       secret ever has to be typed or pasted anywhere.
--
-- Additive and idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  p256dh       TEXT NOT NULL,
  auth         TEXT NOT NULL,
  agent        TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_ok_at   TIMESTAMPTZ,
  failures     INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS app_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
