-- 029: isolated Shopify Lab SIGNED synthetic amendment authorization.
-- NOT an order-edit commit, bill, payment, confirmation or real customer consent.
-- Held in db/migrations/HOLD. Only scratch-PG tests apply this migration.
BEGIN;
CREATE TABLE checkout_lab_apna_signed_amendments (
  authorization_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_claim_id UUID NOT NULL UNIQUE
    REFERENCES checkout_redemptions(claim_id) ON DELETE RESTRICT,
  original_quote_id TEXT NOT NULL REFERENCES checkout_quotes(quote_id) ON DELETE RESTRICT,
  shop_domain TEXT NOT NULL
    CHECK(shop_domain='asb-checkout-lab.myshopify.com'),
  household_key TEXT NOT NULL CHECK(length(btrim(household_key))>0),
  cycle_code TEXT NOT NULL CHECK(cycle_code='MON-2026-11-16'),
  shopify_order_gid TEXT NOT NULL UNIQUE
    CHECK(shopify_order_gid='gid://shopify/Order/19011998580770'),
  signed_amendment JSONB NOT NULL CHECK(jsonb_typeof(signed_amendment)='object'),
  payload_sha256 TEXT NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  original_total_paisa INTEGER NOT NULL DEFAULT 4500 CHECK(original_total_paisa=4500),
  additional_paisa INTEGER NOT NULL DEFAULT 9000 CHECK(additional_paisa=9000),
  proposed_total_paisa INTEGER NOT NULL DEFAULT 13500 CHECK(proposed_total_paisa=13500),
  state TEXT NOT NULL DEFAULT 'synthetic_authorized_uncommitted'
    CHECK(state='synthetic_authorized_uncommitted'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lab_signed_amendment_unique_digest UNIQUE(payload_sha256)
);
COMMENT ON TABLE checkout_lab_apna_signed_amendments IS
 'Synthetic operator-only signed quote for lab order #1002. NOT customer consent, Shopify edit, real bill or authority to call orderEditCommit.';

CREATE FUNCTION checkout_lab_apna_signed_amendment_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'LAB_SIGNED_AMENDMENT_APPEND_ONLY'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_lab_apna_signed_amendment_guard
  BEFORE UPDATE OR DELETE ON checkout_lab_apna_signed_amendments
  FOR EACH ROW EXECUTE FUNCTION checkout_lab_apna_signed_amendment_immutable();
COMMIT;
