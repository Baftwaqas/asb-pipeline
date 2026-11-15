-- 023: ASB ADR-002 DEV-ONLY quote redemption reservation.
-- Strictly additive. No Shopify write, network call, webhook or customer mutation.
-- In production, the policy validator and signed quote issuer MUST be independently reviewed.
BEGIN;
CREATE TABLE checkout_quotes (
  quote_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK (version > 0),
  shop_domain TEXT NOT NULL CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'),
  household_key TEXT NOT NULL,
  cycle_code TEXT NOT NULL,
  delivery_date DATE NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  signed_quote JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_quote_window CHECK (expires_at > issued_at),
  CONSTRAINT checkout_quote_household CHECK (length(btrim(household_key)) > 0)
);
COMMENT ON TABLE checkout_quotes IS
  'ADR-002: server-issued HMAC quote snapshot. No client-supplied prices, rule decisions, shop or household may be substituted.';

CREATE TABLE checkout_household_cycle_locks (
  shop_domain TEXT NOT NULL,
  household_key TEXT NOT NULL,
  cycle_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (shop_domain, household_key, cycle_code)
);
COMMENT ON TABLE checkout_household_cycle_locks IS
  'ADR-002: immutable household/cycle transaction serialization key, not a countable commitment or Rate Meter confirmation.';

CREATE TABLE checkout_redemptions (
  claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id TEXT NOT NULL UNIQUE REFERENCES checkout_quotes(quote_id) ON DELETE RESTRICT,
  quote_version INTEGER NOT NULL CHECK (quote_version > 0),
  shop_domain TEXT NOT NULL,
  household_key TEXT NOT NULL,
  cycle_code TEXT NOT NULL,
  redemption_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('creating','needs_reconcile','completed')),
  policy_version TEXT NOT NULL,
  expected_cod_paisa BIGINT CHECK (expected_cod_paisa IS NULL OR expected_cod_paisa >= 0),
  shopify_order_gid TEXT UNIQUE,
  reconcile_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT checkout_redeem_household CHECK (length(btrim(household_key)) > 0),
  CONSTRAINT checkout_completed_has_order CHECK (state <> 'completed' OR
    (shopify_order_gid IS NOT NULL AND expected_cod_paisa IS NOT NULL)),
  CONSTRAINT checkout_redemption_key_format CHECK (redemption_key ~ '^asb-adr002-[a-f0-9]{40}$')
);
CREATE UNIQUE INDEX uq_checkout_one_household_cycle
  ON checkout_redemptions(shop_domain, household_key, cycle_code);
COMMENT ON TABLE checkout_redemptions IS
  'ADR-002: ONE durable Shopify order creation attempt per quote and household/delivery cycle. Unknown results require manual reconciliation; no automatic retry.';
COMMIT;
