// ============================================================================
// ASB PIPELINE — grocery/sources.js
//
// T0: reserve the Shopify order BEFORE the 200, inside the same transaction as
// the webhook_events dedupe row and the Community capture.
//
//   INSERT shopify_order_sources ... ON CONFLICT (shop, shopify_order_id) DO NOTHING
//
//   * a row comes back  -> this delivery owns the Shopify order (status
//                          'received', bill 'not_ready'); the worker applies it.
//   * no row            -> the Shopify order is already known. It is NEVER
//                          re-applied: first captured create wins. The delivery
//                          is recorded as a duplicate, its webhook_events row
//                          becomes 'ignored', and a different commerce
//                          fingerprint (computed at the SOURCE's version) raises
//                          a loud anomaly alert.
//
// Two identical deliveries racing: Postgres makes the second INSERT wait on the
// unique index until the first transaction ends, so exactly one owner exists.
// ============================================================================

"use strict";

const crypto = require("crypto");
const fingerprint = require("./fingerprint");
const alerts = require("./alerts");

const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function parseTime(t) {
  if (!t) return null;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Inside the caller's transaction. Returns
 *   { kind: 'owner', sourceId }
 *   { kind: 'duplicate', sourceId, differs, alertIds }
 *   { kind: 'invalid', alertIds }
 */
async function reserve(client, { shop, eventRowId, rawText, payload }) {
  const fp = fingerprint.compute(rawText);          // throws FingerprintError -> caller answers 503
  const orderId = fp.canonical.order.id;

  if (!orderId || !/^[0-9]+$/.test(orderId)) {
    await client.query(
      `UPDATE webhook_events SET status = 'failed', processed_at = now(), error_detail = $2 WHERE id = $1`,
      [eventRowId, "orders/create without a numeric order id - not applied"]);
    const a = await alerts.insert(client, { kind: "invalid_order",
      detail: { webhook_event_id: eventRowId, order_name: payload?.name || null, summary: "no numeric order id" } });
    return { kind: "invalid", alertIds: [a] };
  }

  const ins = await client.query(
    `INSERT INTO shopify_order_sources
       (origin, shop, shopify_order_id, shopify_order_name, shopify_created_at, first_webhook_event_id,
        payload_sha256, payload_raw, commerce_fingerprint, commerce_fingerprint_version, commerce_canonical,
        status, bill_state)
     VALUES ('live', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'received', 'not_ready')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [shop, orderId, payload?.name || null, parseTime(payload?.created_at), eventRowId,
     sha256(rawText), rawText, fp.hash, fp.version, fp.canonical]);
  if (ins.rows.length) return { kind: "owner", sourceId: ins.rows[0].id };

  // ---- already known: record the duplicate, never re-apply -----------------
  const src = (await client.query(
    `SELECT id, status, payload_sha256, commerce_fingerprint, commerce_fingerprint_version, commerce_canonical,
            shopify_order_name,
            shop AS source_shop
       FROM shopify_order_sources WHERE shopify_order_id = $1`, [orderId])).rows[0];
  if (!src) throw new Error(`shopify order ${orderId}: insert conflicted but no source row is visible`);

  // Compare at the SOURCE's frozen version; a legacy source has none.
  const incoming = src.commerce_fingerprint_version
    ? fingerprint.computeAt(rawText, src.commerce_fingerprint_version)
    : fp;
  const differs = src.commerce_fingerprint ? incoming.hash !== src.commerce_fingerprint : null;
  const rawSha = sha256(rawText);
  const rawDiffers = src.payload_sha256 ? rawSha !== src.payload_sha256 : null;

  await client.query(
    `INSERT INTO shopify_order_source_duplicates
       (source_id, webhook_event_id, payload_sha256, commerce_fingerprint, commerce_fingerprint_version,
        commerce_canonical, fingerprint_differs, raw_differs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [src.id, eventRowId, rawSha, incoming.hash, incoming.version, incoming.canonical, differs, rawDiffers]);

  await client.query(
    `UPDATE webhook_events SET status = 'ignored', processed_at = now(), error_detail = $2 WHERE id = $1`,
    [eventRowId, differs
      ? `duplicate_shopify_order_MISMATCH: Shopify order ${orderId} already captured (source ${src.id}); NOT re-applied`
      : `duplicate_shopify_order: Shopify order ${orderId} already captured (source ${src.id})`]);

  const alertIds = [];
  if (differs) {
    alertIds.push(await alerts.insert(client, {
      sourceId: src.id, kind: "duplicate_anomaly",
      detail: {
        shopify_order_id: orderId, order_name: src.shopify_order_name, webhook_event_id: eventRowId,
        source_status: src.status, version: incoming.version,
        ...(src.source_shop !== shop ? { shop_mismatch: { source: src.source_shop, delivery: shop } } : {}),
        summary: `different content; ${src.status === "applied" ? "first payload already applied" : "first payload will be applied as captured"}`,
        differing_fields: fingerprint.diffPaths(src.commerce_canonical, incoming.canonical),
        first: src.commerce_canonical, incoming: incoming.canonical,
      },
    }));
  }
  return { kind: "duplicate", sourceId: src.id, differs, alertIds };
}

module.exports = { reserve };
