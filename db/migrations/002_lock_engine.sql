-- ============================================================================
-- ASB PIPELINE — 002_lock_engine.sql
-- The lock-time bill engine :: cycle-level locking
--
-- Lifecycle of a cycle:
--   draft  -> open  -> [MANDI RUN] -> locked -> packing -> delivered -> closed
--                                       ^
--                                       |
--                            asb_lock_cycle() happens HERE
--
-- Before lock : order_items.final_unit_price IS NULL, so billed_unit_price
--               falls back to the ceiling. Every quote is a worst case.
-- At lock     : final prices are stamped onto every line, totals are frozen,
--               and the order becomes immutable except for packed weight.
-- After lock  : the weigh station writes qty_packed; totals refresh; bills go out.
--
-- Every function here is atomic. A half-locked cycle cannot exist.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. PRE-FLIGHT: what is blocking the lock?
--    Run this before asb_lock_cycle() and show it to ops. It returns one row
--    per product that has been ordered but has no usable final price.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_cycle_lock_blockers(p_cycle_id BIGINT)
RETURNS TABLE (
  product_id     BIGINT,
  sku            TEXT,
  name_en        TEXT,
  name_ur        TEXT,
  qty_ordered    NUMERIC,
  order_count    BIGINT,
  ceiling_price  NUMERIC,
  problem        TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    p.id,
    p.sku,
    p.name_en,
    p.name_ur,
    SUM(oi.qty_ordered)::NUMERIC,
    COUNT(DISTINCT o.id),
    cp.ceiling_price,
    CASE
      WHEN cp.id IS NULL          THEN 'no price book row for this cycle'
      WHEN NOT cp.is_available    THEN 'marked unavailable — lines will be voided'
      WHEN cp.final_price IS NULL THEN 'final_price not set after mandi run'
    END
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
               AND o.cycle_id = p_cycle_id
               AND o.status IN ('pending','confirmed')
  JOIN products p ON p.id = oi.product_id
  LEFT JOIN cycle_prices cp
         ON cp.cycle_id = p_cycle_id AND cp.product_id = oi.product_id
  WHERE NOT oi.is_unavailable
    AND (cp.id IS NULL OR NOT cp.is_available OR cp.final_price IS NULL)
  GROUP BY p.id, p.sku, p.name_en, p.name_ur, cp.id, cp.ceiling_price,
           cp.is_available, cp.final_price
  ORDER BY SUM(oi.qty_ordered) DESC;
$$;

COMMENT ON FUNCTION asb_cycle_lock_blockers IS
  'Pre-flight check. Empty result = safe to lock. Items marked unavailable are
   warnings, not hard blockers — asb_lock_cycle voids those lines automatically.';

-- ---------------------------------------------------------------------------
-- 2. TOTALS REFRESH
--    order_items.line_total is a generated column, so it is always correct.
--    The orders table caches the rollup; this recomputes it. Call after lock
--    and after every weigh-station write.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_refresh_order_totals(p_order_id BIGINT)
RETURNS orders
LANGUAGE plpgsql AS $$
DECLARE
  v_order orders;
BEGIN
  UPDATE orders o
     SET ceiling_total = t.ceiling_total,
         billed_total  = t.billed_total,
         savings_total = t.savings_total,
         grand_total   = GREATEST(t.billed_total + o.delivery_fee - o.discount, 0)
    FROM (
      SELECT COALESCE(SUM(oi.ceiling_line_total), 0) AS ceiling_total,
             COALESCE(SUM(oi.line_total), 0)         AS billed_total,
             COALESCE(SUM(oi.line_savings), 0)       AS savings_total
        FROM order_items oi
       WHERE oi.order_id = p_order_id
         AND NOT oi.is_unavailable
    ) t
   WHERE o.id = p_order_id
  RETURNING o.* INTO v_order;

  RETURN v_order;
END;
$$;

CREATE OR REPLACE FUNCTION asb_refresh_cycle_totals(p_cycle_id BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH t AS (
    SELECT o.id AS order_id,
           COALESCE(SUM(oi.ceiling_line_total) FILTER (WHERE NOT oi.is_unavailable), 0) AS ceiling_total,
           COALESCE(SUM(oi.line_total)         FILTER (WHERE NOT oi.is_unavailable), 0) AS billed_total,
           COALESCE(SUM(oi.line_savings)       FILTER (WHERE NOT oi.is_unavailable), 0) AS savings_total
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.cycle_id = p_cycle_id
       AND o.status <> 'cancelled'
     GROUP BY o.id
  )
  UPDATE orders o
     SET ceiling_total = t.ceiling_total,
         billed_total  = t.billed_total,
         savings_total = t.savings_total,
         grand_total   = GREATEST(t.billed_total + o.delivery_fee - o.discount, 0)
    FROM t
   WHERE o.id = t.order_id;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. THE LOCK
--    One transaction. Either the whole cycle locks or nothing changes.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_lock_cycle(
  p_cycle_id      BIGINT,
  p_allow_missing BOOLEAN DEFAULT FALSE   -- TRUE => unpriced lines fall back to ceiling
)
RETURNS TABLE (
  cycle_code        TEXT,
  orders_locked     INTEGER,
  items_priced      INTEGER,
  items_voided      INTEGER,
  ceiling_total     NUMERIC,
  billed_total      NUMERIC,
  savings_total     NUMERIC,
  mandi_cost_total  NUMERIC,
  gross_margin      NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
  v_cycle    cycles;
  v_blockers TEXT;
  v_priced   INTEGER := 0;
  v_voided   INTEGER := 0;
  v_orders   INTEGER := 0;
BEGIN
  -- Serialise against concurrent locks / late orders landing mid-lock.
  SELECT * INTO v_cycle FROM cycles WHERE id = p_cycle_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_LOCK: cycle % does not exist', p_cycle_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_cycle.status = 'locked' THEN
    RAISE EXCEPTION 'ASB_LOCK: cycle % (%) is already locked at %',
      p_cycle_id, v_cycle.code, v_cycle.locked_at
      USING HINT = 'Use asb_unlock_cycle() first if you must re-price.';
  END IF;

  IF v_cycle.status NOT IN ('open','draft') THEN
    RAISE EXCEPTION 'ASB_LOCK: cycle % is in status % and cannot be locked',
      p_cycle_id, v_cycle.status;
  END IF;

  -- --- Guard: refuse to lock with unpriced lines unless explicitly overridden.
  IF NOT p_allow_missing THEN
    SELECT string_agg(sku || ' (' || name_en || ': ' || problem || ')', E'\n  ')
      INTO v_blockers
      FROM asb_cycle_lock_blockers(p_cycle_id)
     WHERE problem <> 'marked unavailable — lines will be voided';

    IF v_blockers IS NOT NULL THEN
      RAISE EXCEPTION E'ASB_LOCK: cycle % has unpriced products:\n  %',
        v_cycle.code, v_blockers
        USING HINT = 'Set cycle_prices.final_price for each, or pass p_allow_missing => TRUE to bill those lines at the ceiling.';
    END IF;
  END IF;

  -- --- Step 1: void lines whose product was unavailable at the mandi.
  -- NOTE: the UPDATE target (oi) cannot be referenced from a JOIN condition in
  -- the FROM clause, so the product match lives in WHERE. This is a Postgres
  -- rule, not a style choice — the JOIN form parses but fails at runtime.
  UPDATE order_items oi
     SET is_unavailable = TRUE,
         packer_note    = COALESCE(oi.packer_note || ' | ', '') || 'auto-voided at lock: not available'
    FROM orders o, cycle_prices cp
   WHERE oi.order_id   = o.id
     AND cp.cycle_id   = o.cycle_id
     AND cp.product_id = oi.product_id
     AND o.cycle_id    = p_cycle_id
     AND o.status IN ('pending','confirmed')
     AND NOT cp.is_available
     AND NOT oi.is_unavailable;
  GET DIAGNOSTICS v_voided = ROW_COUNT;

  -- --- Step 2: stamp final prices onto every live line.
  -- The CHECK on cycle_prices already guarantees final_price <= ceiling_price,
  -- and billed_unit_price is LEAST(ceiling, final) regardless. Two layers.
  UPDATE order_items oi
     SET final_unit_price = cp.final_price
    FROM orders o, cycle_prices cp
   WHERE oi.order_id   = o.id
     AND cp.cycle_id   = o.cycle_id
     AND cp.product_id = oi.product_id
     AND o.cycle_id    = p_cycle_id
     AND o.status IN ('pending','confirmed')
     AND NOT oi.is_unavailable
     AND cp.final_price IS NOT NULL;
  GET DIAGNOSTICS v_priced = ROW_COUNT;

  -- --- Step 3: freeze the price book.
  UPDATE cycle_prices
     SET locked_at = now()
   WHERE cycle_id = p_cycle_id
     AND locked_at IS NULL;

  -- --- Step 4: roll totals up onto the orders.
  PERFORM asb_refresh_cycle_totals(p_cycle_id);

  -- --- Step 5: flip order status.
  UPDATE orders
     SET status    = 'locked',
         locked_at = now()
   WHERE cycle_id  = p_cycle_id
     AND status IN ('pending','confirmed');
  GET DIAGNOSTICS v_orders = ROW_COUNT;

  -- --- Step 6: flip the cycle itself.
  UPDATE cycles
     SET status = 'locked', locked_at = now()
   WHERE id = p_cycle_id;

  -- --- Step 7: report.
  RETURN QUERY
  SELECT
    v_cycle.code,
    v_orders,
    v_priced,
    v_voided,
    COALESCE(SUM(o.ceiling_total), 0),
    COALESCE(SUM(o.billed_total), 0),
    COALESCE(SUM(o.savings_total), 0),
    COALESCE((
      SELECT SUM(oi2.billed_qty * cp2.mandi_cost)
        FROM order_items oi2
        JOIN orders o2 ON o2.id = oi2.order_id AND o2.cycle_id = p_cycle_id
                      AND o2.status = 'locked'
        JOIN cycle_prices cp2 ON cp2.cycle_id = p_cycle_id
                             AND cp2.product_id = oi2.product_id
       WHERE NOT oi2.is_unavailable
    ), 0),
    COALESCE(SUM(o.billed_total), 0) - COALESCE((
      SELECT SUM(oi3.billed_qty * cp3.mandi_cost)
        FROM order_items oi3
        JOIN orders o3 ON o3.id = oi3.order_id AND o3.cycle_id = p_cycle_id
                      AND o3.status = 'locked'
        JOIN cycle_prices cp3 ON cp3.cycle_id = p_cycle_id
                             AND cp3.product_id = oi3.product_id
       WHERE NOT oi3.is_unavailable
    ), 0)
  FROM orders o
  WHERE o.cycle_id = p_cycle_id AND o.status = 'locked';
END;
$$;

COMMENT ON FUNCTION asb_lock_cycle IS
  'Atomically locks a cycle: voids unavailable lines, stamps final prices,
   freezes the price book, refreshes totals, advances order + cycle status.
   Returns a one-row summary including gross margin against mandi cost.';

-- ---------------------------------------------------------------------------
-- 4. UNLOCK — correction path, guarded
--    Refuses once any bill has left the building. A customer who has seen a
--    number must never see a different one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_unlock_cycle(p_cycle_id BIGINT, p_reason TEXT)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
  v_sent INTEGER;
  v_code TEXT;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'ASB_UNLOCK: a written reason is required.';
  END IF;

  SELECT code INTO v_code FROM cycles WHERE id = p_cycle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_UNLOCK: cycle % does not exist', p_cycle_id;
  END IF;

  SELECT COUNT(*) INTO v_sent
    FROM bills WHERE cycle_id = p_cycle_id AND status IN ('sent','paid');

  IF v_sent > 0 THEN
    RAISE EXCEPTION 'ASB_UNLOCK: % bill(s) already sent for cycle %. Refusing.',
      v_sent, v_code
      USING HINT = 'Void the individual bills and issue corrections instead.';
  END IF;

  -- Demote the orders FIRST. The immutability guard keys off order status, so
  -- clearing prices while they are still 'locked' would raise ASB_GUARD.
  UPDATE orders SET status = 'confirmed', locked_at = NULL
   WHERE cycle_id = p_cycle_id AND status = 'locked';

  UPDATE order_items oi
     SET final_unit_price = NULL
    FROM orders o
   WHERE oi.order_id = o.id AND o.cycle_id = p_cycle_id AND o.status = 'confirmed';

  UPDATE cycle_prices SET locked_at = NULL WHERE cycle_id = p_cycle_id;

  UPDATE cycles
     SET status = 'open', locked_at = NULL,
         notes  = COALESCE(notes || E'\n', '')
                  || '[' || now()::TEXT || '] unlocked: ' || p_reason
   WHERE id = p_cycle_id;

  PERFORM asb_refresh_cycle_totals(p_cycle_id);

  RETURN format('Cycle %s reopened. Reason: %s', v_code, p_reason);
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. IMMUTABILITY GUARD
--    After lock, the only field allowed to move is qty_packed (the weigh
--    station) and the packer's note. Prices and ordered quantity are frozen.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guard_locked_order_items()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
BEGIN
  SELECT status INTO v_status FROM orders WHERE id = NEW.order_id;

  IF v_status IN ('locked','packed','out_for_delivery','delivered') THEN
    IF NEW.ceiling_unit_price IS DISTINCT FROM OLD.ceiling_unit_price
       OR NEW.final_unit_price IS DISTINCT FROM OLD.final_unit_price
       OR NEW.qty_ordered      IS DISTINCT FROM OLD.qty_ordered THEN
      RAISE EXCEPTION
        'ASB_GUARD: order % is % — prices and ordered qty are frozen. Only qty_packed may change.',
        NEW.order_id, v_status
        USING HINT = 'Unlock the cycle, or void this line and issue a correction.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_locked_items
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION guard_locked_order_items();

-- Note on ordering: asb_lock_cycle stamps final prices in Step 2 while orders
-- are still 'confirmed', and only flips them to 'locked' in Step 5. The guard
-- therefore never fires during a legitimate lock. asb_unlock_cycle relies on
-- the same trick in reverse — it demotes the order status BEFORE clearing
-- prices, otherwise the guard would block the very correction it exists for.

-- ---------------------------------------------------------------------------
-- 6. WEIGH STATION ENTRY POINT
--    Farhan scans, weighs, writes. Totals refresh on the spot.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_set_packed_qty(
  p_order_item_id BIGINT,
  p_qty_packed    NUMERIC,
  p_note          TEXT DEFAULT NULL
)
RETURNS TABLE (
  order_id     BIGINT,
  line_total   NUMERIC,
  grand_total  NUMERIC,
  drift_pct    NUMERIC
)
LANGUAGE plpgsql AS $$
DECLARE
  v_item order_items;
  v_ord  orders;
BEGIN
  IF p_qty_packed < 0 THEN
    RAISE EXCEPTION 'ASB_PACK: packed quantity cannot be negative.';
  END IF;

  UPDATE order_items
     SET qty_packed  = p_qty_packed,
         packer_note = COALESCE(p_note, packer_note)
   WHERE id = p_order_item_id
  RETURNING * INTO v_item;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_PACK: order_item % not found', p_order_item_id;
  END IF;

  v_ord := asb_refresh_order_totals(v_item.order_id);

  RETURN QUERY SELECT
    v_item.order_id,
    v_item.line_total,
    v_ord.grand_total,
    ROUND(((p_qty_packed - v_item.qty_ordered) / NULLIF(v_item.qty_ordered,0)) * 100, 1);
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. POST-LOCK REPORTING VIEW
--    What the final_bill template renders from, one row per order.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_cycle_lock_report AS
SELECT
  c.id              AS cycle_id,
  c.code            AS cycle_code,
  c.cycle_date,
  c.status          AS cycle_status,
  COUNT(DISTINCT o.id)                       AS orders,
  COUNT(DISTINCT o.customer_id)              AS households,
  COUNT(DISTINCT o.society_id)               AS societies,
  SUM(o.ceiling_total)                       AS committed_at_ceiling,
  SUM(o.billed_total)                        AS actually_billed,
  SUM(o.savings_total)                       AS customer_savings,
  ROUND(
    100.0 * SUM(o.savings_total) / NULLIF(SUM(o.ceiling_total), 0), 2
  )                                          AS savings_pct,
  SUM(o.grand_total)                         AS revenue
FROM cycles c
LEFT JOIN orders o ON o.cycle_id = c.id AND o.status <> 'cancelled'
GROUP BY c.id, c.code, c.cycle_date, c.status;

COMMIT;
