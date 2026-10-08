-- ============================================================================
-- ASB PIPELINE — migration 016: Community isolation + durable intake (Phase 1)
--
-- Community Bulk Buying packs are sold through Shopify like everything else,
-- but they must NEVER enter the grocery pipeline (products stubs, order_items,
-- cycle_prices, procurement, packing, the grocery WhatsApp bill). On 4-5 Oct
-- 2026 they did: unknown pack variants became 0.25 kg grocery stubs.
--
-- Adds four tables. Changes nothing that exists.
--
--   community_products   local registry of Shopify products/variants that are
--   community_variants   Community. The order webhook carries no product type
--                        or tags, so the ONLY reliable in-transaction test is
--                        "is this variant/product id registered here?".
--                        Rows are never deleted. A mistaken registration is
--                        DEACTIVATED (is_active = false) by the guarded operator
--                        command, never by hand-written SQL.
--
--   community_intake     one durable row per Community order line, written in
--                        the SAME transaction as the webhook_events dedupe row,
--                        BEFORE Shopify gets its 200. Self-contained: it keeps
--                        its own immutable copy of the order as received, so
--                        Phase 2 never needs Shopify (or webhook_events) to
--                        reconstruct what was ordered.
--                        Phase 1 states: received -> resolved | review |
--                        retryable_error (review -> received only by the
--                        guarded operator re-queue). No commitments, no meter.
--
--   community_audit      append-only log of every operator action on the
--                        registry or the intake queue.
--
-- Rollback (only before any real Community order is captured):
--   DROP TABLE community_audit, community_intake, community_variants, community_products;
--   DROP FUNCTION community_intake_guard(), community_audit_guard(),
--                 community_no_truncate(), community_registry_no_delete();
--   DELETE FROM schema_migrations WHERE filename = '016_community_intake.sql';
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
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,   -- false = deactivated by an operator
  deactivated_at       TIMESTAMPTZ,
  deactivated_by       TEXT,
  deactivation_reason  TEXT,
  registered_via       TEXT NOT NULL,                   -- snapshot | webhook | reconcile | product_sync
  first_registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,                     -- products/delete seen
  CONSTRAINT community_products_deactivation_chk
    CHECK (is_active OR (deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL
                         AND deactivation_reason IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Registry: variants. Variant id is canonical; SKU is informational only and
-- deliberately NOT unique (the archived demo product shares SKUs with the
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
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,   -- false = deactivated by an operator
  deactivated_at       TIMESTAMPTZ,
  deactivated_by       TEXT,
  deactivation_reason  TEXT,
  first_registered_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT community_variants_deactivation_chk
    CHECK (is_active OR (deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL
                         AND deactivation_reason IS NOT NULL))
);

CREATE INDEX idx_community_variants_product ON community_variants (shopify_product_id);

-- Registry rows are never deleted (deactivate instead - scripts/community-registry.js).
CREATE FUNCTION community_registry_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB_GUARD: % rows are never deleted - deactivate them instead', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_community_products_no_delete
  BEFORE DELETE ON community_products FOR EACH ROW EXECUTE FUNCTION community_registry_no_delete();
CREATE TRIGGER trg_community_variants_no_delete
  BEFORE DELETE ON community_variants FOR EACH ROW EXECUTE FUNCTION community_registry_no_delete();
CREATE INDEX idx_community_variants_sku     ON community_variants (sku);

-- ---------------------------------------------------------------------------
-- Durable intake
-- ---------------------------------------------------------------------------
CREATE TABLE community_intake (
  id                     BIGSERIAL PRIMARY KEY,

  -- ---- identity (immutable) --------------------------------------------
  shop                   TEXT NOT NULL,                 -- X-Shopify-Shop-Domain
  shopify_order_id       TEXT NOT NULL,
  shopify_line_item_id   TEXT NOT NULL,
  shopify_order_name     TEXT,                          -- '#1030'
  webhook_event_id       BIGINT NOT NULL
                         REFERENCES webhook_events (id) ON DELETE RESTRICT,
  topic                  TEXT NOT NULL,                 -- delivery that first captured it

  -- ---- the line as ordered (immutable) ---------------------------------
  shopify_product_id     TEXT,
  shopify_variant_id     TEXT,
  sku                    TEXT,
  vendor                 TEXT,
  title                  TEXT,                          -- product title at order time
  variant_title          TEXT,                          -- '5 kg' at order time
  quantity               INTEGER,                       -- NULL = not a whole number (-> review)
  unit_price             NUMERIC(12,2),
  currency               TEXT,
  customer_phone         TEXT,                          -- normalised 92XXXXXXXXXX, or NULL
  shopify_customer_id    TEXT,
  order_created_at       TIMESTAMPTZ,                   -- Shopify order created_at
  line_payload           JSONB NOT NULL,                -- this line exactly as received
  order_raw              TEXT NOT NULL,                 -- the request body, byte-for-byte (UTF-8 JSON)
  order_payload          JSONB NOT NULL,                -- the same order, parsed (for querying)
  order_payload_sha256   TEXT NOT NULL,                 -- SHA-256 of order_raw

  -- ---- why it was diverted away from grocery (immutable) ----------------
  classification         TEXT NOT NULL,                 -- registered | suspect
  signals                TEXT[] NOT NULL,               -- e.g. {registered_variant,sku_prefix}

  -- ---- Phase 1 worker state (mutable) -----------------------------------
  status                 TEXT NOT NULL DEFAULT 'received',
  review_reason          TEXT,
  resolved_variant_gid   TEXT,
  resolved_product_id    TEXT,
  attempts               INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  next_attempt_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  received_at            TIMESTAMPTZ NOT NULL DEFAULT now(),   -- immutable
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at            TIMESTAMPTZ,

  CONSTRAINT community_intake_line_key
    UNIQUE (shop, shopify_order_id, shopify_line_item_id),
  CONSTRAINT community_intake_status_chk
    CHECK (status IN ('received', 'resolved', 'review', 'retryable_error')),
  CONSTRAINT community_intake_class_chk
    CHECK (classification IN ('registered', 'suspect')),
  CONSTRAINT community_intake_resolved_chk
    CHECK (status <> 'resolved' OR (resolved_variant_gid IS NOT NULL AND resolved_at IS NOT NULL)),
  CONSTRAINT community_intake_unresolved_chk
    CHECK (status = 'resolved' OR (resolved_variant_gid IS NULL AND resolved_product_id IS NULL
                                   AND resolved_at IS NULL)),
  CONSTRAINT community_intake_review_chk
    CHECK (status <> 'review' OR review_reason IS NOT NULL),
  CONSTRAINT community_intake_attempts_chk
    CHECK (attempts >= 0)
);

-- Captured facts never change, rows are never deleted, and the only
-- transitions are the Phase 1 ones. Enforced here, not just in the code.
CREATE FUNCTION community_intake_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASB_GUARD: community_intake rows are never deleted (id %)', OLD.id;
  END IF;

  IF (NEW.id, NEW.shop, NEW.shopify_order_id, NEW.shopify_line_item_id, NEW.shopify_order_name,
      NEW.webhook_event_id, NEW.topic, NEW.shopify_product_id, NEW.shopify_variant_id,
      NEW.sku, NEW.vendor, NEW.title, NEW.variant_title, NEW.quantity, NEW.unit_price,
      NEW.currency, NEW.customer_phone, NEW.shopify_customer_id, NEW.order_created_at,
      NEW.line_payload, NEW.order_raw, NEW.order_payload, NEW.order_payload_sha256,
      NEW.classification, NEW.signals, NEW.received_at)
     IS DISTINCT FROM
     (OLD.id, OLD.shop, OLD.shopify_order_id, OLD.shopify_line_item_id, OLD.shopify_order_name,
      OLD.webhook_event_id, OLD.topic, OLD.shopify_product_id, OLD.shopify_variant_id,
      OLD.sku, OLD.vendor, OLD.title, OLD.variant_title, OLD.quantity, OLD.unit_price,
      OLD.currency, OLD.customer_phone, OLD.shopify_customer_id, OLD.order_created_at,
      OLD.line_payload, OLD.order_raw, OLD.order_payload, OLD.order_payload_sha256,
      OLD.classification, OLD.signals, OLD.received_at) THEN
    RAISE EXCEPTION 'ASB_GUARD: captured order facts on community_intake % are immutable', OLD.id;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'received'        AND NEW.status IN ('resolved', 'review', 'retryable_error'))
    OR (OLD.status = 'retryable_error' AND NEW.status IN ('resolved', 'review', 'retryable_error'))
    OR (OLD.status = 'review'          AND NEW.status = 'received')   -- operator re-queue only
  ) THEN
    RAISE EXCEPTION 'ASB_GUARD: community_intake % cannot move % -> %', OLD.id, OLD.status, NEW.status;
  END IF;

  -- A resolution, once made, is final in Phase 1.
  IF OLD.status = 'resolved' AND (NEW.resolved_variant_gid, NEW.resolved_product_id, NEW.resolved_at)
       IS DISTINCT FROM (OLD.resolved_variant_gid, OLD.resolved_product_id, OLD.resolved_at) THEN
    RAISE EXCEPTION 'ASB_GUARD: resolution of community_intake % is final', OLD.id;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_community_intake_guard
  BEFORE UPDATE OR DELETE ON community_intake
  FOR EACH ROW EXECUTE FUNCTION community_intake_guard();

-- Row triggers do not fire on TRUNCATE (including TRUNCATE ... CASCADE from
-- webhook_events), so every Community table also refuses TRUNCATE outright.
CREATE FUNCTION community_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB_GUARD: % cannot be truncated', TG_TABLE_NAME;
END $$;

CREATE TRIGGER trg_community_intake_no_truncate
  BEFORE TRUNCATE ON community_intake
  FOR EACH STATEMENT EXECUTE FUNCTION community_no_truncate();

-- The worker's queue: only unfinished rows are indexed.
CREATE INDEX idx_community_intake_pending ON community_intake (next_attempt_at)
  WHERE status IN ('received', 'retryable_error');
CREATE INDEX idx_community_intake_attention ON community_intake (status, received_at)
  WHERE status <> 'resolved';
CREATE INDEX idx_community_intake_order   ON community_intake (shopify_order_id);
CREATE INDEX idx_community_intake_variant ON community_intake (shopify_variant_id);
CREATE INDEX idx_community_intake_event   ON community_intake (webhook_event_id);

COMMENT ON TABLE community_intake IS
  'One row per Community Shopify order line, captured before the webhook is acknowledged, '
  'with an immutable copy of the order as received. Phase 1: received -> resolved | review | '
  'retryable_error. Never joined into orders/order_items/cycle_prices.';

-- ---------------------------------------------------------------------------
-- Operator audit log (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE community_audit (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor        TEXT NOT NULL,                           -- who ran the command, or 'system'
  action       TEXT NOT NULL,                           -- deactivate_product | reactivate_product |
                                                        -- deactivate_variant | reactivate_variant |
                                                        -- auto_reactivate_product | requeue_intake
  target_type  TEXT NOT NULL CHECK (target_type IN ('product', 'variant', 'intake')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  before       JSONB,
  after        JSONB
);

CREATE INDEX idx_community_audit_target ON community_audit (target_type, target_id, at);

CREATE FUNCTION community_audit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB_GUARD: community_audit is append-only';
END $$;

CREATE TRIGGER trg_community_audit_guard
  BEFORE UPDATE OR DELETE ON community_audit
  FOR EACH ROW EXECUTE FUNCTION community_audit_guard();

CREATE TRIGGER trg_community_audit_no_truncate
  BEFORE TRUNCATE ON community_audit FOR EACH STATEMENT EXECUTE FUNCTION community_no_truncate();
CREATE TRIGGER trg_community_products_no_truncate
  BEFORE TRUNCATE ON community_products FOR EACH STATEMENT EXECUTE FUNCTION community_no_truncate();
CREATE TRIGGER trg_community_variants_no_truncate
  BEFORE TRUNCATE ON community_variants FOR EACH STATEMENT EXECUTE FUNCTION community_no_truncate();

COMMIT;
