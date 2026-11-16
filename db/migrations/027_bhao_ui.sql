-- ============================================================================
-- 027 — Bhao Tao picture cards and tap buttons (Lane C; depends on 025)
--
-- An outgoing Seth Ji line may now carry a UI: tap buttons ("✅ Rs 1,800
-- manzoor", "🙋 Apna daam", "💵 Advance pe kitna?") and/or a picture card
-- (the Bhao Card, the victory card). bhao_messages.ui records exactly what
-- was offered, so the evidence trail shows the buttons she saw. body stays
-- the plain-text fallback, sent whenever a card or button cannot be.
--
-- Like the rest of a message, ui never changes once written.
-- ============================================================================
BEGIN;

ALTER TABLE bhao_messages ADD COLUMN ui JSONB CHECK (ui IS NULL OR jsonb_typeof(ui) = 'object');

CREATE OR REPLACE FUNCTION asb025_messages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ASB025: bhao_messages are never deleted'; END IF;
  IF NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.body IS DISTINCT FROM OLD.body OR NEW.decision IS DISTINCT FROM OLD.decision
     OR NEW.inbound_wamid IS DISTINCT FROM OLD.inbound_wamid OR NEW.send_after IS DISTINCT FROM OLD.send_after
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.ui IS DISTINCT FROM OLD.ui THEN
    RAISE EXCEPTION 'ASB025: a bhao message is immutable once written';
  END IF;
  IF NEW.send_status IS DISTINCT FROM OLD.send_status AND OLD.send_status <> 'pending' THEN
    RAISE EXCEPTION 'ASB025: send status % is final', OLD.send_status;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
