-- ============================================================================
-- 017_shopify_order_sources.sql  —  grocery reliability (orders/create only)
--
-- ADDITIVE. Creates new tables, one function and triggers ON THE NEW TABLES
-- ONLY. No existing table, column, row, index or trigger is changed.
--
--   shopify_order_sources          one row per Shopify order: the idempotency
--                                  key, the link to the ASB bag (many Shopify
--                                  orders -> one ASB order) and the durable job
--   shopify_order_source_duplicates later deliveries of a known Shopify order
--   shopify_order_source_lines     what each Shopify line contributed (create)
--   shopify_order_bill_snapshots   the customer bill, frozen at apply time
--   shopify_order_bill_attempts    one row per send attempt STARTED
--   shopify_order_source_audit     backfill + operator actions (append-only)
--   grocery_alerts                 alert outbox (sent after commit)
--   whatsapp_receipt_backlog       journal of every WhatsApp status receipt
--
-- Scope: orders/create ONLY. orders/updated and orders/edited stay ignored by
-- the topic allowlist; supporting them needs a separate revision migration.
--
-- Old code (3296c0f) ignores every table here, so applying 017 changes
-- nothing until 017-aware code is deployed AND the backfill marker and the
-- activation records exist AND the GROCERY_* switches are on.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Sources (FKs to the audit / attempt tables are added in section 9)
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_sources (
  id                       BIGSERIAL PRIMARY KEY,
  origin                   TEXT NOT NULL CHECK (origin IN ('live','backfill','compat')),
  shop                     TEXT NOT NULL,
  shopify_order_id         TEXT NOT NULL CHECK (shopify_order_id ~ '^[0-9]+$'),
  shopify_order_name       TEXT,
  shopify_created_at       TIMESTAMPTZ,
  first_webhook_event_id   BIGINT REFERENCES webhook_events(id) ON DELETE RESTRICT,
  payload_sha256           TEXT,
  payload_raw              TEXT,                 -- exact bytes of the first delivery
  commerce_fingerprint         TEXT,
  commerce_fingerprint_version SMALLINT,
  commerce_canonical           JSONB,

  status        TEXT NOT NULL CHECK (status IN ('received','processing','retryable_error','applied',
                                               'community_only','review','dismissed','legacy')),
  review_reason TEXT CHECK (review_reason IN ('no_phone','max_attempts','community_leak_repeat','already_persisted',
                                              'operator_hold')),
  disposition   TEXT CHECK (disposition IN ('created','merged','manual_link')),
  order_id      BIGINT REFERENCES orders(id)    ON DELETE RESTRICT,
  customer_id   BIGINT REFERENCES customers(id) ON DELETE RESTRICT,
  cycle_id      BIGINT REFERENCES cycles(id)    ON DELETE RESTRICT,
  attempts            SMALLINT NOT NULL DEFAULT 0,       -- processing attempts STARTED
  attempt_budget_base SMALLINT NOT NULL DEFAULT 0,       -- attempts at the last operator requeue
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token         UUID,
  lease_until         TIMESTAMPTZ,
  last_started_at     TIMESTAMPTZ,
  last_error          TEXT,
  applied_at          TIMESTAMPTZ,

  legacy_reason TEXT CHECK (legacy_reason IN ('orders_row','persisted_before_cutover','event_processed_unmapped',
                                              'event_failed','event_unfinished','compat_inline')),
  legacy_bill_evidence BOOLEAN,

  bill_state TEXT NOT NULL CHECK (bill_state IN ('not_ready','pending','sending','sent','failed','unknown',
                                                 'not_required','abandoned','legacy')),
  bill_attempts            SMALLINT NOT NULL DEFAULT 0,  -- send attempts STARTED
  bill_attempt_budget_base SMALLINT NOT NULL DEFAULT 0,
  bill_next_attempt_at     TIMESTAMPTZ,
  bill_current_attempt_id  BIGINT,                       -- FK added in section 9
  bill_authorization_audit_id BIGINT,                    -- FK added in section 9
  bill_outcome   TEXT CHECK (bill_outcome IN ('accepted','not_sent','refused','ambiguous','claim_expired',
                                              'compose_error','stale','cancelled','prior_log','operator','receipt',
                                              'window_closed')),
  bill_proof     TEXT CHECK (bill_proof IN ('accepted','receipt','prior_log','operator')),
  bill_done_at   TIMESTAMPTZ,
  bill_hold_reason TEXT,
  bill_hold_by     TEXT,
  bill_hold_at     TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT sos_key        UNIQUE (shop, shopify_order_id),
  -- Shopify order ids are globally unique: a second shop spelling of the same
  -- order (header vs SHOPIFY_SHOP_DOMAIN) must still be the same source.
  CONSTRAINT sos_order_global UNIQUE (shopify_order_id),
  CONSTRAINT sos_id_shopify UNIQUE (id, shopify_order_id),
  CONSTRAINT sos_id_bag     UNIQUE (id, order_id),

  -- provenance
  CONSTRAINT sos_live_payload   CHECK (origin <> 'live' OR (payload_raw IS NOT NULL AND payload_sha256 IS NOT NULL
                                                          AND commerce_fingerprint IS NOT NULL)),
  CONSTRAINT sos_fp_triple      CHECK ((commerce_fingerprint IS NULL) = (commerce_fingerprint_version IS NULL)
                                       AND (commerce_fingerprint IS NULL) = (commerce_canonical IS NULL)),
  CONSTRAINT sos_origin_reason  CHECK (origin = 'live' OR legacy_reason IS NOT NULL),
  CONSTRAINT sos_legacy_reason  CHECK (status <> 'legacy' OR legacy_reason IS NOT NULL),
  CONSTRAINT sos_legacy_known   CHECK (status <> 'legacy'
                                       OR legacy_reason NOT IN ('orders_row','persisted_before_cutover')
                                       OR order_id IS NOT NULL),
  CONSTRAINT sos_legacy_unknown CHECK (status <> 'legacy'
                                       OR legacy_reason NOT IN ('event_processed_unmapped','event_failed','event_unfinished')
                                       OR order_id IS NULL),
  CONSTRAINT sos_reopenable     CHECK (legacy_reason IS NULL OR legacy_reason NOT IN ('event_failed','event_unfinished')
                                       OR first_webhook_event_id IS NOT NULL),
  CONSTRAINT sos_event          CHECK (status = 'legacy' OR first_webhook_event_id IS NOT NULL),

  -- processing state
  CONSTRAINT sos_lease     CHECK ((status = 'processing') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT sos_review    CHECK ((status = 'review') = (review_reason IS NOT NULL)),
  CONSTRAINT sos_applied   CHECK (status <> 'applied' OR (order_id IS NOT NULL
                                  AND disposition IN ('created','merged') AND applied_at IS NOT NULL)),
  CONSTRAINT sos_comm_only CHECK (status <> 'community_only' OR (order_id IS NULL AND bill_state = 'not_required')),
  CONSTRAINT sos_dismissed CHECK (status <> 'dismissed' OR (bill_state = 'not_required'
                                  AND (disposition IS NULL OR disposition = 'manual_link'))),
  CONSTRAINT sos_attempts  CHECK (attempts >= 0 AND attempt_budget_base >= 0 AND attempt_budget_base <= attempts),

  -- bill vs status: every change writes both in ONE statement
  CONSTRAINT sos_bill_live      CHECK (bill_state IN ('not_ready','not_required','legacy') OR status = 'applied'),
  CONSTRAINT sos_bill_not_ready CHECK (bill_state <> 'not_ready'
                                       OR status IN ('received','processing','retryable_error','review')),
  CONSTRAINT sos_bill_legacy    CHECK ((bill_state = 'legacy') = (status = 'legacy')),
  CONSTRAINT sos_bill_sending   CHECK (bill_state <> 'sending' OR bill_current_attempt_id IS NOT NULL),
  CONSTRAINT sos_bill_sent      CHECK (bill_state <> 'sent' OR (bill_done_at IS NOT NULL AND bill_proof IS NOT NULL)),
  CONSTRAINT sos_bill_auth      CHECK (bill_authorization_audit_id IS NULL OR bill_state = 'pending'),
  CONSTRAINT sos_bill_attempts  CHECK (bill_attempts >= 0 AND bill_attempt_budget_base >= 0
                                       AND bill_attempt_budget_base <= bill_attempts),
  CONSTRAINT sos_hold_all_or_none CHECK ((bill_hold_reason IS NULL) = (bill_hold_by IS NULL)
                                         AND (bill_hold_reason IS NULL) = (bill_hold_at IS NULL))
);

CREATE INDEX idx_sos_due      ON shopify_order_sources (next_attempt_at) WHERE status IN ('received','retryable_error');
CREATE INDEX idx_sos_lease    ON shopify_order_sources (lease_until)     WHERE status = 'processing';
CREATE INDEX idx_sos_bill_due ON shopify_order_sources (bill_next_attempt_at) WHERE bill_state = 'pending';
CREATE INDEX idx_sos_order    ON shopify_order_sources (order_id);
CREATE INDEX idx_sos_event    ON shopify_order_sources (first_webhook_event_id);

-- ---------------------------------------------------------------------------
-- 2. Audit (append-only). Created after sources: it references them.
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_source_audit (
  id         BIGSERIAL PRIMARY KEY,
  source_id  BIGINT REFERENCES shopify_order_sources(id) ON DELETE RESTRICT,   -- NULL = run-level row
  action     TEXT NOT NULL CHECK (action IN ('backfill_run','backfill_row','backfill_upgrade',
               'worker_activation','worker_revocation','bill_send_activation','bill_send_revocation',
               'requeue','dismiss','link_order','reopen_legacy','anomaly_ack',
               'bill_confirm_sent','bill_resend','bill_abandon','bill_compose','bill_hold','bill_release',
               'link_receipt')),
  from_status TEXT, to_status TEXT, from_bill_state TEXT, to_bill_state TEXT,
  actor      TEXT NOT NULL CHECK (length(btrim(actor)) > 0),
  reason     TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  detail     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_sosa_source ON shopify_order_source_audit (source_id);
-- Target of the source-aware (composite) foreign keys below: an authorization
-- can only ever point at an audit row of the SAME source.
ALTER TABLE shopify_order_source_audit ADD CONSTRAINT sosa_source_id UNIQUE (source_id, id);

-- ---------------------------------------------------------------------------
-- 3. Duplicate deliveries (insert-only apart from the acknowledgement)
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_source_duplicates (
  id                   BIGSERIAL PRIMARY KEY,
  source_id            BIGINT NOT NULL REFERENCES shopify_order_sources(id) ON DELETE RESTRICT,
  webhook_event_id     BIGINT NOT NULL UNIQUE REFERENCES webhook_events(id) ON DELETE RESTRICT,
  payload_sha256       TEXT NOT NULL,
  commerce_fingerprint         TEXT NOT NULL,
  commerce_fingerprint_version SMALLINT NOT NULL,   -- = the SOURCE's version when it has one
  commerce_canonical           JSONB NOT NULL,
  fingerprint_differs  BOOLEAN,                     -- NULL: source has no fingerprint (legacy)
  raw_differs          BOOLEAN,
  acknowledged_by      TEXT,
  acknowledged_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sosd_ack CHECK ((acknowledged_by IS NULL) = (acknowledged_at IS NULL))
);
CREATE INDEX idx_sosd_source       ON shopify_order_source_duplicates (source_id);
CREATE INDEX idx_sosd_open_anomaly ON shopify_order_source_duplicates (source_id)
  WHERE fingerprint_differs AND acknowledged_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Line contributions at create time (insert-only)
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_source_lines (
  source_id            BIGINT NOT NULL REFERENCES shopify_order_sources(id) ON DELETE RESTRICT,
  shopify_line_item_id TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('grocery','community','skipped')),
  product_id           BIGINT REFERENCES products(id) ON DELETE RESTRICT,
  community_intake_id  BIGINT REFERENCES community_intake(id) ON DELETE RESTRICT,
  quantity             NUMERIC(10,3) NOT NULL,
  unit_price           NUMERIC(12,2),
  skip_reason          TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, shopify_line_item_id),
  CHECK (kind <> 'grocery'   OR product_id IS NOT NULL),
  CHECK (kind <> 'community' OR community_intake_id IS NOT NULL),
  CHECK (kind <> 'skipped'   OR skip_reason IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 5. Frozen bill (insert-only; the ONLY owner of bill_key)
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_bill_snapshots (
  source_id        BIGINT PRIMARY KEY,
  shopify_order_id TEXT   NOT NULL,
  order_id         BIGINT NOT NULL,
  bill_key         TEXT   NOT NULL UNIQUE,
  phone            TEXT   NOT NULL,
  scope            TEXT   NOT NULL CHECK (scope IN ('bag_after_apply','operator_compose')),
  content          JSONB  NOT NULL,
  rich_text        TEXT   NOT NULL,
  template_name    TEXT   NOT NULL,
  template_lang    TEXT   NOT NULL,
  template_params  JSONB  NOT NULL,
  content_sha256   TEXT   NOT NULL,
  composed_by      TEXT   NOT NULL,
  composed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bs_source FOREIGN KEY (source_id, shopify_order_id)
                       REFERENCES shopify_order_sources (id, shopify_order_id) ON DELETE RESTRICT,
  CONSTRAINT bs_bag    FOREIGN KEY (source_id, order_id)
                       REFERENCES shopify_order_sources (id, order_id) ON DELETE RESTRICT,
  CONSTRAINT bs_key    CHECK (bill_key = 'order_confirmed:shopify:' || shopify_order_id),
  CONSTRAINT bs_source_key UNIQUE (source_id, bill_key)
);

-- ---------------------------------------------------------------------------
-- 6. Send attempts (one per attempt STARTED; history is never rewritten)
-- ---------------------------------------------------------------------------
CREATE TABLE shopify_order_bill_attempts (
  id              BIGSERIAL PRIMARY KEY,
  source_id       BIGINT   NOT NULL,
  bill_key        TEXT     NOT NULL,
  attempt_no      SMALLINT NOT NULL CHECK (attempt_no >= 1),
  message_key     TEXT     NOT NULL UNIQUE,          -- = whatsapp_messages.idempotency_key
  claim_token     UUID     NOT NULL UNIQUE,
  channel         TEXT     NOT NULL CHECK (channel IN ('text','template')),
  initiated_by    TEXT     NOT NULL,
  authorization_audit_id BIGINT,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome         TEXT CHECK (outcome IN ('accepted','not_sent','refused','ambiguous','claim_expired')),
  retryable       BOOLEAN,
  transport       JSONB,
  wamid           TEXT UNIQUE,
  proof           TEXT CHECK (proof IN ('accepted','receipt','operator')),
  finished_at     TIMESTAMPTZ,
  UNIQUE (source_id, attempt_no),
  CONSTRAINT ba_source_id UNIQUE (source_id, id),          -- target for the source's current-attempt FK
  CONSTRAINT ba_authorization FOREIGN KEY (source_id, authorization_audit_id)
                         REFERENCES shopify_order_source_audit (source_id, id) ON DELETE RESTRICT,
  CONSTRAINT ba_snapshot FOREIGN KEY (source_id, bill_key)
                         REFERENCES shopify_order_bill_snapshots (source_id, bill_key) ON DELETE RESTRICT,
  CONSTRAINT ba_key      CHECK (message_key = CASE WHEN attempt_no = 1 THEN bill_key
                                                   ELSE bill_key || ':attempt:' || attempt_no END),
  CONSTRAINT ba_operator CHECK (initiated_by = 'worker' OR authorization_audit_id IS NOT NULL),
  CONSTRAINT ba_accepted CHECK (outcome IS DISTINCT FROM 'accepted' OR (wamid IS NOT NULL AND proof IS NOT NULL)),
  CONSTRAINT ba_finished CHECK ((outcome IS NULL) = (finished_at IS NULL)),
  CONSTRAINT ba_proof    CHECK (proof IS NULL OR wamid IS NOT NULL OR proof = 'operator')
);
CREATE INDEX idx_soba_source ON shopify_order_bill_attempts (source_id);

-- ---------------------------------------------------------------------------
-- 7. Alert outbox
-- ---------------------------------------------------------------------------
CREATE TABLE grocery_alerts (
  id          BIGSERIAL PRIMARY KEY,
  source_id   BIGINT REFERENCES shopify_order_sources(id) ON DELETE RESTRICT,
  kind        TEXT NOT NULL CHECK (kind IN ('review','bill_failed','bill_unknown','bill_stale','compose_error',
                                            'duplicate_anomaly','bill_delivery_failed','finalize_conflict',
                                            'receipt_unlinked','invalid_order')),
  detail      JSONB NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sent','gave_up')),
  attempts    SMALLINT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at     TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_alerts_pending ON grocery_alerts (next_attempt_at) WHERE state = 'pending';

-- ---------------------------------------------------------------------------
-- 8. WhatsApp receipt journal (written BEFORE the WhatsApp webhook's 200)
-- ---------------------------------------------------------------------------
CREATE TABLE whatsapp_receipt_backlog (
  wamid          TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('sent','delivered','read','failed')),
  recipient_id   TEXT,
  meta_timestamp TIMESTAMPTZ,
  errors         JSONB,
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at     TIMESTAMPTZ,
  PRIMARY KEY (wamid, status)
);
CREATE INDEX idx_wrb_unapplied ON whatsapp_receipt_backlog (received_at) WHERE applied_at IS NULL;

-- ---------------------------------------------------------------------------
-- 9. Late foreign keys (the referenced tables now exist)
-- ---------------------------------------------------------------------------
ALTER TABLE shopify_order_sources
  -- Source-aware: a source can only point at ITS OWN attempt and ITS OWN
  -- authorizing audit row (MATCH SIMPLE: a NULL pointer is not checked).
  ADD CONSTRAINT sos_current_attempt FOREIGN KEY (id, bill_current_attempt_id)
      REFERENCES shopify_order_bill_attempts (source_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT sos_authorization FOREIGN KEY (id, bill_authorization_audit_id)
      REFERENCES shopify_order_source_audit (source_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 10. Functions and guards
-- ---------------------------------------------------------------------------

-- Monotonic receipt order: queued < sent < failed < delivered < read.
CREATE FUNCTION asb_msg_status_rank(s text) RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE s WHEN 'queued' THEN 0 WHEN 'sent' THEN 1 WHEN 'failed' THEN 2
                WHEN 'delivered' THEN 3 WHEN 'read' THEN 4 ELSE -1 END
$$;

CREATE FUNCTION asb017_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (migration 017 guard)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END $$;

-- Sources: immutable identity, once-only links, and only the allowed edges.
CREATE FUNCTION asb017_sources_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st_ok boolean;
  bill_ok boolean;
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

  -- status edges
  st_ok := NEW.status = OLD.status OR (OLD.status, NEW.status) IN (
      ('received','processing'), ('retryable_error','processing'),
      ('processing','applied'), ('processing','community_only'), ('processing','review'),
      ('processing','retryable_error'), ('processing','legacy'),
      ('received','legacy'),                              -- backfill overlap upgrade
      ('review','received'), ('review','dismissed'),      -- operator
      ('legacy','received'));                             -- operator reopen
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
      ('sent','pending'), ('sent','failed'),              -- only for a 131047 failed receipt, below
      ('unknown','sent'), ('unknown','pending'), ('unknown','abandoned'),
      ('failed','sent'), ('failed','pending'), ('failed','abandoned'));
  IF NOT bill_ok THEN
    RAISE EXCEPTION 'shopify_order_sources %: bill_state % -> % is not allowed', OLD.id, OLD.bill_state, NEW.bill_state
      USING ERRCODE = 'check_violation';
  END IF;

  -- sent -> pending / failed only when WhatsApp reported the TEXT bill
  -- undeliverable because the 24h window was shut (131047): nothing reached
  -- the customer. pending = retry as a template; failed = no automatic budget left.
  IF OLD.bill_state = 'sent' AND NEW.bill_state IN ('pending','failed') AND NEW.bill_outcome IS DISTINCT FROM 'window_closed' THEN
    RAISE EXCEPTION 'shopify_order_sources %: sent -> % only for a 131047 window_closed receipt', OLD.id, NEW.bill_state
      USING ERRCODE = 'check_violation';
  END IF;
  -- failed/unknown -> pending is a person's decision: it needs the audited authorization.
  IF OLD.bill_state IN ('failed','unknown') AND NEW.bill_state = 'pending' AND NEW.bill_authorization_audit_id IS NULL THEN
    RAISE EXCEPTION 'shopify_order_sources %: % -> pending needs an operator authorization', OLD.id, OLD.bill_state
      USING ERRCODE = 'check_violation';
  END IF;

  -- the current attempt only moves on a new claim
  IF NEW.bill_current_attempt_id IS DISTINCT FROM OLD.bill_current_attempt_id
     AND NOT (OLD.bill_state = 'pending' AND NEW.bill_state = 'sending' AND NEW.bill_current_attempt_id IS NOT NULL) THEN
    RAISE EXCEPTION 'shopify_order_sources %: bill_current_attempt_id changes only on a new claim', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- operator resend authorization: set with failed/unknown -> pending; consumed (cleared) when the
  -- bill leaves pending - normally by the claim, which records it on the attempt row
  IF NEW.bill_authorization_audit_id IS DISTINCT FROM OLD.bill_authorization_audit_id THEN
    IF OLD.bill_authorization_audit_id IS NULL THEN
      IF NOT (OLD.bill_state IN ('failed','unknown') AND NEW.bill_state = 'pending') THEN
        RAISE EXCEPTION 'shopify_order_sources %: a resend authorization is set only by failed/unknown -> pending', OLD.id
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

CREATE TRIGGER trg_sos_guard BEFORE UPDATE ON shopify_order_sources
  FOR EACH ROW EXECUTE FUNCTION asb017_sources_guard();

-- A bill that can be (or was) sent always has its frozen snapshot. Checked at
-- COMMIT, so the apply step may write the source row and the snapshot in
-- either order inside one transaction.
CREATE FUNCTION asb017_bill_needs_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cur text;
BEGIN
  SELECT bill_state INTO cur FROM shopify_order_sources WHERE id = NEW.id;
  IF cur IN ('pending','sending','sent','unknown')
     AND NOT EXISTS (SELECT 1 FROM shopify_order_bill_snapshots WHERE source_id = NEW.id) THEN
    RAISE EXCEPTION 'shopify_order_sources %: bill_state % needs a bill snapshot', NEW.id, cur
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_sos_bill_snapshot
  AFTER INSERT OR UPDATE ON shopify_order_sources
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION asb017_bill_needs_snapshot();

-- Attempts: insert-only apart from finishing once (and one late upgrade).
CREATE FUNCTION asb017_attempts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.bill_key IS DISTINCT FROM OLD.bill_key OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.message_key IS DISTINCT FROM OLD.message_key OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
     OR NEW.channel IS DISTINCT FROM OLD.channel OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
     OR NEW.authorization_audit_id IS DISTINCT FROM OLD.authorization_audit_id
     OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
    RAISE EXCEPTION 'shopify_order_bill_attempts %: identity columns are immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome THEN
    IF NOT (OLD.outcome IS NULL
            OR (OLD.outcome IN ('ambiguous','claim_expired') AND NEW.outcome = 'accepted')) THEN
      RAISE EXCEPTION 'shopify_order_bill_attempts %: outcome % -> % is not allowed', OLD.id, OLD.outcome, NEW.outcome
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.retryable IS DISTINCT FROM OLD.retryable OR NEW.transport IS DISTINCT FROM OLD.transport THEN
    RAISE EXCEPTION 'shopify_order_bill_attempts %: the result is written with its outcome only', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.wamid IS NOT NULL AND NEW.wamid IS DISTINCT FROM OLD.wamid)
     OR (OLD.proof IS NOT NULL AND NEW.proof IS DISTINCT FROM OLD.proof)
     OR (OLD.finished_at IS NOT NULL AND NEW.finished_at IS DISTINCT FROM OLD.finished_at) THEN
    RAISE EXCEPTION 'shopify_order_bill_attempts %: wamid / proof / finished_at are set once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_soba_guard BEFORE UPDATE ON shopify_order_bill_attempts
  FOR EACH ROW EXECUTE FUNCTION asb017_attempts_guard();

-- Duplicates: only the acknowledgement, once.
CREATE FUNCTION asb017_duplicates_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'acknowledged_by' - 'acknowledged_at') IS DISTINCT FROM (to_jsonb(OLD) - 'acknowledged_by' - 'acknowledged_at')
     OR OLD.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'shopify_order_source_duplicates %: only an acknowledgement may be added, once', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_sosd_guard BEFORE UPDATE ON shopify_order_source_duplicates
  FOR EACH ROW EXECUTE FUNCTION asb017_duplicates_guard();

-- Alerts: delivery bookkeeping only.
CREATE FUNCTION asb017_alerts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'state' - 'attempts' - 'last_error' - 'sent_at' - 'next_attempt_at') IS DISTINCT FROM
     (to_jsonb(OLD) - 'state' - 'attempts' - 'last_error' - 'sent_at' - 'next_attempt_at')
     OR OLD.state <> 'pending' OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'grocery_alerts %: only pending alerts change, and only their delivery state', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_alerts_guard BEFORE UPDATE ON grocery_alerts
  FOR EACH ROW EXECUTE FUNCTION asb017_alerts_guard();

-- Receipt journal: only applied_at, NULL -> timestamp, once.
CREATE FUNCTION asb017_backlog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'applied_at') IS DISTINCT FROM (to_jsonb(OLD) - 'applied_at')
     OR OLD.applied_at IS NOT NULL OR NEW.applied_at IS NULL THEN
    RAISE EXCEPTION 'whatsapp_receipt_backlog %/%: only applied_at may be set, once', OLD.wamid, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_wrb_guard BEFORE UPDATE ON whatsapp_receipt_backlog
  FOR EACH ROW EXECUTE FUNCTION asb017_backlog_guard();

-- Insert-only tables.
CREATE TRIGGER trg_sosl_no_update  BEFORE UPDATE ON shopify_order_source_lines   FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sobs_no_update  BEFORE UPDATE ON shopify_order_bill_snapshots FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosa_no_update  BEFORE UPDATE ON shopify_order_source_audit   FOR EACH ROW EXECUTE FUNCTION asb017_refuse();

-- No DELETE, no TRUNCATE, anywhere in 017.
CREATE TRIGGER trg_sos_no_delete   BEFORE DELETE ON shopify_order_sources           FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosa_no_delete  BEFORE DELETE ON shopify_order_source_audit      FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosd_no_delete  BEFORE DELETE ON shopify_order_source_duplicates FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosl_no_delete  BEFORE DELETE ON shopify_order_source_lines      FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sobs_no_delete  BEFORE DELETE ON shopify_order_bill_snapshots    FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_soba_no_delete  BEFORE DELETE ON shopify_order_bill_attempts     FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_alerts_no_delete BEFORE DELETE ON grocery_alerts                 FOR EACH ROW EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_wrb_no_delete   BEFORE DELETE ON whatsapp_receipt_backlog        FOR EACH ROW EXECUTE FUNCTION asb017_refuse();

CREATE TRIGGER trg_sos_no_truncate   BEFORE TRUNCATE ON shopify_order_sources           FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosa_no_truncate  BEFORE TRUNCATE ON shopify_order_source_audit      FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosd_no_truncate  BEFORE TRUNCATE ON shopify_order_source_duplicates FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sosl_no_truncate  BEFORE TRUNCATE ON shopify_order_source_lines      FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_sobs_no_truncate  BEFORE TRUNCATE ON shopify_order_bill_snapshots    FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_soba_no_truncate  BEFORE TRUNCATE ON shopify_order_bill_attempts     FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_alerts_no_truncate BEFORE TRUNCATE ON grocery_alerts                 FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();
CREATE TRIGGER trg_wrb_no_truncate   BEFORE TRUNCATE ON whatsapp_receipt_backlog        FOR EACH STATEMENT EXECUTE FUNCTION asb017_refuse();

COMMIT;
