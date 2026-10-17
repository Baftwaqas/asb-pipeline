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
const { writeGroceryOrder, resolveProduct } = require("./grocery/write");
const groceryWorker = require("./grocery/worker");
const groceryAlerts = require("./grocery/alerts");
const groceryReceipts = require("./grocery/receipts");
const grocerySwitches = require("./grocery/switches");
const { parseOrderJson, UnsafeIntegerError } = require("./grocery/orderjson");
const wa = require("./whatsapp");
const notify = require("./notify");
const broadcast = require("./broadcast");
const communityIntake = require("./community/intake");
const communityWorker = require("./community/worker");

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
const INSTANCE_STARTED_AT = new Date().toISOString();
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
// The grocery bag writer lives in grocery/write.js (migration 017). The
// production path is grocery/apply.js, which calls it only for a Shopify
// order whose shopify_order_sources row it holds. persistOrder() is kept as a
// thin wrapper for tests and tools: it bypasses the source mapping, so it is
// NOT an idempotent entry point and nothing in the webhook path calls it.
// ------------------------------------------------------------
async function persistOrder(order, phone) {
  return db.tx((client) => writeGroceryOrder(client, order, phone));
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
    // Where Meta calls go. A rehearsal must point this at a local fake Graph.
    graphHost: (() => { try { return new URL(process.env.GRAPH_BASE || "https://graph.facebook.com").hostname; } catch { return "invalid"; } })(),
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
  // Grocery reliability (migration 017). Reported only: it does not change
  // `ready` or the status code, so a paused worker never fails a deploy check.
  let grocery = { available: false };
  if (h.ok) {
    try {
      const has = (await db.query(`SELECT to_regclass('shopify_order_sources') IS NOT NULL AS t`)).rows[0].t;
      if (has) {
        const sw = await grocerySwitches.status(db);
        const { rows } = await db.query(
          `SELECT (SELECT coalesce(jsonb_object_agg(status, n), '{}') FROM
                    (SELECT status, count(*)::int AS n FROM shopify_order_sources GROUP BY status) x)      AS sources,
                  (SELECT coalesce(jsonb_object_agg(bill_state, n), '{}') FROM
                    (SELECT bill_state, count(*)::int AS n FROM shopify_order_sources GROUP BY bill_state) y) AS bills,
                  (SELECT count(*)::int FROM shopify_order_sources WHERE status = 'processing' AND lease_until < now()) AS expired_leases,
                  (SELECT count(*)::int FROM shopify_order_sources WHERE bill_hold_reason IS NOT NULL)             AS bills_held,
                  (SELECT count(*)::int FROM shopify_order_source_duplicates
                    WHERE fingerprint_differs AND acknowledged_at IS NULL)                                         AS open_anomalies,
                  (SELECT count(*)::int FROM grocery_alerts WHERE state = 'pending')                               AS alerts_pending,
                  (SELECT count(*)::int FROM grocery_alerts WHERE state = 'gave_up')                               AS alerts_gave_up,
                  (SELECT count(*)::int FROM whatsapp_receipt_backlog WHERE applied_at IS NULL)                    AS receipts_unapplied`);
        grocery = { available: true, ...sw, ...rows[0],
                    alert_push: groceryAlerts.pushOn(), push_suppressed: (await push.suppressed(db)) || false };
      }
    } catch (e) {
      grocery = { available: false, error: e.message };
    }
  }
  // Migration 017 must be present: without it every orders/create answers
  // 503. Readiness therefore fails, so a deploy ahead of the migration is
  // caught instead of silently refusing every order.
  const ready = h.ok && h.migrated && config.whatsappToken &&
    config.phoneNumberId && config.appSecret && community.ready && grocery.available;
  res.status(ready ? 200 : 503).json({ ...h, config, community, grocery, ready,
    build: process.env.RENDER_GIT_COMMIT || null, instance_started_at: INSTANCE_STARTED_AT });
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

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch (e) {
    console.error("[wa] webhook body is not JSON:", e.message);
    return res.sendStatus(200);
  }

  // ---- Journal delivery receipts BEFORE the 200 (migration 017) ----
  // A receipt is the only proof a message reached the customer, so it is
  // never acknowledged unrecorded: if the journal write fails, answer 503 and
  // Meta retries. Applying it to whatsapp_messages happens after the 200.
  const receiptList = groceryReceipts.statusesIn(body);
  if (receiptList.length) {
    try {
      await groceryReceipts.journal(db, receiptList);
    } catch (e) {
      console.error("[wa] could not journal delivery receipts - answering 503 so Meta retries:", e.message);
      return res.sendStatus(503);
    }
  }

  // Answer 200 fast, or Meta keeps retrying
  res.sendStatus(200);

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
        // Journalled before the 200; applied here MONOTONICALLY (read is never
        // downgraded). A receipt for a message not logged yet stays in the
        // journal and is applied when the row appears (sweeper / bill finalize).
        for (const status of value.statuses || []) {
          console.log(`STATUS: ${status.recipient_id} -> "${status.status}"`);
          try {
            if (status.id && ["sent", "delivered", "read", "failed"].includes(String(status.status))) {
              await groceryReceipts.applyOne(db, String(status.id), String(status.status));
            }
            handled++;
          } catch (e) {
            console.error("[wa] status update failed (stays in the journal for replay):", e.message);
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
    // Lossless for 64-bit Shopify ids (grocery/orderjson.js).
    order = parseOrderJson(req.body);
  } catch (e) {
    if (e instanceof UnsafeIntegerError) {
      console.error(`Shopify webhook ${deliveryId}: ${e.message} - answering 503, NOT captured`);
      return res.sendStatus(503);
    }
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

  // ---- 4. Orders: hand over to the durable grocery worker ----
  // Migration 017. The capture above reserved this Shopify order
  // (shopify_order_sources) in the same transaction as the dedupe row, so it
  // survives a restart from here on. A Shopify order that was ALREADY known -
  // under any delivery id - was recorded as a duplicate and is never applied
  // or billed again (a different payload raised an anomaly alert).
  if (cap.orderDuplicate || cap.invalidOrder) {
    console.log(`Shopify order ${order.name || order.id}: ${cap.orderDuplicate ? "already captured (source " + cap.sourceId + ") - not applied again" : "no order id - not applied"}`);
    if (cap.alertIds?.length) groceryAlerts.dispatch(db, cap.alertIds).catch(() => {});
    return;
  }

  if (cap.communityLines.length) {
    console.log(
      `   COMMUNITY: ${order.name || order.id} - ${cap.communityLines.length} line(s) captured to community_intake ` +
        `(${cap.inserted} new): ` +
        cap.communityLines.map((c) => `${c.line.title} x${c.line.quantity} [${c.classification}: ${c.signals.join("+")}]`).join(", ")
    );
    communityWorker.kick(db);
  }
  console.log(`NEW ORDER ${order.name || "#" + order.id} captured as source ${cap.sourceId}`);

  // Apply (grocery lines only) and send the frozen bill, right now if the
  // switches allow; otherwise the order waits safely and the sweeper picks it
  // up once the worker is activated. No bill is ever improvised.
  groceryWorker.kick(db, cap.sourceId);
});

// ------------------------------------------------------------
// Started only when run directly (`node server.js`, as Render does). Tests
// require() this file to drive the routes without opening the port or
// starting the background timers.
//
// BIND_HOST (optional): the interface to listen on, e.g. 127.0.0.1 for a local
// rehearsal against a copy of production data, so it is never reachable from
// the LAN. Unset (Render) = Node's default, all interfaces - unchanged.
const BIND_HOST = (process.env.BIND_HOST || "").trim() || null;
function start() {
return app.listen(...(BIND_HOST ? [PORT, BIND_HOST] : [PORT]), async () => {
  console.log(`ASB Pipeline listening on ${BIND_HOST ? `${BIND_HOST}:` : "port "}${PORT} (Graph ${wa.graphVersion})`);

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

  // Grocery worker (migration 017). Always started; the GROCERY_SOURCE_WORKER
  // and GROCERY_BILL_SEND switches (plus their recorded activations) gate the
  // work inside every sweep. Receipt replay and alert delivery always run.
  if (h.ok) {
    try {
      const has = (await db.query(`SELECT to_regclass('shopify_order_sources') IS NOT NULL AS t`)).rows[0].t;
      if (!has) console.error("[grocery] migration 017 NOT applied - Shopify orders will answer 503 until it is.");
      else console.log(`[grocery] switches: ${JSON.stringify(await grocerySwitches.status(db))}`);
    } catch (e) {
      console.error("[grocery] boot check failed:", e.message);
    }
  }
  if (!require("./grocery/fingerprint").HAS_SOURCE) {
    console.warn("[grocery] this Node cannot parse JSON numbers losslessly; orders with ids beyond 2^53 will be refused (503)");
  }
  groceryWorker.start(db);
});
}

if (require.main === module) start();

module.exports = { app, start, persistOrder, resolveProduct, normalizePhone };
