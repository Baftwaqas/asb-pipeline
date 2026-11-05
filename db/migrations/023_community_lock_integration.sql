-- ============================================================================
-- ASB PIPELINE — migration 023: Community Order joins the weekly price lock
-- (ADR-002 Lane C; depends on 021)
--
-- When a cycle locks (asb_lock_cycle sets cycles.status = 'locked'), Community
-- locks IN THE SAME TRANSACTION:
--
--   1. the Rate Meter is frozen (community_lock_meter: one immutable row per
--      Hero tier - verified packs, unlocked yes/no, locked pack price);
--   2. every live commitment of the cycle gets an immutable PRICE LINE
--      (community_cycle_lock_lines) - what that household pays for that line,
--      and why;
--   3. verified commitments move to fulfillment 'locked'.
--
-- If any Community step fails, the whole cycle lock rolls back: grocery and
-- Community never lock apart.
--
-- THE PRICE OF ONE LINE (contract v1 §3, R1; F03, F05, F12, F13)
--
--   counted       = verified and not refused at lock (the meter's own rule)
--   door_eligible = the line's QUOTE, in that DOOR, has counted Hero lines
--                   whose CEILING totals >= Rs 1,200 (120,000 paisa), the
--                   same threshold as community/kernel.js THRESHOLD_PAISA.
--                   Never summed across doors or across quotes.
--   tier price    = only when the tier unlocked AND the line is counted AND
--                   door_eligible; otherwise the ceiling.
--   locked_line   = LEAST(ceiling_line_paisa, packs x locked_pack_paisa) -
--                   never above the line the customer accepted.
--
--   Evaluated on COMMITTED packs at lock (R1). A later ASB short pack, or a
--   refusal by another household, never changes these rows: the locked
--   price is never revoked. Pending / under-review lines are recorded with
--   basis 'not_verified' at the ceiling, for operations to decide on.
--
-- WHAT THIS DOES NOT TOUCH (016 isolation)
--
--   Community packs never enter products, order_items or cycle_prices. This
--   migration writes only community_* tables. Grocery pricing is unchanged.
--
-- GUARDS
--
--   * a Community cycle cannot lock before its cutoff (cycles.locks_at);
--   * every commitment's locks_at must equal its cycle's locks_at: refused at
--     insert, and checked again at lock (a cutoff moved later must be
--     reconciled first);
--   * the Community cycle code is cycles.code; a Hero week for a cycle code
--     with no cycles row is refused at lock.
--   * re-locking after asb_unlock_cycle() reuses the frozen snapshot - it is
--     never recomputed (an unlock is a grocery correction; it cannot reopen
--     Community demand, which closed at the cutoff).
--
-- Deploy: rehearsal DB first; production only with Waqas's approval of this
-- specific migration, after 021.
-- ============================================================================

BEGIN;

CREATE FUNCTION community_threshold_paisa() RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$ SELECT 120000::BIGINT $$;
COMMENT ON FUNCTION community_threshold_paisa IS
  'Rs 1,200 Community entry, at CEILING, per quote per door (F03). Must equal community/kernel.js THRESHOLD_PAISA (tested).';

CREATE TABLE community_cycle_lock_lines (
  id                            BIGSERIAL PRIMARY KEY,
  cycle_code                    TEXT NOT NULL,
  commitment_id                 BIGINT NOT NULL UNIQUE REFERENCES community_commitments(id) ON DELETE RESTRICT,
  quote_id                      TEXT NOT NULL,
  quote_version                 INTEGER NOT NULL,
  line_id                       TEXT NOT NULL,
  household_key                 TEXT NOT NULL,
  door                          TEXT NOT NULL,
  tier_id                       BIGINT NOT NULL REFERENCES community_hero_tiers(id) ON DELETE RESTRICT,
  packs                         INTEGER NOT NULL CHECK (packs > 0),
  ceiling_pack_paisa            BIGINT NOT NULL CHECK (ceiling_pack_paisa > 0),
  ceiling_line_paisa            BIGINT NOT NULL CHECK (ceiling_line_paisa >= 0),
  verification_state_at_lock    TEXT NOT NULL,
  counted                       BOOLEAN NOT NULL,
  door_qualifying_ceiling_paisa BIGINT NOT NULL CHECK (door_qualifying_ceiling_paisa >= 0),
  door_eligible                 BOOLEAN NOT NULL,
  tier_unlocked                 BOOLEAN NOT NULL,
  price_basis                   TEXT NOT NULL CHECK (price_basis IN
                                  ('tier_unlocked', 'ceiling_tier_not_unlocked', 'ceiling_door_not_eligible', 'not_verified')),
  locked_pack_paisa             BIGINT NOT NULL CHECK (locked_pack_paisa > 0),
  locked_line_paisa             BIGINT NOT NULL CHECK (locked_line_paisa >= 0),
  locked_at                     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  locked_by                     TEXT NOT NULL CHECK (length(btrim(locked_by)) > 0),
  CONSTRAINT locked_line_within_ceiling CHECK (locked_line_paisa <= ceiling_line_paisa),
  CONSTRAINT locked_pack_within_ceiling CHECK (locked_pack_paisa <= ceiling_pack_paisa),
  CONSTRAINT tier_price_needs_all_three CHECK (price_basis <> 'tier_unlocked' OR (counted AND door_eligible AND tier_unlocked)),
  CONSTRAINT not_verified_iff_not_counted CHECK ((price_basis = 'not_verified') = (NOT counted))
);
CREATE INDEX idx_community_cycle_lock_lines_cycle ON community_cycle_lock_lines (cycle_code, household_key);

CREATE TRIGGER community_cycle_lock_lines_immutable
  BEFORE UPDATE OR DELETE ON community_cycle_lock_lines FOR EACH ROW EXECUTE FUNCTION asb021_refuse();
CREATE TRIGGER community_cycle_lock_lines_no_truncate BEFORE TRUNCATE ON community_cycle_lock_lines
  FOR EACH STATEMENT EXECUTE FUNCTION asb021_refuse();

-- ---------------------------------------------------------------------------
-- Lock one Community cycle. Called by the cycles trigger below (i.e. by
-- asb_lock_cycle); callable by hand only for the same cycle, same rules.
-- Returns what it did; idempotent - a second call returns the frozen result.
-- ---------------------------------------------------------------------------
CREATE FUNCTION community_lock_cycle(p_cycle_code TEXT, p_locked_by TEXT)
RETURNS TABLE (tiers_frozen INTEGER, lines_priced INTEGER, lines_at_tier_price INTEGER,
               lines_not_verified INTEGER, commitments_locked INTEGER, reused BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE
  v_cycle   cycles;
  v_bad     TEXT;
  v_tiers   INTEGER;
  v_lines   INTEGER;
  v_locked  INTEGER;
BEGIN
  PERFORM asb021_require_read_committed('community_lock_cycle');
  IF p_locked_by IS NULL OR length(btrim(p_locked_by)) = 0 THEN
    RAISE EXCEPTION 'ASB023: a Community lock needs an operator or job name';
  END IF;

  SELECT * INTO v_cycle FROM cycles WHERE code = p_cycle_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ASB023: no cycle % in cycles; Community cycle codes are cycles.code', p_cycle_code;
  END IF;

  -- Freeze writers first (same lock community_lock_meter takes).
  LOCK TABLE community_commitments IN SHARE MODE;

  -- Already locked: the snapshot is final. Report it, change nothing.
  IF EXISTS (SELECT 1 FROM community_cycle_lock_lines WHERE cycle_code = p_cycle_code)
     OR (EXISTS (SELECT 1 FROM community_meter_locks WHERE cycle_code = p_cycle_code)
         AND NOT EXISTS (SELECT 1 FROM community_commitments
                          WHERE cycle_code = p_cycle_code AND verification_state NOT IN ('cancelled', 'rejected'))) THEN
    RETURN QUERY
      SELECT (SELECT count(*)::int FROM community_meter_locks m WHERE m.cycle_code = p_cycle_code),
             count(*)::int,
             (count(*) FILTER (WHERE l.price_basis = 'tier_unlocked'))::int,
             (count(*) FILTER (WHERE l.price_basis = 'not_verified'))::int,
             0, TRUE
        FROM community_cycle_lock_lines l WHERE l.cycle_code = p_cycle_code;
    RETURN;
  END IF;

  -- A Community cycle (one with Hero weeks or commitments) locks only after its cutoff.
  IF clock_timestamp() < v_cycle.locks_at AND (
       EXISTS (SELECT 1 FROM community_hero_weeks WHERE cycle_code = p_cycle_code)
       OR EXISTS (SELECT 1 FROM community_commitments WHERE cycle_code = p_cycle_code)) THEN
    RAISE EXCEPTION 'ASB023: cycle % has Community demand and its cutoff % has not passed',
      p_cycle_code, v_cycle.locks_at;
  END IF;

  SELECT string_agg(DISTINCT locks_at::text, ', ') INTO v_bad
    FROM community_commitments
   WHERE cycle_code = p_cycle_code AND locks_at IS DISTINCT FROM v_cycle.locks_at;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'ASB023: cycle % cutoff is % but commitments carry cutoff(s) %; reconcile before locking',
      p_cycle_code, v_cycle.locks_at, v_bad;
  END IF;

  -- 1. Meter (reuses a snapshot taken earlier by hand, never retakes it).
  IF NOT EXISTS (SELECT 1 FROM community_meter_locks WHERE cycle_code = p_cycle_code) THEN
    PERFORM community_lock_meter(p_cycle_code, p_locked_by);
  END IF;
  SELECT count(*) INTO v_tiers FROM community_meter_locks WHERE cycle_code = p_cycle_code;

  -- 2. One price line per live commitment.
  WITH live AS (
    SELECT c.*,
           (c.verification_state = 'verified' AND c.fulfillment_state <> 'refused') AS counted
      FROM community_commitments c
     WHERE c.cycle_code = p_cycle_code AND c.verification_state NOT IN ('cancelled', 'rejected')
  ), door_totals AS (
    SELECT quote_id, door, COALESCE(SUM(ceiling_line_paisa) FILTER (WHERE counted), 0) AS qualifying
      FROM live GROUP BY quote_id, door
  ), priced AS (
    SELECT l.*, d.qualifying,
           d.qualifying >= community_threshold_paisa() AS eligible,
           m.locked_unlocked, m.locked_pack_paisa AS meter_pack_paisa, m.ceiling_pack_paisa AS meter_ceiling,
           CASE
             WHEN NOT l.counted                          THEN 'not_verified'
             WHEN NOT m.locked_unlocked                  THEN 'ceiling_tier_not_unlocked'
             WHEN d.qualifying < community_threshold_paisa() THEN 'ceiling_door_not_eligible'
             ELSE 'tier_unlocked'
           END AS basis
      FROM live l
      JOIN door_totals d ON d.quote_id = l.quote_id AND d.door = l.door
      JOIN community_meter_locks m ON m.cycle_code = l.cycle_code AND m.tier_id = l.tier_id
  )
  INSERT INTO community_cycle_lock_lines (cycle_code, commitment_id, quote_id, quote_version, line_id, household_key,
         door, tier_id, packs, ceiling_pack_paisa, ceiling_line_paisa, verification_state_at_lock, counted,
         door_qualifying_ceiling_paisa, door_eligible, tier_unlocked, price_basis, locked_pack_paisa,
         locked_line_paisa, locked_by)
  SELECT p.cycle_code, p.id, p.quote_id, p.quote_version, p.line_id, p.household_key,
         p.door, p.tier_id, p.packs, p.meter_ceiling, p.ceiling_line_paisa, p.verification_state, p.counted,
         p.qualifying, p.eligible, p.locked_unlocked, p.basis,
         CASE WHEN p.basis = 'tier_unlocked' THEN p.meter_pack_paisa ELSE p.meter_ceiling END,
         LEAST(p.ceiling_line_paisa,
               p.packs::BIGINT * CASE WHEN p.basis = 'tier_unlocked' THEN p.meter_pack_paisa ELSE p.meter_ceiling END),
         p_locked_by
    FROM priced p;
  GET DIAGNOSTICS v_lines = ROW_COUNT;

  -- Every live commitment must have found its tier in the frozen meter.
  IF v_lines <> (SELECT count(*) FROM community_commitments
                  WHERE cycle_code = p_cycle_code AND verification_state NOT IN ('cancelled', 'rejected')) THEN
    RAISE EXCEPTION 'ASB023: cycle % has commitments whose tier is missing from the frozen meter', p_cycle_code;
  END IF;

  -- 3. Verified demand enters fulfillment.
  UPDATE community_commitments c SET fulfillment_state = 'locked'
    FROM community_cycle_lock_lines l
   WHERE l.commitment_id = c.id AND l.cycle_code = p_cycle_code AND l.counted AND c.fulfillment_state = 'none';
  GET DIAGNOSTICS v_locked = ROW_COUNT;

  RETURN QUERY
    SELECT v_tiers, v_lines,
           (SELECT count(*)::int FROM community_cycle_lock_lines l WHERE l.cycle_code = p_cycle_code AND l.price_basis = 'tier_unlocked'),
           (SELECT count(*)::int FROM community_cycle_lock_lines l WHERE l.cycle_code = p_cycle_code AND l.price_basis = 'not_verified'),
           v_locked, FALSE;
END $$;

-- ---------------------------------------------------------------------------
-- The hook: the moment asb_lock_cycle flips a cycle to 'locked', Community
-- locks in the same transaction. No change to asb_lock_cycle itself.
-- ---------------------------------------------------------------------------
CREATE FUNCTION asb023_cycle_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM community_lock_cycle(NEW.code, 'asb_lock_cycle');
  RETURN NULL;
END $$;

CREATE TRIGGER trg_cycles_community_lock
  AFTER UPDATE OF status ON cycles
  FOR EACH ROW
  WHEN (NEW.status = 'locked' AND OLD.status IS DISTINCT FROM 'locked')
  EXECUTE FUNCTION asb023_cycle_locked();

-- Catch a wrong cutoff at INSERT, not hours later at lock: a commitment for a
-- known cycle must carry that cycle's exact locks_at (copy it in SQL; a
-- JavaScript Date drops the microseconds). A commitment for a code with no
-- cycles row is refused at lock instead.
CREATE FUNCTION asb023_commitment_cutoff() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v TIMESTAMPTZ;
BEGIN
  SELECT locks_at INTO v FROM cycles WHERE code = NEW.cycle_code;
  IF FOUND AND v IS DISTINCT FROM NEW.locks_at THEN
    RAISE EXCEPTION 'ASB023: commitment cutoff % differs from cycle % cutoff %', NEW.locks_at, NEW.cycle_code, v
      USING HINT = 'Set locks_at from cycles.locks_at in SQL.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER community_commitments_cutoff BEFORE INSERT ON community_commitments
  FOR EACH ROW EXECUTE FUNCTION asb023_commitment_cutoff();

-- What a household pays for its Community lines this cycle, at lock.
CREATE VIEW community_cycle_household_totals AS
SELECT cycle_code, household_key, quote_id, door,
       count(*)                                   AS lines,
       SUM(packs)                                 AS packs,
       SUM(ceiling_line_paisa)                    AS ceiling_paisa,
       SUM(locked_line_paisa)                     AS locked_paisa,
       SUM(ceiling_line_paisa - locked_line_paisa) AS community_saving_paisa,
       bool_and(counted)                          AS all_verified
  FROM community_cycle_lock_lines
 GROUP BY cycle_code, household_key, quote_id, door;

COMMIT;
