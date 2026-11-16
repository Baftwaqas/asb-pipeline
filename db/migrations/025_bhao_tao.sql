-- ============================================================================
-- 025 — Bhao Tao on WhatsApp (Lane C; depends on 024 for competitor prices)
--
--   bhao_items          the NON-grocery items Seth Ji may bargain on, with
--                       founder-approved anchor / floor / cost / group tiers
--                       and the only product facts he may state.
--   bhao_conversations  one bargain: a phone, an item, the engine state.
--                       A household cannot restart to reset the price: a new
--                       conversation within 7 days of the last one on the
--                       same item continues from that ask (never lower,
--                       never higher).
--   bhao_messages       every line in and out, append-only, with the engine
--                       decision, where the words came from (ai / template),
--                       why any AI reply was rejected, and when an outgoing
--                       line is due (Seth Ji does not answer instantly).
--
-- Off unless BHAO_TAO_WHATSAPP=on. Changes nothing that exists.
-- ============================================================================
BEGIN;

CREATE TABLE bhao_items (
  item_id          TEXT PRIMARY KEY CHECK (item_id ~ '^[A-Z0-9][A-Z0-9-]{2,40}$'),
  variant_gid      TEXT NOT NULL CHECK (variant_gid ~ '^gid://shopify/ProductVariant/[0-9]+$'),
  name             TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  anchor_paisa     BIGINT NOT NULL CHECK (anchor_paisa > 0),
  floor_paisa      BIGINT NOT NULL CHECK (floor_paisa > 0),
  cost_paisa       BIGINT CHECK (cost_paisa IS NULL OR cost_paisa >= 0),
  group_tiers      JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(group_tiers) = 'array'),
  max_qty          INTEGER NOT NULL DEFAULT 10 CHECK (max_qty BETWEEN 1 AND 100),
  facts            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(facts) = 'array'),
  stock_left       INTEGER CHECK (stock_left IS NULL OR stock_left >= 0),
  approved_by      TEXT NOT NULL CHECK (length(btrim(approved_by)) > 0),
  approved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT floor_not_above_anchor CHECK (floor_paisa <= anchor_paisa),
  CONSTRAINT floor_not_below_cost CHECK (cost_paisa IS NULL OR floor_paisa >= cost_paisa)
);

CREATE TABLE bhao_conversations (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT NOT NULL CHECK (phone ~ '^[0-9]{10,15}$'),
  item_id          TEXT NOT NULL REFERENCES bhao_items(item_id) ON DELETE RESTRICT,
  status           TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'closed', 'expired')),
  state            JSONB NOT NULL,
  policy_version   TEXT NOT NULL,
  accepted_offer   JSONB,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_inbound_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  CONSTRAINT accepted_has_offer CHECK ((status = 'accepted') = (accepted_offer IS NOT NULL))
);
-- at most one open bargain per phone at a time (her next message has one home)
CREATE UNIQUE INDEX uq_bhao_one_open_per_phone ON bhao_conversations (phone) WHERE status = 'open';
CREATE INDEX idx_bhao_conversations_recent ON bhao_conversations (phone, item_id, started_at DESC);

CREATE TABLE bhao_messages (
  id               BIGSERIAL PRIMARY KEY,
  conversation_id  BIGINT NOT NULL REFERENCES bhao_conversations(id) ON DELETE RESTRICT,
  direction        TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  inbound_wamid    TEXT UNIQUE,                       -- in: Meta id, makes redelivery a no-op
  body             TEXT NOT NULL,
  decision         JSONB,                             -- out: the engine action it voices
  source           TEXT CHECK (source IS NULL OR source IN ('ai', 'template')),
  provider         TEXT,
  rejected         JSONB,
  send_after       TIMESTAMPTZ,                       -- out: not before (Seth Ji's pause)
  send_status      TEXT CHECK (send_status IS NULL OR send_status IN ('pending', 'sent', 'failed', 'superseded')),
  sent_wamid       TEXT,
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT in_has_wamid CHECK (direction = 'out' OR inbound_wamid IS NOT NULL),
  CONSTRAINT out_is_scheduled CHECK (direction = 'in' OR (send_after IS NOT NULL AND send_status IS NOT NULL))
);
CREATE INDEX idx_bhao_messages_due ON bhao_messages (send_after) WHERE send_status = 'pending';

-- Messages are evidence: only an outgoing line's send fields may change,
-- and only forward (pending -> sent | failed | superseded).
CREATE FUNCTION asb025_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ASB025: bhao_messages are never deleted'; END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.decision IS DISTINCT FROM OLD.decision
     OR NEW.inbound_wamid IS DISTINCT FROM OLD.inbound_wamid OR NEW.send_after IS DISTINCT FROM OLD.send_after
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ASB025: a bhao message is immutable once written';
  END IF;
  IF NEW.send_status IS DISTINCT FROM OLD.send_status AND OLD.send_status <> 'pending' THEN
    RAISE EXCEPTION 'ASB025: send status % is final', OLD.send_status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bhao_messages_guard BEFORE UPDATE OR DELETE ON bhao_messages
  FOR EACH ROW EXECUTE FUNCTION asb025_messages_guard();
CREATE FUNCTION asb025_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ASB025: % on % is not allowed', TG_OP, TG_TABLE_NAME; END $$;
CREATE TRIGGER bhao_messages_no_truncate BEFORE TRUNCATE ON bhao_messages
  FOR EACH STATEMENT EXECUTE FUNCTION asb025_refuse();
CREATE TRIGGER bhao_conversations_no_delete BEFORE DELETE ON bhao_conversations
  FOR EACH ROW EXECUTE FUNCTION asb025_refuse();
CREATE TRIGGER bhao_items_no_delete BEFORE DELETE ON bhao_items
  FOR EACH ROW EXECUTE FUNCTION asb025_refuse();

COMMIT;
