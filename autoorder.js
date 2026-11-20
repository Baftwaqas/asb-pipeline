// ============================================================================
// ASB PIPELINE — autoorder.js
//
// Orders without a human (founder, 19 Nov 2026). Switch ORDER_BOT=on.
//
//   "order" / "order karna hai" / the 🛒 row in the rate-list menu
//      -> [🔁 Pichla order dobara] [☑️ List se chunein] [✍️ Likh kar]
//   ☑️  -> WhatsApp's own product list (tick + quantity, inside WhatsApp):
//          Roz ki sabzi, Bari bachat, Phal, and "see everything" (catalogue)
//   🔁  -> her last order, at today's prices
//   a cart from the catalogue (any time) or the repeat
//      -> "Aap ka order: ... Total ... Delivery ..." [✅ Theek hai] [✏️ Badlein]
//   ✅  -> a real order, through the SAME path as the inbox
//          (orders.saveInboxOrder), once only, then the usual confirmation
//          message (bill.orderConfirmation) goes to her.
//   ✏️  -> the list again; nothing is saved.
//   ✍️  -> "likh dein" - typed lists still go to the team for now (the AI
//          reader is the next step).
//
// Anything the bot cannot settle (an item no longer for sale, delivery day
// passed, a database error) is said plainly to her and left for the team.
// ============================================================================

"use strict";

const orders = require("./orders");
const bill = require("./bill");
const schedule = require("./schedule");
const ai = require("./ai");
const typed = require("./typedorder");

const on = (env = process.env) => String(env.ORDER_BOT || "").toLowerCase() === "on";

const ASK = /^\s*(order|aa?rder|odr|order\s*(karna|dena|karni|deni)\s*(hai|he)?|mujhe\s+order|saa?ma+n\s+(mangwana|chahiye)|new\s+order)\s*[.!?]*\s*$/i;
const isAsk = (t) => ASK.test(String(t || ""));

const DAILY = /\b(aa?roo|aa?loo|pa?y[ae]a?z|piyaz|tamatar|adrak|lehsan|mirch|dhania|dhaniya|podina|pudina|lemon|leemu)\b/i;

const T = {
  start: "Order kaise dena chahengi? 🛒",
  startNew: "Order kaise dena chahengi? 🛒\n\n☑️ List se chun lein, ya ✍️ apni list likh dein.",
  pick:
    "Neeche *list* kholein, jo chahiye us par *+* dabayein, quantity chunein, phir *cart bhej dein*. 🛒\n\n" +
    "Aur items chahiye? *sab items* likh dein.",
  everything: "Hamari saari cheezein yahan hain 👇",
  write:
    "Theek hai! Apni list likh dein, jaise:\n_2 kg aloo, aadha kilo adrak, dhania 2 gaddi_",
  writeTeam:
    "Theek hai! Apni list likh dein, jaise:\n_2 kg aloo, aadha kilo adrak, dhania 2 gaddi_\n\n" +
    "Hamari team foran confirm kar degi.",
  notUnderstood: "Maazrat, ye list samajh nahi aayi. Hamari team abhi dekh kar confirm kar degi.",
  unknown: (xs) => `_Ye abhi hamare paas nahi: ${xs.join(", ")}. Hum ne note kar liya hai. 📝_`,
  onlyUnknown: (xs) => `Maazrat, ye abhi hamare paas nahi: ${xs.join(", ")}. Hum ne note kar liya hai. 📝\n\nKuch aur chahiye to likh dein, ya *order* likh kar list dekh lein.`,
  unclear: (xs) => `_Ye samajh nahi aaya, dobara likh dein (jaise "1 darjan kele"): ${xs.join(", ")}_`,
  editAsk:
    "Koi baat nahi! Poora order dobara likhne ki zaroorat nahi. 🙂\n" +
    "Bas jo badalna hai woh likh dein, jaise:\n_tamatar 2 kg kar dein, kele hata dein, 1 kg piyaz aur_",
  adjusted: (xs) => xs.map((x) => `_${x.name}: ${x.gotText} rakha (ye is se kam ya adhoora nahi milta)._`).join("\n"),
  askUnit: (xs) => xs.map((x) => `_${x.name} ${x.unit} ke hisaab se milta hai${x.said ? ` ("${x.said}")` : ""}. Kitne ${x.unit} chahiye? *Badlein* daba kar likh dein._`).join("\n"),
  emptied: "Order se sab items nikal diye gaye. Naye order ke liye *order* likh dein.",
  editNotUnderstood: "Maazrat, ye tabdeeli samajh nahi aayi. Dobara likh dein, jaise: _tamatar 2 kg kar dein_",
  confirmHead: "Aap ka order:",
  confirmFoot: (delivery) => `\nDelivery: *${delivery}*\n\nSab theek hai?`,
  changed: "Koi baat nahi. List dobara kholein aur jo chahiye chun lein, ya apni list likh dein.",
  noLast: "Aap ka koi pichla order nahi mila. List se chun lein 👇",
  failed: (why) => `Maazrat, ye order save nahi ho saka: ${why}\nHamari team abhi aap se rabta karegi.`,
  stale: "Ye order pehle hi confirm ho chuka hai. ✅",
  old: "Ye purana order tha, ise badal diya gaya. Naye order ke liye *order* likh dein.",
};
const B = {
  repeat: { id: "order:repeat", title: "🔁 Pichla order" },
  list: { id: "order:list", title: "☑️ List se chunein" },
  write: { id: "order:write", title: "✍️ Likh kar" },
  ok: (id) => ({ id: `order:ok:${id}`, title: "✅ Theek hai" }),
  edit: (id) => ({ id: `order:edit:${id}`, title: "✏️ Badlein" }),
};

async function ready(db) {
  return (await db.query(`SELECT to_regclass('order_drafts') IS NOT NULL AS ok`)).rows[0].ok;
}

// ---------------------------------------------------------------------------
// Products as the customer sees them, today.
// ---------------------------------------------------------------------------
async function forSale(db) {
  return (await db.query(
    `SELECT sku, name_en, name_ur, name_roman, category, unit::text AS unit, min_qty, asb_price, market_price, meta_retailer_id
       FROM products
      WHERE is_active AND asb_price > 0 AND category <> 'community-excluded' AND sku NOT LIKE 'ASB-COM-%'
      ORDER BY name_en`)).rows.map((p) => ({ ...p, asb_price: Number(p.asb_price), market_price: p.market_price == null ? null : Number(p.market_price) }));
}

/** Up to 30 products in sections for WhatsApp's product list (only ones in the Meta catalogue). */
function listSections(products) {
  const inCat = products.filter((p) => p.meta_retailer_id);
  const taken = new Set();
  const take = (arr, n) => arr.filter((p) => !taken.has(p.sku)).slice(0, n).map((p) => { taken.add(p.sku); return p; });
  const save = (p) => (p.market_price > p.asb_price ? (p.market_price - p.asb_price) / p.market_price : 0);
  const sections = [
    { title: "Roz ki sabzi", items: take(inCat.filter((p) => DAILY.test(p.name_en)), 12) },
    { title: "Bari bachat", items: take([...inCat].filter((p) => save(p) > 0).sort((a, b) => save(b) - save(a)), 12) },
    { title: "Phal", items: take(inCat.filter((p) => p.category === "phal"), 6) },
  ].filter((s) => s.items.length);
  return sections.map((s) => ({ title: s.title, product_items: s.items.map((p) => ({ product_retailer_id: p.meta_retailer_id })) }));
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------
/** "pao", "300 g", "aadha darjan" in the order she checks (the bill keeps its own exact wording). */
function spoken(packs, unit, size) {
  const total = Number(packs) * (Number(size) > 0 ? Number(size) : 1);
  if (unit === "kg" && total > 0 && total < 1) {
    const g = Math.round(total * 1000);
    return ({ 250: "pao", 500: "aadha kg", 750: "pauna kg" })[g] || `${g} g`;
  }
  if (unit === "dozen" && total % 1 !== 0) {
    const pcs = Math.round(total * 12);
    if (pcs === 6) return "aadha darjan";
    if (pcs < 12) return `${pcs} adad`;
  }
  return bill.qtyPhrase(packs, unit, size);
}

/** The text she checks. Prices: today's ASB price per pack. */
function draftText(lines, products, deliveryDate) {
  const by = new Map(products.map((p) => [p.sku, p]));
  let total = 0;
  const rows = [];
  for (const l of lines) {
    const p = by.get(l.sku);
    if (!p) continue;
    const amt = p.asb_price * l.packs;
    total += amt;
    rows.push(`• ${p.name_en} — ${spoken(l.packs, p.unit, p.min_qty)} — ${bill.money(amt)}`);
  }
  return [T.confirmHead, ...rows, ``, `Total: *${bill.money(total)}* (zyada se zyada)`, T.confirmFoot(bill.deliveryPhrase(deliveryDate))].join("\n");
}

async function newDraft(db, phone, source, lines) {
  // a new draft replaces any older one still waiting
  await db.query(`UPDATE order_drafts SET status = 'expired', decided_at = now() WHERE phone = $1 AND status = 'shown'`, [phone]);
  return (await db.query(
    `INSERT INTO order_drafts (phone, source, lines) VALUES ($1, $2, $3) RETURNING id`,
    [phone, source, JSON.stringify(lines)])).rows[0].id;
}

async function showDraft(db, { phone, source, lines, send, now, notes = [] }) {
  const products = await forSale(db);
  const sellable = new Set(products.map((p) => p.sku));
  const gone = lines.filter((l) => !sellable.has(l.sku));
  const keep = lines.filter((l) => sellable.has(l.sku));
  if (!keep.length) {
    await send.text(phone, T.failed("in mein se koi cheez abhi available nahi."));
    return { did: "nothing_for_sale" };
  }
  const id = await newDraft(db, phone, source, keep);
  const slot = schedule.deliveryFor(now);
  let text = draftText(keep, products, slot.deliveryDate);
  if (gone.length) text = `_${gone.length} cheez(ein) abhi available nahi, is liye nikal di gayi._\n\n` + text;
  if (notes.length) text = notes.join("\n") + "\n\n" + text;
  await send.buttons(phone, text, [B.ok(id), B.edit(id)]);
  return { did: "confirm", draft: id, lines: keep.length };
}

/** Her last order's lines (packs), most recent order first. */
async function lastOrder(db, phone) {
  const o = (await db.query(
    `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE c.phone = $1 AND o.status::text <> 'cancelled'
      ORDER BY o.id DESC LIMIT 1`, [phone])).rows[0];
  if (!o) return null;
  return (await db.query(
    `SELECT p.sku, oi.qty_ordered::float AS packs FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id`, [o.id])).rows.map((r) => ({ sku: r.sku, packs: Number(r.packs) }));
}

/** A WhatsApp catalogue cart -> lines by SKU (unknown items dropped and counted). */
async function cartLines(db, order) {
  const catalogOrder = require("./catalogOrder");
  const items = order?.product_items || [];
  const rids = items.map((i) => String(i.product_retailer_id));
  const keys = [...new Set(rids.flatMap(catalogOrder.candidates))];
  const rows = keys.length ? (await db.query(
    `SELECT sku, shopify_product_id, shopify_variant_id, meta_retailer_id FROM products
      WHERE meta_retailer_id = ANY($1) OR sku = ANY($1) OR shopify_variant_id = ANY($1) OR shopify_product_id = ANY($1)`,
    [keys])).rows : [];
  const merged = new Map();
  for (const it of items) {
    const p = catalogOrder.match(rows, it.product_retailer_id);
    const q = Number(it.quantity) || 0;
    if (p && q > 0) merged.set(p.sku, (merged.get(p.sku) || 0) + q);
  }
  return [...merged].map(([sku, packs]) => ({ sku, packs }));
}

// ---------------------------------------------------------------------------
// Confirm -> a real order (same path as the inbox), exactly once.
// ---------------------------------------------------------------------------
async function confirm(db, { phone, draftId, name, now }) {
  return db.tx(async (client) => {
    const d = (await client.query(
      `SELECT * FROM order_drafts WHERE id = $1 AND phone = $2 FOR UPDATE`, [draftId, phone])).rows[0];
    if (!d) return { stale: true };
    if (d.status !== "shown") return { stale: true, status: d.status, orderId: d.order_id };
    const saved = await orders.saveInboxOrder(client, {
      phone, name, orderedAt: now, lines: d.lines, enteredBy: "order bot", sourceWamid: null,
    });
    await client.query(`UPDATE order_drafts SET status = 'confirmed', order_id = $2, decided_at = now() WHERE id = $1`,
      [draftId, saved.orderId]);
    return { orderId: saved.orderId, merged: saved.merged };
  });
}

// ---------------------------------------------------------------------------
// The bot. Called for every inbound customer message after it is saved, after
// the area bot. Returns what it did, or null.
//   send: { text, buttons(phone, body, buttons), productList(phone, header, body, catalogId, sections), catalog(phone, body) }
// ---------------------------------------------------------------------------
async function onInbound(db, { phone, msg, send, contactName = null, now = new Date(), env = process.env, catalogId = null, fetchImpl = fetch }) {
  if (!on(env) || !(await ready(db))) return null;
  const id = msg?.interactive?.button_reply?.id || msg?.interactive?.list_reply?.id || "";

  // A cart from the WhatsApp catalogue, any time.
  if (msg?.type === "order" && msg.order) {
    const lines = await cartLines(db, msg.order);
    if (!lines.length) return null;   // nothing we recognise: the team sees it
    return showDraft(db, { phone, source: "cart", lines, send, now });
  }

  const m = /^order:(ok|edit):(\d+)$/.exec(id);
  if (m) {
    const draftId = Number(m[2]);
    if (m[1] === "edit") {
      const r = await db.query(`UPDATE order_drafts SET status = 'changed', decided_at = now() WHERE id = $1 AND phone = $2 AND status = 'shown' RETURNING id`, [draftId, phone]);
      if (!r.rowCount) { await send.text(phone, T.old); return { did: "stale", draft: draftId }; }
      if (ai.configured(env)) {
        // keep her order; she only types what changes
        await send.text(phone, T.editAsk);
        return { did: "edit_ask", draft: draftId };
      }
      await send.buttons(phone, T.changed, [B.list, B.write]);
      return { did: "changed", draft: draftId };
    }
    try {
      const r = await confirm(db, { phone, draftId, name: contactName, now });
      if (r.stale) { await send.text(phone, r.status === "confirmed" ? T.stale : T.old); return { did: "stale", draft: draftId }; }
      const forBill = await orders.loadOrderForBill(db, r.orderId);
      forBill.ordered_at = now;
      await send.text(phone, bill.orderConfirmation(forBill).rich);
      return { did: "ordered", draft: draftId, orderId: r.orderId, orderNumber: forBill.order_number, merged: Boolean(r.merged) };
    } catch (e) {
      await db.query(`UPDATE order_drafts SET status = 'failed', note = $2, decided_at = now() WHERE id = $1`, [draftId, String(e.message).slice(0, 300)]);
      await send.text(phone, T.failed(e.userFacing ? e.message : "system mein masla aa gaya."));
      return { did: "failed", draft: draftId, error: e.message };
    }
  }

  if (id === B.repeat.id) {
    const lines = await lastOrder(db, phone);
    if (!lines?.length) {
      await send.text(phone, T.noLast);
      return sendList(db, { phone, send, catalogId });
    }
    return showDraft(db, { phone, source: "repeat", lines, send, now });
  }
  if (id === B.list.id) return sendList(db, { phone, send, catalogId });
  if (id === B.write.id) {
    await send.text(phone, ai.configured(env) ? T.write : T.writeTeam);
    return { did: "write" };
  }
  if (/^\s*(sab|saare|saari|all)\s+(items?|cheezein|cheezen|saman)\s*$/i.test(msg?.text?.body || "")) {
    await send.catalog(phone, T.everything);
    return { did: "catalogue" };
  }

  // "order" typed, or the 🛒 row in the rate-list menu
  const typedText = msg?.type === "text" ? msg.text?.body : null;
  if (id === "ratelist:order" || isAsk(typedText)) {
    const hasLast = Boolean((await lastOrder(db, phone))?.length);
    await send.buttons(phone, hasLast ? T.start : T.startNew, hasLast ? [B.repeat, B.list, B.write] : [B.list, B.write]);
    return { did: "start", hasLast };
  }

  // A typed order ("2kg aloo, aadha kilo adrak") -> the AI reader -> the same confirmation.
  // She tapped ✏️ Badlein and now types only the change ("tamatar 2 kg kar dein, kele hata dein").
  if (typedText && ai.configured(env)) {
    const editing = await editingDraft(db, phone);
    if (editing) {
      let r;
      try {
        r = await typed.read(typedText, await forSale(db), { env, fetchImpl, current: editing.lines });
      } catch (e) {
        return { did: "ai_failed", error: e.code || e.message };
      }
      if (r.why && r.why.length) console.log(`[order-bot] edit: ${r.lines.length} lines, unclear because: ${r.why.join("; ")}`);
      await recordMissing(db, phone, r.unknown, typedText, "edit");
      const notes = await notesFor(db, r);
      if (!r.lines.length) {
        if (notes.length) { await send.text(phone, T.editNotUnderstood); return { did: "edit_not_understood" }; }
        await send.text(phone, T.emptied);
        return { did: "emptied", draft: editing.id };
      }
      return showDraft(db, { phone, source: editing.source, lines: r.lines, send, now, notes });
    }
  }

  if (typedText && ai.configured(env)) {
    const justAsked = await askedToWrite(db, phone);
    if (!justAsked && !typed.looksLikeOrder(typedText)) return null;
    let r;
    try {
      r = await typed.read(typedText, await forSale(db), { env, fetchImpl });
    } catch (e) {
      return { did: "ai_failed", error: e.code || e.message };   // the team sees the message as before
    }
    if (r.why && r.why.length) console.log(`[order-bot] typed: ${r.lines.length} read, unclear because: ${r.why.join("; ")}`);
    await recordMissing(db, phone, r.unknown, typedText, "typed");
    if (!r.lines.length) {
      if (r.unknown.length && (justAsked || !r.unclear.length)) {
        await send.text(phone, T.onlyUnknown(r.unknown));
        return { did: "only_unknown", unknown: r.unknown.length };
      }
      if (justAsked) { await send.text(phone, T.notUnderstood); return { did: "not_understood" }; }
      return null;
    }
    const notes = await notesFor(db, r);
    return showDraft(db, { phone, source: "typed", lines: r.lines, send, now, notes });
  }
  return null;
}

/** Items we do not sell, kept for the founder's weekly "most asked" list. Never fails the order. */
async function recordMissing(db, phone, items, said, source) {
  if (!items?.length) return;
  try {
    if (!(await db.query(`SELECT to_regclass('missing_items') IS NOT NULL AS ok`)).rows[0].ok) return;
    for (const raw of items.slice(0, 10)) {
      const item = String(raw).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
      if (!item) continue;
      await db.query(`INSERT INTO missing_items (phone, item, said, source) VALUES ($1, $2, $3, $4)`,
        [phone, item, String(said || "").slice(0, 500), source]);
    }
  } catch (e) {
    console.error("[order-bot] could not record missing items:", e.message);
  }
}

/** The founder's list: most-asked missing items over the last N days. */
async function missingReport(db, days = 7) {
  if (!(await db.query(`SELECT to_regclass('missing_items') IS NOT NULL AS ok`)).rows[0].ok) return null;
  return (await db.query(
    `SELECT item, count(*)::int AS asks, count(DISTINCT phone)::int AS people, max(created_at) AS last
       FROM missing_items WHERE created_at > now() - make_interval(days => $1)
      GROUP BY item ORDER BY people DESC, asks DESC, last DESC LIMIT 100`, [days])).rows;
}

/** What to tell her above the order: not stocked, not understood, rounded to a pack, or "kitne kilo?". */
async function notesFor(db, r) {
  const notes = [];
  if (r.unknown?.length) notes.push(T.unknown(r.unknown));
  if (r.askUnit?.length) notes.push(T.askUnit(r.askUnit));
  if (r.unclear?.length) notes.push(T.unclear(r.unclear));
  if (r.adjusted?.length) {
    notes.push(T.adjusted(r.adjusted.map((x) => ({
      name: x.name,
      gotText: spoken(x.packs, x.unit, x.size),
    }))));
  }
  return notes;
}

/** The draft she is changing: the bot's last message (last hour) asked for the change, and that draft is 'changed'. */
async function editingDraft(db, phone) {
  const last = (await db.query(
    `SELECT body_preview FROM whatsapp_messages
      WHERE phone = $1 AND direction = 'outbound' AND agent = 'order bot'
        AND COALESCE(sent_at, received_at) > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  const body = String(last?.body_preview || "");
  if (!body.startsWith("Koi baat nahi! Poora order") && !body.startsWith("Maazrat, ye tabdeeli")) return null;
  const d = (await db.query(
    `SELECT id, source, lines FROM order_drafts
      WHERE phone = $1 AND status = 'changed' AND decided_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  if (!d) return null;
  const lines = typeof d.lines === "string" ? JSON.parse(d.lines) : d.lines;
  return lines?.length ? { id: d.id, source: d.source, lines } : null;
}

/** Did the bot just say "apni list likh dein" (last hour)? */
async function askedToWrite(db, phone) {
  const r = await db.query(
    `SELECT body_preview FROM whatsapp_messages
      WHERE phone = $1 AND direction = 'outbound' AND agent = 'order bot'
        AND COALESCE(sent_at, received_at) > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone]);
  return String(r.rows[0]?.body_preview || "").startsWith("Theek hai! Apni list likh dein");
}

async function sendList(db, { phone, send, catalogId }) {
  const sections = listSections(await forSale(db));
  if (!catalogId || !sections.length) {
    await send.text(phone, T.write);
    return { did: "no_catalogue" };
  }
  // One list only (founder, 20 Nov: two catalogues with the same items was confusing).
  // The whole catalogue comes when she writes "sab items".
  await send.productList(phone, "Apna Sasta Bazaar 🌿", T.pick, catalogId, sections);
  return { did: "list", items: sections.reduce((n, s) => n + s.product_items.length, 0) };
}

module.exports = {
  missingReport, spoken, on, isAsk, T, B, ready, forSale, listSections, draftText, lastOrder, cartLines, confirm, onInbound };
