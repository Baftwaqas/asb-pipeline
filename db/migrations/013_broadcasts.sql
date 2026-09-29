-- ============================================================================
-- ASB PIPELINE — migration 013: rate-list broadcasts and opt-outs
--
-- Replaces the one AiSensy feature ASB actually used besides chat: sending the
-- rate-list poster to every customer.
--
--   broadcasts            one row per send: which poster, which delivery,
--                         how far it got
--   broadcast_recipients  one row per customer per send. The primary key
--                         (broadcast, phone) means a restart mid-send resumes
--                         where it stopped and never sends anyone the poster
--                         twice.
--   marketing_opt_outs    customers who replied STOP. Every broadcast skips
--                         them. WhatsApp requires this, and a number that
--                         keeps messaging people who asked it to stop gets
--                         blocked and reported until Meta limits it.
--
-- Additive and idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS broadcasts (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  template     TEXT NOT NULL,
  media_id     TEXT,
  media_mime   TEXT,
  delivery     TEXT,
  cutoff       TEXT,
  is_test      BOOLEAN NOT NULL DEFAULT false,
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'sending', 'done', 'stopped')),
  total        INT NOT NULL DEFAULT 0,
  sent         INT NOT NULL DEFAULT 0,
  failed       INT NOT NULL DEFAULT 0,
  skipped      INT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS broadcast_recipients (
  broadcast_id BIGINT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  phone        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  wamid        TEXT,
  error        TEXT,
  sent_at      TIMESTAMPTZ,
  PRIMARY KEY (broadcast_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
  ON broadcast_recipients (broadcast_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS marketing_opt_outs (
  phone         TEXT PRIMARY KEY,
  opted_out_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source        TEXT
);

COMMIT;
