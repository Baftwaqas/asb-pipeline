// ============================================================================
// ASB PIPELINE — bhao/runtime.js
// The only place server.js touches Bhao Tao. Everything is a no-op unless
// BHAO_TAO_WHATSAPP=on AND migration 025 is applied, so deploying this code
// changes nothing until the founder switches it on.
// ============================================================================
"use strict";

const BW = require("./whatsapp");

const enabled = (env = process.env) => String(env.BHAO_TAO_WHATSAPP || "").toLowerCase() === "on";

async function ready(db) {
  const { rows } = await db.query(`SELECT to_regclass('bhao_messages') IS NOT NULL AS ok`);
  return rows[0].ok;
}

/**
 * Hand one freshly saved inbound text - or a tap on one of Seth Ji's buttons
 * (`tap` = the button / list row id) - to Bhao Tao. Never throws.
 */
async function onInbound(db, { phone, text, wamid, tap = null, wa = null }) {
  if (!enabled()) return { handled: false, reason: "off" };
  let intent = null;
  if (tap) {
    const t = BW.fromButton(tap);
    if (!t) return { handled: false, reason: "not a bhao tap" };
    text = t.text; intent = t.intent;
  }
  const client = await db.pool.connect();
  try {
    if (!(await ready(client))) return { handled: false, reason: "migration 025 not applied" };
    const r = await BW.onInbound(client, { phone, text, wamid, now: new Date(), intent });
    if (r.menu) {
      const send = (wa || require("../whatsapp"));
      const res = await send.sendList(phone, {
        header: "Seth Ji ki Dukaan", body: r.menuText || "Kis cheez pe bhao lagana hai? Neeche se chunein 👇",
        buttonText: "Cheezein dekhein", rows: r.menu, footer: "Har sauda alag hota hai",
      }).catch(() => ({ ok: false }));
      console.log(`[bhao] ${phone} -> menu (${r.menu.length} items, ${res && res.ok ? "sent" : "send failed"})`);
      return r;
    }
    if (r.handled && !r.duplicate) console.log(`[bhao] ${phone} -> ${r.kind || r.reason || "handled"}${r.source ? " (" + r.source + ")" : ""}`);
    return r;
  } catch (e) {
    console.error("[bhao] inbound failed:", e.message);
    return { handled: false, reason: "error" };
  } finally {
    client.release();
  }
}

let timer = null;
/** Every 10 s, send Seth Ji's replies whose pause has passed. */
function start(db, wa, logOutbound) {
  if (!enabled() || timer) return;
  const tick = async () => {
    const client = await db.pool.connect().catch(() => null);
    if (!client) return;
    try {
      if (!(await ready(client))) return;
      const r = await BW.sendDue(client, {
        sendText: (to, body) => wa.sendText(to, body),
        sendButtons: wa.sendButtons ? (to, m) => wa.sendButtons(to, m) : null,
        sendImage: wa.sendImage ? (to, id, cap) => wa.sendImage(to, id, cap) : null,
        uploadMedia: wa.uploadMedia ? (buf, mime, name) => wa.uploadMedia(buf, mime, name) : null,
        logOutbound,
      });
      if (r.sent || r.failed) console.log(`[bhao] sent ${r.sent}, failed ${r.failed}`);
    } catch (e) {
      console.error("[bhao] send sweep failed:", e.message);
    } finally {
      client.release();
    }
  };
  timer = setInterval(tick, 10000);
  timer.unref?.();
  console.log("[bhao] Bhao Tao on WhatsApp is ON (BHAO_TAO_WHATSAPP=on)");
}

module.exports = { enabled, onInbound, start };
