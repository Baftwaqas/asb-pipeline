-- ============================================================================
-- ASB PIPELINE — migration 004: direct-Cloud-API inbox
--
-- Runs AFTER 001_init, 002_lock_engine and 003_bill_engine.
--
-- Purpose: make whatsapp_messages rich enough to render a real inbox, so the
-- only job AiSensy was still doing (letting a human read and answer customers)
-- moves in-house.
--
-- Every statement is additive and idempotent. Nothing is dropped, no existing
-- column changes type, and running this twice is a no-op. Safe to run against
-- the live Community Day database.
--
--   psql "$DATABASE_URL" -f db/migrations/004_inbox.sql
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Columns the inbox needs
--
-- profile_name : the WhatsApp display name from the webhook's `contacts` block.
--                Often the only name you have for a customer who has never
--                ordered through Shopify, so it is worth keeping separately
--                from customers.name rather than overwriting it.
-- msg_type     : text / image / audio / document / location / button /
--                interactive / sticker / unsupported. Drives the inbox icon and
--                tells you at a glance that a voice note came in.
-- media_id     : Meta's media id. NOT a URL — download URLs expire in minutes,
--                so the id is the only thing worth storing.
-- agent        : who sent an outbound free-form reply ('waqas', 'nadeem').
--                NULL for automated template sends from the pipeline.
-- received_at  : when an inbound message arrived. The 24-hour service window
--                is measured from the newest one, so the inbox cannot work
--                without it.
-- handled_at   : when a human dealt with this inbound message. Drives unread
--                counts. NULL = still needs an answer.
-- reply_to     : wamid this message quotes, when the customer used "reply".
-- ---------------------------------------------------------------------------
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS profile_name text,
  ADD COLUMN IF NOT EXISTS msg_type     text,
  ADD COLUMN IF NOT EXISTS media_id     text,
  ADD COLUMN IF NOT EXISTS media_mime   text,
  ADD COLUMN IF NOT EXISTS agent        text,
  ADD COLUMN IF NOT EXISTS received_at  timestamptz,
  ADD COLUMN IF NOT EXISTS handled_at   timestamptz,
  ADD COLUMN IF NOT EXISTS reply_to     text;

-- Backfill received_at for inbound rows written before this migration.
-- 001_init gives every row a created_at, which is the closest thing those rows
-- have to an arrival time; delivered_at and sent_at are the fallbacks. Only
-- touches NULLs, so re-running never rewrites a real arrival time.
UPDATE whatsapp_messages
   SET received_at = COALESCE(created_at, delivered_at, sent_at, now())
 WHERE direction = 'inbound'
   AND received_at IS NULL;

-- New inbound rows get it automatically; the app sets it explicitly anyway.
ALTER TABLE whatsapp_messages
  ALTER COLUMN received_at SET DEFAULT now();

-- Derive msg_type for existing rows from the stored payload.
UPDATE whatsapp_messages
   SET msg_type = COALESCE(payload->>'type', 'text')
 WHERE msg_type IS NULL
   AND direction = 'inbound';

-- ---------------------------------------------------------------------------
-- 2. Indexes
--
-- The inbox runs two queries on every poll: "newest message per phone" and
-- "the thread for this phone". Both are covered here. On a table this size it
-- hardly matters today, but the conversation list query is O(table) without
-- the first index and Community Day is exactly when you don't want to find out.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_wa_msgs_phone_time
  ON whatsapp_messages (phone, COALESCE(received_at, sent_at) DESC);

CREATE INDEX IF NOT EXISTS idx_wa_msgs_unhandled
  ON whatsapp_messages (received_at DESC)
  WHERE direction = 'inbound' AND handled_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. asb_conversations — one row per customer phone, newest first
--
-- This is a VIEW, not a table, deliberately: a conversations table would need
-- to be kept in sync with every insert, and a missed update means an agent
-- sees a stale window and gets a 131047 rejection. Derived state cannot drift.
--
-- window_open is the important column. WhatsApp only lets you send free-form
-- text within 24 hours of the customer's last message. Outside that you need
-- an approved template. The inbox greys out the reply box on this flag.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW asb_conversations AS
WITH last_inbound AS (
  SELECT phone, max(received_at) AS last_inbound_at
    FROM whatsapp_messages
   WHERE direction = 'inbound'
   GROUP BY phone
),
last_any AS (
  SELECT DISTINCT ON (phone)
         phone,
         COALESCE(received_at, sent_at) AS last_at,
         direction                      AS last_direction,
         body_preview                   AS last_preview,
         msg_type                       AS last_type
    FROM whatsapp_messages
   ORDER BY phone, COALESCE(received_at, sent_at) DESC NULLS LAST
),
unread AS (
  SELECT phone, count(*) AS unread_count
    FROM whatsapp_messages
   WHERE direction = 'inbound' AND handled_at IS NULL
   GROUP BY phone
),
names AS (
  SELECT DISTINCT ON (phone) phone, profile_name
    FROM whatsapp_messages
   WHERE profile_name IS NOT NULL
   ORDER BY phone, COALESCE(received_at, sent_at) DESC NULLS LAST
)
SELECT
  la.phone,
  COALESCE(c.name, n.profile_name)                      AS display_name,
  n.profile_name,
  c.id                                                  AS customer_id,
  c.society_id,
  c.badge,
  la.last_at,
  la.last_direction,
  la.last_preview,
  la.last_type,
  li.last_inbound_at,
  (li.last_inbound_at > now() - interval '24 hours')     AS window_open,
  -- Minutes of free-form replying left. Negative or NULL means template-only.
  CASE
    WHEN li.last_inbound_at IS NULL THEN NULL
    ELSE GREATEST(
      0,
      floor(EXTRACT(EPOCH FROM (li.last_inbound_at + interval '24 hours' - now())) / 60)
    )::int
  END                                                   AS window_minutes_left,
  COALESCE(u.unread_count, 0)::int                      AS unread_count
FROM last_any la
LEFT JOIN last_inbound li ON li.phone = la.phone
LEFT JOIN unread      u  ON u.phone  = la.phone
LEFT JOIN names       n  ON n.phone  = la.phone
LEFT JOIN customers   c  ON c.phone  = la.phone
ORDER BY la.last_at DESC NULLS LAST;

COMMENT ON VIEW asb_conversations IS
  'One row per WhatsApp contact for the ASB inbox. window_open = free-form '
  'replies allowed (customer messaged within 24h); otherwise template only.';

-- ---------------------------------------------------------------------------
-- 4. asb_mark_handled — clear the unread flag for one conversation
--
-- Called when an agent opens a thread or sends a reply. Returns how many
-- messages it cleared, which the API passes back so the UI can update its
-- badge without a second round trip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION asb_mark_handled(p_phone text)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE whatsapp_messages
     SET handled_at = now()
   WHERE phone = p_phone
     AND direction = 'inbound'
     AND handled_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- SELECT phone, display_name, window_open, window_minutes_left, unread_count
--   FROM asb_conversations LIMIT 20;
