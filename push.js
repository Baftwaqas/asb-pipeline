// ============================================================================
// ASB PIPELINE — push.js
//
// Phone notifications for the inbox (Web Push). When a customer writes on
// WhatsApp, every device that switched notifications on gets
//   "Ayesha Qurban · 0335 1594366"  /  "2 kg aloo aur 1 darjan kinnow..."
// and tapping it opens that chat.
//
// Keys: Web Push needs a VAPID key pair. The server makes its own on first
// start and keeps it in app_settings, so there is nothing to generate, type
// or paste. (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in the environment win if
// they are ever set.)
//
// Never allowed to break saving a message: every function here swallows its
// own errors and logs them.
// ============================================================================

"use strict";

const webpush = require("web-push");

const SUBJECT = process.env.VAPID_SUBJECT || "mailto:sasta@apnasastabazaar.com";
let keys = null;          // { publicKey, privateKey } once loaded
let loading = null;

async function loadKeys(db) {
  if (keys) return keys;
  if (loading) return loading;
  loading = (async () => {
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    } else {
      const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'vapid'`);
      if (rows[0]) {
        keys = JSON.parse(rows[0].value);
      } else {
        const fresh = webpush.generateVAPIDKeys();
        // ON CONFLICT: two instances starting at once must end up with ONE pair.
        await db.query(
          `INSERT INTO app_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`,
          [JSON.stringify(fresh)]
        );
        const again = await db.query(`SELECT value FROM app_settings WHERE key = 'vapid'`);
        keys = JSON.parse(again.rows[0].value);
        console.log("[push] created the notification keys");
      }
    }
    webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
    return keys;
  })().finally(() => { loading = null; });
  return loading;
}

async function publicKey(db) {
  return (await loadKeys(db)).publicKey;
}

async function subscribe(db, sub, agent, userAgent) {
  const endpoint = String(sub?.endpoint || "");
  const p256dh = String(sub?.keys?.p256dh || "");
  const auth = String(sub?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw new Error("bad subscription");
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, agent, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, agent = EXCLUDED.agent,
           user_agent = EXCLUDED.user_agent, failures = 0`,
    [endpoint, p256dh, auth, agent || null, String(userAgent || "").slice(0, 300)]
  );
}

async function unsubscribe(db, endpoint) {
  await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [String(endpoint || "")]);
}

// "923351594366" -> "0335 1594366"
function localPhone(p) {
  const d = String(p || "");
  return d.startsWith("92") && d.length === 12 ? `0${d.slice(2, 5)} ${d.slice(5)}` : `+${d}`;
}

async function sendOne(db, row, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload),
      { TTL: 60 * 60 * 6, urgency: "high", topic: payload.topic }
    );
    await db.query(`UPDATE push_subscriptions SET last_ok_at = now(), failures = 0 WHERE endpoint = $1`, [row.endpoint]);
    return true;
  } catch (e) {
    // 404/410: the browser threw this subscription away (app uninstalled,
    // notifications turned off). Forget it. Anything else: count and retry
    // next time; after 20 failures in a row, forget it too.
    if (e.statusCode === 404 || e.statusCode === 410) {
      await unsubscribe(db, row.endpoint);
    } else {
      console.error("[push] send failed:", e.statusCode || "", e.body || e.message);
      await db.query(
        `UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = $1`, [row.endpoint]);
      await db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND failures >= 20`, [row.endpoint]);
    }
    return false;
  }
}

/** Push to every device; `only` limits it to one endpoint (test button). */
async function notifyAll(db, payload, only = null) {
  try {
    await loadKeys(db);
    const { rows } = only
      ? await db.query(`SELECT * FROM push_subscriptions WHERE endpoint = $1`, [only])
      : await db.query(`SELECT * FROM push_subscriptions`);
    let ok = 0;
    for (const row of rows) if (await sendOne(db, row, payload)) ok++;
    return { devices: rows.length, delivered: ok };
  } catch (e) {
    console.error("[push] notify failed:", e.message);
    return { devices: 0, delivered: 0, error: e.message };
  }
}

/** Called for every inbound WhatsApp message. */
async function newMessage(db, { from, name, preview, type }) {
  const who = name ? `${name} · ${localPhone(from)}` : localPhone(from);
  const text = type === "text" ? String(preview || "") : String(preview || `(${type})`);
  return notifyAll(db, {
    title: who,
    body: text.slice(0, 180),
    phone: from,
    url: `/inbox#${from}`,
    // One notification per customer: a second message from the same person
    // replaces the first instead of stacking.
    tag: `wa-${from}`,
    topic: `wa${from}`.slice(0, 32),
  });
}

module.exports = { publicKey, subscribe, unsubscribe, notifyAll, newMessage, localPhone };
