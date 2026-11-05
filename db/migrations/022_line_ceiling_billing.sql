-- ============================================================================
-- 022 — The accepted LINE ceiling is a hard cap on the billed line (F05, F14)
--
-- THE BUG (found in the Lane A preflight review, 5 Nov 2026)
--
--   001 caps the billed RATE at the ceiling rate, but bills that rate on the
--   PACKED quantity. When the weigh station packs more than was ordered, the
--   line goes above the amount the customer was promised at checkout:
--
--     ordered 1 kg, ceiling Rs 100/kg  -> confirmation says Rs 100
--     packed 1.08 kg, final Rs 95/kg   -> old line_total = Rs 102.60  (> 100)
--
--   The confirmation message promises "zyada se zyada" per line. F05 says the
--   customer never pays more than the accepted ceiling; F14 says the bill must
--   not surprise the customer upward. Over-packing is ASB's choice, so the
--   extra weight is ASB's cost.
--
-- THE RULE
--
--   accepted line ceiling = ROUND(qty_ordered * ceiling_unit_price, 2)
--                           (exactly the line amount in the confirmation)
--
--   packed <= ordered  -> every formula is IDENTICAL to 001 (byte-for-byte
--                         the same expression), so under-packed and exact
--                         lines, and every existing order, are unchanged.
--   packed >  ordered  -> line_total         = LEAST(accepted ceiling, old)
--                         ceiling_line_total = accepted ceiling
--                         line_savings       = ceiling_line_total - line_total
--
--   Under-weight still bills less (the customer benefits). Over-weight is
--   delivered, never charged above the promise.
--
-- WHY DROP + ADD
--
--   PostgreSQL 16 cannot change a generated expression in place (SET
--   EXPRESSION arrives in 17), and a generated column cannot read another
--   generated column, so each expression is written out in full.
--   v_order_totals is the only object that depends on these columns; it is
--   dropped and recreated exactly as 001 defines it. The 002/010 refresh
--   functions read the columns by name at call time and need no change.
--
--   ADD COLUMN ... GENERATED ... STORED rewrites order_items and holds an
--   ACCESS EXCLUSIVE lock for the duration. order_items is small (hundreds of
--   rows); run outside the 18:00-22:00 order window all the same.
--
-- WHAT DOES NOT CHANGE
--
--   billed_qty, billed_unit_price, community_savings, market_line_total.
--   The customer did receive the packed weight, so the bazaar value of what
--   arrived (market_line_total) stays on the packed quantity.
--
-- LOCKED ROWS
--
--   guard_locked_order_items() is a BEFORE UPDATE row trigger. Dropping and
--   re-adding generated columns is DDL, not an UPDATE, so it does not fire;
--   the stored values of locked rows are recomputed by the same rule. For
--   every row with packed <= ordered the recomputed value equals the old one
--   (same expression). The verification block below proves no such row moved
--   and reports how many over-packed rows were corrected.
-- ============================================================================

BEGIN;

-- Snapshot what every row bills today, so the change can be proven.
CREATE TEMP TABLE asb022_before ON COMMIT DROP AS
SELECT id, qty_ordered, qty_packed, line_total, ceiling_line_total, line_savings
  FROM order_items;

DROP VIEW v_order_totals;

ALTER TABLE order_items
  DROP COLUMN line_total,
  DROP COLUMN ceiling_line_total,
  DROP COLUMN line_savings;

ALTER TABLE order_items
  ADD COLUMN line_total NUMERIC(14,2)
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(qty_packed, qty_ordered) <= qty_ordered THEN
          ROUND(
            COALESCE(qty_packed, qty_ordered)
            * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))
          , 2)
        ELSE
          LEAST(
            ROUND(qty_ordered * ceiling_unit_price, 2),
            ROUND(
              COALESCE(qty_packed, qty_ordered)
              * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))
            , 2)
          )
      END
    ) STORED,

  ADD COLUMN ceiling_line_total NUMERIC(14,2)
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(qty_packed, qty_ordered) <= qty_ordered THEN
          ROUND(COALESCE(qty_packed, qty_ordered) * ceiling_unit_price, 2)
        ELSE
          ROUND(qty_ordered * ceiling_unit_price, 2)
      END
    ) STORED,

  ADD COLUMN line_savings NUMERIC(14,2)
    GENERATED ALWAYS AS (
      CASE
        WHEN COALESCE(qty_packed, qty_ordered) <= qty_ordered THEN
          ROUND(
            COALESCE(qty_packed, qty_ordered)
            * (ceiling_unit_price
               - LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price)))
          , 2)
        ELSE
          ROUND(qty_ordered * ceiling_unit_price, 2)
          - LEAST(
              ROUND(qty_ordered * ceiling_unit_price, 2),
              ROUND(
                COALESCE(qty_packed, qty_ordered)
                * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))
              , 2)
            )
      END
    ) STORED;

COMMENT ON COLUMN order_items.line_total IS
  '022: never above ROUND(qty_ordered * ceiling_unit_price, 2), the line amount accepted at checkout (F05/F14). Identical to 001 when packed <= ordered.';
COMMENT ON COLUMN order_items.ceiling_line_total IS
  '022: packed qty x ceiling rate, capped at the accepted line ceiling when over-packed.';
COMMENT ON COLUMN order_items.line_savings IS
  '022: ceiling_line_total - line_total when over-packed; 001 formula otherwise.';

-- Recreated exactly as 001_init defines it.
CREATE VIEW v_order_totals AS
SELECT
  o.id AS order_id,
  o.order_number,
  o.cycle_id,
  o.customer_id,
  o.status,
  COUNT(oi.id)                                   AS line_count,
  COALESCE(SUM(oi.ceiling_line_total), 0)        AS ceiling_total,
  COALESCE(SUM(oi.line_total), 0)                AS billed_total,
  COALESCE(SUM(oi.line_savings), 0)              AS savings_total,
  COALESCE(SUM(oi.line_total), 0) + o.delivery_fee - o.discount AS grand_total
FROM orders o
LEFT JOIN order_items oi
       ON oi.order_id = o.id AND NOT oi.is_unavailable
GROUP BY o.id;

-- Proof: no row with packed <= ordered changed by a single paisa; no row
-- anywhere now bills above its accepted line ceiling.
DO $$
DECLARE
  v_moved     INT;
  v_over      INT;
  v_corrected INT;
BEGIN
  SELECT COUNT(*) INTO v_moved
    FROM asb022_before b JOIN order_items oi USING (id)
   WHERE COALESCE(b.qty_packed, b.qty_ordered) <= b.qty_ordered
     AND (oi.line_total, oi.ceiling_line_total, oi.line_savings)
         IS DISTINCT FROM (b.line_total, b.ceiling_line_total, b.line_savings);
  IF v_moved > 0 THEN
    RAISE EXCEPTION 'ASB022: % non-over-packed line(s) changed value; aborting.', v_moved;
  END IF;

  SELECT COUNT(*) INTO v_over
    FROM order_items
   WHERE line_total > ROUND(qty_ordered * ceiling_unit_price, 2);
  IF v_over > 0 THEN
    RAISE EXCEPTION 'ASB022: % line(s) still above the accepted line ceiling; aborting.', v_over;
  END IF;

  SELECT COUNT(*) INTO v_corrected
    FROM asb022_before b JOIN order_items oi USING (id)
   WHERE b.line_total IS DISTINCT FROM oi.line_total;
  RAISE NOTICE 'ASB022: % over-packed line(s) capped at the accepted line ceiling.', v_corrected;
END;
$$;

-- Order headers. A corrected line changes what its order should total.
--
--   No bill sent yet -> refresh the header now, so the bill that goes out is
--                       the capped one.
--   Bill already sent or paid -> leave the header exactly as the customer saw
--                       it. Rewriting a sent bill silently is its own F14
--                       breach; any refund is a founder decision. They are
--                       listed, one NOTICE per order, for that review.
DO $$
DECLARE
  r RECORD;
  v_refreshed INT := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT oi.order_id,
           o.order_number,
           EXISTS (SELECT 1 FROM bills bl
                    WHERE bl.order_id = oi.order_id
                      AND bl.status IN ('sent','paid')) AS billed
      FROM asb022_before b
      JOIN order_items oi USING (id)
      JOIN orders o ON o.id = oi.order_id
     WHERE b.line_total IS DISTINCT FROM oi.line_total
     ORDER BY oi.order_id
  LOOP
    IF r.billed THEN
      RAISE NOTICE 'ASB022: order % was billed above a line ceiling before 022; header left as sent - founder review.', r.order_number;
    ELSE
      PERFORM asb_refresh_order_totals(r.order_id);
      v_refreshed := v_refreshed + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'ASB022: % unbilled order header(s) refreshed.', v_refreshed;
END;
$$;

COMMIT;
