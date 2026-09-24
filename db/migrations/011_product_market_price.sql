-- ============================================================================
-- ASB PIPELINE — migration 011: the LIVING bazaar rate
--
-- WHY THIS EXISTS, AND WHY 010 WASN'T ENOUGH
--
-- 010 added market_price to cycle_prices and market_unit_price to order_items.
-- Both are correct and both are still needed. But between them there is a hole:
-- cycle_prices only has a row once a price book exists for a cycle, and ASB has
-- no price-book process yet - today the book is assembled lazily from whoever
-- orders first. So an order arriving right now has nowhere to read a bazaar
-- rate from, and market_unit_price would be stamped NULL on every line.
--
-- The missing piece is a LIVING rate: one number per product, the current
-- bazaar price, maintained in Shopify as compare_at_price (the struck-through
-- number beside the ASB price on the storefront) and mirrored here.
--
-- The three now sit in a clear chain:
--
--   products.market_price        CURRENT. Edited in Shopify, re-seeded here.
--          |                     Mutable by design - it moves with the bazaar.
--          v  copied when a cycle's price book is published
--   cycle_prices.market_price    WHAT WAS PUBLISHED for that Community Day.
--          |
--          v  copied when a customer orders
--   order_items.market_unit_price  FROZEN on her bill. Never changes again.
--
-- That is the same shape ceiling_price already has, and for the same reason:
-- editing a rate next month must not rewrite a bill sent last month.
--
-- Additive and idempotent. Safe against the live database.
--
--   node scripts/migrate.js
-- ============================================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS market_price NUMERIC(12,2);

COMMENT ON COLUMN products.market_price IS
  'Current local bazaar rate, mirrored from Shopify compare_at_price. NULL '
  'means unknown - bills omit the comparison rather than claim a saving they '
  'cannot prove. Copied into cycle_prices when a price book is published, and '
  'from there onto each order line.';

-- ---------------------------------------------------------------------------
-- A guard, not a constraint.
--
-- A bazaar rate BELOW the ASB ceiling is not impossible - it means ASB is
-- charging more than the bazaar, which can genuinely happen on an item where
-- the mandi moved against us. It must not be blocked. But it must never print
-- as a negative saving, so the generated columns in 010 already clamp at zero.
-- This view is how you find such rows on purpose, before a customer does.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW asb_price_sanity AS
SELECT p.sku,
       p.name_en,
       p.name_ur,
       p.market_price                        AS bazaar,
       cp.ceiling_price                      AS asb_ceiling,
       (p.market_price - cp.ceiling_price)   AS customer_saves,
       c.code                                AS cycle_code
  FROM products p
  LEFT JOIN cycle_prices cp ON cp.product_id = p.id
  LEFT JOIN cycles       c  ON c.id = cp.cycle_id
 WHERE p.is_active
   AND p.market_price IS NOT NULL
   AND cp.ceiling_price IS NOT NULL
   AND p.market_price <= cp.ceiling_price
 ORDER BY (p.market_price - cp.ceiling_price);

COMMENT ON VIEW asb_price_sanity IS
  'Active products where the bazaar rate is at or below the ASB ceiling - i.e. '
  'the customer saves nothing or loses. Should normally be empty. Check it '
  'before publishing a cycle price book.';

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- SELECT count(*) FILTER (WHERE market_price IS NOT NULL) AS with_bazaar_rate,
--        count(*) FILTER (WHERE market_price IS NULL AND is_active) AS missing
--   FROM products;
--
-- SELECT * FROM asb_price_sanity;   -- expect zero rows
