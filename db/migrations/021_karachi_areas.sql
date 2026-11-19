-- ============================================================================
-- 021_karachi_areas.sql
--
-- Where customers live, all over Karachi (founder, 19 Nov 2026): people outside
-- the areas ASB serves message us too. Each phone gets an area, so the day ASB
-- opens a new area there is a ready list to message, and the counts show where
-- demand is growing.
--
--   karachi_areas       district -> area, spellings people use, an approximate
--                       centre point (to SUGGEST an area from a location pin),
--                       and served = ASB delivers there today.
--   customer_locations  one row per phone: its area (or what they typed, if no
--                       match), how it was set (bot / staff / society), and the
--                       bot's state while it is verifying the location.
--
-- The area list itself lives in data/karachi-areas.json and is loaded by
-- areas.js (upserted by name; staff can add more from the inbox).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS karachi_areas (
  id          BIGSERIAL PRIMARY KEY,
  district    TEXT NOT NULL,
  name        TEXT NOT NULL UNIQUE,
  aliases     TEXT[] NOT NULL DEFAULT '{}',
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  served      BOOLEAN NOT NULL DEFAULT FALSE,
  added_by    TEXT NOT NULL DEFAULT 'list',          -- 'list' | staff name
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS customer_locations (
  phone        TEXT PRIMARY KEY CHECK (phone ~ '^92[0-9]{10}$'),
  area_id      BIGINT REFERENCES karachi_areas(id),
  raw_text     TEXT,                                   -- what they typed / pin name
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  source       TEXT CHECK (source IN ('bot', 'staff', 'society')),
  -- bot: 'asked' (waiting for a pin or a name), 'confirming' (asked "is it X?"),
  -- 'done', 'staff' (gave up after two tries - a person should set it)
  bot_state    TEXT NOT NULL DEFAULT 'none'
               CHECK (bot_state IN ('none', 'asked', 'confirming', 'done', 'staff')),
  pending_area BIGINT REFERENCES karachi_areas(id),
  tries        SMALLINT NOT NULL DEFAULT 0,
  asked_at     TIMESTAMPTZ,
  set_at       TIMESTAMPTZ,
  set_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_customer_locations_area ON customer_locations (area_id);

CREATE OR REPLACE FUNCTION asb021_areas_ready() RETURNS boolean LANGUAGE sql AS
$$ SELECT to_regclass('karachi_areas') IS NOT NULL AND to_regclass('customer_locations') IS NOT NULL $$;

COMMIT;
