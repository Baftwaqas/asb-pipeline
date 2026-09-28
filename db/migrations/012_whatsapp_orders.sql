-- ============================================================================
-- ASB PIPELINE — migration 012: orders taken on WhatsApp
--
-- Until now only Shopify orders became orders. A customer who wrote
-- "2 kilo tamatar" to the business number got her message saved and nothing
-- else: no order, no delivery day, no bill.
--
-- The inbox can now create the order. Two things were missing for that.
--
-- 1. THE ASB PRICE.
--    A Shopify order arrives carrying its own price. A WhatsApp order does not,
--    and the catalogue held the bazaar rate but never the ASB selling price.
--    products.asb_price mirrors Shopify's `price`, exactly as market_price
--    mirrors `compare_at_price`. When the price book for a delivery already has
--    a ceiling for a product (because someone ordered it on Shopify), the
--    WhatsApp order uses THAT promise, so two neighbours on the same delivery
--    never get two different ceilings for the same tomatoes.
--
-- 2. WHO ENTERED IT, AND FROM WHICH MESSAGE.
--    A typed-in order needs a trail a Shopify order does not: which staff
--    member entered it, and which customer message it was taken from. That is
--    what settles "I never ordered this" or "I asked for 2 kg, not 1".
--
-- Additive and idempotent. Safe against the live database.
--
--   node scripts/migrate.js --seed
-- ============================================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS asb_price NUMERIC(12,2);

COMMENT ON COLUMN products.asb_price IS
  'Current ASB selling price per pack, mirrored from Shopify `price`. The '
  'ceiling a WhatsApp order is promised when the delivery''s price book has '
  'no ceiling for this product yet. NULL = not for sale.';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS entered_by  TEXT,
  ADD COLUMN IF NOT EXISTS source_wamid TEXT;

COMMENT ON COLUMN orders.entered_by IS
  'Staff member who typed this order into the inbox. NULL for Shopify orders.';
COMMENT ON COLUMN orders.source_wamid IS
  'The customer WhatsApp message this order was taken from.';

CREATE INDEX IF NOT EXISTS idx_orders_channel_placed
  ON orders (channel, placed_at DESC);

COMMIT;
