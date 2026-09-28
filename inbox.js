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
async function logOutbound({ phone, body, agent, template, wamid, ok, payload }) {
  try {
    await db.query(
      `INSERT INTO whatsapp_messages
         (idempotency_key, customer_id, phone, direction, body_preview,
          template_name, template_lang, wamid, status, agent, payload,
          sent_at, received_at, attempts, msg_type)
       VALUES ($1,
               (SELECT id FROM customers WHERE phone = $2),
               $2, 'outbound', $3, $4, $5, $6, $7::msg_status, $8, $9,
               now(), now(), 1, $10)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `inbox:${crypto.randomUUID()}`,
        phone,
        body.slice(0, 500),
        template || null,
        wa.templateLang,
        wamid,
        ok ? "sent" : "failed",
        agent || null,
        payload || {},
        template ? "template" : "text",
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

module.exports = router;
module.exports.normalizePhone = normalizePhone;
