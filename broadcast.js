// ============================================================================
// ASB PIPELINE — broadcast.js
//
// Sending the rate-list poster to many customers at once: the part of AiSensy
// ASB actually used, besides chat.
//
// HOW A SEND WORKS
//   1. The poster is uploaded to Meta once (media id), not once per customer.
//   2. A broadcast row and one recipient row per phone are written FIRST.
//      Anyone who replied STOP is written as 'skipped', never sent to.
//   3. A single worker walks the pending rows, sends the asb_rate_list
//      template to each, and records the answer on that row.
//
// WHY IT IS BUILT THIS WAY
//   * Render's free instance restarts without warning. Because every
//     recipient row exists before sending starts and is marked as it goes, a
//     restart resumes exactly where it stopped (resumeAll on boot). Nobody
//     gets the poster twice, nobody is silently missed.
//   * One broadcast at a time, and a steady pace (SEND_GAP_MS). A burst of
//     hundreds of marketing messages in a second is how a new sender's quality
//     rating drops.
//   * If Meta refuses the first several messages in a row with the same
//     error (for example "(#200)" while AiSensy still holds billing, or a
//     template not yet approved), the send stops by itself instead of
//     burning through the whole list with the same failure.
// ============================================================================

"use strict";

const wa = require("./whatsapp");
const T = require("./templates");

const SEND_GAP_MS = Number(process.env.BROADCAST_GAP_MS || 250); // ~4 per second
const STOP_AFTER_SAME_ERRORS = 5;

let running = null; // id of the broadcast the worker is on, if any

// Replies that mean "stop sending me the rate list", and "start again".
const STOP_WORDS = /^\s*(stop|unsubscribe|band\s*kar(o|\s*do|\s*dein)?|mat\s*bhejo|rate\s*list\s*band)\s*[.!]*\s*$/i;
const START_WORDS = /^\s*(start|subscribe|rate\s*list\s*(bhejo|bhej\s*dein|chahiye))\s*[.!]*\s*$/i;

// ---------------------------------------------------------------------------
// Opt-outs. Called for every inbound text message (server.js).
// ---------------------------------------------------------------------------
async function handleOptWords(db, phone, text) {
  if (!text) return null;
  if (STOP_WORDS.test(text)) {
    await db.query(
      `INSERT INTO marketing_opt_outs (phone, source) VALUES ($1, 'replied STOP')
       ON CONFLICT (phone) DO NOTHING`, [phone]);
    console.log(`[broadcast] +${phone} opted out of rate lists`);
    return "out";
  }
  if (START_WORDS.test(text)) {
    const r = await db.query(`DELETE FROM marketing_opt_outs WHERE phone = $1`, [phone]);
    if (r.rowCount) console.log(`[broadcast] +${phone} opted back in to rate lists`);
    return r.rowCount ? "in" : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Who a broadcast can go to: every customer we have a proper Pakistani mobile
// number for, and everyone who has ever messaged the business number. Numbers
// pasted in by hand (for example exported from AiSensy) are added on top.
// ---------------------------------------------------------------------------
async function audience(db) {
  const { rows } = await db.query(
    `WITH everyone AS (
       SELECT phone FROM customers WHERE phone ~ '^92[0-9]{10}$'
       UNION
       SELECT DISTINCT phone FROM whatsapp_messages
        WHERE direction = 'inbound' AND phone ~ '^92[0-9]{10}$'
     )
     SELECT e.phone, (o.phone IS NOT NULL) AS opted_out
       FROM everyone e
       LEFT JOIN marketing_opt_outs o ON o.phone = e.phone`
  );
  return rows;
}

/** "0300-1234567, +92 300 7654321\n3001112223" -> ['923001234567', ...] */
// Numbers arrive written every way: "0300 1234567", "+92 300-1234567",
// one per line, comma separated, or a spreadsheet column. Split on commas,
// semicolons and line breaks first (so the spaces INSIDE a number survive);
// a piece that still holds several numbers is split again on spaces.
function normaliseOne(raw) {
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("0092")) d = d.slice(2);
  if (d.startsWith("0")) d = "92" + d.slice(1);
  if (d.length === 10 && d.startsWith("3")) d = "92" + d;
  return /^92[0-9]{10}$/.test(d) ? d : null;
}
function parsePhones(text) {
  const out = new Set();
  for (const piece of String(text || "").split(/[,;\n\r\t]+/)) {
    const whole = normaliseOne(piece);
    if (whole) { out.add(whole); continue; }
    for (const word of piece.split(/\s+/)) {
      const one = normaliseOne(word);
      if (one) out.add(one);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Create a broadcast and its recipient list. Does not send.
// ---------------------------------------------------------------------------
async function create(db, { agent, mediaId, mediaMime, delivery, cutoff, phones, isTest }) {
  const unique = [...new Set(phones)];
  return db.tx(async (client) => {
    const b = await client.query(
      `INSERT INTO broadcasts (created_by, template, media_id, media_mime, delivery, cutoff, is_test)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [agent || null, T.TEMPLATES.rateList.name, mediaId, mediaMime || null, delivery, cutoff, Boolean(isTest)]
    );
    const id = b.rows[0].id;
    // One statement for the whole list; opted-out numbers go in as 'skipped'
    // so the report can say how many were left out and why.
    await client.query(
      `INSERT INTO broadcast_recipients (broadcast_id, phone, status, error)
       SELECT $1, p,
              CASE WHEN o.phone IS NULL THEN 'pending' ELSE 'skipped' END,
              CASE WHEN o.phone IS NULL THEN NULL ELSE 'opted out (STOP)' END
         FROM unnest($2::text[]) AS p
         LEFT JOIN marketing_opt_outs o ON o.phone = p
       ON CONFLICT DO NOTHING`,
      [id, unique]
    );
    await client.query(
      `UPDATE broadcasts b
          SET total   = (SELECT count(*) FROM broadcast_recipients WHERE broadcast_id = b.id),
              skipped = (SELECT count(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'skipped')
        WHERE id = $1`, [id]);
    return id;
  });
}

async function status(db, id) {
  const { rows } = await db.query(
    `SELECT id, created_at, created_by, status, is_test, total, sent, failed, skipped,
            delivery, cutoff, media_id, started_at, finished_at, last_error,
            (SELECT count(*) FROM broadcast_recipients r
              WHERE r.broadcast_id = b.id AND r.status = 'pending')::int AS pending
       FROM broadcasts b WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function recent(db, limit = 5) {
  const { rows } = await db.query(
    `SELECT id, created_at, created_by, status, is_test, total, sent, failed, skipped,
            delivery, last_error
       FROM broadcasts ORDER BY id DESC LIMIT $1`, [limit]);
  return rows;
}

// ---------------------------------------------------------------------------
// The worker. Returns immediately; sending carries on in the background.
// logOutbound is passed in so each message shows in the customer's thread.
// ---------------------------------------------------------------------------
function start(db, id, logOutbound) {
  if (running && running !== id) return { ok: false, error: `Broadcast ${running} is still sending.` };
  if (running === id) return { ok: true, already: true };
  running = id;
  run(db, id, logOutbound)
    .catch((e) => console.error(`[broadcast] ${id} crashed:`, e.message))
    .finally(() => { if (running === id) running = null; });
  return { ok: true };
}

async function run(db, id, logOutbound) {
  const b = await status(db, id);
  if (!b || b.status === "done" || b.status === "stopped") return;

  await db.query(
    `UPDATE broadcasts SET status = 'sending', started_at = COALESCE(started_at, now()) WHERE id = $1`, [id]);
  console.log(`[broadcast] ${id} sending to ${b.pending} customer(s)`);

  const t = T.TEMPLATES.rateList;
  const params = T.rateListParams(b.delivery, b.cutoff);
  const preview = T.rateListText(b.delivery, b.cutoff);
  let sameError = { text: null, count: 0 };

  for (;;) {
    // Re-read the status each round so "Stop" in the inbox takes effect.
    const cur = await db.query(`SELECT status FROM broadcasts WHERE id = $1`, [id]);
    if (cur.rows[0]?.status !== "sending") { console.log(`[broadcast] ${id} stopped`); return; }

    const next = await db.query(
      `SELECT phone FROM broadcast_recipients
        WHERE broadcast_id = $1 AND status = 'pending' ORDER BY phone LIMIT 1`, [id]);
    const phone = next.rows[0]?.phone;
    if (!phone) break;

    const r = await wa.sendTemplate(phone, t.name, params, { lang: t.language, headerImageId: b.media_id });
    const msg = r.data?.error?.message || "refused";
    const err = r.ok ? null : (/^\(#\d+\)/.test(msg) ? msg : `(#${r.code || "?"}) ${msg}`).slice(0, 300);

    await db.query(
      `UPDATE broadcast_recipients
          SET status = $3, wamid = $4, error = $5, sent_at = now()
        WHERE broadcast_id = $1 AND phone = $2`,
      [id, phone, r.ok ? "sent" : "failed", r.wamid, err]);
    await db.query(
      `UPDATE broadcasts SET ${r.ok ? "sent = sent + 1" : "failed = failed + 1"},
              last_error = COALESCE($2, last_error) WHERE id = $1`, [id, err]);

    if (logOutbound) {
      await logOutbound({
        phone, body: preview, agent: `broadcast #${id}`, template: t.name,
        wamid: r.wamid, ok: r.ok, payload: r.data,
        mediaId: b.media_id, mediaMime: b.media_mime || "image/jpeg",
      });
    }

    // The same refusal again and again means nothing will get through (no
    // permission, template not approved yet). Stop and say why.
    if (!r.ok) {
      sameError = sameError.text === err ? { text: err, count: sameError.count + 1 } : { text: err, count: 1 };
      if (sameError.count >= STOP_AFTER_SAME_ERRORS) {
        await db.query(
          `UPDATE broadcasts SET status = 'stopped', finished_at = now(),
                  last_error = $2 WHERE id = $1`,
          [id, `Stopped after ${STOP_AFTER_SAME_ERRORS} identical refusals: ${err}`]);
        console.warn(`[broadcast] ${id} STOPPED - ${err}`);
        return;
      }
    } else {
      sameError = { text: null, count: 0 };
    }

    await new Promise((res) => setTimeout(res, SEND_GAP_MS));
  }

  await db.query(`UPDATE broadcasts SET status = 'done', finished_at = now() WHERE id = $1`, [id]);
  const done = await status(db, id);
  console.log(`[broadcast] ${id} done - sent ${done.sent}, failed ${done.failed}, skipped ${done.skipped}`);
}

async function stop(db, id) {
  await db.query(
    `UPDATE broadcasts SET status = 'stopped', finished_at = now()
      WHERE id = $1 AND status IN ('queued', 'sending')`, [id]);
}

// On boot: carry on with any broadcast a restart interrupted.
async function resumeAll(db, logOutbound) {
  try {
    const { rows } = await db.query(
      `SELECT id FROM broadcasts WHERE status = 'sending' ORDER BY id LIMIT 1`);
    if (rows[0]) {
      console.log(`[broadcast] resuming ${rows[0].id} after a restart`);
      start(db, rows[0].id, logOutbound);
    }
  } catch (e) {
    // Table missing (migration 013 not run yet) must not stop the server.
    if (!/does not exist/.test(e.message)) console.error("[broadcast] resume failed:", e.message);
  }
}

module.exports = {
  handleOptWords, audience, parsePhones, create, start, stop, status, recent, resumeAll,
  isRunning: () => running,
};
