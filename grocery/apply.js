// ============================================================================
// ASB PIPELINE — grocery/apply.js
//
// T1: apply one captured Shopify order (a shopify_order_sources row) to the
// household's grocery bag, durably and exactly once.
//
//   T1a claim    own transaction, COMMITTED before any work: status
//                received/retryable_error -> processing, attempts + 1, a lease.
//                "attempts" therefore counts attempts STARTED (a crash mid-way
//                still counts, so a payload that crashes the process reaches
//                max_attempts instead of looping forever).
//   T1b apply    one transaction under the lease: Community split, the bag
//                write (household lock), source lines, the FROZEN bill
//                snapshot, and ONE update that writes status and bill_state
//                together.
//   T1c failure  one update (matched on the lease): retryable_error with
//                backoff, or review once the attempt budget is used.
//
// Alerts are inserted inside the transaction and dispatched after commit.
// ============================================================================

"use strict";

const crypto = require("crypto");
const bill = require("../bill");
const T = require("../templates");
const { loadOrderForBill } = require("../orders");
const communityIntake = require("../community/intake");
const { groceryOnlyOrder } = require("../community/sanitize");
const { writeGroceryOrder } = require("./write");
const alerts = require("./alerts");
const { parseOrderJson } = require("./orderjson");

const MAX_ATTEMPTS = Number(process.env.GROCERY_MAX_ATTEMPTS || 8);
const LEASE_S = Number(process.env.GROCERY_LEASE_S || 300);
const BASE_BACKOFF_S = Number(process.env.GROCERY_BASE_BACKOFF_S || 30);
const MAX_BACKOFF_S = 3600;
const STATEMENT_TIMEOUT_MS = Number(process.env.GROCERY_STATEMENT_TIMEOUT_MS || 60000);

function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(4);
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return "92" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("3")) return "92" + digits;
  return digits;
}

const NOW = { raw: "now()" };
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** T1a. Returns { leaseToken, attempts } or null (not claimable). */
async function claim(db, sourceId) {
  return db.tx(async (c) => {
    const { rows } = await c.query(
      `UPDATE shopify_order_sources
          SET status = 'processing', attempts = attempts + 1, lease_token = gen_random_uuid(),
              lease_until = now() + make_interval(secs => $2), last_started_at = now()
        WHERE id = $1 AND status IN ('received','retryable_error') AND next_attempt_at <= now()
        RETURNING lease_token, attempts, first_webhook_event_id`, [sourceId, LEASE_S]);
    if (!rows.length) return null;
    await c.query(`UPDATE webhook_events SET attempts = $2 WHERE id = $1`, [rows[0].first_webhook_event_id, rows[0].attempts]);
    return { leaseToken: rows[0].lease_token, attempts: rows[0].attempts };
  });
}

/** Single-statement exit from 'processing' (and the webhook mirror). */
async function finishProcessing(c, src, set, webhook) {
  // A value { raw: 'now()' } is written as SQL (database clock, not the app's).
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(set)) {
    if (v && typeof v === "object" && v.raw === "now()") cols.push(`${k} = now()`);
    else { vals.push(v); cols.push(`${k} = $${vals.length + 2}`); }
  }
  const sql = `UPDATE shopify_order_sources
                  SET ${cols.join(", ")},
                      lease_token = NULL, lease_until = NULL
                WHERE id = $1 AND lease_token = $2 AND status = 'processing'`;
  const r = await c.query(sql, [src.id, src.lease_token, ...vals]);
  if (r.rowCount !== 1) throw new Error(`source ${src.id}: lease lost before the result could be written`);
  if (webhook) {
    await c.query(
      `UPDATE webhook_events
          SET status = $2, processed_at = CASE WHEN $2 IN ('processed','ignored') THEN now() ELSE processed_at END,
              attempts = $3, error_detail = COALESCE($4, error_detail)
        WHERE id = $1`,
      [src.first_webhook_event_id, webhook.status, src.attempts, webhook.detail || null]);
  }
}

/** Compose the customer bill from the bag as it is NOW (inside T1b) - frozen. */
async function composeSnapshot(c, { src, orderId, order, phone }) {
  const forBill = await loadOrderForBill(c, orderId);
  if (!forBill) throw new Error(`order ${orderId} not found for the bill`);
  // On a merge the bag carries the FIRST order's time. This bill confirms
  // THIS Shopify order, so it states this order's time.
  forBill.ordered_at = order.created_at || forBill.placed_at;
  const composed = bill.orderConfirmation(forBill);
  const t = T.TEMPLATES.orderBill;
  const params = T.orderBillParams(composed);
  return {
    source_id: src.id, shopify_order_id: src.shopify_order_id, order_id: orderId,
    bill_key: `order_confirmed:shopify:${src.shopify_order_id}`, phone, scope: "bag_after_apply",
    content: forBill, rich_text: composed.rich, template_name: t.name, template_lang: t.language,
    template_params: params, content_sha256: sha256(JSON.stringify({ rich: composed.rich, params })),
    composed_by: "worker",
  };
}

async function insertSnapshot(c, s) {
  await c.query(
    `INSERT INTO shopify_order_bill_snapshots
       (source_id, shopify_order_id, order_id, bill_key, phone, scope, content, rich_text,
        template_name, template_lang, template_params, content_sha256, composed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [s.source_id, s.shopify_order_id, s.order_id, s.bill_key, s.phone, s.scope, JSON.stringify(s.content),
     s.rich_text, s.template_name, s.template_lang, JSON.stringify(s.template_params), s.content_sha256, s.composed_by]);
}

async function insertLines(c, sourceId, lines) {
  for (const l of lines) {
    await c.query(
      `INSERT INTO shopify_order_source_lines
         (source_id, shopify_line_item_id, kind, product_id, community_intake_id, quantity, unit_price, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id, shopify_line_item_id) DO NOTHING`,
      [sourceId, l.lineId, l.kind, l.productId || null, l.intakeId || null, l.qty, l.price ?? null, l.skipReason || null]);
  }
}

const lineIdOf = (line, i) => (line?.id !== undefined && line?.id !== null ? String(line.id) : `pos:${i}`);

/**
 * T1b. Returns { outcome, alertIds, billPending }.
 * outcome: 'applied' | 'community_only' | 'review' | 'legacy' | 'lost'
 */
async function applyClaimed(db, sourceId, leaseToken) {
  const alertIds = [];
  const result = await db.tx(async (c) => {
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, STATEMENT_TIMEOUT_MS | 0)}`);
    const src = (await c.query(
      `SELECT * FROM shopify_order_sources WHERE id = $1 AND status = 'processing' AND lease_token = $2
         FOR NO KEY UPDATE`, [sourceId, leaseToken])).rows[0];
    if (!src) return { outcome: "lost" };

    // Live rows carry the exact bytes; a backfilled row that an operator
    // reopened carries the old event's stored payload instead.
    let rawText = src.payload_raw;
    if (rawText === null) {
      rawText = (await c.query(`SELECT payload::text AS t FROM webhook_events WHERE id = $1`,
                               [src.first_webhook_event_id])).rows[0]?.t || null;
    }
    if (!rawText) throw new Error(`source ${src.id} has no payload to apply`);
    const payload = parseOrderJson(rawText);
    const rawPhone = payload.shipping_address?.phone || payload.customer?.phone || payload.phone || null;

    // Community split. captureOrderLines is idempotent: lines captured before
    // the 200 come back as Community ("already_captured"); a line that became
    // Community since is captured now - never lost, never grocery.
    const cap = await communityIntake.captureOrderLines(c, {
      shop: src.shop, topic: "orders/create", order: payload, eventRowId: src.first_webhook_event_id,
      phone: normalizePhone(rawPhone), orderRaw: rawText,
    });
    const idx = new Map((payload.line_items || []).map((l, i) => [l, i]));
    const communityRows = cap.communityLines.map((cl) => ({
      lineId: lineIdOf(cl.line, idx.get(cl.line)), kind: "community", intakeId: cl.intakeId,
      qty: Number(cl.line.quantity || 0), price: cl.line.price === undefined || cl.line.price === null || cl.line.price === "" ? null : Number(cl.line.price),
    }));

    if (!cap.groceryLines.length) {
      await insertLines(c, src.id, communityRows);
      await finishProcessing(c, src, { status: "community_only", bill_state: "not_required", last_error: null },
                             { status: "processed" });
      return { outcome: "community_only", communityInserted: cap.inserted };
    }

    const order = cap.communityLines.length
      ? groceryOnlyOrder(payload, { ...cap, eventRowId: src.first_webhook_event_id })
      : payload;
    const phone = normalizePhone(order.shipping_address?.phone || order.customer?.phone || order.phone || null);
    if (!phone) {
      await finishProcessing(c, src, { status: "review", review_reason: "no_phone", last_error: "no phone on order" },
                             { status: "failed", detail: "no phone on order" });
      alertIds.push(await alerts.insert(c, { sourceId: src.id, kind: "review",
        detail: { shopify_order_id: src.shopify_order_id, order_name: src.shopify_order_name, reason: "no_phone",
                  summary: "no phone number on the order - not applied" } }));
      return { outcome: "review" };
    }

    const w = await writeGroceryOrder(c, order, phone);
    if (w.alreadyPersisted && src.legacy_reason) {
      // A reopened legacy row whose order turns out to be saved already: a
      // person decides (its provenance stays as it was).
      await finishProcessing(c, src, { status: "review", review_reason: "already_persisted",
                                       last_error: `already persisted as order ${w.orderId}` },
                             { status: "failed", detail: `already persisted as order ${w.orderId}` });
      alertIds.push(await alerts.insert(c, { sourceId: src.id, kind: "review",
        detail: { shopify_order_id: src.shopify_order_id, reason: "already_persisted", order_id: w.orderId,
                  summary: "reopened order is already in a bag - not applied again" } }));
      return { outcome: "review" };
    }
    if (w.alreadyPersisted) {
      // The pre-017 code already saved this Shopify order: never apply twice.
      await finishProcessing(c, src, { status: "legacy", legacy_reason: "persisted_before_cutover",
                                       order_id: w.orderId, bill_state: "legacy", last_error: null },
                             { status: "ignored", detail: `already persisted before cutover as order ${w.orderId}` });
      return { outcome: "legacy" };
    }

    const gIdx = new Map((order.line_items || []).map((l, i) => [l, i]));
    const groceryRows = w.lines.map((l) => ({
      lineId: lineIdOf(l.line, gIdx.get(l.line)), kind: l.kind, productId: l.productId,
      qty: l.qty, price: l.price, skipReason: l.skipReason,
    }));
    await insertLines(c, src.id, [...groceryRows, ...communityRows]);

    // Freeze the bill now (savepoint: a bill bug never blocks the order).
    let snap = null;
    let composeError = null;
    await c.query("SAVEPOINT bill_compose");
    try {
      snap = await composeSnapshot(c, { src, orderId: w.orderId, order, phone });
      await c.query("RELEASE SAVEPOINT bill_compose");
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT bill_compose");
      composeError = e.message;
      console.error(`[grocery] bill compose failed for source ${src.id}: ${e.message}`);
    }

    const keepNotRequired = src.bill_state === "not_required";       // operator reopened without a bill
    const billSet = keepNotRequired ? {}
      : snap ? { bill_state: "pending", bill_next_attempt_at: NOW }
      : { bill_state: "failed", bill_outcome: "compose_error" };
    await finishProcessing(c, src, {
      status: "applied", order_id: w.orderId, customer_id: w.customerId, cycle_id: w.cycleId,
      disposition: w.merged ? "merged" : "created", applied_at: NOW, last_error: null, ...billSet,
    }, { status: "processed" });
    if (snap) await insertSnapshot(c, snap);
    if (!snap && !keepNotRequired) {
      alertIds.push(await alerts.insert(c, { sourceId: src.id, kind: "compose_error",
        detail: { shopify_order_id: src.shopify_order_id, order_name: src.shopify_order_name, error: composeError,
                  summary: "order applied, bill could not be composed" } }));
    }
    console.log(`   Saved as ${w.orderNumber} for ${w.deliveryDay} delivery (${w.cycleCode})` +
                `${w.merged ? " (merged)" : ""} [source ${src.id}]`);
    return { outcome: "applied", billPending: Boolean(snap) && !keepNotRequired, communityInserted: cap.inserted };
  });
  return { ...result, alertIds };
}

/** T1c (also used by the sweeper for an expired lease). */
async function recordFailure(db, sourceId, leaseToken, error, { expired = false } = {}) {
  const msg = String(error && error.message ? error.message : error).slice(0, 2000);
  const code = error && error.code;
  return db.tx(async (c) => {
    const src = (await c.query(
      `SELECT * FROM shopify_order_sources WHERE id = $1 AND status = 'processing' AND lease_token = $2
         FOR NO KEY UPDATE`, [sourceId, leaseToken])).rows[0];
    if (!src) return { status: null, alertIds: [] };
    const used = src.attempts - src.attempt_budget_base;
    const leakAgain = code === "ASB_COMMUNITY_LEAK" && /ASB_COMMUNITY_LEAK/.test(src.last_error || "");
    const toReview = used >= MAX_ATTEMPTS || leakAgain;
    const detail = `${expired ? "lease expired" : "attempt failed"}: ${code ? `${code} ` : ""}${msg}`;
    if (toReview) {
      await c.query(
        `UPDATE shopify_order_sources
            SET status = 'review', review_reason = $3, last_error = $4, lease_token = NULL, lease_until = NULL
          WHERE id = $1 AND lease_token = $2`,
        [sourceId, leaseToken, leakAgain ? "community_leak_repeat" : "max_attempts", detail]);
      await c.query(`UPDATE webhook_events SET status = 'failed', error_detail = $2 WHERE id = $1`,
                    [src.first_webhook_event_id, detail.slice(0, 2000)]);
      const a = await alerts.insert(c, { sourceId, kind: "review",
        detail: { shopify_order_id: src.shopify_order_id, order_name: src.shopify_order_name,
                  reason: leakAgain ? "community_leak_repeat" : "max_attempts", attempts: src.attempts, error: detail,
                  summary: "order NOT applied after repeated failures" } });
      return { status: "review", alertIds: [a] };
    }
    const backoff = Math.min(MAX_BACKOFF_S, BASE_BACKOFF_S * 2 ** Math.max(0, used - 1));
    await c.query(
      `UPDATE shopify_order_sources
          SET status = 'retryable_error', last_error = $3, lease_token = NULL, lease_until = NULL,
              next_attempt_at = now() + make_interval(secs => $4)
        WHERE id = $1 AND lease_token = $2`,
      [sourceId, leaseToken, `${code === "ASB_COMMUNITY_LEAK" ? "ASB_COMMUNITY_LEAK " : ""}${detail}`, backoff]);
    await c.query(`UPDATE webhook_events SET error_detail = $2 WHERE id = $1`, [src.first_webhook_event_id, detail.slice(0, 2000)]);
    return { status: "retryable_error", alertIds: [] };
  });
}

/**
 * Claim and apply one source. Returns the outcome string or null when the
 * row was not claimable. Never throws (a failure is recorded on the row).
 */
async function processSource(db, sourceId) {
  let lease;
  try {
    lease = await claim(db, sourceId);
  } catch (e) {
    console.error(`[grocery] could not claim source ${sourceId}: ${e.message}`);
    return null;
  }
  if (!lease) return null;
  let r;
  try {
    r = await applyClaimed(db, sourceId, lease.leaseToken);
  } catch (e) {
    console.error(`[grocery] apply failed for source ${sourceId}: ${e.message}`);
    try {
      const f = await recordFailure(db, sourceId, lease.leaseToken, e);
      if (f.alertIds.length) await alerts.dispatch(db, f.alertIds);
      return f.status;
    } catch (e2) {
      // Database unreachable: the lease expires and the sweeper records it.
      console.error(`[grocery] could not record the failure for source ${sourceId}: ${e2.message}`);
      return null;
    }
  }
  if (r.alertIds.length) await alerts.dispatch(db, r.alertIds);
  if (r.communityInserted) {
    try { require("../community/worker").kick(db); } catch (_) { /* best effort */ }
  }
  return r.outcome;
}

/** Sweeper: processing rows whose lease ran out (crash, restart, DB outage). */
async function expireLeases(db) {
  const { rows } = await db.query(
    `SELECT id, lease_token FROM shopify_order_sources WHERE status = 'processing' AND lease_until < now() LIMIT 50`);
  let n = 0;
  for (const r of rows) {
    try {
      const f = await recordFailure(db, r.id, r.lease_token, new Error("lease_expired"), { expired: true });
      if (f.status) n++;
      if (f.alertIds.length) await alerts.dispatch(db, f.alertIds);
    } catch (e) {
      console.error(`[grocery] could not expire lease on source ${r.id}: ${e.message}`);
    }
  }
  return n;
}

module.exports = { claim, applyClaimed, recordFailure, processSource, expireLeases, composeSnapshot, insertSnapshot,
                   normalizePhone, MAX_ATTEMPTS, LEASE_S };
