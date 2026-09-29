-- ============================================================================
-- ASB PIPELINE — migration 014: contacts brought over from AiSensy
--
-- Our audience used to be "Shopify customers + anyone who has messaged the
-- new pipeline". Everyone who messaged the number while AiSensy ran it lived
-- only inside AiSensy — about 2,200 people, most of them from the ads. This
-- table keeps them so the rate list still reaches them after AiSensy is gone.
--
--   marketing_contacts   one row per number. `source` says where it came
--                        from ('aisensy'); `first_seen` is when that contact
--                        first messaged, as AiSensy recorded it.
--
-- Numbers AiSensy had BLOCKED go into marketing_opt_outs (source
-- 'aisensy_blocked') by the import route, so a rate list never reaches them.
--
-- Additive and idempotent.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS marketing_contacts (
  phone        TEXT PRIMARY KEY,
  name         TEXT,
  source       TEXT NOT NULL,
  first_seen   TIMESTAMPTZ,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
