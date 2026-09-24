-- ============================================================================
-- ASB PIPELINE — 003_bill_engine.sql
-- Per-order billing :: the bill fires when the BAG is done, not when the
-- cycle locks.
--
--   cycle locks  ->  mandi run  ->  pack bag  ->  weigh  ->  BILL  ->  deliver
--                                                            ^
--                                                   one order at a time
--
-- Why per-order matters: packed weight changes the total. If the bill went out
-- at lock time, every customer would see one number and pay another. Here the
-- number a customer sees is the number they pay, full stop.
--
-- Everything is idempotent. A Render restart mid-send cannot double-bill.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. AUDIT TRAIL FIX
--    bills.order_id was UNIQUE, which meant a correction could only be issued
--    by deleting the original — destroying the record of what the customer was
--    originally told. Swap it for a partial index: one LIVE bill per order,
--    unlimited voided ones kept forever.
-- ---------------------------------------------------------------------------

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_order_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_bills_order_live
  ON bills (order_id) WHERE status <> 'void';

ALTER TABLE bills ADD COLUMN IF NOT EXISTS void_reason   TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS voided_at     TIMESTAMPTZ;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS supersedes_id BIGINT REFERENCES bills(id);

-- ---------------------------------------------------------------------------
-- 1. PACK COMPLETION
--    An order is packable only if every live line has a weighed quantity.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_order_pack_blockers(p_order_id BIGINT)
RETURNS TABLE (order_item_id BIGINT, sku TEXT, name_en TEXT, qty_ordered NUMERIC, problem TEXT)
LANGUAGE sql STABLE AS $$
  SELECT oi.id, p.sku, p.name_en, oi.qty_ordered, 'not weighed yet'
  FROM order_items oi
  JOIN products p ON p.id = oi.product_id
  WHERE oi.order_id = p_order_id
    AND NOT oi.is_unavailable
    AND oi.qty_packed IS NULL;
$$;

CREATE OR REPLACE FUNCTION asb_mark_order_packed(p_order_id BIGINT)
RETURNS orders
LANGUAGE plpgsql AS $$
DECLARE
  v_order    orders;
  v_missing  TEXT;
  v_live     INTEGER;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_PACK: order % does not exist', p_order_id;
  END IF;

  IF v_order.status = 'cancelled' THEN
    RAISE EXCEPTION 'ASB_PACK: order % is cancelled', v_order.order_number;
  END IF;

  IF v_order.status NOT IN ('locked','packed') THEN
    RAISE EXCEPTION 'ASB_PACK: order % is % — it must be locked before packing',
      v_order.order_number, v_order.status
      USING HINT = 'Run asb_lock_cycle() on its cycle first.';
  END IF;

  SELECT string_agg(sku || ' (' || name_en || ')', ', ')
    INTO v_missing FROM asb_order_pack_blockers(p_order_id);

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ASB_PACK: order % still has unweighed items: %',
      v_order.order_number, v_missing;
  END IF;

  SELECT COUNT(*) INTO v_live
    FROM order_items WHERE order_id = p_order_id AND NOT is_unavailable;

  IF v_live = 0 THEN
    UPDATE orders SET status = 'cancelled', cancelled_at = now(),
           cancel_reason = 'every item unavailable at mandi'
     WHERE id = p_order_id RETURNING * INTO v_order;
    RETURN v_order;
  END IF;

  PERFORM asb_refresh_order_totals(p_order_id);

  UPDATE orders SET status = 'packed', packed_at = now()
   WHERE id = p_order_id AND status = 'locked'
  RETURNING * INTO v_order;

  IF v_order.id IS NULL THEN
    SELECT * INTO v_order FROM orders WHERE id = p_order_id;
  END IF;

  RETURN v_order;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. THE SNAPSHOT
--    Exactly what the customer will see, frozen as JSONB. Once this is written
--    the bill is a historical document — later edits to products, prices or
--    even packed weight cannot rewrite it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_build_bill_snapshot(p_order_id BIGINT)
RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'order_number',  o.order_number,
    'cycle_code',    cy.code,
    'delivery_date', cy.delivery_date,
    'customer', jsonb_build_object(
      'name',   c.name,
      'phone',  c.phone,
      'badge',  c.badge,
      'lang',   c.language_pref
    ),
    'address', jsonb_build_object(
      'society',  s.name,
      'building', o.deliver_building,
      'flat',     o.deliver_flat,
      'note',     o.deliver_note
    ),
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name',        oi.name_snapshot,
               'name_ur',     oi.name_ur_snapshot,
               'unit',        oi.unit,
               'qty_ordered', oi.qty_ordered,
               'qty_packed',  oi.qty_packed,
               'ceiling',     oi.ceiling_unit_price,
               'rate',        oi.billed_unit_price,
               'amount',      oi.line_total,
               'saved',       oi.line_savings
             ) ORDER BY oi.id)
      FROM order_items oi
      WHERE oi.order_id = o.id AND NOT oi.is_unavailable
    ), '[]'::jsonb),
    'unavailable', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'name', oi.name_snapshot, 'name_ur', oi.name_ur_snapshot))
      FROM order_items oi
      WHERE oi.order_id = o.id AND oi.is_unavailable
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'subtotal',      o.billed_total,
      'ceiling_total', o.ceiling_total,
      'savings',       o.savings_total,
      'delivery_fee',  o.delivery_fee,
      'discount',      o.discount,
      'grand_total',   o.grand_total
    ),
    'frozen_at', now()
  )
  FROM orders o
  JOIN customers c  ON c.id  = o.customer_id
  JOIN cycles    cy ON cy.id = o.cycle_id
  LEFT JOIN societies s ON s.id = o.society_id
  WHERE o.id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- 3. GENERATE THE BILL + QUEUE THE WHATSAPP MESSAGE
--    Idempotent twice over:
--      - bills.order_id is UNIQUE, so a second call returns the existing bill
--      - whatsapp_messages.idempotency_key is UNIQUE, so a retry never
--        produces a second send
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_generate_bill(p_order_id BIGINT)
RETURNS TABLE (
  bill_id      BIGINT,
  bill_number  TEXT,
  grand_total  NUMERIC,
  savings      NUMERIC,
  message_id   BIGINT,
  was_existing BOOLEAN
)
LANGUAGE plpgsql AS $$
DECLARE
  v_order    orders;
  v_bill     bills;
  v_msg_id   BIGINT;
  v_existing BOOLEAN := FALSE;
  v_snapshot JSONB;
  v_phone    TEXT;
  v_lang     TEXT;
BEGIN
  SELECT * INTO v_order FROM orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_BILL: order % does not exist', p_order_id;
  END IF;

  IF v_order.status NOT IN ('packed','out_for_delivery','delivered') THEN
    RAISE EXCEPTION 'ASB_BILL: order % is % — bill only after packing',
      v_order.order_number, v_order.status
      USING HINT = 'Call asb_mark_order_packed() once every item is weighed.';
  END IF;

  -- Already billed? Hand back the same bill. Never a second one.
  -- Voided bills are skipped — they are history, not the live bill.
  SELECT * INTO v_bill FROM bills
   WHERE order_id = p_order_id AND status <> 'void';
  IF FOUND THEN
    v_existing := TRUE;
    SELECT id INTO v_msg_id FROM whatsapp_messages
     WHERE idempotency_key = 'final_bill:order:' || p_order_id;

    RETURN QUERY SELECT v_bill.id, v_bill.bill_number, v_bill.grand_total,
                        v_bill.savings_total, v_msg_id, TRUE;
    RETURN;
  END IF;

  PERFORM asb_refresh_order_totals(p_order_id);
  SELECT * INTO v_order FROM orders WHERE id = p_order_id;

  v_snapshot := asb_build_bill_snapshot(p_order_id);

  INSERT INTO bills (order_id, cycle_id, customer_id, subtotal, delivery_fee,
                     discount, grand_total, savings_total, status, snapshot,
                     supersedes_id)
  VALUES (v_order.id, v_order.cycle_id, v_order.customer_id, v_order.billed_total,
          v_order.delivery_fee, v_order.discount, v_order.grand_total,
          v_order.savings_total, 'draft', v_snapshot,
          (SELECT id FROM bills
            WHERE order_id = p_order_id AND status = 'void'
            ORDER BY id DESC LIMIT 1))
  RETURNING * INTO v_bill;

  SELECT c.phone, c.language_pref INTO v_phone, v_lang
    FROM customers c WHERE c.id = v_order.customer_id;

  INSERT INTO whatsapp_messages (
    idempotency_key, customer_id, order_id, phone, direction,
    template_name, template_lang, body_preview, payload, status)
  VALUES (
    'final_bill:order:' || p_order_id,
    v_order.customer_id, v_order.id, v_phone, 'outbound',
    'final_bill', v_lang,
    format('%s — Rs %s (bachat Rs %s)',
           v_bill.bill_number, v_order.grand_total, v_order.savings_total),
    jsonb_build_object('bill_id', v_bill.id,
                       'bill_number', v_bill.bill_number,
                       'snapshot', v_snapshot),
    'queued')
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_msg_id;

  IF v_msg_id IS NULL THEN
    SELECT id INTO v_msg_id FROM whatsapp_messages
     WHERE idempotency_key = 'final_bill:order:' || p_order_id;
  END IF;

  RETURN QUERY SELECT v_bill.id, v_bill.bill_number, v_bill.grand_total,
                      v_bill.savings_total, v_msg_id, v_existing;
END;
$$;

COMMENT ON FUNCTION asb_generate_bill IS
  'Creates the bill for one packed order and queues its final_bill WhatsApp
   message. Safe to call repeatedly — returns the existing bill on retry.';

-- Batch helper: bill every packed order in a cycle that has not been billed.
CREATE OR REPLACE FUNCTION asb_generate_bills_for_cycle(p_cycle_id BIGINT)
RETURNS TABLE (bill_number TEXT, order_number TEXT, grand_total NUMERIC, savings NUMERIC)
LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT o.id FROM orders o
     WHERE o.cycle_id = p_cycle_id
       AND o.status IN ('packed','out_for_delivery','delivered')
       AND NOT EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id)
     ORDER BY o.id
  LOOP
    PERFORM asb_generate_bill(r.id);
  END LOOP;

  RETURN QUERY
  SELECT b.bill_number, o.order_number, b.grand_total, b.savings_total
    FROM bills b JOIN orders o ON o.id = b.order_id
   WHERE b.cycle_id = p_cycle_id ORDER BY b.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. SEND CONFIRMATION — called by the Node worker after Meta returns a wamid
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_mark_bill_sent(p_bill_id BIGINT, p_wamid TEXT)
RETURNS bills
LANGUAGE plpgsql AS $$
DECLARE v_bill bills;
BEGIN
  UPDATE bills SET status = 'sent', sent_at = COALESCE(sent_at, now())
   WHERE id = p_bill_id AND status = 'draft'
  RETURNING * INTO v_bill;

  IF v_bill.id IS NULL THEN
    SELECT * INTO v_bill FROM bills WHERE id = p_bill_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ASB_SEND: bill % does not exist', p_bill_id;
    END IF;
  END IF;

  UPDATE whatsapp_messages
     SET wamid = COALESCE(p_wamid, wamid),
         status = 'sent',
         sent_at = COALESCE(sent_at, now()),
         attempts = attempts + 1
   WHERE order_id = v_bill.order_id AND template_name = 'final_bill';

  PERFORM asb_apply_customer_stats(v_bill.customer_id);
  RETURN v_bill;
END;
$$;

CREATE OR REPLACE FUNCTION asb_mark_bill_paid(
  p_bill_id BIGINT, p_method pay_method, p_amount NUMERIC DEFAULT NULL)
RETURNS bills
LANGUAGE plpgsql AS $$
DECLARE v_bill bills;
BEGIN
  UPDATE bills
     SET status = 'paid', payment_method = p_method,
         amount_paid = COALESCE(p_amount, grand_total), paid_at = now()
   WHERE id = p_bill_id
  RETURNING * INTO v_bill;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_PAY: bill % does not exist', p_bill_id;
  END IF;

  PERFORM asb_apply_customer_stats(v_bill.customer_id);
  RETURN v_bill;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. CUSTOMER STATS + BADGE
--    New -> Regular at 3 billed orders -> Gold at 10.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_apply_customer_stats(p_customer_id BIGINT)
RETURNS customers
LANGUAGE plpgsql AS $$
DECLARE v_cust customers;
BEGIN
  UPDATE customers c
     SET orders_count     = t.cnt,
         lifetime_value   = t.value,
         lifetime_savings = t.savings,
         first_order_at   = t.first_at,
         last_order_at    = t.last_at,
         badge = CASE WHEN t.cnt >= 10 THEN 'gold'::badge_tier
                      WHEN t.cnt >= 3  THEN 'regular'::badge_tier
                      ELSE 'new'::badge_tier END
    FROM (
      SELECT COUNT(*)                        AS cnt,
             COALESCE(SUM(b.grand_total),0)  AS value,
             COALESCE(SUM(b.savings_total),0) AS savings,
             MIN(b.created_at)               AS first_at,
             MAX(b.created_at)               AS last_at
        FROM bills b
       WHERE b.customer_id = p_customer_id AND b.status IN ('sent','paid')
    ) t
   WHERE c.id = p_customer_id
  RETURNING c.* INTO v_cust;

  RETURN v_cust;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. WEIGHT FREEZE AFTER SEND
--    Before the bill goes out, qty_packed is editable. After it goes out, it
--    is not — the customer has seen a number and that number is now a promise.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION guard_locked_order_items()
RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status order_status;
  v_billed BOOLEAN;
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

  IF NEW.qty_packed IS DISTINCT FROM OLD.qty_packed
     OR NEW.is_unavailable IS DISTINCT FROM OLD.is_unavailable THEN
    SELECT EXISTS (
      SELECT 1 FROM bills b
       WHERE b.order_id = NEW.order_id AND b.status IN ('sent','paid')
    ) INTO v_billed;

    IF v_billed THEN
      RAISE EXCEPTION
        'ASB_GUARD: the bill for order % has already been sent — packed weight is frozen.',
        NEW.order_id
        USING HINT = 'Void the bill and issue a corrected one.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. VOID + CORRECT
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION asb_void_bill(p_bill_id BIGINT, p_reason TEXT)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_bill bills;
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) < 5 THEN
    RAISE EXCEPTION 'ASB_VOID: a written reason is required.';
  END IF;

  UPDATE bills
     SET status = 'void', void_reason = p_reason, voided_at = now()
   WHERE id = p_bill_id AND status <> 'void'
  RETURNING * INTO v_bill;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB_VOID: bill % does not exist or is already void', p_bill_id;
  END IF;

  -- Free the idempotency key so a corrected bill can be issued and re-sent.
  -- The old message row is kept, renamed, as proof of what was sent before.
  UPDATE whatsapp_messages
     SET idempotency_key = idempotency_key || ':void:' || p_bill_id
   WHERE idempotency_key = 'final_bill:order:' || v_bill.order_id;

  -- The bill row itself is NEVER deleted. uq_bills_order_live excludes voids,
  -- so a corrected bill can now be generated alongside it.

  PERFORM asb_apply_customer_stats(v_bill.customer_id);
  RETURN format('Bill %s voided (record retained). Reason: %s',
                v_bill.bill_number, p_reason);
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. WORKER VIEWS
-- ---------------------------------------------------------------------------

-- What the Node sender polls.
CREATE OR REPLACE VIEW v_whatsapp_outbox AS
SELECT m.id AS message_id, m.idempotency_key, m.phone, m.template_name,
       m.template_lang, m.payload, m.attempts, m.status,
       b.id AS bill_id, b.bill_number, o.order_number, c.name AS customer_name
FROM whatsapp_messages m
LEFT JOIN orders    o ON o.id = m.order_id
LEFT JOIN bills     b ON b.order_id = o.id
LEFT JOIN customers c ON c.id = m.customer_id
WHERE m.direction = 'outbound'
  AND m.status IN ('queued','failed')
  AND m.attempts < 5
ORDER BY m.created_at;

-- Packing floor board: what Farhan still has to weigh.
CREATE OR REPLACE VIEW v_packing_queue AS
SELECT o.id AS order_id, o.order_number, o.cycle_id, c.name AS customer_name,
       s.name AS society, o.deliver_building, o.deliver_flat, o.status,
       COUNT(oi.id) FILTER (WHERE NOT oi.is_unavailable)                          AS items_total,
       COUNT(oi.id) FILTER (WHERE NOT oi.is_unavailable AND oi.qty_packed IS NOT NULL) AS items_weighed,
       EXISTS (SELECT 1 FROM bills b WHERE b.order_id = o.id)                     AS is_billed
FROM orders o
JOIN customers c ON c.id = o.customer_id
LEFT JOIN societies s ON s.id = o.society_id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.status IN ('locked','packed')
GROUP BY o.id, c.name, s.name
ORDER BY o.id;

COMMIT;
