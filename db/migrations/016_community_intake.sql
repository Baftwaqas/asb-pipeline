-- ============================================================================
-- ASB PIPELINE — migration 016: Community isolation + durable intake (Phase 1)
--
-- Community Bulk Buying packs are sold through Shopify like everything else,
-- but they must NEVER enter the grocery pipeline (products stubs, order_items,
-- cycle_prices, procurement, packing, the grocery WhatsApp bill). On 4-5 Oct
-- 2026 they did: unknown pack variants became 0.25 kg grocery stubs.
--
-- This migration adds three tables and changes nothing that exists:
--
--   community_products   local registry of Shopify products that are
--   community_variants   Community. The order webhook carries no product type
--                        or tags, so the ONLY reliable in-transaction test is
--                        "is this variant/product id registered here?".
--                        Rows are never deleted: once Community, an id stays
--                        Community (fail closed). A product whose Shopify data
--                        stops looking Community keeps its rows with
--                        signals_ok = false, and its lines go to review.
--
--   community_intake     one durable row per Community order line, written in
--                        the SAME transaction as the webhook_events dedupe row,
--                        BEFORE Shopify gets its 200. Phase 1 states only:
--                        received -> resolved | review | retryable_error.
--                        No commitments, no meter, no settlement.
--
-- Additive only. No existing table, column, view or function is touched.
-- Rollback (only if nothing has been written to them yet):
--   DROP TABLE community_intake, community_variants, community_products;
-- ============================================================================

BEGIN;

-- The foreign key to webhook_events briefly locks that (busy) table. Give up
-- rather than queue behind live traffic; re-run later if this times out.
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Registry: products
-- ---------------------------------------------------------------------------
CREATE TABLE community_products (
  shopify_product_id   TEXT PRIMARY KEY,                -- numeric id as text, as in webhooks
  product_gid          TEXT NOT NULL UNIQUE,            -- gid://shopify/Product/<id>
  title                TEXT,
  shopify_status       TEXT,                            -- active | draft | archived | deleted
  product_type         TEXT,
  vendor               TEXT,
  tags                 TEXT[] NOT NULL DEFAULT '{}',
  signals_ok           BOOLEAN NOT NULL,                -- latest Shopify data still marks it Community
  registered_via       TEXT NOT NULL,                   -- snapshot | webhook | reconcile | product_sync
  first_registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Registry: variants. variant id is canonical; SKU is informational only and
-- is deliberately NOT unique (the archived demo product shares SKUs with the
-- Draft products).
-- ---------------------------------------------------------------------------
CREATE TABLE community_variants (
  shopify_variant_id   TEXT PRIMARY KEY,                -- numeric id as text = line_items[].variant_id
  variant_gid          TEXT NOT NULL UNIQUE,            -- gid://shopify/ProductVariant/<id>
  shopify_product_id   TEXT NOT NULL REFERENCES community_products (shopify_product_id),
  sku                  TEXT,
  variant_title        TEXT,
  price                NUMERIC(12,2),
  is_present           BOOLEAN NOT NULL DEFAULT TRUE,   -- false once Shopify no longer lists it
  first_registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_community_variants_product ON community_variants (shopify_product_id);
CREATE INDEX idx_community_variants_sku     ON community_variants (sku);

-- ---------------------------------------------------------------------------
-- Durable intake
-- ---------------------------------------------------------------------------
CREATE TABLE community_intake (
  id                     BIGSERIAL PRIMARY KEY,

  -- identity: the strongest Shopify identity available for a line
  shop                   TEXT NOT NULL,                 -- X-Shopify-Shop-Domain
  shopify_order_id       TEXT NOT NULL,
  shopify_line_item_id   TEXT NOT NULL,
  shopify_order_name     TEXT,                          -- '#1030'
  webhook_event_id       BIGINT REFERENCES webhook_events (id),
  topic                  TEXT,

  -- the line as Shopify sent it (copied out for querying; full line in line_payload)
  shopify_product_id     TEXT,
  shopify_variant_id     TEXT,
  sku                    TEXT,
  vendor                 TEXT,
  title                  TEXT,
  quantity               INTEGER,
  unit_price             NUMERIC(12,2),
  customer_phone         TEXT,                          -- normalised 92XXXXXXXXXX, or NULL
  shopify_customer_id    TEXT,
  order_created_at       TIMESTAMPTZ,

  -- why it was diverted away from grocery
  classification         TEXT NOT NULL,                 -- registered | suspect
  signals                TEXT[] NOT NULL,               -- e.g. {registered_variant,sku_prefix}

  -- Phase 1 worker state
  status                 TEXT NOT NULL DEFAULT 'received',
  review_reason          TEXT,
  resolved_variant_gid   TEXT,
  resolved_product_id    TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  line_payload           JSONB NOT NULL,
  received_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ,

  CONSTRAINT community_intake_line_key
    UNIQUE (shop, shopify_order_id, shopify_line_item_id),
  CONSTRAINT community_intake_status_chk
    CHECK (status IN ('received', 'resolved', 'review', 'retryable_error')),
  CONSTRAINT community_intake_class_chk
    CHECK (classification IN ('registered', 'suspect')),
  CONSTRAINT community_intake_resolved_chk
    CHECK (status <> 'resolved' OR resolved_variant_gid IS NOT NULL),
  CONSTRAINT community_intake_review_chk
    CHECK (status <> 'review' OR review_reason IS NOT NULL)
);

CREATE TRIGGER trg_community_intake_updated BEFORE UPDATE ON community_intake
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The worker's queue: only unfinished rows are indexed.
CREATE INDEX idx_community_intake_pending ON community_intake (next_attempt_at)
  WHERE status IN ('received', 'retryable_error');
CREATE INDEX idx_community_intake_order ON community_intake (shopify_order_id);

COMMENT ON TABLE community_intake IS
  'One row per Community Shopify order line, captured before the webhook is acknowledged. '
  'Phase 1: received -> resolved (exact registered variant) | review (fail closed) | retryable_error. '
  'Never joined into orders/order_items/cycle_prices.';

COMMIT;
