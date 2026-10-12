BEGIN;

DO $$
DECLARE
  shopify_unique_count integer;
  shopify_lookup_count integer;
  phone_unique_count integer;
BEGIN
  -- Shopify customer ID must NOT uniquely identify an ASB customer.
  SELECT count(*)
    INTO shopify_unique_count
    FROM pg_index i
    JOIN pg_class t
      ON t.oid = i.indrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY(i.indkey::smallint[])
   WHERE n.nspname = 'public'
     AND t.relname = 'customers'
     AND i.indisunique
     AND i.indnkeyatts = 1
     AND a.attname = 'shopify_customer_id';

  IF shopify_unique_count <> 0 THEN
    RAISE EXCEPTION
      '019 invariant failed: customers.shopify_customer_id is still unique';
  END IF;

  -- Expected non-unique lookup index from migration 018 must exist.
  SELECT count(*)
    INTO shopify_lookup_count
    FROM pg_index i
    JOIN pg_class t
      ON t.oid = i.indrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    JOIN pg_class idx
      ON idx.oid = i.indexrelid
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY(i.indkey::smallint[])
   WHERE n.nspname = 'public'
     AND t.relname = 'customers'
     AND idx.relname = 'idx_customers_shopify_customer_id'
     AND NOT i.indisunique
     AND i.indnkeyatts = 1
     AND a.attname = 'shopify_customer_id';

  IF shopify_lookup_count <> 1 THEN
    RAISE EXCEPTION
      '019 invariant failed: expected non-unique Shopify customer lookup index is missing';
  END IF;

  -- Normalized phone remains the ASB customer identity key.
  SELECT count(*)
    INTO phone_unique_count
    FROM pg_index i
    JOIN pg_class t
      ON t.oid = i.indrelid
    JOIN pg_namespace n
      ON n.oid = t.relnamespace
    JOIN pg_attribute a
      ON a.attrelid = t.oid
     AND a.attnum = ANY(i.indkey::smallint[])
   WHERE n.nspname = 'public'
     AND t.relname = 'customers'
     AND i.indisunique
     AND i.indnkeyatts = 1
     AND a.attname = 'phone';

  IF phone_unique_count = 0 THEN
    RAISE EXCEPTION
      '019 invariant failed: customers.phone is no longer unique';
  END IF;
END
$$;

COMMIT;