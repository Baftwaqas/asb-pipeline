-- ============================================================================
-- 022_order_drafts.sql
--
-- Orders without a human (founder, 19 Nov 2026). A customer picks items in the
-- WhatsApp catalogue list, or asks to repeat her last order; the bot shows her
-- the order it understood with [Theek hai] [Badlein]. Until she taps Theek
-- hai it is only a DRAFT - this table. Confirming turns the draft into a real
-- order through the same path the inbox uses (orders.saveInboxOrder), once.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS order_drafts (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL CHECK (phone ~ '^92[0-9]{10}$'),
  source      TEXT NOT NULL CHECK (source IN ('cart', 'repeat', 'typed', 'voice')),
  lines       JSONB NOT NULL,                -- [{ sku, packs }]
  status      TEXT NOT NULL DEFAULT 'shown'
              CHECK (status IN ('shown', 'confirmed', 'changed', 'expired', 'failed')),
  order_id    BIGINT REFERENCES orders(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_order_drafts_phone ON order_drafts (phone, id DESC);

CREATE OR REPLACE FUNCTION asb022_order_drafts_ready() RETURNS boolean LANGUAGE sql AS
$$ SELECT to_regclass('order_drafts') IS NOT NULL $$;

COMMIT;
