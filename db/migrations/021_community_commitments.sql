-- ============================================================================
-- ASB PIPELINE — migration 021: Community commitments + Rate Meter (ADR-002 Lane C)
--
-- Phase 2 storage for the Community King feature, per docs/quote-contract-v1.md
-- (accepted 5 Nov 2026, R1-R3). Adds four tables and one view. CHANGES NOTHING
-- THAT EXISTS: no grocery table, no order_items, no bill. The line-ceiling
-- column for order_items / bill.js (contract §7) is a separate joint PR.
--
--   community_hero_weeks   which canonical products are Heroes in one cycle
--   community_hero_tiers   each Hero's distinct pack configuration(s) (F11),
--                          ceiling and unlock rule
--   community_commitments  one row per committed quote line, keyed by
--                          quoteId:version:lineId so a replay is the same row
--   community_commitment_events  append-only status history (audit)
--   community_rate_meter   view: verified-or-later packs per tier, per cycle
--
-- Database-enforced rules (mirrors community/kernel.js):
--   * doors: only community_order, dish_to_cart, budget_to_cart can commit (F02)
--   * unlock price can never exceed the tier ceiling (F05)
--   * status moves only forward along the lifecycle (F13):
--       pending   -> verified | cancelled
--       verified  -> locked | cancelled
--       locked    -> fulfilled | refused
--       fulfilled -> paid | refused
--     paid, cancelled, refused are final.
--   * verified_at + verification_rule_version are set on entering 'verified'
--     and are never changed or cleared afterwards (R3: the verification event
--     is kept separately from the mutable status)
--   * no row is ever deleted; no table can be TRUNCATEd
--   * a commitment's tier must belong to the commitment's cycle (T10)
--
-- Deploy: rehearsal DB first; production only with Waqas's approval of this
-- specific migration. Nothing reads these tables yet.
-- ============================================================================

BEGIN;

CREATE TABLE community_hero_weeks (
  id                   BIGSERIAL PRIMARY KEY,
  hero_week_code       TEXT NOT NULL UNIQUE,              -- 'HW-2026-11-09'
  cycle_code           TEXT NOT NULL,                     -- 'MON-2026-11-09'
  canonical_product_id TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_by           TEXT NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_code, canonical_product_id)
);

CREATE TABLE community_hero_tiers (
  id                    BIGSERIAL PRIMARY KEY,
  tier_code             TEXT NOT NULL UNIQUE,             -- 'ONION-10KG-2026-11-09'
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
  household_key             TEXT NOT NULL,
  door                      TEXT NOT NULL CHECK (door IN ('community_order', 'dish_to_cart', 'budget_to_cart')),
  tier_id                   BIGINT NOT NULL REFERENCES community_hero_tiers(id) ON DELETE RESTRICT,
  packs                     INTEGER NOT NULL CHECK (packs > 0),
  ceiling_line_paisa        BIGINT NOT NULL CHECK (ceiling_line_paisa >= 0),
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'verified', 'locked', 'fulfilled', 'paid', 'cancelled', 'refused')),
  verified_at               TIMESTAMPTZ,
  verification_rule_version TEXT,
  shopify_order_gid         TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT key_matches_parts CHECK (commitment_key = quote_id || ':' || quote_version || ':' || line_id),
  CONSTRAINT verified_fields_together CHECK ((verified_at IS NULL) = (verification_rule_version IS NULL)),
  CONSTRAINT verified_statuses_have_event CHECK (
    status NOT IN ('verified', 'locked', 'fulfilled', 'paid') OR verified_at IS NOT NULL
  ),
  CONSTRAINT pending_is_unverified CHECK (status <> 'pending' OR verified_at IS NULL)
);
CREATE INDEX idx_community_commitments_cycle_tier ON community_commitments (cycle_code, tier_id, status);
CREATE INDEX idx_community_commitments_household ON community_commitments (household_key, cycle_code);

CREATE TABLE community_commitment_events (
  id            BIGSERIAL PRIMARY KEY,
  commitment_id BIGINT NOT NULL REFERENCES community_commitments(id) ON DELETE RESTRICT,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  reason        TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE FUNCTION asb021_commitment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tier_cycle TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ASB021: community commitments are never deleted (cancel instead)';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'ASB021: a commitment starts pending, not %', NEW.status;
    END IF;
    SELECT w.cycle_code INTO tier_cycle
      FROM community_hero_tiers t JOIN community_hero_weeks w ON w.id = t.hero_week_id
     WHERE t.id = NEW.tier_id;
    IF tier_cycle IS DISTINCT FROM NEW.cycle_code THEN
      RAISE EXCEPTION 'ASB021: tier % belongs to cycle %, not %', NEW.tier_id, tier_cycle, NEW.cycle_code;
    END IF;
    INSERT INTO community_commitment_events (commitment_id, from_status, to_status, reason)
      VALUES (NEW.id, NULL, NEW.status, 'created');
    RETURN NEW;
  END IF;

  -- UPDATE: identity and committed facts are immutable
  IF NEW.commitment_key IS DISTINCT FROM OLD.commitment_key OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.quote_version IS DISTINCT FROM OLD.quote_version OR NEW.line_id IS DISTINCT FROM OLD.line_id
     OR NEW.cycle_code IS DISTINCT FROM OLD.cycle_code OR NEW.household_key IS DISTINCT FROM OLD.household_key
     OR NEW.door IS DISTINCT FROM OLD.door OR NEW.tier_id IS DISTINCT FROM OLD.tier_id
     OR NEW.packs IS DISTINCT FROM OLD.packs OR NEW.ceiling_line_paisa IS DISTINCT FROM OLD.ceiling_line_paisa
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ASB021: committed facts are immutable; a change is a new quote version';
  END IF;

  -- the verification event, once recorded, never changes (R3)
  IF OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_rule_version IS DISTINCT FROM OLD.verification_rule_version) THEN
    RAISE EXCEPTION 'ASB021: verified_at / verification_rule_version cannot change once set';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'pending'   AND NEW.status IN ('verified', 'cancelled'))
      OR (OLD.status = 'verified'  AND NEW.status IN ('locked', 'cancelled'))
      OR (OLD.status = 'locked'    AND NEW.status IN ('fulfilled', 'refused'))
      OR (OLD.status = 'fulfilled' AND NEW.status IN ('paid', 'refused'))
    ) THEN
      RAISE EXCEPTION 'ASB021: status % -> % is not allowed', OLD.status, NEW.status;
    END IF;
    INSERT INTO community_commitment_events (commitment_id, from_status, to_status)
      VALUES (NEW.id, OLD.status, NEW.status);
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- INSERT runs AFTER (the audit event references the new id; a raise still
-- rolls the insert back). UPDATE / DELETE run BEFORE.
CREATE TRIGGER community_commitments_guard_ins
  AFTER INSERT ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb021_commitment_guard();
CREATE TRIGGER community_commitments_guard_upd
  BEFORE UPDATE OR DELETE ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb021_commitment_guard();

CREATE FUNCTION asb021_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB021: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END $$;

-- events are append-only
CREATE TRIGGER community_commitment_events_append_only
  BEFORE UPDATE OR DELETE ON community_commitment_events
  FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
-- hero weeks / tiers: never deleted (deactivate instead)
CREATE TRIGGER community_hero_weeks_no_delete
  BEFORE DELETE ON community_hero_weeks FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_tiers_no_delete
  BEFORE DELETE ON community_hero_tiers FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
-- no TRUNCATE on any 021 table
CREATE TRIGGER community_hero_weeks_no_truncate BEFORE TRUNCATE ON community_hero_weeks
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_hero_tiers_no_truncate BEFORE TRUNCATE ON community_hero_tiers
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_commitments_no_truncate BEFORE TRUNCATE ON community_commitments
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_commitment_events_no_truncate BEFORE TRUNCATE ON community_commitment_events
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();

-- ---------------------------------------------------------------------------
-- Rate Meter (F02, F13): verified-or-later packs per tier per cycle, each
-- commitment counted once (one row per commitment_key). Pending, cancelled and
-- refused are shown separately and never counted toward the unlock.
-- ---------------------------------------------------------------------------
CREATE VIEW community_rate_meter AS
SELECT
  w.cycle_code,
  t.id                AS tier_id,
  t.tier_code,
  t.unlock_verified_packs,
  t.unlock_pack_paisa,
  t.ceiling_pack_paisa,
  COALESCE(SUM(c.packs) FILTER (WHERE c.status IN ('verified', 'locked', 'fulfilled', 'paid')), 0) AS verified_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.status = 'pending'), 0)   AS pending_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.status = 'cancelled'), 0) AS cancelled_packs,
  COALESCE(SUM(c.packs) FILTER (WHERE c.status = 'refused'), 0)   AS refused_packs,
  (t.unlock_verified_packs IS NOT NULL AND
   COALESCE(SUM(c.packs) FILTER (WHERE c.status IN ('verified', 'locked', 'fulfilled', 'paid')), 0)
     >= t.unlock_verified_packs) AS unlocked
FROM community_hero_tiers t
JOIN community_hero_weeks w ON w.id = t.hero_week_id
LEFT JOIN community_commitments c ON c.tier_id = t.id AND c.cycle_code = w.cycle_code
GROUP BY w.cycle_code, t.id;

COMMIT;
