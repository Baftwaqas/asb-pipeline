-- 027: ASB LAB ONLY, simulated order-edit billing evidence.
-- Never proves an actual Shopify order change, customer notification or payment.
-- Held in db/migrations/HOLD. Only scratch test DB applies this migration.
BEGIN;
CREATE TABLE checkout_apna_amendment_bill_simulations (
  simulation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL UNIQUE
    REFERENCES checkout_apna_amendment_reservations(reservation_id) ON DELETE RESTRICT,
  shop_domain TEXT NOT NULL CHECK (shop_domain = 'asb-checkout-lab.myshopify.com'),
  shopify_order_gid TEXT NOT NULL CHECK
    (shopify_order_gid ~ '^gid://shopify/Order/[1-9][0-9]*$'),
  original_bill_version INTEGER NOT NULL CHECK (original_bill_version >= 1),
  draft_bill_version INTEGER NOT NULL CHECK (draft_bill_version = original_bill_version + 1),
  original_bill_sha256 TEXT NOT NULL CHECK (original_bill_sha256 ~ '^[a-f0-9]{64}$'),
  draft_bill_sha256 TEXT NOT NULL CHECK (draft_bill_sha256 ~ '^[a-f0-9]{64}$'),
  expected_total_paisa BIGINT NOT NULL CHECK (expected_total_paisa >= 0),
  additional_paisa BIGINT NOT NULL CHECK (additional_paisa >= 0),
  draft_json JSONB NOT NULL CHECK (jsonb_typeof(draft_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'simulation_only'
    CHECK (state = 'simulation_only'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT apna_bill_simulation_per_order_version UNIQUE
    (shop_domain,shopify_order_gid,draft_bill_version)
);
COMMENT ON TABLE checkout_apna_amendment_bill_simulations IS
  'Immutable SIMULATION evidence only. No real Shopify commit, billing, payment, notification or policy activation.';

CREATE FUNCTION checkout_apna_bill_simulation_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'APNA_BILL_SIMULATION_IMMUTABLE';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_apna_bill_simulation_immutable_guard
  BEFORE UPDATE OR DELETE ON checkout_apna_amendment_bill_simulations
  FOR EACH ROW EXECUTE FUNCTION checkout_apna_bill_simulation_immutable();
COMMIT;
