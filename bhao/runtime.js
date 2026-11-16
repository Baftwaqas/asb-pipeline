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
    // "Seth Ji ke Case": the game's messages go out at once, in order - a
    // 90-second clock cannot wait for the 10-second send sweep
    if (r.out && r.out.length) {
      const send = (wa || sender.wa || require("../whatsapp"));
      for (const m of r.out) {
        const res = await sendOut(send, phone, m).catch(() => ({ ok: false }));
        if (sender.logOutbound) await sender.logOutbound({ phone, body: m.body, agent: "seth-ji", wamid: res && res.wamid, ok: !!(res && res.ok), payload: { bhao_case: r.kind } }).catch(() => {});
        if (!(res && res.ok)) console.error(`[bhao] ${phone} case message failed to send (${m.type})`);
      }
    }
    if (r.instant && sender.wa) await sweep(client, sender.wa, sender.logOutbound).catch((e) => console.error("[bhao] instant send failed:", e.message));
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

const sender = { wa: null, logOutbound: null };
/** One game message: a list, buttons, or plain text (also the fallback). */
async function sendOut(send, phone, m, { render = null } = {}) {
  let res = null;
  if (m.type === "list" && send.sendList) res = await send.sendList(phone, { body: m.body, buttonText: m.buttonText, sections: m.sections });
  else if (m.type === "buttons" && send.sendButtons) {
    // a scene of Asli Kahaniyan: its picture goes on top of the buttons
    let headerImageId = null;
    if (m.image && send.uploadMedia) {
      const jpg = await (render || require("./cards").storyScene)(m.image).catch(() => null);
      const up = jpg ? await send.uploadMedia(jpg, "image/jpeg", "scene.jpg").catch(() => null) : null;
      headerImageId = up && up.ok ? up.id : null;
    }
    res = await send.sendButtons(phone, { body: m.body, buttons: m.buttons, headerImageId });
  }
  if (res && res.ok) return res;
  return send.sendText(phone, m.body);
}
async function sweep(client, wa, logOutbound) {
  return BW.sendDue(client, {
    sendText: (to, body) => wa.sendText(to, body),
    sendButtons: wa.sendButtons ? (to, m) => wa.sendButtons(to, m) : null,
    sendImage: wa.sendImage ? (to, id, cap) => wa.sendImage(to, id, cap) : null,
    uploadMedia: wa.uploadMedia ? (buf, mime, name) => wa.uploadMedia(buf, mime, name) : null,
    logOutbound: logOutbound || (async () => {}),
  });
}

let timer = null;
/** Every 10 s, send Seth Ji's replies whose pause has passed. */
function start(db, wa, logOutbound) {
  if (!enabled() || timer) return;
  sender.wa = wa; sender.logOutbound = logOutbound;
  const tick = async () => {
    const client = await db.pool.connect().catch(() => null);
    if (!client) return;
    try {
      if (!(await ready(client))) return;
      const r = await sweep(client, wa, logOutbound);
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

module.exports = { enabled, onInbound, start, sendOut };
