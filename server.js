// ============================================================
// ASB PIPELINE - Apna Sasta Bazaar
// Shopify -> Postgres -> WhatsApp order pipeline
//
// Running direct on Meta's Cloud API. No BSP in the path.
// ============================================================
// Jobs:
//   1. Prove to Meta that we own our webhook URL (the "handshake")
//   2. Receive WhatsApp messages + delivery receipts (inbound)
//   3. Receive Shopify orders, WRITE THEM TO THE DATABASE, then
//      send the order_confirmed WhatsApp template
//   4. Serve /inbox so a human can read and answer customers
//
// What changed in the AiSensy cutover (migration 003):
//   - The WhatsApp webhook now VERIFIES META'S SIGNATURE. Before this
//     it accepted any POST, which meant anyone who learned the URL
//     could inject fabricated customer messages into the database.
//     This is the single most important change in the file.
//   - Inbound messages are parsed properly: profile name, message
//     type, media ids, button/interactive replies, quoted messages.
//     A webhook carrying several messages no longer loses all but
//     the first.
//   - Cloud API calls moved to ./whatsapp.js, which also knows how
//     to send free-form text (needed to answer people) and download
//     media (needed for voice notes).
//   - Inbound messages are marked read, so customers see blue ticks
//     and know a person is there.
// ============================================================

const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const wa = require("./whatsapp");

const app = express();
app.set("trust proxy", 1); // Render sits behind a proxy

// ------------------------------------------------------------
// SETTINGS - from Environment Variables in Render.
// NEVER write real secrets here.
//
// Required for the direct Cloud API setup:
//   WHATSAPP_TOKEN        System User token (permanent)
//   PHONE_NUMBER_ID       the business number's id
//   META_APP_SECRET       <- NEW. App secret, for webhook signatures.
//   VERIFY_TOKEN          any string; must match what you type in Meta
//   SHOPIFY_WEBHOOK_SECRET
//   DATABASE_URL
//   INBOX_PASSWORD        shared password for /inbox
//   INBOX_COOKIE_SECRET   any long random string
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "asb-verify-2026";

// ------------------------------------------------------------
// Both webhooks need the RAW body to check their signature, so raw
// parsing is mounted on those two paths only. Everything else gets
// normal JSON.
//
// Order matters: these must come BEFORE express.json().
// ------------------------------------------------------------
app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
app.use("/webhooks/whatsapp", express.raw({ type: "application/json" }));
app.use(express.json());

// ------------------------------------------------------------
// Tiny helper: turn any Pakistani phone format into 923001234567
// ------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(4);
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return "92" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("3")) return "92" + digits;
  return digits;
}

// ============================================================
// DATABASE HELPERS
// ============================================================

// ------------------------------------------------------------
// Which buying cycle does a new order belong to?
//
// Normally there is exactly one cycle with status 'open'. If there
// isn't, we create a provisional one rather than dropping the order
// on the floor - the raw payload is safe in webhook_events either
// way, but an order sitting in `orders` is far easier to work with.
// The WARN line is deliberate: provisional cycles need their real
// lock and delivery times set by hand.
// ------------------------------------------------------------
async function resolveCycle(client) {
  const open = await client.query(
    `SELECT id, code FROM cycles WHERE status = 'open'
      ORDER BY cycle_date DESC LIMIT 1`
  );
  if (open.rows.length > 0) return open.rows[0];

  const code = "C-AUTO-" + new Date().toISOString().slice(0, 10);
  const created = await client.query(
    `INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status, notes)
     VALUES ($1, CURRENT_DATE, now(), now() + interval '1 day',
             CURRENT_DATE + 1, 'open',
             'auto-created by the pipeline - set real lock/delivery times')
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING id, code`,
    [code]
  );
  console.warn(
    `[db] no open cycle found - created provisional ${created.rows[0].code}. ` +
      `Set its locks_at / delivery_date before the mandi run.`
  );
  return created.rows[0];
}

// ------------------------------------------------------------
// Find or create the customer. Phone is the identity.
// ------------------------------------------------------------
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
      `SELECT id, unit, name_en, name_ur FROM products WHERE shopify_variant_id = $1`,
      [variantId]
    );
    if (hit.rows.length) return hit.rows[0];
  }
  if (sku) {
    const hit = await client.query(
      `SELECT id, unit, name_en, name_ur FROM products WHERE sku = $1`,
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
     RETURNING id, unit, name_en, name_ur`,
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

// ------------------------------------------------------------
// Write the order.
//
// One live order per customer per cycle is a database rule (that is
// the community model: one bag per household per Community Day). If
// the same customer orders twice before lock, the second order's
// items are merged into the first rather than rejected.
// ------------------------------------------------------------
async function persistOrder(order, phone) {
  return db.tx(async (client) => {
    const cycle = await resolveCycle(client);

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

    // Is there already a live order for this household this cycle?
    const existing = await client.query(
      `SELECT id, order_number FROM orders
        WHERE customer_id = $1 AND cycle_id = $2 AND status <> 'cancelled'`,
      [customer.id, cycle.id]
    );

    let orderRow;
    let merged = false;

    if (existing.rows.length > 0) {
      orderRow = existing.rows[0];
      merged = true;
      console.log(
        `[db] merging Shopify ${order.name} into existing ${orderRow.order_number}`
      );
    } else {
      const ins = await client.query(
        `INSERT INTO orders (customer_id, cycle_id, society_id, channel, status,
                             shopify_order_id, shopify_order_name,
                             deliver_building, deliver_flat, deliver_note,
                             source_payload)
         VALUES ($1, $2, $3, 'shopify', 'confirmed', $4, $5, $6, $7, $8, $9)
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
        ]
      );

      if (ins.rows.length === 0) {
        const again = await client.query(
          `SELECT id, order_number FROM orders WHERE shopify_order_id = $1`,
          [String(order.id)]
        );
        return { skipped: true, orderNumber: again.rows[0]?.order_number };
      }
      orderRow = ins.rows[0];
    }

    // --- line items -------------------------------------------------
    // The Shopify price is the CEILING. Nothing here sets a final price;
    // that happens at lock time, after the mandi run.
    for (const item of order.line_items || []) {
      const product = await resolveProduct(client, item);
      const qty = Number(item.quantity || 1);
      const ceiling = Number(item.price || 0);

      if (!(ceiling > 0)) {
        console.warn(`[db] line "${item.title}" has no price - skipped`);
        continue;
      }

      await client.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, name_ur_snapshot,
                                  unit, qty_ordered, ceiling_unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (order_id, product_id) DO UPDATE
            SET qty_ordered = order_items.qty_ordered + EXCLUDED.qty_ordered`,
        [
          orderRow.id,
          product.id,
          item.title || product.name_en,
          product.name_ur,
          product.unit,
          qty,
          ceiling,
        ]
      );

      // Publish the ceiling into the cycle price book if it isn't there.
      // Never overwrite an existing ceiling - that would move a promise
      // that customers have already seen.
      await client.query(
        `INSERT INTO cycle_prices (cycle_id, product_id, ceiling_price)
         VALUES ($1, $2, $3)
         ON CONFLICT (cycle_id, product_id) DO NOTHING`,
        [cycle.id, product.id, ceiling]
      );
    }

    await client.query(`SELECT asb_refresh_order_totals($1)`, [orderRow.id]);

    const totals = await client.query(
      `SELECT order_number, ceiling_total, grand_total FROM orders WHERE id = $1`,
      [orderRow.id]
    );

    return {
      skipped: false,
      merged,
      orderId: orderRow.id,
      customerId: customer.id,
      cycleCode: cycle.code,
      ...totals.rows[0],
    };
  });
}

// ------------------------------------------------------------
// Log an outbound WhatsApp send against the order.
// The idempotency key makes a duplicate send impossible even if
// this function is somehow called twice.
// ------------------------------------------------------------
// `preview` is what a human reads in the inbox. Without it a template send
// shows up as an empty bubble, which makes the thread impossible to follow -
// you can see that something went out but not what the customer was told.
async function logOutbound({ key, customerId, orderId, phone, template, preview, wamid, ok, payload }) {
  try {
    await db.query(
      `INSERT INTO whatsapp_messages
         (idempotency_key, customer_id, order_id, phone, direction,
          template_name, template_lang, wamid, status, payload, sent_at,
          received_at, attempts, msg_type, body_preview)
       -- $8 is used both as an enum and in a text comparison, so both uses
       -- need an explicit cast. Without them Postgres refuses the statement
       -- with "inconsistent types deduced for parameter $8".
       VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8::msg_status, $9,
               CASE WHEN $8::text = 'sent' THEN now() ELSE NULL END,
               now(), 1, 'template', $10)
       ON CONFLICT (idempotency_key) DO UPDATE
          SET wamid = COALESCE(EXCLUDED.wamid, whatsapp_messages.wamid),
              status = EXCLUDED.status,
              attempts = whatsapp_messages.attempts + 1`,
      [
        key,
        customerId || null,
        orderId || null,
        phone,
        template,
        wa.templateLang,
        wamid,
        ok ? "sent" : "failed",
        payload || {},
        (preview || template || "").slice(0, 500),
      ]
    );
  } catch (e) {
    console.error("[db] could not log outbound message:", e.message);
  }
}

// ------------------------------------------------------------
// Store one inbound message.
//
// Pulls out everything worth having: the WhatsApp profile name (often
// the only name we have for a customer who never used Shopify), the
// type, media ids for photos and voice notes, and the readable text
// for button taps and list selections - which arrive as structured
// objects, not text, and used to be stored as the useless "(button)".
// ------------------------------------------------------------
async function saveInbound(msg, contact) {
  const from = normalizePhone(msg.from);
  const type = msg.type || "unknown";

  // Readable text, whatever the message type.
  let preview;
  let mediaId = null;
  let mediaMime = null;

  switch (type) {
    case "text":
      preview = msg.text?.body || "";
      break;
    case "button":
      // Quick-reply on a template.
      preview = msg.button?.text || "(button)";
      break;
    case "interactive":
      preview =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        "(interactive)";
      break;
    case "image":
    case "audio":
    case "video":
    case "document":
    case "sticker":
      mediaId = msg[type]?.id || null;
      mediaMime = msg[type]?.mime_type || null;
      preview =
        msg[type]?.caption ||
        (type === "audio" && msg.audio?.voice ? "(voice note)" : `(${type})`);
      break;
    case "location":
      preview = `(location ${msg.location?.latitude}, ${msg.location?.longitude})` +
        (msg.location?.name ? ` ${msg.location.name}` : "");
      break;
    case "order":
      preview = "(catalogue order)";
      break;
    case "reaction":
      preview = `(reacted ${msg.reaction?.emoji || ""})`;
      break;
    default:
      preview = `(${type})`;
  }

  // Meta sends the message timestamp as unix seconds, as a string.
  const at = msg.timestamp
    ? new Date(Number(msg.timestamp) * 1000)
    : new Date();

  await db.query(
    `INSERT INTO whatsapp_messages
       (wamid, phone, direction, body_preview, msg_type, media_id, media_mime,
        profile_name, reply_to, payload, status, received_at, customer_id)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, 'delivered', $10,
             (SELECT id FROM customers WHERE phone = $2))
     ON CONFLICT (wamid) DO NOTHING`,
    [
      msg.id,
      from,
      String(preview).slice(0, 500),
      type,
      mediaId,
      mediaMime,
      contact?.profile?.name || null,
      msg.context?.id || null,
      msg,
      at,
    ]
  );

  console.log(`[wa] INBOUND ${type} from ${from}: ${String(preview).slice(0, 80)}`);
  return { from, type, preview };
}

// ============================================================
// ROUTES
// ============================================================

// ------------------------------------------------------------
// The inbox UI + its API. Mounted here so it shares the db pool.
// ------------------------------------------------------------
app.use(require("./inbox"));

// ------------------------------------------------------------
// ROUTE 0: Health check
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("ASB Pipeline is running. Sasta Bhi, Achha Bhi!");
});

// Deeper check - confirms the database is reachable AND migrated,
// and that the env vars the Cloud API needs are actually present.
app.get("/healthz", async (req, res) => {
  const h = await db.health();
  const config = {
    graphVersion: wa.graphVersion,
    whatsappToken: Boolean(process.env.WHATSAPP_TOKEN),
    phoneNumberId: Boolean(process.env.PHONE_NUMBER_ID),
    appSecret: Boolean(process.env.META_APP_SECRET),
    inboxConfigured: Boolean(
      process.env.INBOX_PASSWORD &&
        (process.env.INBOX_COOKIE_SECRET || process.env.VERIFY_TOKEN)
    ),
  };
  const ready = h.ok && h.migrated && config.whatsappToken &&
    config.phoneNumberId && config.appSecret;
  res.status(ready ? 200 : 503).json({ ...h, config, ready });
});

// ------------------------------------------------------------
// ROUTE 1: Meta webhook VERIFICATION handshake (GET)
// ------------------------------------------------------------
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook VERIFIED by Meta");
    return res.status(200).send(challenge);
  }
  console.warn("Webhook verification FAILED (wrong token)");
  return res.sendStatus(403);
});

// ------------------------------------------------------------
// ROUTE 2: Inbound WhatsApp events (POST)
//
// Customer messages are stored; delivery receipts are matched
// back to the outbound message by wamid.
//
// Step 0 is the signature check. Meta HMACs every body with the app
// secret; without this the endpoint is an open write into our
// customer records. It runs before anything is parsed or stored.
// ------------------------------------------------------------
app.post("/webhooks/whatsapp", async (req, res) => {
  // ---- 0. Is this really Meta? ----
  // req.body is a Buffer here (express.raw), which is exactly what was
  // signed. Re-serialising parsed JSON would not match.
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  if (!wa.verifySignature(raw, req.get("X-Hub-Signature-256"))) {
    console.warn("[wa] webhook REJECTED - bad or missing signature");
    return res.sendStatus(401);
  }

  // Always answer 200 fast, or Meta keeps retrying
  res.sendStatus(200);

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error("[wa] webhook body is not JSON:", e.message);
    return;
  }

  const eventId = crypto
    .createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, 40);

  try {
    const { isNew, id: eventRowId } = await db.recordWebhook(
      "whatsapp",
      eventId,
      "messages",
      body
    );
    if (!isNew) {
      console.log("Duplicate WhatsApp webhook ignored");
      return;
    }

    // A single webhook can carry several entries, each with several
    // changes, each with several messages. The old code read [0] of
    // everything and silently dropped the rest - which on a busy
    // Community Day morning means lost customer messages.
    let handled = 0;

    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        const contacts = value.contacts || [];

        // --- real messages from customers ---
        for (let i = 0; i < (value.messages || []).length; i++) {
          const msg = value.messages[i];
          try {
            await saveInbound(msg, contacts[i] || contacts[0]);
            handled++;
            // Blue ticks: cheap, free, and tells the customer a human
            // is on the other end. Never allowed to fail the webhook.
            wa.markRead(msg.id).catch(() => {});
          } catch (e) {
            console.error(`[wa] could not save inbound ${msg.id}:`, e.message);
          }
        }

        // --- delivery receipts for things we sent ---
        for (const status of value.statuses || []) {
          console.log(`STATUS: ${status.recipient_id} -> "${status.status}"`);
          try {
            await db.query(
              `UPDATE whatsapp_messages
                  SET status = $2::msg_status,
                      delivered_at = CASE WHEN $2::text IN ('delivered','read')
                                          THEN COALESCE(delivered_at, now()) END,
                      read_at      = CASE WHEN $2::text = 'read'
                                          THEN COALESCE(read_at, now()) END,
                      error_code   = $3
                WHERE wamid = $1`,
              [
                status.id,
                status.status,
                status.errors?.[0]?.code?.toString() || null,
              ]
            );
            handled++;
          } catch (e) {
            console.error("[wa] status update failed:", e.message);
          }
        }

        // --- account-level notices worth seeing in the logs ---
        // Template rejections and quality-rating drops arrive here. On a
        // BSP dashboard these showed up as an alert; direct on the Cloud
        // API, the log is the alert.
        if (change.field && change.field !== "messages") {
          console.warn(
            `[wa] account event "${change.field}": ${JSON.stringify(value).slice(0, 400)}`
          );
          handled++;
        }
      }
    }

    if (handled === 0) {
      console.log("Webhook event (other):", raw.toString("utf8").slice(0, 300));
    }
    await db.markWebhookProcessed(eventRowId);
  } catch (e) {
    console.error("Error reading WhatsApp webhook:", e.message);
  }
});

// ------------------------------------------------------------
// ROUTE 3: Shopify orders/create webhook (POST)
//
// Order of operations matters here:
//   1. verify HMAC          - is this really Shopify?
//   2. record the webhook   - have we seen this delivery before?
//   3. answer 200           - stop Shopify retrying
//   4. persist + send       - the slow part, after the ack
// ------------------------------------------------------------
app.post("/webhooks/shopify", async (req, res) => {
  // ---- 1. Verify the HMAC signature ----
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", process.env.SHOPIFY_WEBHOOK_SECRET || "")
    .update(req.body)
    .digest("base64");

  let valid = false;
  try {
    valid =
      hmacHeader.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (_) {
    valid = false;
  }

  if (!valid) {
    console.warn("Shopify webhook REJECTED - bad HMAC signature");
    return res.sendStatus(401);
  }

  // ---- 2. Dedupe BEFORE doing any work ----
  // Shopify retries if it doesn't get a 200 within 5 seconds. A free
  // Render instance waking from sleep takes longer than that, so the
  // same order genuinely does arrive more than once.
  const deliveryId =
    req.get("X-Shopify-Webhook-Id") ||
    crypto.createHash("sha256").update(req.body).digest("hex").slice(0, 40);
  const topic = req.get("X-Shopify-Topic") || "orders/create";

  let order;
  try {
    order = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    console.error("Shopify webhook body is not JSON:", e.message);
    return res.sendStatus(400);
  }

  let eventRowId;
  try {
    const rec = await db.recordWebhook("shopify", deliveryId, topic, order);
    eventRowId = rec.id;
    if (!rec.isNew) {
      console.log(`Duplicate Shopify delivery ${deliveryId} ignored`);
      return res.sendStatus(200);
    }
  } catch (e) {
    console.error("Could not record webhook:", e.message);
    // Fall through - better to process an order twice than lose it.
  }

  // ---- 3. Answer Shopify fast ----
  res.sendStatus(200);

  // ---- 4. Persist, then notify ----
  try {
    const orderName = order.name || `#${order.id}`;
    const firstName =
      order.customer?.first_name || order.shipping_address?.first_name || "Customer";
    const rawPhone =
      order.shipping_address?.phone || order.customer?.phone || order.phone || null;
    const phone = normalizePhone(rawPhone);

    const items = (order.line_items || [])
      .map((i) => `${i.title} x${i.quantity}`)
      .join(", ");

    const totalPKR = Math.round(Number(order.total_price || 0)).toLocaleString("en-PK");

    console.log(`NEW ORDER ${orderName} from ${firstName}, phone: ${rawPhone} -> ${phone}`);
    console.log(`   Items: ${items} | Max bill: Rs ${totalPKR}`);

    if (!phone) {
      console.error(`   No phone on order ${orderName} - cannot save or send`);
      if (eventRowId) await db.markWebhookFailed(eventRowId, "no phone on order");
      return;
    }

    // --- save it ---
    let saved = null;
    try {
      saved = await persistOrder(order, phone);
      if (saved.skipped) {
        console.log(`   Already saved as ${saved.orderNumber} - not sending again`);
        if (eventRowId) await db.markWebhookProcessed(eventRowId);
        return;
      }
      console.log(
        `   Saved as ${saved.order_number} in cycle ${saved.cycleCode}` +
          `${saved.merged ? " (merged)" : ""}, ceiling Rs ${saved.ceiling_total}`
      );
    } catch (e) {
      console.error(`   DB write failed for ${orderName}:`, e.message);
      if (eventRowId) await db.markWebhookFailed(eventRowId, e.message);
      // Still send the confirmation - the customer matters more than our records,
      // and the raw payload is safe in webhook_events for a later backfill.
    }

    // --- tell the customer ---
    const result = await wa.sendTemplate(phone, "order_confirmed", [
      { name: "customer_name", value: firstName },
      { name: "order_id", value: saved?.order_number || orderName },
      { name: "order_items", value: items || "-" },
      { name: "max_bill", value: totalPKR },
    ]);

    await logOutbound({
      key: `order_confirmed:shopify:${order.id}`,
      customerId: saved?.customerId,
      orderId: saved?.orderId,
      phone,
      template: "order_confirmed",
      preview:
        `Order ${saved?.order_number || orderName} confirmed for ${firstName} — ` +
        `${items || "-"} · max Rs ${totalPKR}`,
      wamid: result.wamid,
      ok: result.ok,
      payload: { order_name: orderName, response: result.data },
    });

    if (eventRowId) await db.markWebhookProcessed(eventRowId);
  } catch (e) {
    console.error("Error processing Shopify order:", e.message);
    if (eventRowId) await db.markWebhookFailed(eventRowId, e.message);
  }
});

// ------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`ASB Pipeline listening on port ${PORT} (Graph ${wa.graphVersion})`);

  // Fail loudly at boot rather than silently at the first message.
  if (!process.env.META_APP_SECRET) {
    console.error(
      "[wa] META_APP_SECRET is NOT set - every WhatsApp webhook will be " +
        "rejected with 401. Add it in Render -> Environment."
    );
  }
  if (!process.env.INBOX_PASSWORD) {
    console.warn("[inbox] INBOX_PASSWORD not set - /inbox will refuse to sign anyone in.");
  }

  const h = await db.health();
  if (h.ok && h.migrated) {
    console.log(`[db] connected - ${h.tables} tables, ${h.asbFunctions} asb_* functions`);
  } else if (h.ok) {
    console.warn(`[db] connected but NOT fully migrated:`, JSON.stringify(h));
  } else {
    console.error(`[db] NOT reachable:`, h.error);
  }
});
