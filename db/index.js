// ============================================================================
// ASB PIPELINE — db/index.js
// Postgres connection layer for Render
//
// Exports:
//   query(text, params)          — one-off query, logs slow ones
//   tx(async (client) => {...})  — transaction, auto COMMIT/ROLLBACK
//   recordWebhook(...)           — insert-first dedupe for Shopify + Meta
//   markWebhookProcessed/Failed  — close out a webhook event
//   health()                     — connectivity check for /healthz
//   shutdown()                   — drain the pool on SIGTERM
// ============================================================================

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('[db] FATAL: DATABASE_URL is not set. Add it in Render → Environment.');
  process.exit(1);
}

// TLS decision, by hostname.
//
// This used to test for `.render.com` specifically, which silently breaks the
// moment the database lives anywhere else: a Neon URL
// (`ep-xxx.us-east-1.aws.neon.tech`) did not match, SSL was switched OFF, and
// Neon — which requires TLS — refused the connection. The failure reads like a
// bad password, so it costs an hour to find.
//
// The real rule is about the hostname's shape, not its brand:
//   * Render's INTERNAL host is a bare name with no dots (`dpg-xxxxx-a`) and
//     sits on a private network — no TLS needed.
//   * localhost / 127.0.0.1 — no TLS needed.
//   * Anything else crosses the public internet and must use TLS.
//
// rejectUnauthorized is false because Render's certs are signed by a CA that
// isn't in Node's default trust store. Traffic is still encrypted. Neon's certs
// DO verify properly, so once Render is out of the picture this can become
// `{ rejectUnauthorized: true }`.
let dbHost = '';
try {
  dbHost = new URL(connectionString).hostname;
} catch (_) {
  // Not a URL (e.g. a key=value DSN). Fall back to requiring TLS — the safe
  // default for anything we cannot positively identify as local.
}
const isLocal =
  dbHost === 'localhost' ||
  dbHost === '127.0.0.1' ||
  dbHost === '::1' ||
  (dbHost !== '' && !dbHost.includes('.'));   // Render internal: no dots

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },

  // Free-tier Postgres has a low connection ceiling and the web service is a
  // single instance. Five is plenty and leaves headroom for psql sessions.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,

  // Community Day is bursty: a slow query holding a connection is worse than
  // a failed one. Cut anything that runs longer than 15s.
  statement_timeout: 15_000,
  query_timeout: 15_000,
});

pool.on('error', (err) => {
  // Fires when an IDLE client dies — Render restarting the database, or Neon
  // scaling a compute to zero after 5 minutes idle (which drops open
  // connections by design). The pool replaces it on the next query, so this is
  // a log line, not a crash. On Neon this is expected and harmless.
  console.error('[db] idle client error:', err.message);
});

console.log(
  `[db] pool ready (host ${dbHost || 'unparsed'}, ` +
    `${isLocal ? 'no tls' : 'tls'}, max 5)`
);

// ---------------------------------------------------------------------------
// query — for anything that fits in a single statement
// ---------------------------------------------------------------------------

async function query(text, params = []) {
  const started = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - started;
    if (ms > 1000) {
      console.warn(`[db] slow query ${ms}ms: ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
    }
    return res;
  } catch (err) {
    // Surface the Postgres error code — ASB_GUARD / ASB_LOCK messages from the
    // migrations come through as err.message, which is what callers want to show.
    console.error(`[db] query failed [${err.code || 'no-code'}]: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// tx — multi-statement work that must be all-or-nothing
//
//   await tx(async (c) => {
//     const { rows } = await c.query('INSERT INTO orders ... RETURNING id');
//     await c.query('INSERT INTO order_items ...', [rows[0].id]);
//   });
// ---------------------------------------------------------------------------

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release(); // always, even if COMMIT threw
  }
}

// ---------------------------------------------------------------------------
// WEBHOOK IDEMPOTENCY
//
// Shopify retries a webhook if it doesn't get a 200 within 5 seconds. On a free
// Render instance that just woke from sleep, that is a realistic scenario — so
// the SAME order can arrive three or four times.
//
// The rule: INSERT FIRST, PROCESS SECOND.
//   const { isNew } = await recordWebhook(...);
//   if (!isNew) return res.sendStatus(200);   // already have it, ack and stop
//
// The UNIQUE(source, event_id) constraint does the deduping, so two concurrent
// deliveries of the same event cannot both win.
// ---------------------------------------------------------------------------

async function recordWebhook(source, eventId, topic, payload) {
  if (!eventId) {
    // No id header means we can't dedupe. Better to know than to guess.
    throw new Error(`[db] recordWebhook: missing eventId for source="${source}"`);
  }

  const { rows } = await query(
    `INSERT INTO webhook_events (source, event_id, topic, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (source, event_id) DO NOTHING
     RETURNING id`,
    [source, String(eventId), topic || null, payload || {}]
  );

  if (rows.length > 0) {
    return { isNew: true, id: rows[0].id };
  }

  // Conflict: we've seen this event before. Fetch the original row so the
  // caller can log which delivery it duplicates.
  const existing = await query(
    `SELECT id, status, received_at, processed_at
       FROM webhook_events
      WHERE source = $1 AND event_id = $2`,
    [source, String(eventId)]
  );

  return { isNew: false, id: existing.rows[0]?.id, existing: existing.rows[0] };
}

async function markWebhookProcessed(id) {
  await query(
    `UPDATE webhook_events
        SET status = 'processed', processed_at = now(), attempts = attempts + 1
      WHERE id = $1`,
    [id]
  );
}

async function markWebhookFailed(id, error) {
  await query(
    `UPDATE webhook_events
        SET status = 'failed', attempts = attempts + 1,
            error_detail = $2
      WHERE id = $1`,
    [id, String(error).slice(0, 2000)]
  );
}

// ---------------------------------------------------------------------------
// health — cheap check for a /healthz route or a startup probe
// ---------------------------------------------------------------------------

async function health() {
  try {
    const { rows } = await query(
      `SELECT now() AS at,
              (SELECT count(*) FROM pg_proc WHERE proname LIKE 'asb%') AS asb_functions,
              (SELECT count(*) FROM information_schema.tables
                WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables`
    );
    const r = rows[0];
    return {
      ok: true,
      at: r.at,
      tables: Number(r.tables),
      asbFunctions: Number(r.asb_functions),
      // 10 tables + 15 asb_* functions is a fully migrated database.
      migrated: Number(r.tables) >= 10 && Number(r.asb_functions) >= 15,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// shutdown — Render sends SIGTERM before replacing an instance
// ---------------------------------------------------------------------------

async function shutdown() {
  console.log('[db] draining pool…');
  try {
    await pool.end();
    console.log('[db] pool closed');
  } catch (err) {
    console.error('[db] error closing pool:', err.message);
  }
}

process.once('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});

module.exports = {
  pool,
  query,
  tx,
  recordWebhook,
  markWebhookProcessed,
  markWebhookFailed,
  health,
  shutdown,
};
