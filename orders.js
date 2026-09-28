// ============================================================================
// ASB PIPELINE — orders.js
//
// The rules every order follows, whatever door it came in by:
//
//   * which delivery it belongs to     (schedule.js: Sunday 8pm / Wednesday 8pm)
//   * one bag per household per delivery (a second order merges into the first)
//   * who the customer is               (phone is the identity)
//   * what the customer is promised     (the ceiling, and the bazaar rate beside it)
//
// Shopify orders (server.js) and WhatsApp orders typed into the inbox
// (inbox.js) both call into here. Keeping one copy is the point: two copies of
// the merge rule is how the same household ends up with two bags on Monday.
// ============================================================================

"use strict";

const schedule = require("./schedule");

// ---------------------------------------------------------------------------
// Which delivery this order is for, from the time the customer ORDERED.
//
// The cycle row is created on first use with its real cut-off and delivery
// date. If ops has closed that cycle early by hand, the order rolls to the
// next delivery rather than joining a locked bag.
// ---------------------------------------------------------------------------
async function resolveCycle(client, orderedAt) {
  let slot = schedule.deliveryFor(orderedAt || new Date());

  for (let attempt = 0; attempt < 2; attempt++) {
    await client.query(
      `INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status, notes)
       VALUES ($1, $2::date, $3, $4, $2::date, 'open',
               'created by the booking calendar (schedule.js)')
       ON CONFLICT (code) DO NOTHING`,
      [slot.code, slot.deliveryDate, slot.opensAt, slot.locksAt]
    );
    const { rows } = await client.query(
      `SELECT id, code, status::text AS status, delivery_date FROM cycles WHERE code = $1`,
      [slot.code]
    );
    const cy = rows[0];
    if (cy && (cy.status === "open" || cy.status === "draft")) {
      return { ...cy, deliveryDay: slot.deliveryDay, deliveryDate: slot.deliveryDate };
    }
    console.warn(`[cycle] ${slot.code} is ${cy?.status} - rolling order to the next delivery`);
    slot = schedule.nextAfter(slot);
  }
  throw new Error("no open cycle available for this order (two consecutive cycles closed)");
}

// ---------------------------------------------------------------------------
// Find or create the customer. Phone is the identity. A name already on file
// is never overwritten by a later, possibly worse, one.
// ---------------------------------------------------------------------------
async function upsertCustomer(client, { phone, name, shopifyCustomerId }) {
  const { rows } = await client.query(
    `INSERT INTO customers (phone, name, shopify_customer_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (phone) DO UPDATE
        SET name = COALESCE(customers.name, EXCLUDED.name),
            shopify_customer_id =
              COALESCE(customers.shopify_customer_id, EXCLUDED.shopify_customer_id)
     RETURNING id, name, society_id, badge`,
    [phone, name || null, shopifyCustomerId ? String(shopifyCustomerId) : null]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// The household's live bag for this delivery, if there is one.
// ---------------------------------------------------------------------------
async function findOpenOrder(client, customerId, cycleId) {
  const { rows } = await client.query(
    `SELECT id, order_number FROM orders
      WHERE customer_id = $1 AND cycle_id = $2 AND status <> 'cancelled'
      ORDER BY id LIMIT 1`,
    [customerId, cycleId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// An order in the shape bill.js reads. Composed from the database - real SKU,
// the unit it is sold in, the Urdu name, the bazaar rate, the delivery date.
// ---------------------------------------------------------------------------
async function loadOrderForBill(db, orderId) {
  const head = await db.query(
    `SELECT o.order_number, o.status::text AS status,
            o.ceiling_total, o.billed_total, o.market_total,
            o.community_total, o.savings_total, o.grand_total,
            COALESCE(c.name, 'Customer') AS customer_name,
            cy.delivery_date, o.placed_at
       FROM orders o
       JOIN cycles cy ON cy.id = o.cycle_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId]
  );
  if (!head.rows.length) return null;

  const lines = await db.query(
    `SELECT p.sku, oi.name_snapshot AS name_en, oi.name_ur_snapshot AS name_ur,
            oi.unit::text AS unit, oi.qty_ordered, oi.qty_packed,
            oi.ceiling_unit_price, oi.final_unit_price, oi.billed_unit_price,
            oi.market_unit_price,
            -- How much is in ONE pack. Quantities count packs, not grams, so
            -- without this a 500 g bag of spinach renders as "1 g".
            p.min_qty AS pack_size
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id`,
    [orderId]
  );

  return { ...head.rows[0], lines: lines.rows };
}

// ---------------------------------------------------------------------------
// An order typed into the inbox from a customer's WhatsApp message.
//
//   lines: [{ sku, packs }]     packs counts what Shopify counts: bags,
//                               gaddis, kilos - the unit shown on the shelf.
//
// PRICE. For each product the ceiling is, in order:
//   1. the ceiling already published for THIS delivery - if a Shopify customer
//      has ordered it, the WhatsApp customer gets the same promise;
//   2. otherwise the current ASB price from the catalogue, which is then
//      published for this delivery so everyone after gets it too.
// A product with neither is refused rather than sold at a made-up price.
//
// Runs inside the caller's transaction. Returns the saved order id.
// ---------------------------------------------------------------------------
async function saveInboxOrder(client, { phone, name, orderedAt, lines, enteredBy, sourceWamid }) {
  const cycle = await resolveCycle(client, orderedAt);
  const customer = await upsertCustomer(client, { phone, name });

  // Look every product up first, so a bad line fails before anything is written.
  const skus = lines.map((l) => l.sku);
  const { rows: products } = await client.query(
    `SELECT p.id, p.sku, p.name_en, p.name_ur, p.unit::text AS unit, p.is_active,
            COALESCE(cp.ceiling_price, p.asb_price)   AS ceiling,
            COALESCE(cp.market_price,  p.market_price) AS market,
            (cp.ceiling_price IS NOT NULL)             AS already_published
       FROM products p
       LEFT JOIN cycle_prices cp ON cp.product_id = p.id AND cp.cycle_id = $2
      WHERE p.sku = ANY($1)`,
    [skus, cycle.id]
  );
  const bySku = new Map(products.map((p) => [p.sku, p]));
  for (const l of lines) {
    const p = bySku.get(l.sku);
    if (!p) throw userError(`Unknown product ${l.sku}`);
    if (!p.is_active || !(Number(p.ceiling) > 0)) {
      throw userError(`${p.name_en} is not for sale right now (no price in Shopify)`);
    }
  }

  let orderRow = await findOpenOrder(client, customer.id, cycle.id);
  const merged = Boolean(orderRow);

  if (!orderRow) {
    const ins = await client.query(
      `INSERT INTO orders (customer_id, cycle_id, society_id, channel, status,
                           placed_at, entered_by, source_wamid)
       VALUES ($1, $2, $3, 'whatsapp', 'confirmed', $4, $5, $6)
       RETURNING id, order_number`,
      [customer.id, cycle.id, customer.society_id, orderedAt, enteredBy || null, sourceWamid || null]
    );
    orderRow = ins.rows[0];
  }

  for (const l of lines) {
    const p = bySku.get(l.sku);
    await client.query(
      `INSERT INTO order_items (order_id, product_id, name_snapshot, name_ur_snapshot,
                                unit, qty_ordered, ceiling_unit_price, market_unit_price)
       VALUES ($1, $2, $3, $4, $5::unit_type, $6, $7, $8)
       ON CONFLICT (order_id, product_id) DO UPDATE
          SET qty_ordered = order_items.qty_ordered + EXCLUDED.qty_ordered,
              market_unit_price = COALESCE(order_items.market_unit_price,
                                           EXCLUDED.market_unit_price)`,
      [orderRow.id, p.id, p.name_en, p.name_ur, p.unit, l.packs, p.ceiling, p.market]
    );
    if (!p.already_published) {
      await client.query(
        `INSERT INTO cycle_prices (cycle_id, product_id, ceiling_price, market_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cycle_id, product_id) DO NOTHING`,
        [cycle.id, p.id, p.ceiling, p.market]
      );
    }
  }

  await client.query(`SELECT asb_refresh_order_totals($1)`, [orderRow.id]);

  return {
    orderId: orderRow.id,
    orderNumber: orderRow.order_number,
    merged,
    cycleCode: cycle.code,
    deliveryDate: cycle.deliveryDate,
    deliveryDay: cycle.deliveryDay,
  };
}

// An error whose message is safe and useful to show the person at the inbox.
function userError(message) {
  const e = new Error(message);
  e.userFacing = true;
  return e;
}

module.exports = {
  resolveCycle,
  upsertCustomer,
  findOpenOrder,
  loadOrderForBill,
  saveInboxOrder,
  userError,
};
