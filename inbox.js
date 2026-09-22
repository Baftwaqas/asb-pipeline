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

module.exports = router;
module.exports.normalizePhone = normalizePhone;
