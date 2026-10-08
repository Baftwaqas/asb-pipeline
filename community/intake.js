// ============================================================================
// ASB PIPELINE — community/intake.js
//
// The part of the Shopify webhook that runs BEFORE the 200.
//
// One Postgres transaction, no network calls:
//
//   1. INSERT the webhook_events dedupe row (ON CONFLICT DO NOTHING).
//      Conflict = a delivery we already captured -> report duplicate, stop.
//   2. products/*  -> refresh the Community registry from the payload.
//      orders/*    -> classify every line; INSERT one community_intake row per
//                     Community line (ON CONFLICT on shop+order+line DO NOTHING).
//   3. COMMIT. Only now may the caller answer 200.
//
// If this throws, the caller must NOT answer 200: Shopify then retries, and a
// Community line is never acknowledged without being stored. (Grocery
// processing still happens after the 200, exactly as before - a known
// limitation of the existing pipeline, not changed in Phase 1.)
// ============================================================================

"use strict";

const crypto = require("crypto");
const { classifyLines } = require("./classify");
const registry = require("./registry");

/**
 * db: the db module (needs .tx).
 * Returns:
 *   { duplicate: true, eventRowId }                       already captured
 *   { duplicate: false, eventRowId, kind: 'product', registry }
 *   { duplicate: false, eventRowId, kind: 'order', groceryLines, communityLines, inserted }
 */
async function captureWebhook(db, { shop, deliveryId, topic, payload, phone, rawBody }) {
  // The bytes Shopify actually sent, kept verbatim on every intake row with
  // their SHA-256 (falls back to the serialised payload when called without
  // the raw body, e.g. from a script).
  const orderRaw = rawBody ? Buffer.from(rawBody).toString("utf8") : JSON.stringify(payload || {});
  return db.tx(async (client) => {
    const ins = await client.query(
      `INSERT INTO webhook_events (source, event_id, topic, payload)
       VALUES ('shopify', $1, $2, $3)
       ON CONFLICT (source, event_id) DO NOTHING
       RETURNING id`,
      [String(deliveryId), topic || null, payload || {}]
    );
    if (!ins.rows.length) {
      const ex = await client.query(
        `SELECT id FROM webhook_events WHERE source = 'shopify' AND event_id = $1`,
        [String(deliveryId)]
      );
      return { duplicate: true, eventRowId: ex.rows[0]?.id || null };
    }
    const eventRowId = ins.rows[0].id;

    if (String(topic || "").startsWith("products/")) {
      const r = await registry.syncFromProductWebhook(client, topic, payload);
      return { duplicate: false, eventRowId, kind: "product", registry: r };
    }

    const cap = await captureOrderLines(client, { shop, topic, order: payload, eventRowId, phone, orderRaw });
    return { duplicate: false, eventRowId, kind: "order", ...cap };
  });
}

/** A whole number, or NULL (the worker sends NULL quantities to review). */
function intOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

/** Classify an order's lines and store the Community ones. Runs inside a transaction. */
async function captureOrderLines(client, { shop, topic, order, eventRowId, phone, orderRaw }) {
  const raw = orderRaw || JSON.stringify(order);
  const sha = crypto.createHash("sha256").update(raw, "utf8").digest("hex");
  const classified = await classifyLines(client, order?.line_items || [], { orderId: order?.id });
  const groceryLines = [];
  const communityLines = [];
  let inserted = 0;

  for (const c of classified) {
    if (!c.community) {
      groceryLines.push(c.line);
      continue;
    }
    const l = c.line;
    if (l?.id === undefined || l?.id === null || order?.id === undefined || order?.id === null) {
      // Without Shopify's own ids there is no idempotency key. Refuse the
      // whole capture so the webhook is retried / investigated, rather than
      // store a line we could later double-count.
      throw new Error(`Community line without order/line id on ${order?.name || "?"} - cannot capture idempotently`);
    }
    const r = await client.query(
      `INSERT INTO community_intake
         (shop, shopify_order_id, shopify_line_item_id, shopify_order_name, webhook_event_id, topic,
          shopify_product_id, shopify_variant_id, sku, vendor, title, variant_title, quantity,
          unit_price, currency, customer_phone, shopify_customer_id, order_created_at,
          classification, signals, line_payload, order_raw, order_payload, order_payload_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24)
       ON CONFLICT ON CONSTRAINT community_intake_line_key DO NOTHING
       RETURNING id`,
      [
        shop,
        String(order.id),
        String(l.id),
        order.name || null,
        eventRowId,
        topic || null,
        registry.numericId(l.product_id),
        registry.numericId(l.variant_id),
        l.sku || null,
        l.vendor || null,
        l.title || null,
        l.variant_title || null,
        intOrNull(l.quantity),
        l.price === undefined || l.price === null || l.price === "" ? null : Number(l.price),
        order.currency || order.presentment_currency || null,
        phone || null,
        order.customer?.id ? String(order.customer.id) : null,
        order.created_at || null,
        c.classification,
        c.signals,
        l,
        raw,
        order,
        sha,
      ]
    );
    inserted += r.rowCount;
    let intakeId = r.rows[0]?.id || null;
    if (!intakeId) {
      // Already captured by an earlier delivery of the same order: keep the
      // FIRST capture (its facts are immutable) and report its id.
      const ex = await client.query(
        `SELECT id FROM community_intake
          WHERE shop = $1 AND shopify_order_id = $2 AND shopify_line_item_id = $3`,
        [shop, String(order.id), String(l.id)]);
      intakeId = ex.rows[0]?.id || null;
    }
    communityLines.push({ line: l, classification: c.classification, signals: c.signals, intakeId });
  }

  return { groceryLines, communityLines, inserted };
}

module.exports = { captureWebhook, captureOrderLines };
