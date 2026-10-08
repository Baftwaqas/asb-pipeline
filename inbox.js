// ============================================================================
// ASB PIPELINE — inbox.js
//
// The screen AiSensy was really providing. An Express router that lets you and
// Nadeem read inbound customer messages and answer them, straight off your own
// Postgres and your own Cloud API token.
//
// Mount it in server.js:
//   app.use(require("./inbox"));
//
// Routes:
//   GET  /inbox                        the UI (login gate, then the inbox)
//   POST /api/inbox/login              exchange the shared password for a cookie
//   POST /api/inbox/logout
//   GET  /api/inbox/conversations      list, newest first
//   GET  /api/inbox/thread/:phone      full thread + window state
//   POST /api/inbox/reply              free-form text (24h window only)
//   POST /api/inbox/template           approved template (works any time)
//   POST /api/inbox/handled            clear the unread badge
//   GET  /api/inbox/media/:id          stream an inbound photo or voice note
//   GET  /api/inbox/catalogue          products on sale, for the order panel
//   GET  /api/inbox/delivery?at=ISO    which delivery an order placed then gets
//   POST /api/inbox/order              save an order taken on WhatsApp
//   POST /api/inbox/send-bill          send a saved order's bill (text or template)
//   POST /api/inbox/send-image         send a picture into an open chat
//   GET  /api/inbox/broadcast/setup    audience size + this delivery's wording
//   POST /api/inbox/broadcast/poster   upload the rate-list poster once
//   POST /api/inbox/broadcast          create + start a rate-list broadcast
//   GET  /api/inbox/broadcast/:id      progress
//   POST /api/inbox/broadcast/:id/stop
//   POST /api/inbox/contacts/import    bring a contact list over (AiSensy)
//   GET  /api/inbox/push/key           public key for phone notifications
//   POST /api/inbox/push/subscribe     this device wants notifications
//   POST /api/inbox/push/unsubscribe   this device no longer does
//   POST /api/inbox/push/test          send a test notification to this device
//   GET  /inbox-sw.js, /inbox/manifest.webmanifest, /inbox/icon-*.png
//                                      what makes the inbox installable
//
// AUTH: one shared password (INBOX_PASSWORD) traded for an HMAC-signed,
// HttpOnly cookie. Two people, one warehouse — per-user accounts would be
// theatre. It is deliberately NOT a bearer token in localStorage: this page
// can send messages as Apna Sasta Bazaar, so the credential stays out of JS.
// ============================================================================

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const db = require("./db");
const wa = require("./whatsapp");
const bill = require("./bill");
const schedule = require("./schedule");
const orders = require("./orders");
const notify = require("./notify");
const broadcast = require("./broadcast");
const T = require("./templates");
const push = require("./push");

const router = express.Router();

const INBOX_PASSWORD = process.env.INBOX_PASSWORD || "";
const COOKIE_SECRET =
  process.env.INBOX_COOKIE_SECRET || process.env.VERIFY_TOKEN || "";
const COOKIE_NAME = "asb_inbox";
const SESSION_HOURS = 24 * 14; // a fortnight; re-login every other week

// ---------------------------------------------------------------------------
// Session cookie: "<expiryMs>.<hmac>". Stateless, so a Render restart (which
// happens constantly on the free tier) does not log everybody out.
// ---------------------------------------------------------------------------
function mintToken() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const sig = crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(String(exp))
    .digest("hex");
  return `${exp}.${sig}`;
}

function tokenValid(token) {
  if (!token || !COOKIE_SECRET) return false;
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;

  const expected = crypto
    .createHmac("sha256", COOKIE_SECRET)
    .update(exp)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch (_) {
    return false;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

// Gate for every /api/inbox route except login.
function requireAuth(req, res, next) {
  if (!INBOX_PASSWORD || !COOKIE_SECRET) {
    return res.status(503).json({
      error: "Inbox not configured. Set INBOX_PASSWORD and INBOX_COOKIE_SECRET in Render.",
    });
  }
  if (!tokenValid(readCookie(req, COOKIE_NAME))) {
    return res.status(401).json({ error: "Not signed in" });
  }
  next();
}

// ---------------------------------------------------------------------------
// Phone normalisation — same rule as the Shopify path, so a customer who
// ordered on the web and a customer who messaged on WhatsApp land on the same
// conversation instead of two half-threads.
// ---------------------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (digits.startsWith("0092")) digits = digits.slice(4);
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return "92" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("3")) return "92" + digits;
  return digits;
}

// ============================================================================
// THE UI
// ============================================================================
router.get("/inbox", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "inbox.html"));
});

// Installable app + notifications. The service worker lives at the site root
// so its scope covers /inbox; it must never be cached stale, or a fixed bug
// in it would stay on phones for a day.
router.get("/inbox-sw.js", (_req, res) => {
  res.set("Cache-Control", "no-cache");
  res.type("application/javascript");
  res.sendFile(path.join(__dirname, "public", "inbox-sw.js"));
});
router.get("/inbox/manifest.webmanifest", (_req, res) => {
  res.type("application/manifest+json");
  res.sendFile(path.join(__dirname, "public", "manifest.webmanifest"));
});
for (const f of ["icon-192.png", "icon-512.png", "icon-badge.png"]) {
  router.get(`/inbox/${f}`, (_req, res) => {
    res.set("Cache-Control", "public, max-age=604800");
    res.sendFile(path.join(__dirname, "public", f));
  });
}

// ============================================================================
// AUTH
// ============================================================================
router.post("/api/inbox/login", express.json(), (req, res) => {
  if (!INBOX_PASSWORD || !COOKIE_SECRET) {
    return res.status(503).json({
      error: "Set INBOX_PASSWORD and INBOX_COOKIE_SECRET in Render → Environment.",
    });
  }

  const given = String(req.body?.password || "");
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(
      Buffer.from(given.padEnd(64).slice(0, 64)),
      Buffer.from(INBOX_PASSWORD.padEnd(64).slice(0, 64))
    );
  } catch (_) {
    ok = false;
  }

  if (!ok) {
    console.warn("[inbox] failed login attempt");
    return res.status(401).json({ error: "Wrong password" });
  }

  res.cookie
    ? res.cookie(COOKIE_NAME, mintToken(), {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: SESSION_HOURS * 3600 * 1000,
      })
    : res.setHeader(
        "Set-Cookie",
        `${COOKIE_NAME}=${mintToken()}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${
          SESSION_HOURS * 3600
        }`
      );

  res.json({ ok: true });
});

router.post("/api/inbox/logout", (_req, res) => {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
  );
  res.json({ ok: true });
});

router.get("/api/inbox/me", (req, res) => {
  res.json({ signedIn: tokenValid(readCookie(req, COOKIE_NAME)) });
});

// ============================================================================
// CONVERSATIONS
// ============================================================================
router.get("/api/inbox/conversations", requireAuth, async (req, res) => {
  try {
    const onlyUnread = req.query.unread === "1";
    const { rows } = await db.query(
      `SELECT phone, display_name, customer_id, society_id, badge,
              last_at, last_direction, last_preview, last_type,
              last_inbound_at, window_open, window_minutes_left, unread_count
         FROM asb_conversations
        ${onlyUnread ? "WHERE unread_count > 0" : ""}
        LIMIT 300`
    );

    const totalUnread = rows.reduce((n, r) => n + (r.unread_count || 0), 0);
    res.json({ conversations: rows, totalUnread });
  } catch (e) {
    console.error("[inbox] conversations failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// One thread. Also returns live window state, because the list may have been
// fetched minutes ago and a 24h window can close in between.
// ---------------------------------------------------------------------------
router.get("/api/inbox/thread/:phone", requireAuth, async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: "Bad phone" });

  try {
    const [msgs, conv, orders] = await Promise.all([
      db.query(
        `SELECT wamid, direction, body_preview, msg_type, media_id, media_mime,
                template_name, agent, status, reply_to,
                COALESCE(received_at, sent_at) AS at,
                delivered_at, read_at, error_code
           FROM whatsapp_messages
          WHERE phone = $1
          ORDER BY COALESCE(received_at, sent_at) ASC NULLS FIRST
          LIMIT 500`,
        [phone]
      ),
      db.query(
        `SELECT phone, display_name, customer_id, society_id, badge,
                window_open, window_minutes_left, last_inbound_at
           FROM asb_conversations WHERE phone = $1`,
        [phone]
      ),
      // Recent orders give context while answering — "where is my bag" is the
      // single most common inbound message, and the answer is in this table.
      db.query(
        `SELECT o.order_number, o.status, o.ceiling_total, o.grand_total,
                c.code AS cycle_code, c.delivery_date
           FROM orders o
           JOIN customers cu ON cu.id = o.customer_id
           LEFT JOIN cycles c ON c.id = o.cycle_id
          WHERE cu.phone = $1
          ORDER BY o.id DESC
          LIMIT 5`,
        [phone]
      ).catch(() => ({ rows: [] })),
    ]);

    res.json({
      phone,
      conversation: conv.rows[0] || { phone, window_open: false },
      messages: msgs.rows,
      orders: orders.rows,
    });

    // Fetching a thread means a human is looking at it, so the unread badge
    // clears here rather than in the browser. Doing it server-side means any
    // client gets the same behaviour, and it survives a tab closing mid-read.
    // After the response, so a slow UPDATE never delays the messages.
    db.query(`SELECT asb_mark_handled($1)`, [phone]).catch((e) =>
      console.error("[inbox] mark handled failed:", e.message)
    );
  } catch (e) {
    console.error("[inbox] thread failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Clear the unread badge. Fired when a thread is opened.
// ---------------------------------------------------------------------------
router.post("/api/inbox/handled", requireAuth, express.json(), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: "Bad phone" });
  try {
    const { rows } = await db.query(`SELECT asb_mark_handled($1) AS n`, [phone]);
    res.json({ ok: true, cleared: rows[0]?.n || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// SENDING
// ============================================================================

// ---------------------------------------------------------------------------
// Free-form reply. Checked against the window server-side — never trust the
// browser's copy of window_open, it may be minutes stale.
// ---------------------------------------------------------------------------
router.post("/api/inbox/reply", requireAuth, express.json(), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const body = String(req.body?.body || "").trim();
  const agent = String(req.body?.agent || "asb").slice(0, 40);

  if (!phone) return res.status(400).json({ error: "Bad phone" });
  if (!body) return res.status(400).json({ error: "Empty message" });

  try {
    const { rows } = await db.query(
      `SELECT window_open, window_minutes_left FROM asb_conversations WHERE phone = $1`,
      [phone]
    );

    if (!rows[0]?.window_open) {
      return res.status(409).json({
        error: "window_closed",
        message:
          "The 24-hour reply window has closed for this customer. " +
          "Send an approved template instead — that reopens the conversation.",
      });
    }

    const result = await wa.sendText(phone, body, {
      replyToWamid: req.body?.replyTo || null,
    });

    await logOutbound({
      phone,
      body,
      agent,
      wamid: result.wamid,
      ok: result.ok,
      payload: result.data,
    });

    // Answering a customer means you have dealt with them.
    await db.query(`SELECT asb_mark_handled($1)`, [phone]).catch(() => {});

    if (!result.ok) {
      return res.status(502).json({
        error: "send_failed",
        code: result.code,
        message: result.data?.error?.message || "Meta rejected the message",
      });
    }

    res.json({ ok: true, wamid: result.wamid });
  } catch (e) {
    console.error("[inbox] reply failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Template send — the escape hatch when the window is shut. Only templates
// you have actually had approved will work; anything else comes back 132001.
// ---------------------------------------------------------------------------
router.post("/api/inbox/template", requireAuth, express.json(), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const name = String(req.body?.template || "").trim();
  const params = Array.isArray(req.body?.params) ? req.body.params : [];

  if (!phone) return res.status(400).json({ error: "Bad phone" });
  if (!name) return res.status(400).json({ error: "No template name" });

  try {
    const result = await wa.sendTemplate(
      phone,
      name,
      params.map((v) => ({ value: v }))
    );

    await logOutbound({
      phone,
      body: `[${name}] ${params.join(" | ")}`,
      agent: String(req.body?.agent || "asb").slice(0, 40),
      template: name,
      wamid: result.wamid,
      ok: result.ok,
      payload: result.data,
    });

    if (!result.ok) {
      return res.status(502).json({
        error: "send_failed",
        code: result.code,
        message: result.data?.error?.message || "Meta rejected the template",
      });
    }
    res.json({ ok: true, wamid: result.wamid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Log a manual send. Separate from server.js's logOutbound because that one is
// keyed to a Shopify order id; these have no order behind them.
// ---------------------------------------------------------------------------
async function logOutbound({ phone, body, agent, template, wamid, ok, payload, mediaId, mediaMime }) {
  try {
    await db.query(
      `INSERT INTO whatsapp_messages
         (idempotency_key, customer_id, phone, direction, body_preview,
          template_name, template_lang, wamid, status, agent, payload,
          sent_at, received_at, attempts, msg_type, media_id, media_mime)
       VALUES ($1,
               (SELECT id FROM customers WHERE phone = $2),
               $2, 'outbound', $3, $4, $5, $6, $7::msg_status, $8, $9,
               now(), now(), 1, $10, $11, $12)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `inbox:${crypto.randomUUID()}`,
        phone,
        body.slice(0, 500),
        template || null,
        template ? T.LANG : null,
        wamid,
        ok ? "sent" : "failed",
        agent || null,
        payload || {},
        template ? "template" : mediaId ? "image" : "text",
        mediaId || null,
        mediaMime || null,
      ]
    );
  } catch (e) {
    // A logging failure must not make a delivered message look undelivered.
    console.error("[inbox] could not log outbound:", e.message);
  }
}

// ============================================================================
// MEDIA PROXY
//
// Inbound photos and voice notes cannot be linked directly: the download URL
// expires in minutes and needs the bearer token. So the browser asks us, and we
// fetch it server-side. Nothing is written to disk — Render's filesystem is
// ephemeral and a voice note is only interesting while you are reading the
// thread.
// ============================================================================
router.get("/api/inbox/media/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id).replace(/[^\w.-]/g, "");
  if (!id) return res.sendStatus(400);

  try {
    const media = await wa.downloadMedia(id);
    if (!media) return res.status(404).send("Media expired or unavailable");

    res.setHeader("Content-Type", media.mimeType || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.send(media.buffer);
  } catch (e) {
    console.error("[inbox] media proxy failed:", e.message);
    res.status(502).send("Could not fetch media");
  }
});

// ============================================================================
// ORDERS TAKEN ON WHATSAPP
//
// A customer writes "2 kilo tamatar, 1 gaddi dhania" to the business number.
// Whoever is on the inbox picks the products and quantities; the order then
// follows exactly the rules a Shopify order follows (orders.js): delivery day
// from the booking calendar, one bag per household per delivery, the same
// ceiling for the same product on the same delivery, the same bill.
// ============================================================================

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;
const todayPKT = () => new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Products on sale, for the picker. Only what has an ASB price today: a
// product Shopify shows at Rs 0 is out of season and cannot be ordered.
// ---------------------------------------------------------------------------
router.get("/api/inbox/catalogue", requireAuth, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT sku, name_en, name_ur, name_roman, category, unit::text AS unit,
              min_qty AS pack_size, asb_price, market_price, sort_order
         FROM products
        WHERE is_active AND asb_price > 0
          -- Community packs are never offered in the grocery picker.
          AND category <> 'community-excluded'
          AND NOT EXISTS (SELECT 1 FROM community_variants cv
                           WHERE cv.shopify_variant_id = products.shopify_variant_id)
        ORDER BY category, sort_order, name_en`
    );
    // Labels come from bill.js so the panel says "aadha kg" and "Rs 320/kg"
    // exactly as the customer's bill will - one copy of that logic, not two.
    res.json({
      products: rows.map((p) => ({
        ...p,
        asb_price: Number(p.asb_price),
        market_price: p.market_price == null ? null : Number(p.market_price),
        pack_label: bill.qtyPhrase(1, p.unit, p.pack_size),
        rate_label: bill.ratePhrase(p.asb_price, p.unit, p.pack_size),
      })),
    });
  } catch (e) {
    console.error("[inbox] catalogue failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// "If she ordered at this time, when does it arrive?" - so the panel can show
// the delivery day while the order is being typed, before anything is saved.
// ---------------------------------------------------------------------------
router.get("/api/inbox/delivery", requireAuth, (req, res) => {
  const at = req.query.at ? new Date(String(req.query.at)) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: "Bad time" });
  const slot = schedule.deliveryFor(at);
  res.json({
    ordered: bill.orderedPhrase(at),
    delivery: bill.deliveryPhrase(slot.deliveryDate),
    deliveryDate: slot.deliveryDate,
    cutoff: bill.orderedPhrase(slot.locksAt),
    passed: slot.deliveryDate <= todayPKT(),
  });
});

// ---------------------------------------------------------------------------
// Save an order typed in from a WhatsApp conversation.
//
// body: {
//   phone, name,
//   orderedAt   when the CUSTOMER ordered (her message time, not now) - this
//               decides the delivery day, so staff taking an hour to get to
//               the message never pushes her to the next delivery
//   lines       [{ sku, packs }]
//   sourceWamid the message the order was read from
//   clientKey   one per order panel; a double-click saves once
//   agent
// }
//
// Replies with the confirmation text. Sending it is a separate, deliberate
// click, so the person at the inbox reads what the customer will read first.
// ---------------------------------------------------------------------------
router.post("/api/inbox/order", requireAuth, express.json(), async (req, res) => {
  const b = req.body || {};
  const phone = normalizePhone(b.phone);
  const name = String(b.name || "").trim().slice(0, 80) || null;
  const agent = String(b.agent || "asb").slice(0, 40);
  const clientKey = String(b.clientKey || "").slice(0, 80);
  const sourceWamid = b.sourceWamid ? String(b.sourceWamid).slice(0, 200) : null;

  if (!phone) return res.status(400).json({ error: "bad_phone", message: "No valid phone number." });
  if (!clientKey) return res.status(400).json({ error: "no_key", message: "Missing form key; reload the page." });

  // --- order time ------------------------------------------------------------
  const orderedAt = new Date(String(b.orderedAt || ""));
  if (Number.isNaN(orderedAt.getTime())) {
    return res.status(400).json({ error: "bad_time", message: "Order time is missing or not a valid time." });
  }
  if (orderedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    return res.status(400).json({ error: "future_time", message: "Order time is in the future." });
  }
  if (orderedAt.getTime() < Date.now() - 7 * 24 * 3600 * 1000) {
    return res.status(400).json({ error: "old_time", message: "Order time is more than a week ago." });
  }
  const slot = schedule.deliveryFor(orderedAt);
  if (slot.deliveryDate <= todayPKT()) {
    return res.status(409).json({
      error: "delivery_passed",
      message:
        `An order placed ${bill.orderedPhrase(orderedAt)} was for ` +
        `${bill.deliveryPhrase(slot.deliveryDate)}, which is today or already gone. ` +
        `Set the order time to now to put it on the next delivery.`,
    });
  }

  // --- lines -----------------------------------------------------------------
  const raw = Array.isArray(b.lines) ? b.lines : [];
  const merged = new Map();
  for (const l of raw) {
    const sku = String(l?.sku || "").trim();
    const packs = Number(l?.packs);
    if (!sku) continue;
    if (!(packs > 0) || packs > 200 || Math.round(packs * 1000) !== packs * 1000) {
      return res.status(400).json({ error: "bad_qty", message: `Quantity for ${sku} must be between 0 and 200.` });
    }
    merged.set(sku, (merged.get(sku) || 0) + packs);
  }
  const lines = [...merged].map(([sku, packs]) => ({ sku, packs }));
  if (!lines.length) return res.status(400).json({ error: "no_lines", message: "Add at least one product." });
  if (lines.length > 60) return res.status(400).json({ error: "too_many", message: "More than 60 products in one order." });

  try {
    const result = await db.tx(async (client) => {
      // Insert-first dedupe, the same trick the Shopify webhook uses: the
      // unique (source, event_id) row means a double-click or a retried
      // request cannot save the order twice and double every quantity.
      const key = await client.query(
        `INSERT INTO webhook_events (source, event_id, topic, payload)
         VALUES ('inbox', $1, 'order/create', $2)
         ON CONFLICT (source, event_id) DO NOTHING
         RETURNING id`,
        [clientKey, { phone, lines, orderedAt, agent }]
      );
      if (!key.rows.length) {
        const prev = await client.query(
          `SELECT payload->>'order_id' AS order_id FROM webhook_events
            WHERE source = 'inbox' AND event_id = $1`,
          [clientKey]
        );
        return { duplicate: true, orderId: Number(prev.rows[0]?.order_id) || null };
      }

      const saved = await orders.saveInboxOrder(client, {
        phone, name, orderedAt, lines, enteredBy: agent, sourceWamid,
      });

      await client.query(
        `UPDATE webhook_events
            SET status = 'processed', processed_at = now(), attempts = attempts + 1,
                payload = payload || jsonb_build_object('order_id', $2::bigint,
                                                        'order_number', $3::text)
          WHERE id = $1`,
        [key.rows[0].id, saved.orderId, saved.orderNumber]
      );
      return saved;
    });

    if (!result.orderId) {
      return res.status(409).json({ error: "duplicate", message: "This order was already saved." });
    }

    const forBill = await orders.loadOrderForBill(db, result.orderId);
    forBill.ordered_at = orderedAt;
    const composed = bill.orderConfirmation(forBill);

    const conv = await db.query(
      `SELECT window_open FROM asb_conversations WHERE phone = $1`, [phone]
    ).catch(() => ({ rows: [] }));

    console.log(
      `[inbox] ${agent} ${result.duplicate ? "re-submitted" : "saved"} WhatsApp order ` +
        `${forBill.order_number} for +${phone}` +
        `${result.merged ? " (merged into the existing bag)" : ""}`
    );

    res.json({
      ok: true,
      duplicate: Boolean(result.duplicate),
      merged: Boolean(result.merged),
      orderNumber: forBill.order_number,
      delivery: bill.deliveryPhrase(forBill.delivery_date),
      ceilingTotal: Number(forBill.ceiling_total),
      message: composed.rich,
      windowOpen: Boolean(conv.rows[0]?.window_open),
    });
  } catch (e) {
    if (e.userFacing) return res.status(400).json({ error: "rejected", message: e.message });
    console.error("[inbox] order failed:", e.message);
    res.status(500).json({ error: "server", message: "Could not save the order. Nothing was saved." });
  }
});

// ============================================================================
// SENDING A BILL, A PICTURE, A RATE LIST
// ============================================================================

// Decode an image posted as base64 JSON. The browser shrinks posters before
// sending (max 1600 px, JPEG), so a real one is a few hundred KB; Meta's own
// limit for images is 5 MB.
function decodeImage(b) {
  const mime = String(b?.mime || "");
  if (!/^image\/(jpeg|png)$/.test(mime)) return { error: "Only JPG or PNG pictures can be sent." };
  const data = String(b?.dataBase64 || "").replace(/^data:[^,]+,/, "");
  const buffer = Buffer.from(data, "base64");
  if (!buffer.length) return { error: "The picture is empty." };
  if (buffer.length > 5 * 1024 * 1024) return { error: "The picture is larger than 5 MB." };
  return { buffer, mime };
}

// ---------------------------------------------------------------------------
// The bill for an order saved from the inbox. Free text inside the 24h
// window, the approved asb_order_bill template outside it (notify.js).
// ---------------------------------------------------------------------------
router.post("/api/inbox/send-bill", requireAuth, express.json(), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const orderNumber = String(req.body?.orderNumber || "").trim();
  const agent = String(req.body?.agent || "asb").slice(0, 40);
  if (!phone || !orderNumber) return res.status(400).json({ error: "bad_request", message: "Phone and order number are needed." });

  try {
    const { rows } = await db.query(
      `SELECT o.id, o.placed_at FROM orders o JOIN customers c ON c.id = o.customer_id
        WHERE o.order_number = $1 AND c.phone = $2`, [orderNumber, phone]);
    if (!rows[0]) return res.status(404).json({ error: "not_found", message: `${orderNumber} is not this customer's order.` });

    const forBill = await orders.loadOrderForBill(db, rows[0].id);
    const orderedAt = req.body?.orderedAt ? new Date(String(req.body.orderedAt)) : null;
    if (orderedAt && !Number.isNaN(orderedAt.getTime())) forBill.ordered_at = orderedAt;
    const composed = bill.orderConfirmation(forBill);

    const { result, via, template } = await notify.sendOrderBill(db, phone, composed);
    await logOutbound({ phone, body: composed.rich, agent, template, wamid: result.wamid, ok: result.ok, payload: result.data });

    if (!result.ok) {
      return res.status(502).json({
        error: "send_failed", via, code: result.code,
        message: result.data?.error?.message || "WhatsApp refused the message",
      });
    }
    res.json({ ok: true, via, wamid: result.wamid });
  } catch (e) {
    console.error("[inbox] send-bill failed:", e.message);
    res.status(500).json({ error: "server", message: e.message });
  }
});

// ---------------------------------------------------------------------------
// A picture into an open chat (a poster for one customer, a photo of the
// mangoes). Only inside the 24-hour window, like any free message.
// ---------------------------------------------------------------------------
router.post("/api/inbox/send-image", requireAuth, express.json({ limit: "8mb" }), async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const caption = String(req.body?.caption || "").trim().slice(0, 1024);
  const agent = String(req.body?.agent || "asb").slice(0, 40);
  if (!phone) return res.status(400).json({ error: "bad_phone", message: "No valid phone number." });

  const img = decodeImage(req.body);
  if (img.error) return res.status(400).json({ error: "bad_image", message: img.error });

  if (!(await notify.windowOpen(db, phone))) {
    return res.status(409).json({
      error: "window_closed",
      message: "Her 24-hour window is closed, so a picture can only go as the rate-list template. Use \"Rate list\" instead.",
    });
  }

  try {
    const up = await wa.uploadMedia(img.buffer, img.mime, img.mime === "image/png" ? "picture.png" : "picture.jpg");
    if (!up.ok) return res.status(502).json({ error: "upload_failed", code: up.code, message: up.error });

    const result = await wa.sendImage(phone, up.id, caption);
    await logOutbound({
      phone, body: caption || "(picture)", agent, template: null,
      wamid: result.wamid, ok: result.ok, payload: result.data, mediaId: up.id, mediaMime: img.mime,
    });
    if (!result.ok) {
      return res.status(502).json({ error: "send_failed", code: result.code, message: result.data?.error?.message || "WhatsApp refused the picture" });
    }
    res.json({ ok: true, wamid: result.wamid });
  } catch (e) {
    console.error("[inbox] send-image failed:", e.message);
    res.status(500).json({ error: "server", message: e.message });
  }
});

// ---------------------------------------------------------------------------
// RATE-LIST BROADCAST
// ---------------------------------------------------------------------------

// What the panel needs before anything is chosen: this delivery's wording,
// how many customers there are, how many said STOP, and the last few sends.
router.get("/api/inbox/broadcast/setup", requireAuth, async (_req, res) => {
  try {
    const slot = schedule.deliveryFor(new Date());
    const people = await broadcast.audience(db);
    res.json({
      delivery: bill.deliveryPhrase(slot.deliveryDate),
      cutoff: bill.orderedPhrase(slot.locksAt),
      audience: people.filter((p) => !p.opted_out).length,
      optedOut: people.filter((p) => p.opted_out).length,
      running: broadcast.isRunning(),
      recent: await broadcast.recent(db, 5),
      template: T.TEMPLATES.rateList.name,
    });
  } catch (e) {
    const missing = /does not exist/.test(e.message);
    res.status(missing ? 503 : 500).json({
      error: missing ? "not_migrated" : "server",
      message: missing ? "Run the database update first: node scripts/mi*.js" : e.message,
    });
  }
});

// Upload the poster once. The returned id is reused for the test and the
// real send (Meta keeps it 30 days).
router.post("/api/inbox/broadcast/poster", requireAuth, express.json({ limit: "8mb" }), async (req, res) => {
  const img = decodeImage(req.body);
  if (img.error) return res.status(400).json({ error: "bad_image", message: img.error });
  const up = await wa.uploadMedia(img.buffer, img.mime, img.mime === "image/png" ? "rate-list.png" : "rate-list.jpg");
  if (!up.ok) return res.status(502).json({ error: "upload_failed", code: up.code, message: up.error });
  res.json({ ok: true, mediaId: up.id, mime: img.mime });
});

// Create and start. For a real send the browser must echo back the number of
// people it showed on the confirm button: if the audience changed in between,
// nothing is sent and the panel shows the new number.
router.post("/api/inbox/broadcast", requireAuth, express.json(), async (req, res) => {
  const b = req.body || {};
  const agent = String(b.agent || "asb").slice(0, 40);
  const mediaId = String(b.mediaId || "").replace(/[^\w.-]/g, "");
  const delivery = String(b.delivery || "").trim().slice(0, 60);
  const cutoff = String(b.cutoff || "").trim().slice(0, 60);
  const isTest = Boolean(b.isTest);
  if (!mediaId) return res.status(400).json({ error: "no_poster", message: "Choose the poster first." });
  if (!delivery || !cutoff) return res.status(400).json({ error: "no_wording", message: "Delivery day and booking cut-off are needed." });

  if (broadcast.isRunning()) {
    return res.status(409).json({ error: "busy", message: "Another rate list is still sending. Wait for it to finish or stop it." });
  }

  try {
    let phones;
    if (isTest) {
      phones = broadcast.parsePhones(b.testPhone);
      if (phones.length !== 1) return res.status(400).json({ error: "bad_phone", message: "Enter one mobile number for the test." });
    } else {
      const people = await broadcast.audience(db);
      const optedOut = new Set(people.filter((p) => p.opted_out).map((p) => p.phone));
      const everyone = people.filter((p) => !p.opted_out).map((p) => p.phone);
      // Pasted numbers that said STOP are dropped here too, so the count on
      // the confirm button is exactly the number of messages Meta will bill.
      const extra = broadcast.parsePhones(b.extraPhones);
      phones = [...new Set([...everyone, ...extra.filter((p) => !optedOut.has(p))])];
      if (b.dryRun) {
        return res.json({ ok: true, count: phones.length, leftOut: optedOut.size });
      }
      if (Number(b.confirmCount) !== phones.length) {
        return res.status(409).json({
          error: "count_changed", count: phones.length,
          message: `The list is now ${phones.length} numbers, not ${b.confirmCount}. Check and confirm again.`,
        });
      }
    }
    if (!phones.length) return res.status(400).json({ error: "nobody", message: "There is nobody to send to." });

    const id = await broadcast.create(db, {
      agent, mediaId, mediaMime: String(b.mime || "image/jpeg"), delivery, cutoff, phones, isTest,
    });
    const started = broadcast.start(db, id, logOutbound);
    if (!started.ok) return res.status(409).json({ error: "busy", message: started.error });
    console.log(`[inbox] ${agent} started ${isTest ? "a TEST" : "a"} rate-list broadcast #${id} to ${phones.length}`);
    res.json({ ok: true, id, count: phones.length });
  } catch (e) {
    console.error("[inbox] broadcast failed:", e.message);
    res.status(500).json({ error: "server", message: e.message });
  }
});

router.get("/api/inbox/broadcast/:id", requireAuth, async (req, res) => {
  const s = await broadcast.status(db, Number(req.params.id)).catch(() => null);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json(s);
});

router.post("/api/inbox/broadcast/:id/stop", requireAuth, async (req, res) => {
  await broadcast.stop(db, Number(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Bring a contact list over from AiSensy (or any other tool).
//   body: { source: "aisensy", contacts: [{ phone, name, firstSeen, blocked }] }
// Safe to send twice, and in pieces: a number already here keeps its first
// row (a missing name is filled in). `blocked` numbers are also put on the
// opt-out list so a rate list never reaches them.
// ---------------------------------------------------------------------------
router.post("/api/inbox/contacts/import", requireAuth, express.json({ limit: "3mb" }), async (req, res) => {
  const b = req.body || {};
  const source = String(b.source || "import").replace(/[^\w-]/g, "").slice(0, 30) || "import";
  const list = Array.isArray(b.contacts) ? b.contacts.slice(0, 20000) : [];
  const phones = [], names = [], seen = [], blocked = [];
  const done = new Set();
  let bad = 0;
  for (const c of list) {
    let d = String((c && c.phone) || "").replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.startsWith("0")) d = "92" + d.slice(1);
    if (d.length === 10 && d.startsWith("3")) d = "92" + d;
    if (d.length < 8 || d.length > 15 || done.has(d)) { bad += d.length < 8 || d.length > 15 ? 1 : 0; continue; }
    done.add(d);
    const t = c.firstSeen ? new Date(c.firstSeen) : null;
    phones.push(d);
    names.push(c.name ? String(c.name).trim().slice(0, 80) || null : null);
    seen.push(t && !isNaN(t) ? t.toISOString() : null);
    if (c.blocked) blocked.push(d);
  }
  try {
    const out = await db.tx(async (client) => {
      const ins = await client.query(
        `INSERT INTO marketing_contacts (phone, name, source, first_seen)
         SELECT p, n, $4, s::timestamptz FROM unnest($1::text[], $2::text[], $3::text[]) AS x(p, n, s)
         ON CONFLICT (phone) DO UPDATE
           SET name = COALESCE(marketing_contacts.name, EXCLUDED.name)
         RETURNING (xmax = 0) AS inserted`,
        [phones, names, seen, source]
      );
      const opt = await client.query(
        `INSERT INTO marketing_opt_outs (phone, source)
         SELECT unnest($1::text[]), $2 ON CONFLICT (phone) DO NOTHING`,
        [blocked, `${source}_blocked`]
      );
      return { added: ins.rows.filter((r) => r.inserted).length, optedOut: opt.rowCount };
    });
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM marketing_contacts`);
    console.log(`[inbox] contacts import (${source}): ${phones.length} received, ${out.added} new, ${out.optedOut} blocked`);
    res.json({ ok: true, received: phones.length, added: out.added, alreadyHere: phones.length - out.added,
               blockedAdded: out.optedOut, unreadable: bad, totalContacts: rows[0].n });
  } catch (e) {
    const missing = /does not exist/.test(e.message);
    res.status(missing ? 503 : 500).json({
      error: missing ? "not_migrated" : "server",
      message: missing ? "Run the database update first: node scripts/migrate.js" : e.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Phone notifications (push.js does the work).
// ---------------------------------------------------------------------------
const pushMissing = (e, res) => {
  const missing = /does not exist/.test(e.message);
  res.status(missing ? 503 : 500).json({
    error: missing ? "not_migrated" : "server",
    message: missing ? "Run the database update first: node scripts/migrate.js" : e.message,
  });
};

router.get("/api/inbox/push/key", requireAuth, async (_req, res) => {
  try { res.json({ key: await push.publicKey(db) }); } catch (e) { pushMissing(e, res); }
});

router.post("/api/inbox/push/subscribe", requireAuth, express.json(), async (req, res) => {
  try {
    await push.subscribe(db, req.body?.subscription, String(req.body?.agent || "").slice(0, 40),
      req.get("user-agent"));
    res.json({ ok: true });
  } catch (e) {
    if (e.message === "bad subscription") return res.status(400).json({ error: "bad_subscription" });
    pushMissing(e, res);
  }
});

router.post("/api/inbox/push/unsubscribe", requireAuth, express.json(), async (req, res) => {
  try { await push.unsubscribe(db, req.body?.endpoint); res.json({ ok: true }); }
  catch (e) { pushMissing(e, res); }
});

router.post("/api/inbox/push/test", requireAuth, express.json(), async (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  if (!endpoint) return res.status(400).json({ error: "no_endpoint" });
  const r = await push.notifyAll(db, {
    title: "ASB Inbox",
    body: "Notifications are on. Customer messages will show up like this.",
    url: "/inbox", tag: "asb-test", topic: "asbtest",
  }, endpoint);
  res.json({ ok: r.delivered === 1, ...r });
});

// ---------------------------------------------------------------------------
// Rates: Shopify -> products table -> WhatsApp catalogue (productSync.js).
//
//   GET  /api/inbox/rates/meta       the catalogue as Meta has it, each item
//                                    with the product it is linked to (if any)
//   POST /api/inbox/rates/products   { products: [Shopify product JSON] }
//                                    save them into products (same code path as
//                                    the products/update webhook); push:true
//                                    also sends linked ones to the catalogue
//   POST /api/inbox/rates/link       { links: [{ shopify_variant_id, retailer_id }] }
//                                    remember which catalogue item each product
//                                    is, then send their prices to the catalogue
//   POST /api/inbox/rates/meta       { updates: [{ retailer_id, asb_price,
//                                    market_price, name?, in_stock? }] }
//                                    direct catalogue edit (e.g. mark items that
//                                    are not in today's list out of stock)
// ---------------------------------------------------------------------------
const productSync = require("./productSync");

const ratesFail = (e, res) => {
  console.error("[rates]", e.message);
  if (/meta_retailer_id|does not exist/.test(e.message)) return pushMissing(e, res);
  res.status(500).json({ error: e.message });
};

router.get("/api/inbox/rates/meta", requireAuth, async (_req, res) => {
  try {
    const catId = await productSync.catalogId(db);
    if (!catId) return res.status(404).json({ error: "no_catalogue" });
    const items = await productSync.metaItems(catId);
    const { rows } = await db.query(
      `SELECT meta_retailer_id, sku, name_en, shopify_variant_id, asb_price, market_price
         FROM products WHERE meta_retailer_id IS NOT NULL`);
    const byRid = new Map(rows.map((r) => [r.meta_retailer_id, r]));
    res.json({ catalogId: catId, count: items.length,
               items: items.map((i) => ({ ...i, linked: byRid.get(i.retailer_id) || null })) });
  } catch (e) { ratesFail(e, res); }
});

router.post("/api/inbox/rates/products", requireAuth, express.json({ limit: "3mb" }), async (req, res) => {
  const list = Array.isArray(req.body?.products) ? req.body.products : [];
  if (!list.length) return res.status(400).json({ error: "no_products" });
  try {
    const saved = [];
    const failed = [];
    for (const p of list) {
      try {
        const row = await productSync.upsertFromShopify(db, p);
        if (row) saved.push(row);
      } catch (e) { failed.push({ title: p.title, error: e.message }); }
    }
    let pushed = 0;
    if (req.body?.push) {
      for (const row of saved) if (row.meta_retailer_id && await productSync.pushOne(db, row)) pushed++;
    }
    res.json({ saved: saved.length, failed, pushed });
  } catch (e) { ratesFail(e, res); }
});

router.post("/api/inbox/rates/link", requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const links = Array.isArray(req.body?.links) ? req.body.links : [];
  if (!links.length) return res.status(400).json({ error: "no_links" });
  const linked = [];
  const missing = [];
  try {
    await db.tx(async (client) => { for (const l of links) {
      const rid = String(l.retailer_id || "").trim();
      const vid = String(l.shopify_variant_id || "").trim();
      if (!rid || !vid) continue;
      // A catalogue item belongs to one product only: free it first.
      await client.query(
        `UPDATE products SET meta_retailer_id = NULL
          WHERE meta_retailer_id = $1 AND shopify_variant_id <> $2`, [rid, vid]);
      const { rows } = await client.query(
        `UPDATE products SET meta_retailer_id = $1 WHERE shopify_variant_id = $2
         RETURNING name_en, asb_price, market_price, is_active, meta_retailer_id`, [rid, vid]);
      if (rows[0]) linked.push(rows[0]); else missing.push(vid);
    } });
  } catch (e) {
    return ratesFail(e, res);
  }

  let meta = null;
  if (req.body?.push !== false && linked.length) {
    try {
      const catId = await productSync.catalogId(db);
      meta = await productSync.metaUpdate(catId, linked
        .filter((r) => Number(r.asb_price) > 0)
        .map((r) => ({ retailer_id: r.meta_retailer_id, asb_price: r.asb_price,
                       market_price: r.market_price, in_stock: r.is_active })));
    } catch (e) { meta = { error: e.message }; }
  }
  res.json({ linked: linked.length, missing, meta });
});

router.post("/api/inbox/rates/meta", requireAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
  if (!updates.length) return res.status(400).json({ error: "no_updates" });
  try {
    const catId = await productSync.catalogId(db);
    res.json(await productSync.metaUpdate(catId, updates));
  } catch (e) { ratesFail(e, res); }
});

module.exports = router;
module.exports.normalizePhone = normalizePhone;
module.exports.logOutbound = logOutbound;
