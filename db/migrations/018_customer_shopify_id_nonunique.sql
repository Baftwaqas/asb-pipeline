-- ============================================================================
-- ASB PIPELINE — 018_customer_shopify_id_nonunique.sql
--
-- Customer identity in ASB is the normalised phone number. A Shopify customer
-- id is useful provenance/metadata, but it is not a household identity: one
-- Shopify account may legitimately place orders for different phone numbers.
--
-- 001 made shopify_customer_id UNIQUE. That turns a normal returning-customer
-- case (same Shopify account, different delivery phone) into PostgreSQL 23505.
-- Under migration 017 the order is durable, but it retries and eventually
-- needs operator review. Remove that avoidable failure here.
--
-- Existing application code already upserts customers ON CONFLICT (phone)
-- and does not rely on shopify_customer_id being unique.
-- ============================================================================

BEGIN;

-- Do not queue Shopify/customer writes behind this DDL. If the customer table
-- cannot be locked promptly, abort the migration and retry in a quieter window.
SET LOCAL lock_timeout = '5s';

ALTER TABLE customers
  DROP CONSTRAINT IF EXISTS customers_shopify_customer_id_key;

CREATE INDEX IF NOT EXISTS idx_customers_shopify_customer_id
  ON customers (shopify_customer_id);

COMMIT;
