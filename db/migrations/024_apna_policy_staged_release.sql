-- ADR-002: founder-signed Apna quantity policies: STAGING STORAGE ONLY.
-- Signing does NOT deploy policy. Activation requires separately reviewed gate.
-- No mutation of grocery product/price tables or customer/order data.
BEGIN;
CREATE TABLE checkout_apna_policy_releases (
  release_id TEXT PRIMARY KEY
    CHECK (release_id ~ '^apna-signed-[0-9a-f]{24}$'),
  shop_domain TEXT NOT NULL
    CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]*[.]myshopify[.]com$'),
  signed_envelope JSONB NOT NULL,
  authorized_by TEXT NOT NULL CHECK (authorized_by ~ '^[1-9][0-9]*$'),
  issued_at TIMESTAMPTZ NOT NULL,
  source_expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  state TEXT NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged','active','revoked')),
  activated_at TIMESTAMPTZ,
  activated_by TEXT,
  effective_delivery_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkout_apna_source_time CHECK (
    source_expires_at > issued_at AND
    source_expires_at <= issued_at + INTERVAL '1 hour' AND
    verified_at >= issued_at AND verified_at < source_expires_at
  ),
  CONSTRAINT checkout_apna_active_metadata CHECK (
    state <> 'active' OR
    (activated_at IS NOT NULL AND activated_by IS NOT NULL AND
     activated_by ~ '^[1-9][0-9]*$' AND effective_delivery_date IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_checkout_one_active_apna_release_per_shop
  ON checkout_apna_policy_releases(shop_domain) WHERE state='active';

CREATE TABLE checkout_apna_variant_bindings (
  release_id TEXT NOT NULL REFERENCES checkout_apna_policy_releases(release_id)
    ON DELETE RESTRICT,
  variant_gid TEXT NOT NULL
    CHECK (variant_gid ~ '^gid://shopify/ProductVariant/[1-9][0-9]*$'),
  product_gid TEXT NOT NULL
    CHECK (product_gid ~ '^gid://shopify/Product/[1-9][0-9]*$'),
  canonical_product_id TEXT NOT NULL
    CHECK (canonical_product_id ~ '^[A-Z0-9][A-Z0-9_-]{2,79}$'),
  unit TEXT NOT NULL CHECK (unit IN ('g','piece')),
  pack_quantity INTEGER NOT NULL CHECK (pack_quantity > 0),
  sku TEXT,
  PRIMARY KEY (release_id,variant_gid)
);
CREATE INDEX ix_checkout_apna_bindings_canonical
  ON checkout_apna_variant_bindings(release_id,canonical_product_id);

CREATE TABLE checkout_apna_release_audit (
  id BIGSERIAL PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES checkout_apna_policy_releases(release_id)
    ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'SIGNED_CANDIDATE_STAGED','INDEPENDENT_REVIEW_APPROVED',
    'ACTIVATED','REVOKED','REJECTED'
  )),
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE checkout_apna_policy_releases IS
  'Founder-signed candidate policy: staged is NOT active. Activation is a separate, audited manual change; never inferred from a signed download.';
COMMENT ON TABLE checkout_apna_variant_bindings IS
  'Shopify variant-to-pack bindings validated from server-observed current Shopify catalogue at import time. Prices remain Shopify-owned.';
COMMIT;
