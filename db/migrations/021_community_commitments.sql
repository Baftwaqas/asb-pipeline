-- ============================================================================
-- ASB PIPELINE — migration 021: Community commitments + Rate Meter (ADR-002 Lane C)
--
-- Storage for the Community King feature, per docs/quote-contract-v1.md
-- (accepted 5 Nov 2026, R1-R3) and docs/community-verification-policy-v1.md
-- (ADR-002-VERIFY-001, Option A, founder-approved 5 Nov 2026).
-- CHANGES NOTHING THAT EXISTS: no grocery table, no order_items, no bill. The
-- order_items / bill.js line ceiling (contract §7) is a separate joint PR.
--
--   community_hero_weeks         which canonical products are Heroes in a cycle
--   community_hero_tiers         each Hero's distinct pack configuration (F11)
--   community_commitments        one row per committed quote line
--   community_commitment_events  append-only history of every state change
--   community_rate_meter         view: LIVE verified packs per tier per cycle (pre-lock progress)
--   community_meter_locks        immutable snapshot frozen at cycle lock (the price decision)
--   community_replace_quote()    the ONLY way to apply a customer edit (atomic supersede + insert)
--   community_lock_meter()       freezes the snapshot; asb_lock_cycle integration is a later PR
--
-- Three SEPARATE dimensions on every commitment (policy, Option A):
--   verification_state      pending | under_review | verified | rejected | cancelled
--   fulfillment_state       none | locked | packed | fulfilled | paid | refused
--   payment_security_state  unsecured_cod | deposit_confirmed | prepaid_confirmed
--
-- Database-enforced rules:
--   * doors: only community_order, dish_to_cart, budget_to_cart commit (F02)
--   * unlock price never above tier ceiling (F05)
--   * a commitment starts pending / none / unsecured_cod
--   * verification moves:  pending -> under_review | verified | rejected | cancelled
--                          under_review -> pending | verified | rejected | cancelled
--                          verified -> cancelled (only while fulfillment is none)
--                          rejected, cancelled are final
--   * fulfillment moves only for a verified commitment:
--                          none -> locked -> packed -> fulfilled -> paid
--                          locked | packed | fulfilled -> refused ; paid, refused final
--   * payment security only moves up, and needs a provider reference (a
--     screenshot is not a provider reference)
--   * verified needs verified_at + policy version; created_at <= verified_at <= locks_at,
--     and the transition itself must happen before locks_at by the DATABASE clock;
--     both fields are fixed once set (R3; policy: verified after lock never counts)
--   * no commitment is inserted at or after its cycle's locks_at (database clock)
--   * committed facts are immutable; a quote edit is a NEW version written only by
--     community_replace_quote(), which cancels older versions and inserts the new
--     lines in one call, before cutoff, never after lock (no double count, no
--     silent loss of verified demand). Direct inserts of version > 1 are refused.
--   * a quote chain lives in exactly one cycle (policy test 5)
--   * a commitment's tier belongs to the same cycle (T10)
--   * no row is deleted; no table can be TRUNCATEd
--
-- Deploy: rehearsal DB first; production only with Waqas's approval of this
-- specific migration. Nothing reads these tables yet.
-- ============================================================================

BEGIN;

CREATE TABLE community_hero_weeks (
  id                   BIGSERIAL PRIMARY KEY,
  hero_week_code       TEXT NOT NULL UNIQUE,
  cycle_code           TEXT NOT NULL,
  canonical_product_id TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_code, canonical_product_id)
);

CREATE TABLE community_hero_tiers (
  id                    BIGSERIAL PRIMARY KEY,
  tier_code             TEXT NOT NULL UNIQUE,
  hero_week_id          BIGINT NOT NULL REFERENCES community_hero_weeks(id) ON DELETE RESTRICT,
  pack_variant_gid      TEXT NOT NULL CHECK (pack_variant_gid ~ '^gid://shopify/ProductVariant/[0-9]+$'),
  unit                  TEXT NOT NULL CHECK (unit IN ('g', 'piece')),
  pack_qty              INTEGER NOT NULL CHECK (pack_qty > 0),
  max_packs_per_line    INTEGER NOT NULL DEFAULT 1 CHECK (max_packs_per_line > 0),
  ceiling_pack_paisa    BIGINT NOT NULL CHECK (ceiling_pack_paisa > 0),
  unlock_verified_packs INTEGER CHECK (unlock_verified_packs IS NULL OR unlock_verified_packs > 0),
  unlock_pack_paisa     BIGINT CHECK (unlock_pack_paisa IS NULL OR unlock_pack_paisa > 0),
  mandi_cost_pack_paisa BIGINT CHECK (mandi_cost_pack_paisa IS NULL OR mandi_cost_pack_paisa >= 0),
  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unlock_not_above_ceiling CHECK (unlock_pack_paisa IS NULL OR unlock_pack_paisa <= ceiling_pack_paisa),
  CONSTRAINT unlock_rule_complete CHECK ((unlock_verified_packs IS NULL) = (unlock_pack_paisa IS NULL)),
  UNIQUE (hero_week_id, pack_variant_gid)
);

CREATE TABLE community_commitments (
  id                        BIGSERIAL PRIMARY KEY,
  commitment_key            TEXT NOT NULL UNIQUE,         -- quoteId:version:lineId
  quote_id                  TEXT NOT NULL,
  quote_version             INTEGER NOT NULL CHECK (quote_version > 0),
  line_id                   TEXT NOT NULL,
  cycle_code                TEXT NOT NULL,
  locks_at                  TIMESTAMPTZ NOT NULL,         -- the cycle's cutoff
  household_key             TEXT NOT NULL,
  door                      TEXT NOT NULL CHECK (door IN ('community_order', 'dish_to_cart', 'budget_to_cart')),
  tier_id                   BIGINT NOT NULL REFERENCES community_hero_tiers(id) ON DELETE RESTRICT,
  packs                     INTEGER NOT NULL CHECK (packs > 0),
  ceiling_line_paisa        BIGINT NOT NULL CHECK (ceiling_line_paisa >= 0),
  verification_state        TEXT NOT NULL DEFAULT 'pending'
                            CHECK (verification_state IN ('pending', 'under_review', 'verified', 'rejected', 'cancelled')),
  fulfillment_state         TEXT NOT NULL DEFAULT 'none'
                            CHECK (fulfillment_state IN ('none', 'locked', 'packed', 'fulfilled', 'paid', 'refused')),
  payment_security_state    TEXT NOT NULL DEFAULT 'unsecured_cod'
                            CHECK (payment_security_state IN ('unsecured_cod', 'deposit_confirmed', 'prepaid_confirmed')),
  payment_provider_ref      TEXT,
  verified_at               TIMESTAMPTZ,
  verification_policy_version TEXT,
  superseded_by_version     INTEGER,
  shopify_order_gid         TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT key_matches_parts CHECK (commitment_key = quote_id || ':' || quote_version || ':' || line_id),
  CONSTRAINT verified_fields_together CHECK ((verified_at IS NULL) = (verification_policy_version IS NULL)),
  CONSTRAINT verified_has_event CHECK (verification_state <> 'verified' OR verified_at IS NOT NULL),
  CONSTRAINT verified_before_lock CHECK (verified_at IS NULL OR verified_at <= locks_at),
  CONSTRAINT verified_after_creation CHECK (verified_at IS NULL OR verified_at >= created_at),
  CONSTRAINT fulfillment_needs_verified CHECK (fulfillment_state = 'none' OR verified_at IS NOT NULL),
  CONSTRAINT secured_needs_provider_ref CHECK (payment_security_state = 'unsecured_cod'
    OR (payment_provider_ref IS NOT NULL AND length(btrim(payment_provider_ref)) > 0)),
  CONSTRAINT superseded_is_cancelled CHECK (superseded_by_version IS NULL OR
    (verification_state = 'cancelled' AND superseded_by_version > quote_version))
);
CREATE INDEX idx_community_commitments_cycle_tier ON community_commitments (cycle_code, tier_id, verification_state);
CREATE INDEX idx_community_commitments_quote ON community_commitments (quote_id, quote_version);

CREATE TABLE community_commitment_events (
  id            BIGSERIAL PRIMARY KEY,
  commitment_id BIGINT NOT NULL REFERENCES community_commitments(id) ON DELETE RESTRICT,
  dimension     TEXT NOT NULL CHECK (dimension IN ('created', 'verification', 'fulfillment', 'payment_security')),
  from_state    TEXT,
  to_state      TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION asb021_commitment_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tier_cycle TEXT;
BEGIN
  IF NEW.verification_state <> 'pending' OR NEW.fulfillment_state <> 'none'
     OR NEW.payment_security_state <> 'unsecured_cod' OR NEW.verified_at IS NOT NULL
     OR NEW.superseded_by_version IS NOT NULL THEN
    RAISE EXCEPTION 'ASB021: a commitment starts pending / none / unsecured_cod';
  END IF;
  SELECT w.cycle_code INTO tier_cycle
    FROM community_hero_tiers t JOIN community_hero_weeks w ON w.id = t.hero_week_id
   WHERE t.id = NEW.tier_id;
  IF tier_cycle IS DISTINCT FROM NEW.cycle_code THEN
    RAISE EXCEPTION 'ASB021: tier % belongs to cycle %, not %', NEW.tier_id, tier_cycle, NEW.cycle_code;
  END IF;
  IF clock_timestamp() >= NEW.locks_at THEN
    RAISE EXCEPTION 'ASB021: cycle % is past its cutoff; no new commitments', NEW.cycle_code;
  END IF;
  IF NEW.quote_version > 1 AND current_setting('asb021.replacing', true) IS DISTINCT FROM NEW.quote_id THEN
    RAISE EXCEPTION 'ASB021: version % of quote % must be written by community_replace_quote()', NEW.quote_version, NEW.quote_id;
  END IF;
  -- serialise inserts per quote chain, then check the chain
  PERFORM pg_advisory_xact_lock(hashtext('asb021:' || NEW.quote_id));
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE quote_id = NEW.quote_id AND cycle_code <> NEW.cycle_code) THEN
    RAISE EXCEPTION 'ASB021: quote % already belongs to another cycle', NEW.quote_id;
  END IF;
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE quote_id = NEW.quote_id AND quote_version > NEW.quote_version) THEN
    RAISE EXCEPTION 'ASB021: quote % already has a newer version than %', NEW.quote_id, NEW.quote_version;
  END IF;
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE quote_id = NEW.quote_id AND quote_version < NEW.quote_version
                AND verification_state NOT IN ('cancelled', 'rejected')) THEN
    RAISE EXCEPTION 'ASB021: quote % has a live older version; use community_replace_quote()', NEW.quote_id;
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION asb021_commitment_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO community_commitment_events (commitment_id, dimension, from_state, to_state)
    VALUES (NEW.id, 'created', NULL, 'pending');
  RETURN NULL;
END $$;

CREATE FUNCTION asb021_commitment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASB021: community commitments are never deleted (cancel instead)';
  END IF;

  IF NEW.commitment_key IS DISTINCT FROM OLD.commitment_key OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.quote_version IS DISTINCT FROM OLD.quote_version OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.cycle_code IS DISTINCT FROM OLD.cycle_code OR NEW.locks_at IS DISTINCT FROM OLD.locks_at
     OR NEW.household_key IS DISTINCT FROM OLD.household_key OR NEW.door IS DISTINCT FROM OLD.door
     OR NEW.tier_id IS DISTINCT FROM OLD.tier_id OR NEW.packs IS DISTINCT FROM OLD.packs
     OR NEW.ceiling_line_paisa IS DISTINCT FROM OLD.ceiling_line_paisa OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ASB021: committed facts are immutable; a change is a new quote version';
  END IF;

  IF OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_policy_version IS DISTINCT FROM OLD.verification_policy_version) THEN
    RAISE EXCEPTION 'ASB021: verified_at / verification_policy_version cannot change once set';
  END IF;
  IF OLD.superseded_by_version IS NOT NULL AND NEW.superseded_by_version IS DISTINCT FROM OLD.superseded_by_version THEN
    RAISE EXCEPTION 'ASB021: superseded_by_version cannot change once set';
  END IF;
  IF OLD.payment_provider_ref IS NOT NULL AND NEW.payment_provider_ref IS DISTINCT FROM OLD.payment_provider_ref
     AND NOT (OLD.payment_security_state = 'deposit_confirmed' AND NEW.payment_security_state = 'prepaid_confirmed') THEN
    RAISE EXCEPTION 'ASB021: payment_provider_ref changes only when a deposit is upgraded to prepaid';
  END IF;

  IF NEW.verification_state IS DISTINCT FROM OLD.verification_state THEN
    IF NOT (
         (OLD.verification_state = 'pending'      AND NEW.verification_state IN ('under_review', 'verified', 'rejected', 'cancelled'))
      OR (OLD.verification_state = 'under_review' AND NEW.verification_state IN ('pending', 'verified', 'rejected', 'cancelled'))
      OR (OLD.verification_state = 'verified'     AND NEW.verification_state = 'cancelled' AND OLD.fulfillment_state = 'none')
    ) THEN
      RAISE EXCEPTION 'ASB021: verification % -> % is not allowed', OLD.verification_state, NEW.verification_state;
    END IF;
    IF NEW.verification_state = 'verified' AND clock_timestamp() > NEW.locks_at THEN
      RAISE EXCEPTION 'ASB021: cycle % is past its cutoff; a commitment cannot be verified now', NEW.cycle_code;
    END IF;
    INSERT INTO community_commitment_events (commitment_id, dimension, from_state, to_state)
      VALUES (NEW.id, 'verification', OLD.verification_state, NEW.verification_state);
  END IF;

  IF NEW.fulfillment_state IS DISTINCT FROM OLD.fulfillment_state THEN
    IF NEW.verification_state <> 'verified' THEN
      RAISE EXCEPTION 'ASB021: only a verified commitment moves through fulfillment';
    END IF;
    IF NOT (
         (OLD.fulfillment_state = 'none'      AND NEW.fulfillment_state = 'locked')
      OR (OLD.fulfillment_state = 'locked'    AND NEW.fulfillment_state IN ('packed', 'refused'))
      OR (OLD.fulfillment_state = 'packed'    AND NEW.fulfillment_state IN ('fulfilled', 'refused'))
      OR (OLD.fulfillment_state = 'fulfilled' AND NEW.fulfillment_state IN ('paid', 'refused'))
    ) THEN
      RAISE EXCEPTION 'ASB021: fulfillment % -> % is not allowed', OLD.fulfillment_state, NEW.fulfillment_state;
    END IF;
    INSERT INTO community_commitment_events (commitment_id, dimension, from_state, to_state)
      VALUES (NEW.id, 'fulfillment', OLD.fulfillment_state, NEW.fulfillment_state);
  END IF;

  IF NEW.payment_security_state IS DISTINCT FROM OLD.payment_security_state THEN
    IF NOT ((OLD.payment_security_state = 'unsecured_cod' AND NEW.payment_security_state IN ('deposit_confirmed', 'prepaid_confirmed'))
         OR (OLD.payment_security_state = 'deposit_confirmed' AND NEW.payment_security_state = 'prepaid_confirmed')) THEN
      RAISE EXCEPTION 'ASB021: payment security % cannot change to %', OLD.payment_security_state, NEW.payment_security_state;
    END IF;
    INSERT INTO community_commitment_events (commitment_id, dimension, from_state, to_state)
      VALUES (NEW.id, 'payment_security', OLD.payment_security_state, NEW.payment_security_state);
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER community_commitments_ins BEFORE INSERT ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb021_commitment_insert();
CREATE TRIGGER community_commitments_created AFTER INSERT ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb021_commitment_created();
CREATE TRIGGER community_commitments_upd BEFORE UPDATE OR DELETE ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb021_commitment_update();

-- A customer edit before cutoff: in ONE call, under the quote-chain lock,
-- cancel every live line of older versions and insert the new version's lines.
-- p_lines = [{"line_id","household_key","door","tier_id","packs","ceiling_line_paisa"}, ...]
-- Returns the new commitment ids. Refused after cutoff or once any older line
-- has entered fulfillment (post-lock changes follow the amendment policy).
CREATE FUNCTION community_replace_quote(p_quote_id TEXT, p_new_version INTEGER, p_lines JSONB)
RETURNS SETOF BIGINT LANGUAGE plpgsql AS $$
DECLARE
  chain_cycle TEXT;
  chain_locks TIMESTAMPTZ;
  l JSONB;
  new_id BIGINT;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'ASB021: a replacement must carry the new version''s lines';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('asb021:' || p_quote_id));
  SELECT min(cycle_code), min(locks_at) INTO chain_cycle, chain_locks
    FROM community_commitments WHERE quote_id = p_quote_id;
  IF chain_cycle IS NULL THEN
    RAISE EXCEPTION 'ASB021: quote % has no earlier version to replace', p_quote_id;
  END IF;
  IF clock_timestamp() >= chain_locks THEN
    RAISE EXCEPTION 'ASB021: quote % is past its cutoff; it cannot be replaced', p_quote_id;
  END IF;
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE quote_id = p_quote_id AND quote_version >= p_new_version) THEN
    RAISE EXCEPTION 'ASB021: quote % already has version % or newer', p_quote_id, p_new_version;
  END IF;
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE quote_id = p_quote_id AND fulfillment_state <> 'none'
                AND verification_state NOT IN ('cancelled', 'rejected')) THEN
    RAISE EXCEPTION 'ASB021: quote % is already locked for fulfillment', p_quote_id;
  END IF;
  -- row locks on the old lines: a concurrent verifier waits, then sees 'cancelled'
  UPDATE community_commitments
     SET verification_state = 'cancelled', superseded_by_version = p_new_version
   WHERE quote_id = p_quote_id AND quote_version < p_new_version
     AND verification_state NOT IN ('cancelled', 'rejected');
  PERFORM set_config('asb021.replacing', p_quote_id, true);
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
        household_key, door, tier_id, packs, ceiling_line_paisa)
      VALUES (p_quote_id || ':' || p_new_version || ':' || (l->>'line_id'), p_quote_id, p_new_version, l->>'line_id',
              chain_cycle, chain_locks, l->>'household_key', l->>'door', (l->>'tier_id')::BIGINT,
              (l->>'packs')::INTEGER, (l->>'ceiling_line_paisa')::BIGINT)
      RETURNING id INTO new_id;
    RETURN NEXT new_id;
  END LOOP;
  PERFORM set_config('asb021.replacing', '', true);
  RETURN;
END $$;

-- ---------------------------------------------------------------------------
-- Frozen meter at cycle lock. The live view can change after lock (a refusal
-- leaves it); the LOCKED price decision must not. One immutable row per tier.
-- ---------------------------------------------------------------------------
CREATE TABLE community_meter_locks (
  id                    BIGSERIAL PRIMARY KEY,
  cycle_code            TEXT NOT NULL,
  tier_id               BIGINT NOT NULL REFERENCES community_hero_tiers(id) ON DELETE RESTRICT,
  locked_verified_packs INTEGER NOT NULL CHECK (locked_verified_packs >= 0),
  locked_secured_packs  INTEGER NOT NULL CHECK (locked_secured_packs >= 0),
  locked_unlocked       BOOLEAN NOT NULL,
  locked_pack_paisa     BIGINT NOT NULL CHECK (locked_pack_paisa > 0),
  ceiling_pack_paisa    BIGINT NOT NULL CHECK (ceiling_pack_paisa > 0),
  locked_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  locked_by             TEXT NOT NULL,
  UNIQUE (cycle_code, tier_id),
  CONSTRAINT locked_price_not_above_ceiling CHECK (locked_pack_paisa <= ceiling_pack_paisa)
);

-- Freeze every tier of a cycle. Refused before the cycle's cutoff, and refused
-- twice (the unique key). The price is the unlock price when unlocked, else the ceiling.
CREATE FUNCTION community_lock_meter(p_cycle_code TEXT, p_locked_by TEXT)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  n INTEGER;
BEGIN
  IF p_locked_by IS NULL OR length(btrim(p_locked_by)) = 0 THEN
    RAISE EXCEPTION 'ASB021: a meter lock needs an operator or job name';
  END IF;
  IF EXISTS (SELECT 1 FROM community_commitments
              WHERE cycle_code = p_cycle_code AND locks_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'ASB021: cycle % has not reached its cutoff', p_cycle_code;
  END IF;
  INSERT INTO community_meter_locks (cycle_code, tier_id, locked_verified_packs, locked_secured_packs,
                                     locked_unlocked, locked_pack_paisa, ceiling_pack_paisa, locked_by)
  SELECT m.cycle_code, m.tier_id, m.verified_packs, m.payment_secured_packs, m.unlocked,
         CASE WHEN m.unlocked THEN m.unlock_pack_paisa ELSE m.ceiling_pack_paisa END,
         m.ceiling_pack_paisa, p_locked_by
    FROM community_rate_meter m
   WHERE m.cycle_code = p_cycle_code;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE FUNCTION asb021_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB021: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

CREATE TRIGGER community_commitment_events_append_only
  BEFORE UPDATE OR DELETE ON community_commitment_events FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_weeks_no_delete
  BEFORE DELETE ON community_hero_weeks FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_tiers_no_delete
  BEFORE DELETE ON community_hero_tiers FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_weeks_no_truncate BEFORE TRUNCATE ON community_hero_weeks
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_tiers_no_truncate BEFORE TRUNCATE ON community_hero_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_commitments_no_truncate BEFORE TRUNCATE ON community_commitments
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_commitment_events_no_truncate BEFORE TRUNCATE ON community_commitment_events
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_meter_locks_immutable
  BEFORE UPDATE OR DELETE ON community_meter_locks FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_meter_locks_no_truncate BEFORE TRUNCATE ON community_meter_locks
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();

-- ---------------------------------------------------------------------------
-- Rate Meter (F02, F13, policy tests 1-8): verified packs per tier per cycle.
-- Counts only verification_state = 'verified' and fulfillment not refused.
-- Superseded versions are cancelled, so an edit never double counts.
-- Pending, under review, refused and cancelled/rejected are shown separately;
-- payment-secured packs are shown beside verified (unsecured) COD packs.
-- ---------------------------------------------------------------------------
CREATE VIEW community_rate_meter AS
SELECT
  w.cycle_code,
  t.id AS tier_id,
  t.tier_code,
  t.unlock_verified_packs,
  t.unlock_pack_paisa,
  t.ceiling_pack_paisa,
  COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state = 'verified' AND c.fulfillment_state <> 'refused'), 0) AS verified_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state = 'verified' AND c.fulfillment_state <> 'refused'
                                  AND c.payment_security_state <> 'unsecured_cod'), 0) AS payment_secured_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state = 'pending'), 0)       AS pending_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state = 'under_review'), 0)  AS under_review_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.fulfillment_state = 'refused'), 0)        AS refused_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state IN ('cancelled', 'rejected')), 0) AS cancelled_or_rejected_packs,
  (t.unlock_verified_packs IS NOT NULL AND
   COALESCE(SUM(c.packs) FILTER (WHERE c.verification_state = 'verified' AND c.fulfillment_state <> 'refused'), 0)
     >= t.unlock_verified_packs) AS unlocked
FROM community_hero_tiers t
JOIN community_hero_weeks w ON w.id = t.hero_week_id
LEFT JOIN community_commitments c ON c.tier_id = t.id AND c.cycle_code = w.cycle_code
GROUP BY w.cycle_code, t.id;

COMMIT;
