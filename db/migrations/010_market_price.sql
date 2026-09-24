-- ============================================================================
-- ASB PIPELINE — migration 010: the bazaar rate, and the two savings
--
-- WHY
-- The schema modelled two prices: the ceiling (what ASB promises) and the
-- final (what the mandi actually cost). That is one price short.
--
-- A customer's saving has TWO parts and they are earned differently:
--
--   bazaar rate  350   <- what the same kilo costs in the local bazaar
--        |  Rs 100     COMMUNITY SAVING. Earned by ordering at all. Certain
--        v             from the moment she checks out. Never clawed back.
--   ASB ceiling  250   <- the zyada se zyada promise
--        |  Rs  50     MANDI SAVING. Only if the mandi run comes in cheaper.
--        v             May be zero. That is normal, not a failure.
--   final price  200   <- what she is actually billed
--
-- Collapsing these into one number cost ASB its own story: on a cycle where
-- the mandi held firm, the bill read "poora Rs 540 hi bana" - as though the
-- customer had saved nothing - when she had already saved Rs 160 against the
-- bazaar before the trucks left. The same is true when a community target is
-- missed: the community saving still stands.
--
-- SHAPE
-- market_unit_price is SNAPSHOTTED onto order_items, exactly like
-- ceiling_unit_price, for the same reason: a bill must not change when a
-- bazaar rate is edited months later. cycle_prices carries the live figure
-- for the cycle; order_items carries the frozen one for the order.
--
-- Additive and idempotent. No column changes type, nothing is dropped, and
-- running it twice is a no-op. Safe against the live database.
--
--   psql "$DATABASE_URL" -f db/migrations/010_market_price.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The bazaar rate for this cycle's price book.
--    Sourced from Shopify's compare_at_price, which is already what the
--    storefront strikes through next to the ASB price.
-- ---------------------------------------------------------------------------
ALTER TABLE cycle_prices
  ADD COLUMN IF NOT EXISTS market_price NUMERIC(12,2);

COMMENT ON COLUMN cycle_prices.market_price IS
  'Local bazaar rate for this cycle. The strike-through price on Shopify. '
  'NULL means unknown, not zero - the bill hides the comparison rather than '
  'claiming a saving it cannot prove.';

-- ---------------------------------------------------------------------------
-- 2. The frozen bazaar rate on the order line.
-- ---------------------------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS market_unit_price NUMERIC(12,2);

COMMENT ON COLUMN order_items.market_unit_price IS
  'Bazaar rate at the moment this line was ordered. Snapshot, never updated.';

-- ---------------------------------------------------------------------------
-- 3. The two savings, computed not stored-by-hand.
--
-- community_savings : (bazaar - ceiling) x billed qty. Certain at checkout.
-- line_savings      : (ceiling - billed)  x billed qty. ALREADY EXISTS from
--                     001_init; it is the mandi saving and is left untouched.
-- total_savings     : the sum, which is what the customer sees.
--
-- GREATEST(...,0) guards the case where a bazaar rate is edited BELOW the ASB
-- rate by mistake. A negative saving must never print on a bill; it would read
-- as ASB charging above the bazaar.
-- ---------------------------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS community_savings NUMERIC(14,2)
    GENERATED ALWAYS AS (
      ROUND(
        COALESCE(qty_packed, qty_ordered)
        * GREATEST(COALESCE(market_unit_price, ceiling_unit_price) - ceiling_unit_price, 0)
      , 2)
    ) STORED;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS market_line_total NUMERIC(14,2)
    GENERATED ALWAYS AS (
      ROUND(
        COALESCE(qty_packed, qty_ordered)
        * COALESCE(market_unit_price, ceiling_unit_price)
      , 2)
    ) STORED;

-- ---------------------------------------------------------------------------
-- 4. Order-level rollups.
--    market_total    : what this basket costs in the bazaar.
--    community_total : guaranteed saving, known at checkout.
--    (savings_total from 001_init stays the MANDI saving.)
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS market_total    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS community_total NUMERIC(14,2) NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 5. Teach the totals function about them.
--
-- asb_refresh_order_totals is the single place order headers are recomputed;
-- 003_bill_engine calls it at lock, at pack and at bill time. Extending it
-- here means every existing caller picks the new numbers up with no change.
-- ---------------------------------------------------------------------------
-- This is 002_lock_engine's function with two sums added and nothing else
-- touched: same signature, same scalar subquery (so an order with no billable
-- lines still returns a row and zeroes cleanly), same GREATEST clamp on
-- grand_total. savings_total keeps its original meaning - the MANDI saving.
CREATE OR REPLACE FUNCTION asb_refresh_order_totals(p_order_id BIGINT)
RETURNS orders
LANGUAGE plpgsql AS $$
DECLARE
  v_order orders;
BEGIN
  UPDATE orders o
     SET ceiling_total   = t.ceiling_total,
         billed_total    = t.billed_total,
         savings_total   = t.savings_total,
         market_total    = t.market_total,
         community_total = t.community_total,
         grand_total     = GREATEST(t.billed_total + o.delivery_fee - o.discount, 0)
    FROM (
      SELECT COALESCE(SUM(oi.ceiling_line_total), 0) AS ceiling_total,
             COALESCE(SUM(oi.line_total), 0)         AS billed_total,
             COALESCE(SUM(oi.line_savings), 0)       AS savings_total,
             COALESCE(SUM(oi.market_line_total), 0)  AS market_total,
             COALESCE(SUM(oi.community_savings), 0)  AS community_total
        FROM order_items oi
       WHERE oi.order_id = p_order_id
         AND NOT oi.is_unavailable
    ) t
   WHERE o.id = p_order_id
  RETURNING o.* INTO v_order;

  RETURN v_order;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- SELECT order_number, market_total, ceiling_total, billed_total,
--        community_total AS saved_by_joining,
--        savings_total   AS saved_at_mandi,
--        community_total + savings_total AS total_saved
--   FROM orders ORDER BY id DESC LIMIT 5;
