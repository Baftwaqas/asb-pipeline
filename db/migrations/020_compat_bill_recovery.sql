-- ============================================================================
-- 020_compat_bill_recovery.sql
--
-- Narrow guard extension for emergency L3 rollback recovery.
--
-- A rollback-compat-017 source normally remains legacy forever. The only new
-- edge added here is:
--
--   compat_inline + linked order + legacy/legacy
--       -> applied/pending
--
-- and ONLY when the same source already has an append-only bill_compose audit
-- row whose detail.mode = 'compat_bill_recovery'. The pending bill must also
-- have a frozen snapshot at COMMIT (the existing deferred 017 constraint).
--
-- This does not make compat rows automatically replayable and does not weaken
-- event_failed/event_unfinished legacy reopening.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION asb017_sources_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st_ok boolean;
  bill_ok boolean;
  compat_bill_recovery boolean;
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.shop IS DISTINCT FROM OLD.shop
     OR NEW.shopify_order_id IS DISTINCT FROM OLD.shopify_order_id
     OR NEW.shopify_order_name IS DISTINCT FROM OLD.shopify_order_name
     OR NEW.shopify_created_at IS DISTINCT FROM OLD.shopify_created_at
     OR NEW.first_webhook_event_id IS DISTINCT FROM OLD.first_webhook_event_id
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.payload_raw IS DISTINCT FROM OLD.payload_raw
     OR NEW.commerce_fingerprint IS DISTINCT FROM OLD.commerce_fingerprint
     OR NEW.commerce_fingerprint_version IS DISTINCT FROM OLD.commerce_fingerprint_version
     OR NEW.commerce_canonical IS DISTINCT FROM OLD.commerce_canonical
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shopify_order_sources %: identity columns are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  -- set once, never changed or cleared
  IF (OLD.legacy_reason IS NOT NULL AND NEW.legacy_reason IS DISTINCT FROM OLD.legacy_reason)
     OR (OLD.legacy_bill_evidence IS NOT NULL AND NEW.legacy_bill_evidence IS DISTINCT FROM OLD.legacy_bill_evidence)
     OR (OLD.order_id IS NOT NULL AND NEW.order_id IS DISTINCT FROM OLD.order_id)
     OR (OLD.customer_id IS NOT NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id)
     OR (OLD.cycle_id IS NOT NULL AND NEW.cycle_id IS DISTINCT FROM OLD.cycle_id)
     OR (OLD.disposition IS NOT NULL AND NEW.disposition IS DISTINCT FROM OLD.disposition)
     OR (OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at) THEN
    RAISE EXCEPTION 'shopify_order_sources %: a set-once column was changed', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.attempts < OLD.attempts OR NEW.bill_attempts < OLD.bill_attempts
     OR NEW.attempt_budget_base < OLD.attempt_budget_base
     OR NEW.bill_attempt_budget_base < OLD.bill_attempt_budget_base THEN
    RAISE EXCEPTION 'shopify_order_sources %: attempt counters never go down', OLD.id USING ERRCODE = 'check_violation';
  END IF;

  compat_bill_recovery :=
       OLD.origin = 'compat'
   AND OLD.status = 'legacy'
   AND OLD.legacy_reason = 'compat_inline'
   AND OLD.bill_state = 'legacy'
   AND OLD.legacy_bill_evidence IS DISTINCT FROM true
   AND OLD.order_id IS NOT NULL
   AND OLD.customer_id IS NOT NULL
   AND OLD.cycle_id IS NOT NULL
   AND OLD.disposition IN ('created','merged')
   AND NEW.status = 'applied'
   AND NEW.bill_state = 'pending'
   AND NEW.order_id = OLD.order_id
   AND NEW.customer_id = OLD.customer_id
   AND NEW.cycle_id = OLD.cycle_id
   AND NEW.disposition = OLD.disposition
   AND NEW.applied_at IS NOT NULL
   AND NEW.bill_authorization_audit_id IS NOT NULL
   AND EXISTS (
       SELECT 1
         FROM shopify_order_source_audit a
        WHERE a.id = NEW.bill_authorization_audit_id
          AND a.source_id = OLD.id
          AND a.action = 'bill_compose'
          AND a.detail->>'mode' = 'compat_bill_recovery'
   );

  -- status edges
  st_ok := NEW.status = OLD.status OR (OLD.status, NEW.status) IN (
      ('received','processing'), ('retryable_error','processing'),
      ('processing','applied'), ('processing','community_only'), ('processing','review'),
      ('processing','retryable_error'), ('processing','legacy'),
      ('received','legacy'),
      ('review','received'), ('review','dismissed'),
      ('legacy','received'))
      OR compat_bill_recovery;
  IF NOT st_ok THEN
    RAISE EXCEPTION 'shopify_order_sources %: status % -> % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'legacy' AND NEW.status = 'received'
     AND OLD.legacy_reason NOT IN ('event_failed','event_unfinished') THEN
    RAISE EXCEPTION 'shopify_order_sources %: only event_failed / event_unfinished legacy rows can be reopened', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- bill edges
  bill_ok := NEW.bill_state = OLD.bill_state OR (OLD.bill_state, NEW.bill_state) IN (
      ('not_ready','pending'), ('not_ready','failed'), ('not_ready','not_required'), ('not_ready','legacy'),
      ('legacy','not_ready'), ('legacy','not_required'),
      ('pending','sending'), ('pending','sent'), ('pending','not_required'), ('pending','failed'),
      ('sending','sent'), ('sending','pending'), ('sending','failed'), ('sending','unknown'),
      ('sent','pending'), ('sent','failed'),
      ('unknown','sent'), ('unknown','pending'), ('unknown','abandoned'),
      ('failed','sent'), ('failed','pending'), ('failed','abandoned'))
      OR compat_bill_recovery;
  IF NOT bill_ok THEN
    RAISE EXCEPTION 'shopify_order_sources %: bill_state % -> % is not allowed', OLD.id, OLD.bill_state, NEW.bill_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.bill_state = 'sent' AND NEW.bill_state IN ('pending','failed') AND NEW.bill_outcome IS DISTINCT FROM 'window_closed' THEN
    RAISE EXCEPTION 'shopify_order_sources %: sent -> % only for a 131047 window_closed receipt', OLD.id, NEW.bill_state
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.bill_state IN ('failed','unknown') AND NEW.bill_state = 'pending' AND NEW.bill_authorization_audit_id IS NULL THEN
    RAISE EXCEPTION 'shopify_order_sources %: % -> pending needs an operator authorization', OLD.id, OLD.bill_state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.bill_current_attempt_id IS DISTINCT FROM OLD.bill_current_attempt_id
     AND NOT (OLD.bill_state = 'pending' AND NEW.bill_state = 'sending' AND NEW.bill_current_attempt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'shopify_order_sources %: bill_current_attempt_id changes only on a new claim', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.bill_authorization_audit_id IS DISTINCT FROM OLD.bill_authorization_audit_id THEN
    IF OLD.bill_authorization_audit_id IS NULL THEN
      IF NOT ((OLD.bill_state IN ('failed','unknown') AND NEW.bill_state = 'pending')
              OR compat_bill_recovery) THEN
        RAISE EXCEPTION 'shopify_order_sources %: a resend authorization is set only by failed/unknown -> pending or audited compat recovery', OLD.id
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.bill_authorization_audit_id IS NOT NULL
          OR NOT (OLD.bill_state = 'pending' AND NEW.bill_state <> 'pending') THEN
      RAISE EXCEPTION 'shopify_order_sources %: a resend authorization is consumed only when the bill leaves pending', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

COMMIT;
