-- ============================================================================
-- 024_order_bill_label.sql
--
-- Founder, 20 Nov 2026: neighbours club together - one delivery address, one
-- WhatsApp number - but each wants HER OWN bill. Until now the database held
-- exactly one live order per customer per delivery (uq_orders_customer_cycle_live),
-- so a second order could only be merged into the first.
--
-- Now: the household's main order has no label (NULL) - Shopify orders and
-- inbox orders still merge into it exactly as before. A separate bill on the
-- same number carries a short label ("Ayesha - padosan"); one live order per
-- customer per delivery PER LABEL.
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS bill_label TEXT
  CHECK (bill_label IS NULL OR length(btrim(bill_label)) BETWEEN 1 AND 40);

DROP INDEX IF EXISTS uq_orders_customer_cycle_live;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_customer_cycle_label_live
  ON orders (customer_id, cycle_id, (COALESCE(lower(btrim(bill_label)), '')))
  WHERE status <> 'cancelled';

COMMIT;
