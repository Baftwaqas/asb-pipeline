-- ============================================================================
-- ASB PIPELINE — 001_init.sql
-- Apna Sasta Bazaar :: core schema
-- Target: PostgreSQL 15+ (Render managed Postgres)
--
-- Design principles:
--   1. Money is NUMERIC(12,2) in PKR. Never float.
--   2. Quantity is NUMERIC(10,3) so 1.055 kg is expressible.
--   3. The CEILING PROMISE is enforced by the database, not by app code.
--      A customer can never be billed above the price they committed to.
--   4. Every price/name on an order line is a SNAPSHOT. Changing the
--      product master never rewrites history.
--   5. Shopify + WhatsApp webhooks are idempotent by event id / wamid.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. Extensions + shared helpers
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy search on names (Urdu/Roman)

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 1. Enumerated types
-- ---------------------------------------------------------------------------

CREATE TYPE badge_tier    AS ENUM ('new','regular','gold');
CREATE TYPE unit_type     AS ENUM ('kg','g','pao','pcs','bundle','dozen','packet');
CREATE TYPE cycle_status  AS ENUM ('draft','open','locked','packing','delivered','closed');
CREATE TYPE order_status  AS ENUM ('pending','confirmed','locked','packed','out_for_delivery','delivered','cancelled');
CREATE TYPE order_channel AS ENUM ('whatsapp','shopify','field','phone','walk_in');
CREATE TYPE bill_status   AS ENUM ('draft','sent','paid','void');
CREATE TYPE msg_direction AS ENUM ('outbound','inbound');
CREATE TYPE msg_status    AS ENUM ('queued','sent','delivered','read','failed');
CREATE TYPE pay_method    AS ENUM ('cod','easypaisa','jazzcash','bank_transfer','credit');

-- ---------------------------------------------------------------------------
-- 2. societies — the 76+ residential complexes
-- ---------------------------------------------------------------------------

CREATE TABLE societies (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,              -- 'FKP', 'RAK-01'
  name            TEXT NOT NULL,
  name_ur         TEXT,
  area            TEXT,                              -- 'Gulistan-e-Johar'
  city            TEXT NOT NULL DEFAULT 'Karachi',
  -- 0 = Sunday ... 6 = Saturday. ASB default: Sunday + Thursday.
  community_days  SMALLINT[] NOT NULL DEFAULT '{0,4}',
  delivery_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  household_count INTEGER,                           -- addressable market size
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  launched_on     DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT society_days_valid CHECK (community_days <@ ARRAY[0,1,2,3,4,5,6]::SMALLINT[])
);

CREATE TRIGGER trg_societies_updated BEFORE UPDATE ON societies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_societies_active ON societies (is_active) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 3. customers — phone is the identity, not email
-- ---------------------------------------------------------------------------

CREATE TABLE customers (
  id                BIGSERIAL PRIMARY KEY,
  -- E.164 WITHOUT the plus, exactly how WhatsApp Cloud API returns it: 923001234567
  phone             TEXT UNIQUE NOT NULL,
  name              TEXT,
  name_ur           TEXT,
  society_id        BIGINT REFERENCES societies(id) ON DELETE SET NULL,
  building          TEXT,                            -- tower / block
  flat              TEXT,                            -- flat / house no.
  address_note      TEXT,
  badge             badge_tier NOT NULL DEFAULT 'new',
  whatsapp_opt_in   BOOLEAN NOT NULL DEFAULT TRUE,
  language_pref     TEXT NOT NULL DEFAULT 'ur_roman',-- 'ur_roman' | 'ur' | 'en'
  shopify_customer_id TEXT UNIQUE,
  -- denormalised counters, refreshed by the bill engine
  orders_count      INTEGER NOT NULL DEFAULT 0,
  lifetime_value    NUMERIC(14,2) NOT NULL DEFAULT 0,
  lifetime_savings  NUMERIC(14,2) NOT NULL DEFAULT 0,
  first_order_at    TIMESTAMPTZ,
  last_order_at     TIMESTAMPTZ,
  is_blocked        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT phone_is_e164_digits CHECK (phone ~ '^[1-9][0-9]{9,14}$')
);

CREATE TRIGGER trg_customers_updated BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_customers_society ON customers (society_id);
CREATE INDEX idx_customers_badge   ON customers (badge);
CREATE INDEX idx_customers_name_trgm ON customers USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 4. products — mirrors the Product Master Catalogue / Shopify
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  id                  BIGSERIAL PRIMARY KEY,
  sku                 TEXT UNIQUE NOT NULL,          -- 'SBZ-TOM-001'
  name_en             TEXT NOT NULL,
  name_ur             TEXT,
  name_roman          TEXT,                          -- 'Tamatar'
  category            TEXT NOT NULL,                 -- 'sabziyaan' | 'phal' | 'grocery'
  subcategory         TEXT,
  unit                unit_type NOT NULL DEFAULT 'kg',
  step_qty            NUMERIC(10,3) NOT NULL DEFAULT 0.250,  -- min increment
  min_qty             NUMERIC(10,3) NOT NULL DEFAULT 0.250,
  is_weighed          BOOLEAN NOT NULL DEFAULT TRUE, -- TRUE => packed weight may differ
  shopify_product_id  TEXT,
  shopify_variant_id  TEXT UNIQUE,
  image_url           TEXT,
  sort_order          INTEGER NOT NULL DEFAULT 100,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_products_category ON products (category, sort_order) WHERE is_active;

-- ---------------------------------------------------------------------------
-- 5. cycles — one Community Day buying window
-- ---------------------------------------------------------------------------

CREATE TABLE cycles (
  id             BIGSERIAL PRIMARY KEY,
  code           TEXT UNIQUE NOT NULL,               -- 'C-2026-08-09'
  cycle_date     DATE NOT NULL,                      -- the Community Day itself
  opens_at       TIMESTAMPTZ NOT NULL,
  locks_at       TIMESTAMPTZ NOT NULL,               -- cut-off; mandi run happens after
  delivery_date  DATE NOT NULL,
  status         cycle_status NOT NULL DEFAULT 'draft',
  locked_at      TIMESTAMPTZ,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cycle_window_sane CHECK (locks_at > opens_at)
);

CREATE TRIGGER trg_cycles_updated BEFORE UPDATE ON cycles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_cycles_status ON cycles (status, cycle_date DESC);

-- ---------------------------------------------------------------------------
-- 6. cycle_prices — the price book for one cycle
--    ceiling_price is published BEFORE orders open (the promise).
--    final_price is written at lock time, AFTER the mandi run.
-- ---------------------------------------------------------------------------

CREATE TABLE cycle_prices (
  id             BIGSERIAL PRIMARY KEY,
  cycle_id       BIGINT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  product_id     BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  ceiling_price  NUMERIC(12,2) NOT NULL,             -- max the customer can pay
  mandi_cost     NUMERIC(12,2),                      -- our landed cost per unit
  final_price    NUMERIC(12,2),                      -- set at lock; NULL until then
  market_price   NUMERIC(12,2),                      -- retail comparison, for "savings" copy
  is_available   BOOLEAN NOT NULL DEFAULT TRUE,
  locked_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, product_id),
  CONSTRAINT ceiling_positive     CHECK (ceiling_price > 0),
  CONSTRAINT final_not_above_ceil CHECK (final_price IS NULL OR final_price <= ceiling_price)
);

CREATE TRIGGER trg_cycle_prices_updated BEFORE UPDATE ON cycle_prices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_cycle_prices_cycle ON cycle_prices (cycle_id);

-- ---------------------------------------------------------------------------
-- 7. orders
-- ---------------------------------------------------------------------------

CREATE SEQUENCE asb_order_seq START 1001;

CREATE TABLE orders (
  id                 BIGSERIAL PRIMARY KEY,
  order_number       TEXT UNIQUE NOT NULL
                       DEFAULT 'ASB-' || LPAD(nextval('asb_order_seq')::TEXT, 6, '0'),
  customer_id        BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  cycle_id           BIGINT NOT NULL REFERENCES cycles(id)    ON DELETE RESTRICT,
  society_id         BIGINT REFERENCES societies(id) ON DELETE SET NULL,
  channel            order_channel NOT NULL DEFAULT 'whatsapp',
  status             order_status  NOT NULL DEFAULT 'pending',

  -- Shopify is the universal ledger; this is the link back.
  shopify_order_id   TEXT UNIQUE,
  shopify_order_name TEXT,

  -- Address snapshot (customer may move; the delivery record must not change)
  deliver_building   TEXT,
  deliver_flat       TEXT,
  deliver_note       TEXT,

  delivery_fee       NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount           NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Recomputed by the bill engine from order_items
  ceiling_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  billed_total       NUMERIC(14,2) NOT NULL DEFAULT 0,
  savings_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  grand_total        NUMERIC(14,2) NOT NULL DEFAULT 0,

  placed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at          TIMESTAMPTZ,
  packed_at          TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  cancelled_at       TIMESTAMPTZ,
  cancel_reason      TEXT,

  source_payload     JSONB,                          -- raw Shopify / WhatsApp body
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_orders_cycle_status ON orders (cycle_id, status);
CREATE INDEX idx_orders_customer     ON orders (customer_id, placed_at DESC);
CREATE INDEX idx_orders_society      ON orders (society_id, cycle_id);

-- One live order per customer per cycle (cancelled ones don't count).
CREATE UNIQUE INDEX uq_orders_customer_cycle_live
  ON orders (customer_id, cycle_id)
  WHERE status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- 8. order_items — where the ceiling promise is physically enforced
--
--   billed_qty        = packed weight if known, else ordered qty
--   billed_unit_price = LEAST(ceiling, final)  <-- can NEVER exceed the ceiling
--   line_total        = billed_qty * billed_unit_price
--
-- These are GENERATED columns. No application bug, no bad admin edit, and no
-- manual UPDATE can ever bill a customer above the price they committed to.
-- ---------------------------------------------------------------------------

CREATE TABLE order_items (
  id                 BIGSERIAL PRIMARY KEY,
  order_id           BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id         BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- snapshots, so catalogue edits never rewrite an old bill
  name_snapshot      TEXT NOT NULL,
  name_ur_snapshot   TEXT,
  unit               unit_type NOT NULL,

  qty_ordered        NUMERIC(10,3) NOT NULL,
  qty_packed         NUMERIC(10,3),                  -- from the weigh station
  ceiling_unit_price NUMERIC(12,2) NOT NULL,
  final_unit_price   NUMERIC(12,2),                  -- copied from cycle_prices at lock

  billed_qty NUMERIC(10,3)
    GENERATED ALWAYS AS (COALESCE(qty_packed, qty_ordered)) STORED,

  billed_unit_price NUMERIC(12,2)
    GENERATED ALWAYS AS (
      LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))
    ) STORED,

  line_total NUMERIC(14,2)
    GENERATED ALWAYS AS (
      ROUND(
        COALESCE(qty_packed, qty_ordered)
        * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))
      , 2)
    ) STORED,

  ceiling_line_total NUMERIC(14,2)
    GENERATED ALWAYS AS (ROUND(COALESCE(qty_packed, qty_ordered) * ceiling_unit_price, 2)) STORED,

  line_savings NUMERIC(14,2)
    GENERATED ALWAYS AS (
      ROUND(
        COALESCE(qty_packed, qty_ordered)
        * (ceiling_unit_price
           - LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price)))
      , 2)
    ) STORED,

  is_substituted     BOOLEAN NOT NULL DEFAULT FALSE,
  is_unavailable     BOOLEAN NOT NULL DEFAULT FALSE, -- out of stock at mandi
  packer_note        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT qty_ordered_positive CHECK (qty_ordered > 0),
  CONSTRAINT qty_packed_sane      CHECK (qty_packed IS NULL OR qty_packed >= 0),
  UNIQUE (order_id, product_id)
);

CREATE TRIGGER trg_order_items_updated BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_order_items_order   ON order_items (order_id);
CREATE INDEX idx_order_items_product ON order_items (product_id);

-- ---------------------------------------------------------------------------
-- 9. bills — the final_bill artefact sent over WhatsApp
-- ---------------------------------------------------------------------------

CREATE SEQUENCE asb_bill_seq START 1;

CREATE TABLE bills (
  id             BIGSERIAL PRIMARY KEY,
  bill_number    TEXT UNIQUE NOT NULL
                   DEFAULT 'ASB-B-' || LPAD(nextval('asb_bill_seq')::TEXT, 6, '0'),
  order_id       BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  cycle_id       BIGINT NOT NULL REFERENCES cycles(id) ON DELETE RESTRICT,
  customer_id    BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  subtotal       NUMERIC(14,2) NOT NULL,
  delivery_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount       NUMERIC(12,2) NOT NULL DEFAULT 0,
  grand_total    NUMERIC(14,2) NOT NULL,
  savings_total  NUMERIC(14,2) NOT NULL DEFAULT 0,

  status         bill_status NOT NULL DEFAULT 'draft',
  payment_method pay_method,
  amount_paid    NUMERIC(14,2) NOT NULL DEFAULT 0,

  pdf_url        TEXT,
  image_url      TEXT,                               -- rendered bill card for WhatsApp
  sent_at        TIMESTAMPTZ,
  paid_at        TIMESTAMPTZ,
  snapshot       JSONB,                              -- frozen line items as billed
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_bills_updated BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_bills_cycle_status ON bills (cycle_id, status);

-- ---------------------------------------------------------------------------
-- 10. whatsapp_messages — send log + delivery receipts + idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE whatsapp_messages (
  id              BIGSERIAL PRIMARY KEY,
  wamid           TEXT UNIQUE,                       -- Meta message id
  idempotency_key TEXT UNIQUE,                       -- e.g. 'final_bill:order:1042'
  customer_id     BIGINT REFERENCES customers(id) ON DELETE SET NULL,
  order_id        BIGINT REFERENCES orders(id)    ON DELETE SET NULL,
  phone           TEXT NOT NULL,
  direction       msg_direction NOT NULL DEFAULT 'outbound',
  template_name   TEXT,                              -- 'order_confirmed' | 'final_bill'
  template_lang   TEXT DEFAULT 'en',
  body_preview    TEXT,
  payload         JSONB,
  status          msg_status NOT NULL DEFAULT 'queued',
  error_code      TEXT,
  error_detail    TEXT,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_wa_messages_updated BEFORE UPDATE ON whatsapp_messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_wa_order   ON whatsapp_messages (order_id);
CREATE INDEX idx_wa_phone   ON whatsapp_messages (phone, created_at DESC);
CREATE INDEX idx_wa_pending ON whatsapp_messages (status) WHERE status IN ('queued','failed');

-- ---------------------------------------------------------------------------
-- 11. webhook_events — Shopify + Meta replay protection
--     Insert FIRST, process SECOND. ON CONFLICT DO NOTHING = dedupe.
-- ---------------------------------------------------------------------------

CREATE TABLE webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,                       -- 'shopify' | 'whatsapp'
  event_id      TEXT NOT NULL,                       -- X-Shopify-Webhook-Id / wamid
  topic         TEXT,                                -- 'orders/create'
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'received',    -- received|processed|failed|ignored
  attempts      SMALLINT NOT NULL DEFAULT 0,
  error_detail  TEXT,
  UNIQUE (source, event_id)
);

CREATE INDEX idx_webhook_unprocessed ON webhook_events (source, received_at)
  WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 12. Operating views
-- ---------------------------------------------------------------------------

-- The mandi purchase list: how many kg of each item to buy for one cycle.
CREATE VIEW v_cycle_procurement AS
SELECT
  o.cycle_id,
  p.id                       AS product_id,
  p.sku,
  p.name_en,
  p.name_ur,
  oi.unit,
  COUNT(DISTINCT o.id)       AS order_count,
  SUM(oi.qty_ordered)        AS total_qty_ordered,
  SUM(oi.qty_packed)         AS total_qty_packed,
  cp.ceiling_price,
  cp.mandi_cost,
  cp.final_price,
  ROUND(SUM(oi.qty_ordered) * COALESCE(cp.mandi_cost, 0), 2) AS estimated_mandi_spend
FROM order_items oi
JOIN orders   o  ON o.id = oi.order_id AND o.status <> 'cancelled'
JOIN products p  ON p.id = oi.product_id
LEFT JOIN cycle_prices cp ON cp.cycle_id = o.cycle_id AND cp.product_id = p.id
GROUP BY o.cycle_id, p.id, p.sku, p.name_en, p.name_ur, oi.unit,
         cp.ceiling_price, cp.mandi_cost, cp.final_price;

-- Live totals straight from the line items (source of truth for the bill engine).
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

-- Per-society scoreboard for a cycle.
CREATE VIEW v_society_cycle_summary AS
SELECT
  o.cycle_id,
  s.id   AS society_id,
  s.code,
  s.name,
  COUNT(DISTINCT o.id)          AS orders,
  COUNT(DISTINCT o.customer_id) AS households,
  SUM(o.grand_total)            AS revenue,
  SUM(o.savings_total)          AS customer_savings
FROM orders o
JOIN societies s ON s.id = o.society_id
WHERE o.status <> 'cancelled'
GROUP BY o.cycle_id, s.id, s.code, s.name;

COMMIT;
