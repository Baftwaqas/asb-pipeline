-- 028: ASB amendment Shopify COMMIT-INTENT / recovery SIMULATION ONLY.
-- HOLD: applying to any connected Shopify/Neon/Render database is forbidden
-- until independent security/payment review and real order-edit reconciliation.
-- Only disposable PostgreSQL tests may apply this schema manually.
BEGIN;
CREATE TABLE checkout_apna_edit_commit_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id UUID NOT NULL UNIQUE
    REFERENCES checkout_apna_amendment_reservations(reservation_id) ON DELETE RESTRICT,
  shop_domain TEXT NOT NULL CHECK (shop_domain = 'asb-checkout-lab.myshopify.com'),
  household_key TEXT NOT NULL CHECK (length(btrim(household_key))>0),
  shopify_order_gid TEXT NOT NULL
    CHECK (shopify_order_gid ~ '^gid://shopify/Order/[1-9][0-9]*$'),
  calculated_order_gid TEXT NOT NULL
    CHECK (calculated_order_gid ~ '^gid://shopify/CalculatedOrder/[1-9][0-9]*$'),
  intent_key TEXT NOT NULL UNIQUE CHECK (intent_key ~ '^asb-edit-[a-f0-9]{40}$'),
  proof_sha256 TEXT NOT NULL CHECK (proof_sha256 ~ '^[a-f0-9]{64}$'),
  expected_additions JSONB NOT NULL CHECK (jsonb_typeof(expected_additions) = 'array'),
  source_bill_sha256 TEXT NOT NULL CHECK (source_bill_sha256 ~ '^[a-f0-9]{64}$'),
  expected_total_paisa BIGINT NOT NULL CHECK (expected_total_paisa >= 0),
  state TEXT NOT NULL DEFAULT 'intent_recorded'
    CHECK (state IN ('intent_recorded','needs_reconcile','verified_simulation')),
  evidence_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reconciled_at TIMESTAMPTZ,
  CONSTRAINT apna_edit_evidence_consistency CHECK (
    (state='intent_recorded' AND evidence_json IS NULL AND reconciled_at IS NULL)
    OR (state='needs_reconcile' AND reconciled_at IS NULL)
    OR (state='verified_simulation' AND evidence_json IS NOT NULL AND reconciled_at IS NOT NULL)
  )
);
COMMENT ON TABLE checkout_apna_edit_commit_attempts IS
  'Durable mock-commit intent; never authorizes actual Shopify orderEditCommit. One ever per reservation, including uncertain outcomes.';

CREATE FUNCTION checkout_apna_guard_edit_attempt() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'APNA_EDIT_ATTEMPT_DELETE_FORBIDDEN'; END IF;
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.reservation_id IS DISTINCT FROM OLD.reservation_id
    OR NEW.shop_domain IS DISTINCT FROM OLD.shop_domain
    OR NEW.household_key IS DISTINCT FROM OLD.household_key
    OR NEW.shopify_order_gid IS DISTINCT FROM OLD.shopify_order_gid
    OR NEW.calculated_order_gid IS DISTINCT FROM OLD.calculated_order_gid
    OR NEW.intent_key IS DISTINCT FROM OLD.intent_key
    OR NEW.proof_sha256 IS DISTINCT FROM OLD.proof_sha256
    OR NEW.expected_additions IS DISTINCT FROM OLD.expected_additions
    OR NEW.source_bill_sha256 IS DISTINCT FROM OLD.source_bill_sha256
    OR NEW.expected_total_paisa IS DISTINCT FROM OLD.expected_total_paisa
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state = 'verified_simulation'
    OR NOT (
      (OLD.state='intent_recorded' AND NEW.state IN ('needs_reconcile','verified_simulation'))
      OR (OLD.state='needs_reconcile' AND NEW.state='verified_simulation')
    ) THEN
      RAISE EXCEPTION 'APNA_EDIT_ATTEMPT_IMMUTABLE_OR_INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_apna_edit_attempt_guard
  BEFORE UPDATE OR DELETE ON checkout_apna_edit_commit_attempts
  FOR EACH ROW EXECUTE FUNCTION checkout_apna_guard_edit_attempt();

CREATE TABLE checkout_apna_edit_attempt_audit (
  event_id BIGSERIAL PRIMARY KEY,
  attempt_id UUID NOT NULL REFERENCES checkout_apna_edit_commit_attempts(attempt_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('MOCK_INTENT_RECORDED','MOCK_RESULT_UNCERTAIN','MOCK_READ_VERIFIED')),
  evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION checkout_apna_edit_audit_immutable() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'APNA_EDIT_AUDIT_APPEND_ONLY'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_apna_edit_audit_guard
  BEFORE UPDATE OR DELETE ON checkout_apna_edit_attempt_audit
  FOR EACH ROW EXECUTE FUNCTION checkout_apna_edit_audit_immutable();
COMMIT;
