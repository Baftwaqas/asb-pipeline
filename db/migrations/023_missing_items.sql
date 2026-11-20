-- ============================================================================
-- 023_missing_items.sql
--
-- Founder, 20 Nov 2026: when a customer asks the order bot for something ASB
-- does not sell, the bot says "abhi hamare paas nahi" and RECORDS it here, so
-- the founder sees each week which missing items people ask for most and
-- decides what to add. One row per item per message.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS missing_items (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL CHECK (phone ~ '^92[0-9]{10}$'),
  item        TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 120),   -- the item's name, lower case
  said        TEXT,                                                     -- her words, for context
  source      TEXT NOT NULL DEFAULT 'typed' CHECK (source IN ('typed', 'edit', 'voice')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS missing_items_created_idx ON missing_items (created_at DESC);
CREATE INDEX IF NOT EXISTS missing_items_item_idx ON missing_items (item);

COMMIT;
