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
const push = require("./push");
const catalogOrder = require("./catalogOrder");
const productSync = require("./productSync");
const bill = require("./bill");
const { resolveCycle, upsertCustomer, findOpenOrder, loadOrderForBill } = require("./orders");
const wa = require("./whatsapp");
const notify = require("./notify");
const broadcast = require("./broadcast");
const communityIntake = require("./community/intake");
const communityWorker = require("./community/worker");
const { assertNoCommunityLines } = require("./community/classify");
const { groceryOnlyOrder } = require("./community/sanitize");

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
// The limit matters: this parser runs before every route, so a per-route
// express.json({ limit }) further down never gets a say. Pictures sent from
// the inbox (up to 5 MB, base64) and contact-list imports are far bigger
// than the 100 KB default, which answered them with "413 Payload Too Large".
app.use(express.json({ limit: "8mb" }));

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

// ------------------------------------------------------------
// Write the order.
//
// One live order per customer per cycle is a database rule (that is
// the community model: one bag per household per Community Day). If
// the same customer orders twice before lock, the second order's
// items are merged into the first rather than rejected.
// ------------------------------------------------------------
//
// Community lines never reach this function: the webhook diverts them to
// community_intake first. assertNoCommunityLines() is the backstop - if one
// ever does arrive, the whole write is refused (rolled back) rather than
// creating a products stub, an order_items row or a cycle_prices row.
//
// For a mixed cart `order` is the sanitized grocery-only view
// (community/sanitize.js), so orders.source_payload never holds a Community
// line either.
async function persistOrder(order, phone) {
  return db.tx(async (client) => {
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

    // Is there already a live order for this household this cycle?
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
        // market_unit_price is the BAZAAR rate, frozen onto this line.
        //
        // It cannot come from the Shopify webhook - an order line_item carries
        // `price` but not `compare_at_price` (confirmed against Shopify's Order
        // API reference). So it is read from our own catalogue, which mirrors
        // compare_at_price via db/seed/001_shopify_catalogue.sql.
        //
        // NULL is a legitimate value and means "we don't know the bazaar rate
        // for this product". The bill then omits the comparison for that line
        // rather than inventing one. On a merge, COALESCE keeps whatever rate
        // was recorded first - the promise the customer already saw.
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
      // Never overwrite an existing ceiling - that would move a promise
      // that customers have already seen.
      await client.query(
        `INSERT INTO cycle_prices (cycle_id, product_id, ceiling_price, market_price)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cycle_id, product_id) DO NOTHING`,
        [cycle.id, product.id, ceiling, product.market_price ?? null]
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
      deliveryDay: cycle.deliveryDay,
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
               now(), 1, CASE WHEN $5::text IS NULL THEN 'text' ELSE 'template' END, $10)
       ON CONFLICT (idempotency_key) DO UPDATE
          SET wamid = COALESCE(EXCLUDED.wamid, whatsapp_messages.wamid),
              status = EXCLUDED.status,
              attempts = whatsapp_messages.attempts + 1`,
      [
        key,
        customerId || null,
        orderId || null,
        phone,
        template || null,
        template ? "ur" : null,
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
      // A cart sent from the WhatsApp catalogue. Meta sends only product ids,
      // so catalogOrder.js looks the names up and writes the items out.
      preview = await catalogOrder.describe(db, msg.order);
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

  const saved = await db.query(
    `INSERT INTO whatsapp_messages
       (wamid, phone, direction, body_preview, msg_type, media_id, media_mime,
        profile_name, reply_to, payload, status, received_at, customer_id)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, $7, $8, $9, 'delivered', $10,
             (SELECT id FROM customers WHERE phone = $2))
     ON CONFLICT (wamid) DO NOTHING`,
    [
      msg.id,
      from,
      String(preview).slice(0, 1500),
      type,
      mediaId,
      mediaMime,
      contact?.profile?.name || null,
      msg.context?.id || null,
      msg,
      at,
    ]
  );

  // "STOP" / "band karo" takes a customer off the rate-list broadcasts,
  // "START" puts her back. Never allowed to break saving the message.
  if (type === "text") {
    await broadcast.handleOptWords(db, from, preview).catch((e) =>
      console.error("[broadcast] opt-out check failed:", e.message));
  }

  console.log(`[wa] INBOUND ${type} from ${from}: ${String(preview).slice(0, 80)}`);

  // Ping the phones that switched inbox notifications on. Only for a message
  // saved just now (Meta re-delivers webhooks; a repeat must not ping twice),
  // and not awaited, so a slow push service never delays the webhook reply.
  if (saved.rowCount === 1) {
    push.newMessage(db, { from, name: contact?.profile?.name || null, preview, type })
      .catch((e) => console.error("[push] inbound ping failed:", e.message));
  }
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
  // Community (migration 016). Ready only when the tables exist AND the
  // registry is usable: at least one active product and at least one variant
  // the worker could actually resolve (active variant of an active,
  // non-archived, non-deleted product that Shopify still marks Community).
  // Tables alone, or an empty registry, are NOT ready. Review rows are
  // surfaced here because nothing else alerts on them yet.
  let community = { ready: false };
  if (h.ok) {
    try {
      const { rows } = await db.query(
        // environment: 'rehearsal' only on a staging copy whose operator set
        // app_settings asb_environment (scripts/community-rehearsal.js checks it).
        `SELECT coalesce((SELECT value FROM app_settings WHERE key = 'asb_environment'), 'production') AS environment,
                (SELECT count(*) FROM community_products)::int                     AS products,
                (SELECT count(*) FROM community_products WHERE is_active)::int     AS products_active,
                (SELECT count(*) FROM community_variants)::int                     AS variants,
                (SELECT count(*) FROM community_variants v
                   JOIN community_products p USING (shopify_product_id)
                  WHERE v.is_active AND p.is_active)::int                          AS variants_active,
                (SELECT count(*) FROM community_variants v
                   JOIN community_products p USING (shopify_product_id)
                  WHERE v.is_active AND v.is_present AND p.is_active AND p.signals_ok
                    AND p.deleted_at IS NULL
                    AND coalesce(p.shopify_status, '') NOT IN ('archived', 'deleted'))::int AS variants_resolvable,
                (SELECT count(*) FROM community_intake WHERE status = 'review')::int AS review,
                (SELECT count(*) FROM community_intake
                  WHERE status IN ('received','retryable_error'))::int AS pending`);
      const c = rows[0];
      const usable = c.products_active > 0 && c.variants_resolvable > 0;
      community = { ready: usable, ...(usable ? {} : { reason: "registry_empty_or_unusable" }), ...c };
    } catch (e) {
      community = { ready: false, error: e.message };
    }
  }
  const ready = h.ok && h.migrated && config.whatsappToken &&
    config.phoneNumberId && config.appSecret && community.ready;
  res.status(ready ? 200 : 503).json({ ...h, config, community, ready });
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
//   2. capture (one tx)     - dedupe row + Community intake/registry;
//                             fails -> 503, Shopify retries
//   3. answer 200           - stop Shopify retrying
//   4. persist + send       - grocery lines only, the slow part, after the ack
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
  // No default: a delivery without a topic is NOT assumed to be an order.
  const topic = req.get("X-Shopify-Topic") || null;
  const kind = communityIntake.topicKind(topic);   // 'order' | 'product' | 'ignored'

  let order;
  try {
    order = JSON.parse(req.body.toString("utf8"));
  } catch (e) {
    console.error("Shopify webhook body is not JSON:", e.message);
    return res.sendStatus(400);
  }

  // ---- 2a. Topic allowlist ----
  // Phase 1 handles exactly orders/create (commerce) and products/create,
  // products/update, products/delete. Anything else - orders/updated,
  // orders/edited, orders/cancelled, customers/*, fulfillments/*, a missing or
  // unknown topic - is recorded for audit as 'ignored' and acknowledged. It
  // never reaches persistOrder(), never merges grocery quantities and never
  // sends a bill. (On main every non-product topic was treated as an order.)
  if (kind === "ignored") {
    try {
      await db.query(
        `INSERT INTO webhook_events (source, event_id, topic, payload, status, processed_at, error_detail)
         VALUES ('shopify', $1, $2, $3, 'ignored', now(), $4)
         ON CONFLICT (source, event_id) DO NOTHING`,
        [String(deliveryId), topic, order, `topic ${topic || "(missing)"} is not handled in Phase 1`]);
    } catch (e) {
      console.error(`Could not record ignored Shopify topic ${topic}:`, e.message);
    }
    console.log(`Shopify webhook ${deliveryId}: topic "${topic || "(missing)"}" ignored (Phase 1 allowlist)`);
    return res.sendStatus(200);
  }

  // ---- 2b. Capture BEFORE answering ----
  // One transaction: the webhook_events dedupe row, plus (orders) one
  // community_intake row per Community line, or (products) a refresh of the
  // Community registry. No network calls. Only after it commits may Shopify
  // get its 200 - so a Community line is never acknowledged without being
  // stored. If it fails, answer 503 and let Shopify retry: without the
  // registry we cannot tell a Community line from a grocery line, and
  // guessing "grocery" is exactly the 4-5 Oct contamination.
  //
  // KNOWN LIMITATION (unchanged, out of Phase 1 scope): grocery persistence
  // and the WhatsApp bill still run AFTER the 200, as before.
  // Shop identity is part of the intake key, so it is never invented: the
  // Shopify header, else the configured SHOPIFY_SHOP_DOMAIN, else refuse.
  const shop = req.get("X-Shopify-Shop-Domain") || process.env.SHOPIFY_SHOP_DOMAIN || null;
  if (!shop) {
    console.error(`Shopify webhook ${deliveryId} (${topic}) has no X-Shopify-Shop-Domain and SHOPIFY_SHOP_DOMAIN ` +
      `is not set - NOT captured, answering 503`);
    return res.sendStatus(503);
  }
  const rawPhoneEarly =
    order.shipping_address?.phone || order.customer?.phone || order.phone || null;

  let cap;
  try {
    cap = await communityIntake.captureWebhook(db, {
      shop,
      deliveryId,
      topic,
      payload: order,
      phone: normalizePhone(rawPhoneEarly),
      rawBody: req.body,
    });
  } catch (e) {
    console.error(`Shopify webhook ${deliveryId} (${topic}) NOT captured - answering 503 so Shopify retries:`, e.message);
    return res.sendStatus(503);
  }

  const eventRowId = cap.eventRowId;
  if (cap.duplicate) {
    console.log(`Duplicate Shopify delivery ${deliveryId} ignored`);
    return res.sendStatus(200);
  }

  // ---- 3. Answer Shopify ----
  res.sendStatus(200);

  // A product was created or edited in Shopify (a new price, a new unit):
  // mirror it into products and pass the price on to the WhatsApp catalogue.
  // Community products were registered in step 2b and are refused by
  // productSync, so they never reach `products` or the Meta catalogue.
  if (kind === "product") {
    try {
      // products/delete carries only { id }: nothing to mirror. (On main this
      // was already a no-op; skipping it also keeps the registry's "deleted"
      // mark from being overwritten by an empty payload.)
      if (topic !== "products/delete") await productSync.fromShopifyWebhook(db, order);
      if (eventRowId) await db.markWebhookProcessed(eventRowId);
    } catch (e) {
      console.error(`[rates] product webhook failed for "${order.title}":`, e.message);
      if (eventRowId) await db.markWebhookFailed(eventRowId, e.message);
    }
    return;
  }

  if (cap.kind === "order" && cap.communityLines.length) {
    console.log(
      `   COMMUNITY: ${order.name || order.id} - ${cap.communityLines.length} line(s) captured to community_intake ` +
        `(${cap.inserted} new): ` +
        cap.communityLines.map((c) => `${c.line.title} x${c.line.quantity} [${c.classification}: ${c.signals.join("+")}]`).join(", ")
    );
    communityWorker.kick(db);
  }

  // ---- 4. Persist, then notify ----
  // From here on the grocery pipeline sees ONLY grocery lines. An order whose
  // lines were all Community creates no grocery order and sends no grocery
  // bill. An order with no Community lines is handled exactly as before.
  const hasCommunity = cap.kind === "order" && cap.communityLines.length > 0;
  const rawOrder = order;
  if (hasCommunity) {
    order = groceryOnlyOrder(rawOrder, { ...cap, eventRowId });
    if (!cap.groceryLines.length) {
      console.log(`   ${rawOrder.name || rawOrder.id}: Community-only order - no grocery order created, no grocery bill sent`);
      if (eventRowId) await db.markWebhookProcessed(eventRowId);
      return;
    }
  }

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

    // A mixed cart's grocery view carries no Shopify totals (they included the
    // Community packs), so the fallback total is summed from the grocery lines.
    const totalPKR = Math.round(
      hasCommunity
        ? (order.line_items || []).reduce((s, i) => s + Number(i.price || 0) * Number(i.quantity || 1), 0)
        : Number(order.total_price || 0)
    ).toLocaleString("en-PK");

    console.log(`NEW ORDER ${orderName} from ${firstName}, phone: ${rawPhone} -> ${phone}`);
    console.log(`   Items: ${items} | Max bill: Rs ${totalPKR}`);

    if (!phone) {
      console.error(`   No phone on order ${orderName} - cannot save or send`);
      if (eventRowId) await db.markWebhookFailed(eventRowId, "no phone on order");
      return;
    }

    // --- save it ---
    let saved = null;
    let recapturedLeak = false;
    try {
      saved = await persistOrder(order, phone).catch(async (e) => {
        if (e.code !== "ASB_COMMUNITY_LEAK") throw e;
        // The registry changed between capture (before the 200) and now, so a
        // line that was grocery then is Community now. Capture it to
        // community_intake (never lose it), then persist only what is still
        // grocery. No second chance: a further leak is refused below.
        recapturedLeak = true;
        const cap2 = await db.tx((c) => communityIntake.captureOrderLines(c, {
          shop, topic, order: rawOrder, eventRowId, phone: normalizePhone(rawPhoneEarly),
          orderRaw: Buffer.from(req.body).toString("utf8"),
        }));
        console.warn(`   ${orderName}: registry changed after capture - ${cap2.communityLines.length} Community line(s) now in community_intake`);
        communityWorker.kick(db);
        if (!cap2.groceryLines.length) return { communityOnly: true };
        order = groceryOnlyOrder(rawOrder, { ...cap2, eventRowId });
        return persistOrder(order, phone);
      });
      if (saved.communityOnly) {
        console.log(`   ${orderName}: no grocery lines left - no grocery order, no grocery bill`);
        if (eventRowId) await db.markWebhookProcessed(eventRowId);
        return;
      }
      if (saved.skipped) {
        console.log(`   Already saved as ${saved.orderNumber} - not sending again`);
        if (eventRowId) await db.markWebhookProcessed(eventRowId);
        return;
      }
      console.log(
        `   Saved as ${saved.order_number} for ${saved.deliveryDay} delivery (${saved.cycleCode})` +
          `${saved.merged ? " (merged)" : ""}, ceiling Rs ${saved.ceiling_total}`
      );
    } catch (e) {
      console.error(`   DB write failed for ${orderName}:`, e.message);
      if (eventRowId) await db.markWebhookFailed(eventRowId, e.message);
      // The Community backstop refused the order (a Community line reached
      // the grocery writer). Send nothing: an improvised bill here could list
      // the wrong lines. The payload stays in webhook_events for review.
      if (e.code === "ASB_COMMUNITY_LEAK" || recapturedLeak) return;
      // Still send the confirmation - the customer matters more than our records,
      // and the raw payload is safe in webhook_events for a later backfill.
    }

    // --- compose the message ---
    //
    // Built from the saved order when we have one. If the DB write failed we
    // fall back to the raw Shopify payload rather than sending nothing: an
    // improvised confirmation beats silence for the customer, and the payload
    // is safe in webhook_events for a later backfill.
    let composed = null;
    if (saved?.orderId) {
      try {
        const forBill = await loadOrderForBill(db, saved.orderId);
        if (forBill) {
          // On a merge the saved order carries the FIRST order's time. The
          // message confirms THIS order, so it states this order's time.
          forBill.ordered_at = order.created_at || forBill.placed_at;
          composed = bill.orderConfirmation(forBill);
        }
      } catch (e) {
        console.error(`   Could not compose bill for ${orderName}:`, e.message);
      }
    }

    // Print the exact customer-facing text to the log. This is how the message
    // can be read and checked while outbound sending is still blocked.
    if (composed) {
      console.log("   --- message the customer would receive ---");
      for (const ln of composed.rich.split("\n")) console.log("   " + ln);
      console.log("   ------------------------------------------");
    }

    // If the order could not be composed from the database (the DB write
    // failed), build a stand-in from the raw Shopify payload so the customer
    // still hears from us. Same shape bill.orderConfirmation returns.
    if (!composed) {
      const orderNo = saved?.order_number || orderName;
      composed = {
        communitySaved: 0,
        rich:
          `Assalam-o-Alaikum ${firstName} 🌿\nAap ka order mil gaya — *${orderNo}*\n\n` +
          `${items || "-"}\n\nZyada se zyada: *Rs ${totalPKR}*\n\nApna Sasta Bazaar`,
        params: {
          customer_name: firstName, order_id: orderNo, ordered: "-", delivery: "-",
          order_items: items || "-", bazaar_total: `Rs ${totalPKR}`,
          zyada_se_zyada: `Rs ${totalPKR}`, abhi_se_bachat: "Rs 0",
        },
      };
    }

    // --- tell the customer ---
    // Free text if she has written to us in the last 24 hours, the approved
    // asb_order_bill template otherwise (notify.js decides).
    const { result, via, template } = await notify.sendOrderBill(db, phone, composed);
    console.log(`   Bill sent as ${via}: ${result.ok ? "accepted by Meta" : "REFUSED (" + (result.code || "?") + ")"}`);

    await logOutbound({
      key: `order_confirmed:shopify:${order.id}`,
      customerId: saved?.customerId,
      orderId: saved?.orderId,
      phone,
      template,
      preview: composed.rich,
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
// Started only when run directly (`node server.js`, as Render does). Tests
// require() this file to drive the routes without opening the port or
// starting the background timers.
function start() {
return app.listen(PORT, async () => {
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

  // A rate-list broadcast interrupted by a restart carries on from where it
  // stopped. Every recipient is marked as sent, so nobody gets it twice.
  if (h.ok) broadcast.resumeAll(db, require("./inbox").logOutbound);

  // Read the Meta catalogue's product names (retailer id -> name), then write
  // names into saved catalogue orders that still show "item <id>" or the old
  // "(catalogue order)". Repeats every 6 hours so new products are picked up.
  // products.meta_retailer_id must exist before catalogue orders are read.
  if (h.ok) {
    productSync.ensureSchema(db)
      .catch((e) => console.error("[rates] could not add products.meta_retailer_id:", e.message))
      .finally(() => catalogOrder.start(db));
  }

  // Community isolation needs migration 016 and a bootstrapped registry.
  // Without the tables every Shopify webhook answers 503 and Shopify only
  // retries for a limited time - so say so loudly at boot (and /healthz is 503).
  if (h.ok) {
    try {
      const { rows } = await db.query(
        `SELECT to_regclass('community_intake') IS NOT NULL AS intake,
                to_regclass('community_variants') IS NOT NULL AS registry`);
      if (!rows[0].intake || !rows[0].registry) {
        console.error("[community] migration 016 NOT applied - Shopify webhooks will answer 503 until it is. " +
          "Run: node scripts/migrate.js");
      } else {
        const n = (await db.query(`SELECT count(*)::int AS n FROM community_variants`)).rows[0].n;
        if (!n) console.warn("[community] registry is EMPTY - Community lines will only be caught by SKU and go to review. " +
          "Run: node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json --apply");
        else console.log(`[community] registry: ${n} Community variants`);
      }
    } catch (e) {
      console.error("[community] boot check failed:", e.message);
    }
  }
  // Intake sweeper: finishes any community_intake row left in 'received' or
  // 'retryable_error' (a crash, a deploy, a failed attempt). Started even if
  // the boot check failed (e.g. Neon still waking) - each sweep tolerates errors.
  communityWorker.start(db);
});
}

if (require.main === module) start();

module.exports = { app, start, persistOrder, resolveProduct, normalizePhone };
