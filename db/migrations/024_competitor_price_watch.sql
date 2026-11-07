-- ============================================================================
-- 024 — Competitor price watch for Bhao Tao (Lane C)
--
-- Seth Ji may say "Daraz pe yehi Rs 2,350 ki hai" ONLY when ASB holds a
-- recent, automatically checked price for THAT SAME item on THAT
-- marketplace, and ours is lower. This is where those prices live.
--
--   competitor_price_watches  one row per (our item, a competitor's product
--                             page) that a PERSON confirmed is the same item
--                             (size, material, brand). The person is named.
--   competitor_price_checks   append-only result of every automatic check:
--                             the price, or why there is none (robots rule,
--                             HTTP error, page not readable, out of stock).
--   competitor_price_latest   latest check per watch.
--
-- The checker (scripts/price-watch-run.js) reads only the product pages
-- listed here, never search or catalogue pages, obeys the site's
-- robots.txt, identifies itself, and never works around a block: a blocked
-- or unreadable page is recorded as such and simply not used.
--
-- Changes nothing that exists. Nothing reads these tables except the
-- Bhao Tao voice. Deploy with the rest of Bhao Tao, with Waqas's approval.
-- ============================================================================
BEGIN;

CREATE TABLE competitor_price_watches (
  id                     BIGSERIAL PRIMARY KEY,
  item_id                TEXT NOT NULL CHECK (length(btrim(item_id)) > 0),
  marketplace            TEXT NOT NULL CHECK (marketplace ~ '^[a-z][a-z0-9_]{1,30}$'),
  url                    TEXT NOT NULL CHECK (url ~ '^https://[^\s]+$' AND length(url) <= 2000),
  confirmed_same_item_by TEXT NOT NULL CHECK (length(btrim(confirmed_same_item_by)) > 0),
  confirmed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  note                   TEXT,
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, marketplace, url)
);

CREATE TABLE competitor_price_checks (
  id           BIGSERIAL PRIMARY KEY,
  watch_id     BIGINT NOT NULL REFERENCES competitor_price_watches(id) ON DELETE RESTRICT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  status       TEXT NOT NULL CHECK (status IN ('ok', 'unavailable', 'blocked_by_robots', 'http_error', 'parse_failed', 'fetch_failed')),
  http_status  INTEGER,
  price_paisa  BIGINT CHECK (price_paisa IS NULL OR price_paisa > 0),
  via          TEXT,
  CONSTRAINT price_iff_ok CHECK ((status = 'ok') = (price_paisa IS NOT NULL))
);
CREATE INDEX idx_competitor_price_checks_watch ON competitor_price_checks (watch_id, checked_at DESC);

CREATE FUNCTION asb024_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ASB024: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME;
END $$;
CREATE TRIGGER competitor_price_checks_append_only
  BEFORE UPDATE OR DELETE ON competitor_price_checks FOR EACH ROW EXECUTE FUNCTION asb024_refuse();
CREATE TRIGGER competitor_price_checks_no_truncate
  BEFORE TRUNCATE ON competitor_price_checks FOR EACH STATEMENT EXECUTE FUNCTION asb024_refuse();
-- A watch is never deleted (its checks are evidence); it is deactivated.
CREATE TRIGGER competitor_price_watches_no_delete
  BEFORE DELETE ON competitor_price_watches FOR EACH ROW EXECUTE FUNCTION asb024_refuse();

CREATE VIEW competitor_price_latest AS
SELECT DISTINCT ON (w.id)
       w.id AS watch_id, w.item_id, w.marketplace, w.url, w.active,
       c.checked_at, c.status, c.http_status, c.price_paisa, c.via
  FROM competitor_price_watches w
  LEFT JOIN competitor_price_checks c ON c.watch_id = w.id
 ORDER BY w.id, c.checked_at DESC NULLS LAST, c.id DESC;

COMMIT;
