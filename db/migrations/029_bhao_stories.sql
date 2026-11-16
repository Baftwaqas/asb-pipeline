-- ============================================================================
-- 029 — Asli Kahaniyan: real-history story game (Lane C; depends on 028)
--
-- Founder, 16 Nov: the customer plays a real moment from history blind - 4
-- decisions, 60 seconds each, hidden meters, a dramatic ending, then the
-- reveal of what really happened. Points join the same weekly society
-- leaderboard as Seth Ji ke Case (bhao_players).
--
-- Changes nothing that exists.
-- ============================================================================
BEGIN;

CREATE TABLE bhao_story_plays (
  id           BIGSERIAL PRIMARY KEY,
  phone        TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,15}$'),
  story_id     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('playing', 'done')),
  step         INTEGER NOT NULL DEFAULT 0 CHECK (step >= 0),   -- the decision she is on (0-based)
  flags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  meters       JSONB NOT NULL DEFAULT '[0,0,0]'::jsonb,
  picks        JSONB NOT NULL DEFAULT '[]'::jsonb,              -- [{choice, late}] per decision
  step_at      TIMESTAMPTZ NOT NULL,                            -- when this decision was handed to her
  started_at   TIMESTAMPTZ NOT NULL,
  ended_at     TIMESTAMPTZ,
  points       INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0),
  CONSTRAINT story_ended_when_done CHECK ((status = 'done') = (ended_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_bhao_one_story_playing ON bhao_story_plays (phone) WHERE status = 'playing';
CREATE UNIQUE INDEX uq_bhao_story_once ON bhao_story_plays (phone, story_id);
CREATE INDEX idx_bhao_story_plays_ended ON bhao_story_plays (ended_at) WHERE ended_at IS NOT NULL;

CREATE FUNCTION asb029_stories_ready() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;

COMMIT;
