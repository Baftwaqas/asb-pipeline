-- ============================================================================
-- 026 — Bhao Tao aftercare (Lane C; depends on 025)
--
-- A bargain did not end at "Sauda pakka". The founder's live test (7 Nov):
-- she agreed at Rs 1,200, then wrote "order cancel karo, meri dost ne yahi
-- degchi 800 mein li hai" - and Seth Ji said nothing, because a finished
-- bargain no longer had a voice. A real seller answers.
--
--   bhao_conversations.status gains 'cancelled': she backed out of an
--   accepted deal. The accepted offer is KEPT (evidence of what was agreed
--   and then cancelled), so the rule becomes "an offer exists exactly when
--   the deal was accepted, whether or not it was later cancelled".
--   cancelled_at records when.
--
-- Changes nothing that exists: every row valid before stays valid.
-- ============================================================================
BEGIN;

ALTER TABLE bhao_conversations DROP CONSTRAINT bhao_conversations_status_check;
ALTER TABLE bhao_conversations ADD CONSTRAINT bhao_conversations_status_check
  CHECK (status IN ('open', 'accepted', 'closed', 'expired', 'cancelled'));

ALTER TABLE bhao_conversations DROP CONSTRAINT accepted_has_offer;
ALTER TABLE bhao_conversations ADD CONSTRAINT accepted_has_offer
  CHECK ((status IN ('accepted', 'cancelled')) = (accepted_offer IS NOT NULL));

ALTER TABLE bhao_conversations ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE bhao_conversations ADD CONSTRAINT cancelled_has_time
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

-- the code checks for this before using aftercare, so it degrades to the
-- old behaviour (the inbox only) on a database without 026
CREATE FUNCTION asb026_aftercare_ready() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;

COMMIT;
