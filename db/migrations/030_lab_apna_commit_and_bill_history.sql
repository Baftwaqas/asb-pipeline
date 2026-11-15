-- 030: durable Shopify LAB order-edit COMMIT INTENT + immutable bill draft.
-- NOT executable in normal migrations. Only scratch PostgreSQL 18 tests apply.
-- This schema carries no production customer authority and DOES NOT enable
-- an orderEditCommit route, Shopify order mutation or WhatsApp delivery.
BEGIN;
CREATE TABLE checkout_lab_apna_real_commit_attempts (
  attempt_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  authorization_id UUID NOT NULL UNIQUE
    REFERENCES checkout_lab_apna_signed_amendments(authorization_id) ON DELETE RESTRICT,
  original_claim_id UUID NOT NULL UNIQUE
    REFERENCES checkout_redemptions(claim_id) ON DELETE RESTRICT,
  shop_domain TEXT NOT NULL CHECK(shop_domain='asb-checkout-lab.myshopify.com'),
  household_key TEXT NOT NULL CHECK(length(btrim(household_key))>0),
  cycle_code TEXT NOT NULL CHECK(cycle_code='MON-2026-11-16'),
  shopify_order_gid TEXT NOT NULL UNIQUE
    CHECK(shopify_order_gid='gid://shopify/Order/19011998580770'),
  calculated_order_gid TEXT NOT NULL
    CHECK(calculated_order_gid ~ '^gid://shopify/CalculatedOrder/[1-9][0-9]*$'),
  signed_packet_sha256 TEXT NOT NULL CHECK(signed_packet_sha256 ~ '^[a-f0-9]{64}$'),
  source_quote_sha256 TEXT NOT NULL CHECK(source_quote_sha256 ~ '^[a-f0-9]{64}$'),
  original_paisa INTEGER NOT NULL CHECK(original_paisa=4500),
  addition_paisa INTEGER NOT NULL CHECK(addition_paisa=9000),
  expected_paisa INTEGER NOT NULL CHECK(expected_paisa=13500),
  state TEXT NOT NULL DEFAULT 'intent_recorded'
    CHECK(state IN ('intent_recorded','needs_reconcile','verified')),
  evidence_json JSONB,
  postcommit_order_sha256 TEXT CHECK(postcommit_order_sha256 ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  verified_at TIMESTAMPTZ,
  CONSTRAINT lab_commit_state_proof CHECK (
    (state='intent_recorded' AND evidence_json IS NULL AND
       postcommit_order_sha256 IS NULL AND verified_at IS NULL)
    OR (state='needs_reconcile' AND verified_at IS NULL AND
       postcommit_order_sha256 IS NULL)
    OR (state='verified' AND evidence_json IS NOT NULL AND
       postcommit_order_sha256 IS NOT NULL AND verified_at IS NOT NULL)
  )
);
COMMENT ON TABLE checkout_lab_apna_real_commit_attempts IS
  'One durable irrevocable Shopify commit-dispatch barrier for synthetic lab order #1002. NOT operational checkout or authorization.';
CREATE FUNCTION checkout_lab_guard_commit_attempt() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'LAB_COMMIT_ATTEMPT_DELETE_FORBIDDEN'; END IF;
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
    OR NEW.authorization_id IS DISTINCT FROM OLD.authorization_id
    OR NEW.original_claim_id IS DISTINCT FROM OLD.original_claim_id
    OR NEW.shop_domain IS DISTINCT FROM OLD.shop_domain
    OR NEW.household_key IS DISTINCT FROM OLD.household_key
    OR NEW.cycle_code IS DISTINCT FROM OLD.cycle_code
    OR NEW.shopify_order_gid IS DISTINCT FROM OLD.shopify_order_gid
    OR NEW.calculated_order_gid IS DISTINCT FROM OLD.calculated_order_gid
    OR NEW.signed_packet_sha256 IS DISTINCT FROM OLD.signed_packet_sha256
    OR NEW.source_quote_sha256 IS DISTINCT FROM OLD.source_quote_sha256
    OR NEW.original_paisa IS DISTINCT FROM OLD.original_paisa
    OR NEW.addition_paisa IS DISTINCT FROM OLD.addition_paisa
    OR NEW.expected_paisa IS DISTINCT FROM OLD.expected_paisa
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.state='verified'
    OR NOT ((OLD.state='intent_recorded' AND NEW.state IN ('needs_reconcile','verified'))
       OR (OLD.state='needs_reconcile' AND NEW.state='verified')) THEN
    RAISE EXCEPTION 'LAB_COMMIT_ATTEMPT_IMMUTABLE_OR_BAD_TRANSITION';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_lab_commit_guard
  BEFORE UPDATE OR DELETE ON checkout_lab_apna_real_commit_attempts
  FOR EACH ROW EXECUTE FUNCTION checkout_lab_guard_commit_attempt();

CREATE TABLE checkout_lab_apna_commit_audit (
  event_id BIGSERIAL PRIMARY KEY,
  attempt_id UUID NOT NULL
    REFERENCES checkout_lab_apna_real_commit_attempts(attempt_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN (
    'INTENT_DURABLE_NO_RETRY',
    'COMMIT_OUTCOME_UNCERTAIN',
    'SHOPIFY_READBACK_VERIFIED',
    'BILL_VERSION_2_DRAFTED'
  )),
  evidence_json JSONB NOT NULL CHECK(jsonb_typeof(evidence_json)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE checkout_lab_apna_bill_history (
  bill_record_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL
    REFERENCES checkout_lab_apna_real_commit_attempts(attempt_id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version IN (1,2)),
  supersedes_version INTEGER,
  currency TEXT NOT NULL DEFAULT 'PKR' CHECK(currency='PKR'),
  total_paisa INTEGER NOT NULL CHECK(total_paisa>=0),
  state TEXT NOT NULL CHECK(state IN ('source_checkout_not_sent','reconciled_draft_not_sent')),
  snapshot_sha256 TEXT NOT NULL CHECK(snapshot_sha256 ~ '^[a-f0-9]{64}$'),
  snapshot_json JSONB NOT NULL CHECK(jsonb_typeof(snapshot_json)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT lab_bill_one_version UNIQUE(attempt_id,version),
  CONSTRAINT lab_bill_version_state CHECK(
    (version=1 AND supersedes_version IS NULL AND total_paisa=4500
     AND state='source_checkout_not_sent')
    OR (version=2 AND supersedes_version=1 AND total_paisa=13500
     AND state='reconciled_draft_not_sent')
  )
);
COMMENT ON TABLE checkout_lab_apna_bill_history IS
 'Append-only, not-sent LAB bill history. Does NOT replace or send WhatsApp/Shopify invoices.';
CREATE FUNCTION checkout_lab_append_only() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'LAB_APPEND_ONLY_AUDIT_OR_BILL'; END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER checkout_lab_commit_audit_guard
  BEFORE UPDATE OR DELETE ON checkout_lab_apna_commit_audit
  FOR EACH ROW EXECUTE FUNCTION checkout_lab_append_only();
CREATE TRIGGER checkout_lab_bill_history_guard
  BEFORE UPDATE OR DELETE ON checkout_lab_apna_bill_history
  FOR EACH ROW EXECUTE FUNCTION checkout_lab_append_only();
COMMIT;
