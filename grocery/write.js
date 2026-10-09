// ============================================================================
// ASB PIPELINE — grocery/write.js
//
// The grocery bag writer: one Shopify order's GROCERY lines into the
// household's bag for its delivery. Moved unchanged from server.js
// persistOrder(); what changed (migration 017):
//
//   * it runs inside the caller's transaction (the apply step owns it);
//   * the household is locked before findOpenOrder() (orders.lockHousehold);
//   * it reports, per Shopify line, what it contributed, so the apply step can
//     record shopify_order_source_lines.
//
// Idempotency is NOT decided here any more: the apply step only calls this for
// a Shopify order whose source row it holds. The ON CONFLICT on
// orders.shopify_order_id stays as a last guard: it can only fire for an order
// the pre-017 code already saved (see grocery/apply.js).
//
// Community lines never reach this function: assertNoCommunityLines() refuses
// the whole write (rolled back) rather than creating a products stub, an
// order_items row or a cycle_prices row.
// ============================================================================

"use strict";

const crypto = require("crypto");
const { resolveCycle, upsertCustomer, findOpenOrder, lockHousehold } = require("../orders");
const { assertNoCommunityLines } = require("../community/classify");

// ------------------------------------------------------------
// Match a Shopify line item to a product in our catalogue.
// Try variant id, then SKU, then title. If nothing matches we
// create a stub so the order is never silently truncated - the
// WARN tells us to tidy the catalogue afterwards.
// ------------------------------------------------------------
async function resolveProduct(client, item) {
  const variantId = item.variant_id ? String(item.variant_id) : null;
  const sku = item.sku || null;

  if (variantId) {
    const hit = await client.query(
      `SELECT id, unit, name_en, name_ur, market_price
         FROM products WHERE shopify_variant_id = $1`,
      [variantId]
    );
    if (hit.rows.length) return hit.rows[0];
  }
  if (sku) {
    const hit = await client.query(
      `SELECT id, unit, name_en, name_ur, market_price
         FROM products WHERE sku = $1`,
      [sku]
    );
    if (hit.rows.length) {
      if (variantId) {
        await client.query(
          `UPDATE products SET shopify_variant_id = $1
            WHERE id = $2 AND shopify_variant_id IS NULL`,
          [variantId, hit.rows[0].id]
        );
      }
      return hit.rows[0];
    }
  }

  const stubSku = sku || `SHOPIFY-${variantId || crypto.randomUUID().slice(0, 8)}`;
  const { rows } = await client.query(
    `INSERT INTO products (sku, name_en, category, unit, shopify_product_id, shopify_variant_id)
     VALUES ($1, $2, 'uncategorised', 'kg', $3, $4)
     ON CONFLICT (sku) DO UPDATE SET name_en = EXCLUDED.name_en
     RETURNING id, unit, name_en, name_ur, market_price`,
    [
      stubSku,
      item.title || stubSku,
      item.product_id ? String(item.product_id) : null,
      variantId,
    ]
  );
  console.warn(`[db] unknown product "${item.title}" - created stub ${stubSku}`);
  return rows[0];
}

/**
 * One live order per customer per cycle (the community model: one bag per
 * household per Community Day). A second Shopify order before lock merges into
 * the first. Runs inside the caller's transaction.
 *
 * Returns
 *   { alreadyPersisted: true, orderId }        pre-017 code already saved this Shopify order
 *   { alreadyPersisted: false, orderId, orderNumber, merged, customerId, cycleId, cycleCode,
 *     deliveryDay, lines: [{ line, kind: 'grocery'|'skipped', productId?, qty, price, skipReason? }] }
 */
async function writeGroceryOrder(client, order, phone) {
  await assertNoCommunityLines(client, order.line_items || [], { orderId: order.id });

  const cycle = await resolveCycle(
    client,
    order.created_at ? new Date(order.created_at) : new Date()
  );

  const firstName =
    order.customer?.first_name || order.shipping_address?.first_name || null;
  const lastName =
    order.customer?.last_name || order.shipping_address?.last_name || "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;

  const customer = await upsertCustomer(client, {
    phone,
    name: fullName,
    shopifyCustomerId: order.customer?.id,
  });

  const addr = order.shipping_address || {};

  // Serialise this household's bag writes, then look for its live bag.
  await lockHousehold(client, customer.id);

  // Last guard against applying a Shopify order twice: an order row that
  // already carries THIS Shopify order id means it was saved before (by the
  // pre-017 code). Checked before the merge path, which would otherwise add
  // its lines to that bag a second time.
  const saved = await client.query(`SELECT id FROM orders WHERE shopify_order_id = $1`, [String(order.id)]);
  if (saved.rows.length) return { alreadyPersisted: true, orderId: saved.rows[0].id };

  const existing = await findOpenOrder(client, customer.id, cycle.id);

  let orderRow;
  let merged = false;

  if (existing) {
    orderRow = existing;
    merged = true;
    console.log(
      `[db] merging Shopify ${order.name} into existing ${orderRow.order_number}`
    );
  } else {
    const ins = await client.query(
      `INSERT INTO orders (customer_id, cycle_id, society_id, channel, status,
                           shopify_order_id, shopify_order_name,
                           deliver_building, deliver_flat, deliver_note,
                           source_payload, placed_at)
       VALUES ($1, $2, $3, 'shopify', 'confirmed', $4, $5, $6, $7, $8, $9,
               COALESCE($10::timestamptz, now()))
       ON CONFLICT (shopify_order_id) DO NOTHING
       RETURNING id, order_number`,
      [
        customer.id,
        cycle.id,
        customer.society_id,
        String(order.id),
        order.name || null,
        addr.address2 || null,
        addr.address1 || null,
        order.note || null,
        order,
        // When the customer ordered, per Shopify. A retried webhook can
        // arrive hours later; the bill must show the real order time.
        order.created_at || null,
      ]
    );

    if (ins.rows.length === 0) {
      const again = await client.query(
        `SELECT id FROM orders WHERE shopify_order_id = $1`, [String(order.id)]);
      return { alreadyPersisted: true, orderId: again.rows[0]?.id || null };
    }
    orderRow = ins.rows[0];
  }

  // --- line items -------------------------------------------------
  // The Shopify price is the CEILING. Nothing here sets a final price;
  // that happens at lock time, after the mandi run.
  const lines = [];
  for (const item of order.line_items || []) {
    const product = await resolveProduct(client, item);
    const qty = Number(item.quantity || 1);
    const ceiling = Number(item.price || 0);

    if (!(ceiling > 0)) {
      console.warn(`[db] line "${item.title}" has no price - skipped`);
      lines.push({ line: item, kind: "skipped", qty, price: null, skipReason: "no_price" });
      continue;
    }

    await client.query(
      // market_unit_price is the BAZAAR rate, frozen onto this line. It is read
      // from our own catalogue (a Shopify order line carries no
      // compare_at_price). NULL means "unknown" and the bill omits the
      // comparison. On a merge, COALESCE keeps the rate recorded first.
      `INSERT INTO order_items (order_id, product_id, name_snapshot, name_ur_snapshot,
                                unit, qty_ordered, ceiling_unit_price, market_unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id, product_id) DO UPDATE
          SET qty_ordered = order_items.qty_ordered + EXCLUDED.qty_ordered,
              market_unit_price = COALESCE(order_items.market_unit_price,
                                           EXCLUDED.market_unit_price)`,
      [
        orderRow.id,
        product.id,
        item.title || product.name_en,
        product.name_ur,
        product.unit,
        qty,
        ceiling,
        product.market_price ?? null,
      ]
    );

    // Publish the ceiling into the cycle price book if it isn't there.
    // Never overwrite an existing ceiling - customers have already seen it.
    await client.query(
      `INSERT INTO cycle_prices (cycle_id, product_id, ceiling_price, market_price)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (cycle_id, product_id) DO NOTHING`,
      [cycle.id, product.id, ceiling, product.market_price ?? null]
    );
    lines.push({ line: item, kind: "grocery", productId: product.id, qty, price: ceiling });
  }

  await client.query(`SELECT asb_refresh_order_totals($1)`, [orderRow.id]);

  return {
    alreadyPersisted: false,
    orderId: orderRow.id,
    orderNumber: orderRow.order_number,
    merged,
    customerId: customer.id,
    cycleId: cycle.id,
    cycleCode: cycle.code,
    deliveryDay: cycle.deliveryDay,
    lines,
  };
}

module.exports = { writeGroceryOrder, resolveProduct };
