-- 026: DEV-ONLY Apna Order amendment reservation preflight.
-- No existing checkout table changed and no Shopify order/bill mutated.
-- Held until reviewed; disposable PG tests apply explicitly.
BEGIN;
CREATE TABLE checkout_apna_amendment_reservations (
  reservation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_domain TEXT NOT NULL CHECK (shop_domain = 'asb-checkout-lab.myshopify.com'),
  household_key TEXT NOT NULL CHECK (length(btrim(household_key)) > 0),
  cycle_code TEXT NOT NULL,
  original_claim_id UUID NOT NULL REFERENCES checkout_redemptions(claim_id) ON DELETE RESTRICT,
  original_quote_id TEXT NOT NULL REFERENCES checkout_quotes(quote_id) ON DELETE RESTRICT,
  shopify_order_gid TEXT NOT NULL CHECK (shopify_order_gid ~ '^gid://shopify/Order/[1-9][0-9]*$'),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^asb-amendment-[a-f0-9]{40}$'),
  snapshot_sha256 TEXT NOT NULL CHECK (snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  proposed_snapshot JSONB NOT NULL CHECK (jsonb_typeof(proposed_snapshot) = 'object'),
  additional_paisa BIGINT NOT NULL CHECK (additional_paisa >= 0),
  state TEXT NOT NULL DEFAULT 'reserved_preflight'
    CHECK (state = 'reserved_preflight'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT apna_amendment_unique_original_order UNIQUE (original_claim_id),
  CONSTRAINT apna_amendment_unique_key UNIQUE (shop_domain,idempotency_key)
);
COMMENT ON TABLE checkout_apna_amendment_reservations IS
  'Lab-only immutable proposal holds; NOT a Shopify order edit, policy activation or bill revision. Remains reserved until a separately reviewed reconciliation workflow exists.';

CREATE OR REPLACE FUNCTION checkout_apna_amendment_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'APNA_AMENDMENT_RESERVATION_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_apna_amendment_immutable_guard
  BEFORE UPDATE OR DELETE ON checkout_apna_amendment_reservations
  FOR EACH ROW EXECUTE FUNCTION checkout_apna_amendment_immutable();
COMMIT;
