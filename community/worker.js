// ============================================================================
// ASB PIPELINE — community/worker.js
//
// Phase 1 worker for community_intake. It does exactly two things:
//   * validate the line (quantity, identity), and
//   * resolve it to the locally registered Community variant - by exact
//     Shopify variant id ONLY. SKU never resolves anything.
//
// States:   received ──▶ resolved
//                    ├──▶ review            (fail closed; a person decides)
//                    └──▶ retryable_error ──▶ (retried with backoff) ──▶ ...
//                                          └──▶ review after MAX_ATTEMPTS
//
// It creates NO commitments, writes NO meter, sends NO messages, and never
// touches orders / order_items / products / cycle_prices.
//
// The sweeper (start()) re-runs runOnce() on a timer, so a row left behind by
// a crash, a deploy or a failed attempt is always picked up again.
// ============================================================================

"use strict";

const { variantGid } = require("./registry");

const MAX_ATTEMPTS = Number(process.env.COMMUNITY_INTAKE_MAX_ATTEMPTS || 8);
const BASE_BACKOFF_S = 30;
const MAX_BACKOFF_S = 3600;

const review = (reason) => ({ status: "review", reason });

/**
 * Decide one intake row. Pure apart from reading the registry.
 * Returns { status:'resolved', variantGid, productId } or { status:'review', reason }.
 */
async function resolveLine(q, row) {
  if (row.quantity === null || row.quantity === undefined) return review("invalid_quantity");
  if (Number(row.quantity) !== 1) return review("quantity_not_one");
  if (!row.shopify_variant_id) return review("no_variant_id");

  const { rows } = await q.query(
    `SELECT v.shopify_variant_id, v.variant_gid, v.shopify_product_id, v.sku, v.is_present,
            p.signals_ok, p.shopify_status, p.deleted_at
       FROM community_variants v
       JOIN community_products p ON p.shopify_product_id = v.shopify_product_id
      WHERE v.shopify_variant_id = $1`,
    [row.shopify_variant_id]
  );
  const v = rows[0];
  if (!v) return review(row.signals?.includes("sku_prefix") ? "unknown_variant_with_community_sku" : "unknown_variant");
  if (row.shopify_product_id && row.shopify_product_id !== v.shopify_product_id) return review("product_mismatch");
  if (!v.signals_ok) return review("registry_config_conflict");
  if (v.deleted_at || v.shopify_status === "deleted") return review("product_deleted");
  if (v.shopify_status === "archived") return review("product_archived");
  if (!v.is_present) return review("variant_not_present");
  if ((row.sku || "") !== (v.sku || "")) return review("sku_mismatch");

  return { status: "resolved", variantGid: v.variant_gid || variantGid(v.shopify_variant_id),
           productId: v.shopify_product_id };
}

/**
 * Process one row in its own transaction. Row-locked with SKIP LOCKED, so two
 * workers (the webhook kick and the sweeper) can never process the same row.
 * Returns the new status, or null if the row was not claimable.
 */
async function processOne(db, id, { resolve = resolveLine } = {}) {
  try {
    return await db.tx(async (c) => {
      const { rows } = await c.query(
        `SELECT * FROM community_intake
          WHERE id = $1 AND status IN ('received', 'retryable_error')
          FOR UPDATE SKIP LOCKED`,
        [id]
      );
      const row = rows[0];
      if (!row) return null;

      const d = await resolve(c, row);
      if (d.status === "resolved") {
        await c.query(
          `UPDATE community_intake
              SET status = 'resolved', resolved_variant_gid = $2, resolved_product_id = $3,
                  review_reason = NULL, last_error = NULL, attempts = attempts + 1,
                  resolved_at = now()
            WHERE id = $1`,
          [id, d.variantGid, d.productId]
        );
      } else {
        await c.query(
          `UPDATE community_intake
              SET status = 'review', review_reason = $2, attempts = attempts + 1
            WHERE id = $1`,
          [id, d.reason]
        );
      }
      return d.status;
    });
  } catch (e) {
    // The attempt rolled back. Record the failure outside it. In SET,
    // "attempts" is the value BEFORE this attempt, so the backoff is
    // 30s, 60s, 120s ... capped at an hour.
    const { rows } = await db.query(
      `UPDATE community_intake
          SET attempts = attempts + 1,
              last_error = $2,
              status = CASE WHEN attempts + 1 >= $3 THEN 'review' ELSE 'retryable_error' END,
              review_reason = CASE WHEN attempts + 1 >= $3 THEN 'max_attempts_exceeded' ELSE review_reason END,
              next_attempt_at = now() + make_interval(
                secs => LEAST($4::double precision, $5::double precision * power(2, attempts)))
        WHERE id = $1 AND status IN ('received', 'retryable_error')
        RETURNING status`,
      [id, String((e && e.message) || e).slice(0, 2000), MAX_ATTEMPTS, MAX_BACKOFF_S, BASE_BACKOFF_S]
    );
    console.error(`[community] intake ${id} attempt failed: ${e.message}`);
    return rows[0]?.status || null;
  }
}

/** One sweep: every due row, oldest first. Returns a tally by outcome. */
async function runOnce(db, { limit = 50, resolve } = {}) {
  const { rows } = await db.query(
    `SELECT id FROM community_intake
      WHERE status IN ('received', 'retryable_error') AND next_attempt_at <= now()
      ORDER BY id
      LIMIT $1`,
    [limit]
  );
  const tally = { resolved: 0, review: 0, retryable_error: 0, skipped: 0 };
  for (const r of rows) {
    const s = await processOne(db, r.id, { resolve });
    if (s && tally[s] !== undefined) tally[s]++;
    else tally.skipped++;
  }
  if (rows.length) console.log(`[community] intake sweep: ${JSON.stringify(tally)}`);
  return tally;
}

/** Fire-and-forget nudge after a webhook captured Community lines. */
function kick(db) {
  if (!enabled()) return;
  setImmediate(() => runOnce(db).catch((e) => console.error("[community] kick failed:", e.message)));
}

function enabled() {
  return String(process.env.COMMUNITY_INTAKE_WORKER || "on").toLowerCase() !== "off";
}

/** Start the sweeper. Unref'd so it never holds the process open. */
function start(db, { intervalMs = Number(process.env.COMMUNITY_INTAKE_SWEEP_MS || 60_000) } = {}) {
  if (!enabled()) {
    console.log("[community] intake worker disabled (COMMUNITY_INTAKE_WORKER=off)");
    return null;
  }
  const t = setInterval(() => {
    runOnce(db).catch((e) => console.error("[community] sweep failed:", e.message));
  }, intervalMs);
  t.unref();
  console.log(`[community] intake sweeper every ${Math.round(intervalMs / 1000)}s`);
  return t;
}

module.exports = { resolveLine, processOne, runOnce, kick, start, MAX_ATTEMPTS };
