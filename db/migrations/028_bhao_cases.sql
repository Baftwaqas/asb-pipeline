-- ============================================================================
-- 028 — Seth Ji ke Case: the role-play game and its society leaderboard
--       (Lane C; depends on 025 and 001's societies / customers)
--
-- Founder, 15 Nov: a customer stuck on a price - or anyone, any time - plays
-- a 90-second case in a role (detective, doctor, pilot...). Solving it earns
-- points; in a bargain it also wins her price. Points count for her SOCIETY
-- on a weekly leaderboard, once her society is verified against the delivery
-- address ASB has on record (customers.society_id).
--
--   bhao_players     one row per phone: the society she named, whether it is
--                    verified, and whether Seth Ji is waiting for her to type it
--   bhao_case_plays  one row per case played: a case is played once per phone
--
-- Changes nothing that exists.
-- ============================================================================
BEGIN;

CREATE TABLE bhao_players (
  phone             TEXT PRIMARY KEY CHECK (phone ~ '^[0-9]{10,15}$'),
  society_id        BIGINT REFERENCES societies(id) ON DELETE SET NULL,
  society_text      TEXT,                              -- what she typed
  society_verified  BOOLEAN NOT NULL DEFAULT FALSE,    -- matches her delivery address on record
  awaiting          TEXT CHECK (awaiting IS NULL OR awaiting IN ('society')),
  awaiting_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bhao_case_plays (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,15}$'),
  case_id          TEXT NOT NULL,
  role             TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('bargain', 'free')),
  conversation_id  BIGINT REFERENCES bhao_conversations(id) ON DELETE RESTRICT,
  status           TEXT NOT NULL CHECK (status IN ('playing', 'won', 'lost', 'timeout')),
  options          JSONB NOT NULL,                     -- the order she saw the answers in
  clues_used       JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  seconds_used     INTEGER,
  points           INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  CONSTRAINT bargain_has_conversation CHECK ((mode = 'bargain') = (conversation_id IS NOT NULL)),
  CONSTRAINT ended_when_not_playing CHECK ((status = 'playing') = (ended_at IS NULL))
);
-- one case at a time per phone; each case once per phone
CREATE UNIQUE INDEX uq_bhao_one_case_playing ON bhao_case_plays (phone) WHERE status = 'playing';
CREATE UNIQUE INDEX uq_bhao_case_once ON bhao_case_plays (phone, case_id);
CREATE INDEX idx_bhao_case_plays_ended ON bhao_case_plays (ended_at) WHERE ended_at IS NOT NULL;

-- the code checks for this before offering the game
CREATE FUNCTION asb028_cases_ready() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;

COMMIT;
