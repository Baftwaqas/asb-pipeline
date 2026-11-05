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
--
-- BILLS ALREADY IN FLIGHT (review B2/B3)
--
--   Every corrected order is classified by its live bill - none, draft, sent,
--   paid - and recorded in bill_ceiling_reviews. Drafts are voided and their
--   queued messages quarantined so the old amount can never be sent; sent and
--   paid bills are left exactly as the customer saw them and queued for a
--   founder decision (v_bill_ceiling_review_queue).
--
-- RUN PLAN
--
--   Staging first, on a restored copy of production, with the classification
--   counts read back before production is touched. Rollback: restore from
--   the pre-run snapshot (Neon branch) - the old generated expressions are in
--   001 and the test file reproduces them.
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

-- ---------------------------------------------------------------------------
-- Orders whose lines were corrected, classified by where their bill stands.
--
--   no live bill          -> header refreshed; the bill that goes out later
--                            is built from the capped lines.
--   live bill, DRAFT      -> never sent, so never seen. The draft bill and its
--                            snapshot carry the old, above-promise amount, and
--                            asb_generate_bill() would hand that same draft
--                            back on retry. So the draft is VOIDED (record
--                            kept, written reason), every queued/failed
--                            final_bill message for the order is QUARANTINED
--                            out of the outbox, and the header is refreshed.
--                            The next asb_generate_bill() issues a fresh,
--                            capped bill under a fresh idempotency key.
--   live bill, SENT/PAID  -> the customer saw it. Bill, snapshot, message and
--                            order header stay exactly as sent. The case goes
--                            to a DURABLE founder-review queue with the old
--                            and corrected amounts; refund or credit is the
--                            founder's decision. bill.js refuses to compose a
--                            bill for such an order (header != lines), so it
--                            cannot be re-sent or collected from by accident.
--
-- bill_ceiling_reviews is that record: one row per corrected order, every
-- class, so the whole correction is auditable after the NOTICEs are gone.
-- ---------------------------------------------------------------------------
CREATE TABLE bill_ceiling_reviews (
  id                    BIGSERIAL PRIMARY KEY,
  order_id              BIGINT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  order_number          TEXT NOT NULL,
  bill_id               BIGINT REFERENCES bills(id) ON DELETE RESTRICT,
  bill_status           TEXT NOT NULL CHECK (bill_status IN ('none','draft','sent','paid')),
  classification        TEXT NOT NULL CHECK (classification IN
                          ('unbilled_refreshed','draft_voided_refreshed','sent_founder_review','paid_founder_review')),
  lines                 JSONB NOT NULL,   -- [{order_item_id, old_line_total, new_line_total}]
  header_before         JSONB NOT NULL,   -- billed/ceiling/savings/grand totals before 022
  header_after          JSONB NOT NULL,   -- after 022 (= before for sent/paid)
  bill_amount_sent      NUMERIC(14,2),    -- bills.grand_total the customer saw, if any
  amount_paid           NUMERIC(14,2),    -- bills.amount_paid at migration time
  corrected_liability   NUMERIC(14,2) NOT NULL, -- capped lines + fee - discount
  overcharge            NUMERIC(14,2) NOT NULL, -- bill_amount_sent - corrected_liability (0 if none sent)
  messages_quarantined  INT NOT NULL DEFAULT 0,
  needs_decision        BOOLEAN NOT NULL,
  decision              TEXT CHECK (decision IN ('refund','credit_next_order','no_action')),
  decided_by            TEXT,
  decided_at            TIMESTAMPTZ,
  decision_note         TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id),
  CONSTRAINT decision_only_when_needed CHECK (needs_decision OR decision IS NULL),
  CONSTRAINT decision_is_attributed CHECK (
    (decision IS NULL AND decided_by IS NULL AND decided_at IS NULL)
    OR (decision IS NOT NULL AND length(trim(decided_by)) > 0 AND decided_at IS NOT NULL))
);

COMMENT ON TABLE bill_ceiling_reviews IS
  '022: every order whose lines the line-ceiling cap corrected. Rows with needs_decision are bills already sent/paid above the promise: founder decides refund / credit / no action.';

CREATE VIEW v_bill_ceiling_review_queue AS
SELECT * FROM bill_ceiling_reviews WHERE needs_decision AND decision IS NULL ORDER BY id;

DO $$
DECLARE
  r       RECORD;
  v_bill  bills;
  v_head  JSONB;
  v_lines JSONB;
  v_class TEXT;
  v_q     INT;
  v_liab  NUMERIC;
  v_n     JSONB := '{}'::jsonb;
BEGIN
  FOR r IN
    SELECT DISTINCT oi.order_id FROM asb022_before b JOIN order_items oi USING (id)
     WHERE b.line_total IS DISTINCT FROM oi.line_total ORDER BY oi.order_id
  LOOP
    SELECT * INTO v_bill FROM bills WHERE order_id = r.order_id AND status <> 'void';

    SELECT jsonb_build_object('billed_total', billed_total, 'ceiling_total', ceiling_total,
                              'savings_total', savings_total, 'grand_total', grand_total)
      INTO v_head FROM orders WHERE id = r.order_id FOR UPDATE;

    SELECT jsonb_agg(jsonb_build_object('order_item_id', oi.id, 'old_line_total', b.line_total,
                                        'new_line_total', oi.line_total) ORDER BY oi.id)
      INTO v_lines
      FROM asb022_before b JOIN order_items oi USING (id)
     WHERE oi.order_id = r.order_id AND b.line_total IS DISTINCT FROM oi.line_total;

    SELECT GREATEST(COALESCE(SUM(oi.line_total) FILTER (WHERE NOT oi.is_unavailable), 0)
                    + o.delivery_fee - o.discount, 0)
      INTO v_liab
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.id = r.order_id GROUP BY o.id;

    v_q := 0;
    IF v_bill.id IS NULL THEN
      v_class := 'unbilled_refreshed';
    ELSIF v_bill.status = 'draft' THEN
      v_class := 'draft_voided_refreshed';
    ELSE
      v_class := v_bill.status::text || '_founder_review';
    END IF;

    IF v_class IN ('unbilled_refreshed', 'draft_voided_refreshed') THEN
      -- Quarantine BEFORE voiding: asb_void_bill renames the key, and the
      -- outbox would otherwise still see the queued old-amount message.
      UPDATE whatsapp_messages
         SET status = 'failed', attempts = GREATEST(attempts, 5),
             error_code = 'ASB022_STALE_ABOVE_CEILING',
             error_detail = 'Quarantined by migration 022: built from a line above the accepted ceiling. Never send; regenerate the bill.'
       WHERE order_id = r.order_id AND direction = 'outbound'
         AND idempotency_key LIKE 'final_bill:order:' || r.order_id || '%'
         AND status IN ('queued', 'failed');
      GET DIAGNOSTICS v_q = ROW_COUNT;

      IF v_class = 'draft_voided_refreshed' THEN
        PERFORM asb_void_bill(v_bill.id,
          'Migration 022: draft built from a line above the accepted line ceiling (F05). Regenerate.');
      END IF;
      PERFORM asb_refresh_order_totals(r.order_id);
    END IF;

    INSERT INTO bill_ceiling_reviews (order_id, order_number, bill_id, bill_status, classification,
           lines, header_before, header_after, bill_amount_sent, amount_paid,
           corrected_liability, overcharge, messages_quarantined, needs_decision)
    SELECT o.id, o.order_number, v_bill.id, COALESCE(v_bill.status::text, 'none'), v_class,
           v_lines, v_head,
           jsonb_build_object('billed_total', o.billed_total, 'ceiling_total', o.ceiling_total,
                              'savings_total', o.savings_total, 'grand_total', o.grand_total),
           CASE WHEN v_class LIKE '%founder_review' THEN v_bill.grand_total END,
           CASE WHEN v_class LIKE '%founder_review' THEN v_bill.amount_paid END,
           v_liab,
           CASE WHEN v_class LIKE '%founder_review' THEN GREATEST(v_bill.grand_total - v_liab, 0) ELSE 0 END,
           v_q,
           v_class LIKE '%founder_review'
      FROM orders o WHERE o.id = r.order_id;

    v_n := jsonb_set(v_n, ARRAY[v_class], to_jsonb(COALESCE((v_n->>v_class)::int, 0) + 1));
    IF v_class LIKE '%founder_review' THEN
      RAISE NOTICE 'ASB022: order % — bill % already %; held for founder review (bill_ceiling_reviews).',
        (SELECT order_number FROM orders WHERE id = r.order_id), v_bill.bill_number, v_bill.status;
    END IF;
  END LOOP;
  RAISE NOTICE 'ASB022: corrected orders by class: %', v_n;
END;
$$;

COMMIT;
