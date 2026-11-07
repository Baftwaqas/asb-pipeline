-- 025: separate human review and audited activation for founder-signed Apna policy.
-- Dev-only; never activates an existing release by applying this migration.
BEGIN;

CREATE TABLE checkout_apna_activation_reviews (
  release_id TEXT PRIMARY KEY REFERENCES checkout_apna_policy_releases(release_id) ON DELETE RESTRICT,
  shop_domain TEXT NOT NULL CHECK (shop_domain = 'asb-checkout-lab.myshopify.com'),
  reviewer_staff_id TEXT NOT NULL CHECK (reviewer_staff_id ~ '^[1-9][0-9]*$'),
  source_approver_id TEXT NOT NULL CHECK (source_approver_id ~ '^[1-9][0-9]*$'),
  effective_delivery_date DATE NOT NULL,
  bindings_sha256 TEXT NOT NULL CHECK (bindings_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_json JSONB NOT NULL CHECK (jsonb_typeof(evidence_json) = 'object'),
  state TEXT NOT NULL DEFAULT 'approved' CHECK (state IN ('approved','consumed','withdrawn')),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  consumed_at TIMESTAMPTZ,
  CONSTRAINT apna_distinct_reviewer_from_signer CHECK (reviewer_staff_id <> source_approver_id),
  CONSTRAINT apna_review_consumed_time CHECK (state <> 'consumed' OR consumed_at IS NOT NULL)
);
COMMENT ON TABLE checkout_apna_activation_reviews IS
  'Separate independently authenticated staff review; a founder signature alone can never activate a policy.';

-- Existing audit table already supports STAGED, REVIEWED, ACTIVATED, REVOKED.
-- Make the audit trail append-only at the application database role level.
CREATE FUNCTION checkout_apna_block_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'APNA_AUDIT_APPEND_ONLY';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER checkout_apna_audit_append_only
BEFORE UPDATE OR DELETE ON checkout_apna_release_audit
FOR EACH ROW EXECUTE FUNCTION checkout_apna_block_audit_mutation();

-- Human review records cannot be deleted to erase evidence. Status changes
-- are restricted by the activation service; database ownership remains privileged.
CREATE FUNCTION checkout_apna_block_review_delete() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'APNA_REVIEW_DELETE_FORBIDDEN';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER checkout_apna_review_no_delete
BEFORE DELETE ON checkout_apna_activation_reviews
FOR EACH ROW EXECUTE FUNCTION checkout_apna_block_review_delete();

-- No reviewer identity, signed catalogue digest, evidence or effective day
-- can be changed after review. Only approved -> consumed is permitted during
-- a committed activation transaction; no silent review replacement.
CREATE FUNCTION checkout_apna_guard_review_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.state <> 'approved' OR NEW.state <> 'consumed'
     OR NEW.consumed_at IS NULL
     OR NEW.release_id IS DISTINCT FROM OLD.release_id
     OR NEW.shop_domain IS DISTINCT FROM OLD.shop_domain
     OR NEW.reviewer_staff_id IS DISTINCT FROM OLD.reviewer_staff_id
     OR NEW.source_approver_id IS DISTINCT FROM OLD.source_approver_id
     OR NEW.effective_delivery_date IS DISTINCT FROM OLD.effective_delivery_date
     OR NEW.bindings_sha256 IS DISTINCT FROM OLD.bindings_sha256
     OR NEW.evidence_json IS DISTINCT FROM OLD.evidence_json
     OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    RAISE EXCEPTION 'APNA_REVIEW_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER checkout_apna_review_guard_update
BEFORE UPDATE ON checkout_apna_activation_reviews
FOR EACH ROW EXECUTE FUNCTION checkout_apna_guard_review_update();

COMMIT;
