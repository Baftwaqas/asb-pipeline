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
  sameDay: (o, delivery, more) =>
    `Aap ka ${delivery} ka order *${o.order_number}* pehle se hai (${bill.money(o.total)}).` +
    (more ? `\n_Is number par ${more} alag bill bhi hain._` : "") +
    `\n\nYe naye items usi order mein shamil karun, ya inka *alag bill* banaun?`,
  askLabel: "Theek hai! Ye alag bill kis naam se banaun?\n_Jaise: Ayesha — padosan_",
  badLabel: "Naam thora chhota likh dein (40 huroof tak), jaise: _Ayesha — padosan_",
  mergedNote: (num) => `✅ Ye items aap ke order *${num}* mein shamil kar diye. Poora order neeche 👇`,
  whichKind: (said) => `"${said}" — kaunsa chahiye? 👇`,
  whichKindBtn: "Chunein",
  short: (o, label, merged, delivery) => {
    const ceiling = Number(o.ceiling_total || 0), market = Number(o.market_total || 0);
    const saved = Math.max(0, Math.round(market - ceiling));
    return [
      merged ? `✅ Ye items aap ke order *${o.order_number}* mein shamil kar diye.` : `✅ Order mil gaya — *${o.order_number}*`,
      ...(label ? [`Alag bill: *${label}*`] : []),
      ...(delivery ? [`Delivery: *${delivery}*`] : []),
      ``,
      `Zyada se zyada: *${bill.money(ceiling)}*`,
      ...(saved > 0 ? [`Bazaar rate par: ${bill.money(market)}`, `Aap ki bachat: *${bill.money(saved)}* ✅`] : []),
      ``,
      `Is se zyada aap kabhi nahi denge — ye hamara wada hai.`,
    ].join("\n");
  },
  changeAsk: (o, delivery) =>
    `✏️ Order *${o.order_number}* (${delivery}) mein kya badalna hai?\n` +
    "Bas wohi likh dein, jaise:\n_tamatar 2 kg kar dein, kele hata dein, 1 kg piyaz aur_",
  changeHead: (num) => `✏️ Order *${num}* ab aisa hoga:`,
  changed2: (num) => `✏️ Order *${num}* badal diya.`,
  whichOrder: "Kaunsa order badalna hai? 👇",
  locked: (o, delivery, cutoffDay) =>
    `Aap ka order *${o.order_number}* (${delivery}) band ho chuka hai — cutoff ${cutoffDay} raat 9 baje tha, ` +
    "saman khareeda ja raha hai. Is mein tabdeeli ke liye hamari team aap se rabta karegi. 🙏\n\n" +
    "Naye items agli delivery ke liye chahiye hon to likh dein.",
  lockedNew: (delivery, cutoffDay) =>
    `_Aap ka ${delivery} ka order band ho chuka hai (cutoff ${cutoffDay} raat 9 baje). Ye naya order agli delivery ke liye hai._`,
  cancelAsk: (num) => `Order *${num}* se sab items nikal diye. Poora order *cancel* kar doon?`,
  cancelled: (num) => `Order *${num}* cancel kar diya. 👍 Naye order ke liye *order* likh dein.`,
  kept: "Theek hai, order waise hi rahega. 👍",
  remind: (o, delivery, cutoffDay) =>
    `⏰ Yaad dahani: aap ka order *${o.order_number}* (${delivery}) aaj ${cutoffDay} raat 9 baje band ho jayega. ` +
    "Kuch badalna ho to abhi likh dein — us ke baad tabdeeli nahi ho sakegi.",
  emptied: "Order se sab items nikal diye gaye. Naye order ke liye *order* likh dein.",
  aiBusy: "Shukriya! 🙏 Aap ka order mil gaya hai. Hamari team thori dair mein confirm kar degi.",
  editNotUnderstood: "Maazrat, ye tabdeeli samajh nahi aayi. Dobara likh dein, jaise: _tamatar 2 kg kar dein_",
  confirmHead: "Aap ka order:",
  confirmFoot: (delivery) => `\nDelivery: *${delivery}*\n\nSab theek hai?`,
  changed: "Koi baat nahi. List dobara kholein aur jo chahiye chun lein, ya apni list likh dein.",
  noLast: "Aap ka koi pichla order nahi mila. List se chun lein 👇",
  startEditable: (os, cutoff) => (os.length === 1
    ? `Aap ka ${os[0].day} ka order *${os[0].order_number}* (${bill.money(os[0].total)}) pehle se hai — ${cutoff} raat 9 baje tak badal sakti hain.`
    : `Aap ke ${os[0].day} ke ${os.length} orders pehle se hain — ${cutoff} raat 9 baje tak badal sakti hain.`) +
    "\n\n✏️ Badalna ho to *Order badlein*, ya naya alag order list se / likh kar dein.",
  startLocked: (o, cutoff) =>
    `Aap ka ${o.day} ka order *${o.order_number}* band ho chuka hai (cutoff ${cutoff} raat 9 baje) — delivery ${o.day} ko hogi. 🙏\n\n` +
    "Agli delivery ke liye naya order list se chunein ya likh kar dein 👇",
  whoseLast: "Kis ka pichla order? 👇",
  repeatHead: (label) => (label ? `${label} ka pichla order:` : "Aap ka pichla order:"),
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
  merge: (id) => ({ id: `order:merge:${id}`, title: "➕ Usi mein shamil" }),
  fullBill: (orderId) => ({ id: `order:bill:${orderId}`, title: "🧾 Poora bill" }),
  change: (orderId) => ({ id: `order:change:${orderId}`, title: "✏️ Order badlein" }),
  cancelYes: (orderId) => ({ id: `order:cancel:${orderId}`, title: "🗑️ Haan, cancel" }),
  cancelNo: { id: "order:keep", title: "Nahi, rehne dein" },
  split: (id) => ({ id: `order:split:${id}`, title: "🧾 Alag bill" }),
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

async function newDraft(db, phone, source, lines, note = null) {
  // a new draft replaces any older one still waiting
  await db.query(`UPDATE order_drafts SET status = 'expired', decided_at = now() WHERE phone = $1 AND status = 'shown'`, [phone]);
  return (await db.query(
    `INSERT INTO order_drafts (phone, source, lines, note) VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, source, JSON.stringify(lines), note])).rows[0].id;
}

// A draft that CHANGES a confirmed order carries it in its note:
//   change:{"order":12,"number":"ASB-001030","before":[...lines]}
// ("choose:" notes carry it as changeOf while kinds are being asked.)
const changeNote = (c) => (c ? "change:" + JSON.stringify(c) : null);
function repeatLabelOf(note) {
  const n = String(note || "");
  try {
    if (n.startsWith("repeat:")) return JSON.parse(n.slice(7)).label || null;
    if (n.startsWith("choose:")) return JSON.parse(n.slice(7)).repeatLabel || null;
  } catch (_) { /* not ours */ }
  return null;
}
function changeOfNote(note) {
  const n = String(note || "");
  try {
    if (n.startsWith("change:")) return JSON.parse(n.slice(7));
    if (n.startsWith("choose:")) return JSON.parse(n.slice(7)).changeOf || null;
  } catch (_) { /* not ours */ }
  return null;
}
const cutoffDayOf = (deliveryDate) => {
  // DATE columns arrive as local midnight; a 'YYYY-MM-DD' string is read the same way
  const d = typeof deliveryDate === "string" ? new Date(deliveryDate + "T00:00:00") : new Date(deliveryDate);
  return ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][d.getDay()];   // the day before
};

async function showDraft(db, { phone, source, lines, send, now, notes = [], changeOf = null, repeatLabel = null, repeatHead = false }) {
  const products = await forSale(db);
  const sellable = new Set(products.map((p) => p.sku));
  const gone = lines.filter((l) => !sellable.has(l.sku));
  const keep = lines.filter((l) => sellable.has(l.sku));
  if (!keep.length) {
    await send.text(phone, T.failed("in mein se koi cheez abhi available nahi."));
    return { did: "nothing_for_sale" };
  }
  const id = await newDraft(db, phone, source, keep,
    changeOf ? changeNote(changeOf) : (repeatLabel ? "repeat:" + JSON.stringify({ label: repeatLabel }) : null));
  const slot = schedule.deliveryFor(now);
  let text = draftText(keep, products, slot.deliveryDate);
  if (changeOf) text = text.replace(T.confirmHead, T.changeHead(changeOf.number));
  else if (repeatHead || repeatLabel) text = text.replace(T.confirmHead, T.repeatHead(repeatLabel));
  if (gone.length) text = `_${gone.length} cheez(ein) abhi available nahi, is liye nikal di gayi._\n\n` + text;
  if (notes.length) text = notes.join("\n") + "\n\n" + text;
  await send.buttons(phone, text, [B.ok(id), B.edit(id)]);
  return { did: "confirm", draft: id, lines: keep.length };
}

/**
 * "order": what to offer depends on the clock (founder, 20 Nov).
 *   an order still before its cut-off -> ✏️ Order badlein (no Pichla order)
 *   an order past its cut-off        -> say it is closed; List / Likh kar for the NEXT delivery
 *   nothing coming                    -> 🔁 Pichla order (her last DELIVERED order) / List / Likh kar
 */
async function startMenu(db, { phone, send, now, up = null }) {
  up = up || await orders.upcomingOrdersFor(db, phone, now);
  const day = (o) => ({ ...o, day: bill.deliveryPhrase(o.delivery_date).split(",")[0] });
  if (up.editable.length) {
    const os = up.editable.map(day);
    const edit = os.length === 1 ? B.change(os[0].id) : { id: "order:changemenu", title: "✏️ Order badlein" };
    await send.buttons(phone, T.startEditable(os, cutoffDayOf(os[0].delivery_date)), [edit, B.list, B.write]);
    return { did: "start_editable", orders: os.length };
  }
  if (up.locked.length) {
    const o = day(up.locked[0]);
    await send.buttons(phone, T.startLocked(o, cutoffDayOf(o.delivery_date)), [B.list, B.write]);
    return { did: "start_locked", orderId: o.id };
  }
  const hasLast = (await pastBills(db, phone)).length > 0;
  await send.buttons(phone, hasLast ? T.start : T.startNew, hasLast ? [B.repeat, B.list, B.write] : [B.list, B.write]);
  return { did: "start", hasLast };
}

/** Her last DELIVERED (past) order per bill on this number: her own first, then neighbours' by name. */
async function pastBills(db, phone) {
  const label = (await orders.hasBillLabel(db)) ? "o.bill_label" : "NULL::text";
  const { rows } = await db.query(
    `SELECT DISTINCT ON (COALESCE(lower(${label}), '')) o.id, ${label} AS bill_label
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN cycles cy ON cy.id = o.cycle_id
      WHERE c.phone = $1 AND o.status::text <> 'cancelled'
        AND cy.delivery_date < (now() AT TIME ZONE 'Asia/Karachi')::date
        AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)
      ORDER BY COALESCE(lower(${label}), ''), o.id DESC`, [phone]);
  return rows.map((r) => ({ id: Number(r.id), bill_label: r.bill_label }))
    .sort((a, b) => (a.bill_label ? 1 : 0) - (b.bill_label ? 1 : 0));
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
async function confirm(db, { phone, draftId, name, now, billLabel = null }) {
  return db.tx(async (client) => {
    const d = (await client.query(
      `SELECT * FROM order_drafts WHERE id = $1 AND phone = $2 FOR UPDATE`, [draftId, phone])).rows[0];
    if (!d) return { stale: true };
    if (d.status !== "shown") return { stale: true, status: d.status, orderId: d.order_id };
    const saved = await orders.saveInboxOrder(client, {
      phone, name, orderedAt: now, lines: d.lines, enteredBy: "order bot", sourceWamid: null, billLabel,
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

  const m = /^order:(ok|edit|merge|split):(\d+)$/.exec(id);
  if (m) {
    const draftId = Number(m[2]);
    // Theek hai, but she already has an order for that delivery: ask before mixing them.
    if (m[1] === "ok") {
      const d = (await db.query(`SELECT status, note FROM order_drafts WHERE id = $1 AND phone = $2`, [draftId, phone])).rows[0];
      if (d?.status === "shown" && String(d.note || "").startsWith("change:")) return applyChange(db, { phone, draftId, now, send });
      const rl = d?.status === "shown" ? repeatLabelOf(d.note) : null;
      if (rl) return placeOrder(db, { phone, draftId, contactName, now, send, billLabel: rl });
      if (d?.status === "shown") {
        const live = await orders.liveOrdersFor(db, phone, now);
        const main = live.find((o) => !o.bill_label) || live[0];
        if (main) {
          const delivery = bill.deliveryPhrase(main.delivery_date);
          const more = live.filter((o) => o.id !== main.id).length;
          await send.buttons(phone, T.sameDay(main, delivery, more), [B.merge(draftId), B.split(draftId)]);
          return { did: "same_day_ask", draft: draftId, existing: main.order_number };
        }
      }
    }
    if (m[1] === "split") {
      const r = await db.query(
        `UPDATE order_drafts SET note = 'awaiting_label' WHERE id = $1 AND phone = $2 AND status = 'shown' RETURNING id`, [draftId, phone]);
      if (!r.rowCount) { await send.text(phone, T.old); return { did: "stale", draft: draftId }; }
      await send.text(phone, T.askLabel);
      return { did: "label_ask", draft: draftId };
    }
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
    return placeOrder(db, { phone, draftId, contactName, now, send });
  }

  // ✏️ Order badlein (on the confirmation), 🗑️ cancel, keep.
  const ch = /^order:(change|cancel):(\d+)$/.exec(id);
  if (ch) {
    const { editable, locked } = await orders.upcomingOrdersFor(db, phone, now);
    const o = editable.find((x) => x.id === Number(ch[2]));
    if (!o) {
      const l = locked.find((x) => x.id === Number(ch[2]));
      if (l) { await send.text(phone, T.locked(l, bill.deliveryPhrase(l.delivery_date), cutoffDayOf(l.delivery_date))); return { did: "locked", orderId: l.id }; }
      await send.text(phone, T.old); return { did: "stale" };
    }
    if (ch[1] === "cancel") {
      const r = await db.query(
        `UPDATE orders o SET status = 'cancelled' FROM cycles cy
          WHERE o.id = $1 AND cy.id = o.cycle_id AND o.status IN ('pending','confirmed') AND cy.status IN ('open','draft') RETURNING o.id`, [o.id]);
      if (!r.rowCount) { await send.text(phone, T.locked(o, bill.deliveryPhrase(o.delivery_date), cutoffDayOf(o.delivery_date))); return { did: "locked" }; }
      await db.query(`INSERT INTO order_drafts (phone, source, lines, status, order_id, note, decided_at)
                      VALUES ($1, 'typed', '[]', 'confirmed', $2, $3, now())`,
        [phone, o.id, changeNote({ order: o.id, number: o.order_number, before: await orderLines(db, o.id), cancelled: true })]);
      await send.text(phone, T.cancelled(o.order_number));
      return { did: "order_cancelled", orderId: o.id, orderNumber: o.order_number };
    }
    return startChange(db, { phone, o, send });
  }
  if (id === B.cancelNo.id) { await send.text(phone, T.kept); return { did: "kept" }; }
  if (id === "order:changemenu") {
    const { editable } = await orders.upcomingOrdersFor(db, phone, now);
    if (!editable.length) return startMenu(db, { phone, send, now });
    await send.list(phone, T.whichOrder, "Order chunein", editable.slice(0, 10).map((o) => ({
      id: `order:changewhich:${o.id}`, title: o.bill_label ? String(o.bill_label).slice(0, 24) : "Mera order",
      description: `${o.order_number} — ${bill.money(o.total)}` })), "Orders");
    return { did: "which_order", orders: editable.length };
  }
  // the order to change, when the number has several bills
  const cw = /^order:changewhich:(\d+)$/.exec(id);
  if (cw) {
    const { editable } = await orders.upcomingOrdersFor(db, phone, now);
    const o = editable.find((x) => x.id === Number(cw[1]));
    if (!o) { await send.text(phone, T.old); return { did: "stale" }; }
    return startChange(db, { phone, o, send });
  }

  // 🧾 Poora bill: the itemised bill for one of HER orders.
  const fb = /^order:bill:(\d+)$/.exec(id);
  if (fb) {
    const own = (await db.query(
      `SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = $1 AND c.phone = $2`, [Number(fb[1]), phone])).rows[0];
    if (!own) return null;
    const forBill = await orders.loadOrderForBill(db, own.id);
    await send.text(phone, bill.orderConfirmation(forBill).rich);
    return { did: "full_bill", orderId: own.id, orderNumber: forBill.order_number };
  }

  // "Kaunsa?" - a tap on one of the kinds, or her typed answer.
  const pk = /^order:pick:(\d+):(.+)$/.exec(id);
  if (pk) {
    const d = await choosingDraft(db, phone, Number(pk[1]));
    if (!d) { await send.text(phone, T.old); return { did: "stale" }; }
    return pickKind(db, { phone, d, sku: pk[2], send, now });
  }
  if (msg?.type === "text") {
    const d = await choosingDraft(db, phone);
    if (d && d.queue.length) {
      const sku = matchKind(msg.text?.body, d.queue[0].options);
      if (sku) return pickKind(db, { phone, d, sku, send, now });
      // a short reply we could not match: ask again; a longer message goes on as usual
      if (String(msg.text?.body || "").trim().split(/\s+/).length <= 3) return askNext(db, { phone, id: d.id, choose: d.queue, send });
    }
  }

  // 🧾 Alag bill: the name she types for the separate bill.
  if (msg?.type === "text") {
    const waiting = await awaitingLabel(db, phone);
    if (waiting) {
      const label = String(msg.text?.body || "").replace(/\s+/g, " ").trim();
      if (!label || label.length > 40) { await send.text(phone, T.badLabel); return { did: "bad_label", draft: waiting.id }; }
      return placeOrder(db, { phone, draftId: waiting.id, contactName, now, send, billLabel: label });
    }
  }

  if (id === B.repeat.id || /^order:repeatof:\d+$/.test(id)) {
    // the clock decides (founder, 20 Nov): an order still open -> change it; past its cut-off -> no repeat
    const up = await orders.upcomingOrdersFor(db, phone, now);
    if (up.editable.length || up.locked.length) return startMenu(db, { phone, send, now, up });
    const bills = await pastBills(db, phone);
    if (!bills.length) {
      await send.text(phone, T.noLast);
      return sendList(db, { phone, send, catalogId });
    }
    let pick = bills[0];
    const of = /^order:repeatof:(\d+)$/.exec(id);
    if (of) pick = bills.find((b) => b.id === Number(of[1])) || null;
    else if (bills.length > 1) {
      await send.buttons(phone, T.whoseLast, bills.slice(0, 3).map((b) => ({
        id: `order:repeatof:${b.id}`, title: (b.bill_label ? String(b.bill_label) : "Mera").slice(0, 20) })));
      return { did: "whose_last", bills: bills.length };
    }
    if (!pick) { await send.text(phone, T.old); return { did: "stale" }; }
    const lines = await orderLines(db, pick.id);
    if (!lines.length) { await send.text(phone, T.noLast); return sendList(db, { phone, send, catalogId }); }
    return showDraft(db, { phone, source: "repeat", lines, send, now, repeatLabel: pick.bill_label || null, repeatHead: true });
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
    if (/pichl[ae]|pehl[ae]\s*wala|same|wahi|dobara/i.test(typedText || "")) console.log(`[order-bot] +${phone}: asked for the last order by text`);
    return startMenu(db, { phone, send, now });
  }

  // A typed order ("2kg aloo, aadha kilo adrak") -> the AI reader -> the same confirmation.
  // She tapped ✏️ Badlein and now types only the change ("tamatar 2 kg kar dein, kele hata dein").
  if (typedText && ai.configured(env)) {
    // Also: an order is on her screen waiting for Theek hai, and she types more items
    // ("2 pao lehson" after "lehsan samajh nahi aaya") - that ADDS to it, never replaces it.
    const editing = (await editingDraft(db, phone)) ||
      (typed.looksLikeOrder(typedText) ? await pendingDraft(db, phone) : null);
    if (editing) {
      let r;
      try {
        r = await typed.read(typedText, await forSale(db), { env, fetchImpl, current: editing.lines });
      } catch (e) {
        await send.text(phone, T.aiBusy);   // never leave her waiting; the team sees the message
        return { did: "ai_failed", error: e.code || e.message };
      }
      if (r.why && r.why.length) console.log(`[order-bot] edit: ${r.lines.length} lines, unclear because: ${r.why.join("; ")}`);
      await recordMissing(db, phone, r.unknown, typedText, "edit");
      const notes = await notesFor(db, r);
      if (r.choose?.length) return askChoices(db, { phone, source: editing.source, lines: r.lines, choose: r.choose, notes, send, changeOf: editing.changeOf, repeatLabel: editing.repeatLabel });
      if (!r.lines.length) {
        if (notes.length) { await send.text(phone, T.editNotUnderstood); return { did: "edit_not_understood" }; }
        if (editing.changeOf) {
          await send.buttons(phone, T.cancelAsk(editing.changeOf.number), [B.cancelYes(editing.changeOf.order), B.cancelNo]);
          return { did: "cancel_ask", orderId: editing.changeOf.order };
        }
        await send.text(phone, T.emptied);
        return { did: "emptied", draft: editing.id };
      }
      if (editing.pending && sameLines(r.lines, editing.lines) && !notes.length) return null;   // nothing changed: leave it
      return showDraft(db, { phone, source: editing.source, lines: r.lines, send, now, notes, changeOf: editing.changeOf, repeatLabel: editing.repeatLabel });
    }
  }

  // "tamatar hata dein" / "aloo 2 kg kar dein" with no order on screen: it is about her CONFIRMED order.
  if (typedText && ai.configured(env) && CHANGE_WORDS.test(typedText)) {
    const { editable, locked } = await orders.upcomingOrdersFor(db, phone, now);
    if (editable.length > 1) {
      await send.list(phone, T.whichOrder, "Order chunein", editable.slice(0, 10).map((o) => ({
        id: `order:changewhich:${o.id}`, title: o.bill_label ? String(o.bill_label).slice(0, 24) : "Mera order",
        description: `${o.order_number} — ${bill.money(o.total)}` })), "Orders");
      return { did: "which_order", orders: editable.length };
    }
    if (editable.length === 1) {
      const o = editable[0];
      const before = await orderLines(db, o.id);
      let r;
      try {
        r = await typed.read(typedText, await forSale(db), { env, fetchImpl, current: before });
      } catch (e) {
        await send.text(phone, T.aiBusy);
        return { did: "ai_failed", error: e.code || e.message };
      }
      const changeOf = { order: o.id, number: o.order_number, before };
      await recordMissing(db, phone, r.unknown, typedText, "edit");
      const notes = await notesFor(db, r);
      if (r.choose?.length) return askChoices(db, { phone, source: "typed", lines: r.lines, choose: r.choose, notes, send, changeOf });
      if (!r.lines.length) {
        if (notes.length) { await send.text(phone, T.editNotUnderstood); return { did: "edit_not_understood" }; }
        await send.buttons(phone, T.cancelAsk(o.order_number), [B.cancelYes(o.id), B.cancelNo]);
        return { did: "cancel_ask", orderId: o.id };
      }
      if (sameLines(r.lines, before) && !notes.length) return null;
      return showDraft(db, { phone, source: "typed", lines: r.lines, send, now, notes, changeOf });
    }
    if (locked.length) {
      const l = locked[0];
      await send.text(phone, T.locked(l, bill.deliveryPhrase(l.delivery_date), cutoffDayOf(l.delivery_date)));
      return { did: "locked", orderId: l.id };   // the team sees her message too
    }
  }

  if (typedText && ai.configured(env)) {
    const justAsked = await askedToWrite(db, phone);
    if (!justAsked && !typed.looksLikeOrder(typedText)) return null;
    let r;
    try {
      r = await typed.read(typedText, await forSale(db), { env, fetchImpl });
    } catch (e) {
      // she asked to type her order: tell her it arrived; the team sees the message as before
      if (justAsked) await send.text(phone, T.aiBusy);
      return { did: "ai_failed", error: e.code || e.message };
    }
    if (r.why && r.why.length) console.log(`[order-bot] typed: ${r.lines.length} read, unclear because: ${r.why.join("; ")}`);
    await recordMissing(db, phone, r.unknown, typedText, "typed");
    if (r.choose?.length) return askChoices(db, { phone, source: "typed", lines: r.lines, choose: r.choose, notes: await notesFor(db, r), send });
    if (!r.lines.length) {
      if (r.unknown.length && (justAsked || !r.unclear.length)) {
        await send.text(phone, T.onlyUnknown(r.unknown));
        return { did: "only_unknown", unknown: r.unknown.length };
      }
      if (justAsked) { await send.text(phone, T.notUnderstood); return { did: "not_understood" }; }
      return null;
    }
    const notes = await notesFor(db, r);
    // her earlier order is already past its cut-off: say this one is for the next delivery
    const { editable, locked } = await orders.upcomingOrdersFor(db, phone, now);
    if (!editable.length && locked.length) {
      notes.unshift(T.lockedNew(bill.deliveryPhrase(locked[0].delivery_date), cutoffDayOf(locked[0].delivery_date)));
    }
    return showDraft(db, { phone, source: "typed", lines: r.lines, send, now, notes });
  }
  return null;
}

// Words that mean "change my order" rather than a new list.
const CHANGE_WORDS = /\b(hata|hatain|hatayen|hata\s*d[eo]i?n?|nikal|nikaal|kam\s*kar|kam\s*kr|cancel|nahi\s*chahiye|nai\s*chahiye|na\s*bhej|mat\s*bhej|remove|badal|badl|change|kar\s*d[eo]i?n?|kardo|kardein|kr\s*d[eo])\b/i;

/** The lines of a saved order, as packs - what a change starts from. */
async function orderLines(db, orderId) {
  return (await db.query(
    `SELECT p.sku, oi.qty_ordered::float AS packs FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1 ORDER BY oi.id`, [orderId])).rows.map((r) => ({ sku: r.sku, packs: Number(r.packs) }));
}

/** ✏️ Order badlein: her order becomes a draft she changes by typing just the change. */
async function startChange(db, { phone, o, send }) {
  const before = await orderLines(db, o.id);
  const id = await newDraft(db, phone, "typed", before, changeNote({ order: o.id, number: o.order_number, before }));
  await db.query(`UPDATE order_drafts SET status = 'changed', decided_at = now() WHERE id = $1`, [id]);
  await send.text(phone, T.changeAsk(o, bill.deliveryPhrase(o.delivery_date)));
  return { did: "change_ask", orderId: o.id, draft: id };
}

/** Theek hai on a changed order: its items become the draft's, if still before the cut-off. */
async function applyChange(db, { phone, draftId, now, send }) {
  let res;
  try {
    res = await db.tx(async (client) => {
      const d = (await client.query(`SELECT * FROM order_drafts WHERE id = $1 AND phone = $2 FOR UPDATE`, [draftId, phone])).rows[0];
      if (!d || d.status !== "shown") return { stale: true, status: d?.status };
      const c = changeOfNote(d.note);
      const lines = typeof d.lines === "string" ? JSON.parse(d.lines) : d.lines;
      const r = await orders.replaceOrderItems(client, { orderId: c.order, lines, bookingCode: schedule.deliveryFor(now).code });
      await client.query(`UPDATE order_drafts SET status = 'confirmed', order_id = $2, decided_at = now() WHERE id = $1`, [draftId, r.orderId]);
      return { orderId: r.orderId };
    });
  } catch (e) {
    if (e.locked) {
      const d = (await db.query(`SELECT note FROM order_drafts WHERE id = $1`, [draftId])).rows[0];
      const c = changeOfNote(d?.note);
      await db.query(`UPDATE order_drafts SET status = 'failed', decided_at = now() WHERE id = $1`, [draftId]);
      const { locked } = await orders.upcomingOrdersFor(db, phone, now);
      const l = locked.find((x) => x.id === c?.order) || { order_number: c?.number, delivery_date: now };
      await send.text(phone, T.locked(l, bill.deliveryPhrase(l.delivery_date), cutoffDayOf(l.delivery_date)));
      return { did: "locked", orderId: c?.order };
    }
    await send.text(phone, T.failed(e.userFacing ? e.message : "system mein masla aa gaya."));
    return { did: "failed", draft: draftId, error: e.message };
  }
  if (res.stale) { await send.text(phone, res.status === "confirmed" ? T.stale : T.old); return { did: "stale", draft: draftId }; }
  const forBill = await orders.loadOrderForBill(db, res.orderId);
  const text = T.short(forBill, forBill.bill_label, false, bill.deliveryPhrase(forBill.delivery_date))
    .replace(/^✅ Order mil gaya — \*[^*]+\*/, T.changed2(forBill.order_number));
  await send.buttons(phone, text, [B.fullBill(res.orderId), B.change(res.orderId)]);
  return { did: "order_changed", orderId: res.orderId, orderNumber: forBill.order_number };
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

/**
 * Who opens the full bill? Bot-confirmed orders in the last N days, by how
 * many orders that customer had placed by then (1st, 2nd, 3rd+), with how
 * many of those orders she tapped 🧾 Poora bill for. Read only.
 */
async function billTapReport(db, days = 30) {
  const { rows } = await db.query(
    `WITH conf AS (
       SELECT d.order_id, d.phone, min(d.decided_at) AS at
         FROM order_drafts d WHERE d.status = 'confirmed' AND d.order_id IS NOT NULL
          AND d.decided_at > now() - make_interval(days => $1)
        GROUP BY d.order_id, d.phone),
     nth AS (
       SELECT conf.*, (SELECT count(*) FROM orders o2 JOIN customers c2 ON c2.id = o2.customer_id
                        WHERE c2.phone = conf.phone AND o2.id <= conf.order_id AND o2.status <> 'cancelled') AS n
         FROM conf),
     taps AS (
       SELECT DISTINCT (regexp_match(payload #>> '{interactive,button_reply,id}', '^order:bill:([0-9]+)$'))[1]::bigint AS order_id
         FROM whatsapp_messages
        WHERE direction = 'inbound' AND payload #>> '{interactive,button_reply,id}' LIKE 'order:bill:%')
     SELECT CASE WHEN n <= 1 THEN '1st order' WHEN n = 2 THEN '2nd order' ELSE '3rd+ order' END AS which,
            count(*)::int AS confirmed, count(t.order_id)::int AS opened_full_bill
       FROM nth LEFT JOIN taps t ON t.order_id = nth.order_id
      GROUP BY 1 ORDER BY 1`, [days]);
  return rows;
}

/**
 * ⏰ A reminder before the cut-off - ONLY for customers who keep changing their
 * orders (founder, 20 Nov): 3 or more changes in the last 30 days. Sent on the
 * cut-off day between 6 and 9 pm, once per order, and only inside WhatsApp's
 * 24-hour window (outside it Meta needs an approved template; those are logged
 * and skipped). Switch: ORDER_REMINDERS=off to stop it.
 */
async function remindFrequentChangers(db, { send, now = new Date(), env = process.env, minChanges = 3 }) {
  if (!on(env) || String(env.ORDER_REMINDERS || "on").toLowerCase() === "off" || !(await ready(db))) return { sent: 0 };
  const slot = schedule.deliveryFor(now);
  const hoursLeft = (new Date(slot.locksAt).getTime() - now.getTime()) / 3600e3;
  if (!(hoursLeft > 0 && hoursLeft <= 3)) return { sent: 0 };
  const { rows } = await db.query(
    `WITH changers AS (
       SELECT phone FROM order_drafts
        WHERE status = 'confirmed' AND note LIKE 'change:%' AND decided_at > now() - interval '30 days'
        GROUP BY phone HAVING count(*) >= $2)
     SELECT o.id, o.order_number, c.phone, cy.delivery_date,
            (SELECT max(received_at) FROM whatsapp_messages w WHERE w.phone = c.phone AND w.direction = 'inbound') AS last_in
       FROM orders o JOIN customers c ON c.id = o.customer_id JOIN cycles cy ON cy.id = o.cycle_id
      WHERE cy.code = $1 AND o.status IN ('pending','confirmed') AND c.phone IN (SELECT phone FROM changers)
        AND NOT EXISTS (SELECT 1 FROM whatsapp_messages w WHERE w.phone = c.phone AND w.direction = 'outbound'
                          AND w.agent = 'order bot' AND w.body_preview LIKE '⏰ Yaad dahani: aap ka order *' || o.order_number || '*%')`,
    [slot.code, minChanges]);
  let sent = 0;
  for (const o of rows) {
    if (!o.last_in || now.getTime() - new Date(o.last_in).getTime() > 23.5 * 3600e3) {
      console.log(`[order-bot] reminder skipped for ${o.order_number}: outside the 24h window (needs a template)`);
      continue;
    }
    await send.text(o.phone, T.remind(o, bill.deliveryPhrase(o.delivery_date), cutoffDayOf(o.delivery_date)));
    sent++;
  }
  return { sent, candidates: rows.length };
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

/** Confirm a draft into an order and send the confirmation (with a note when it joined an earlier order). */
async function placeOrder(db, { phone, draftId, contactName, now, send, billLabel = null }) {
  try {
    const r = await confirm(db, { phone, draftId, name: contactName, now, billLabel });
    if (r.stale) { await send.text(phone, r.status === "confirmed" ? T.stale : T.old); return { did: "stale", draft: draftId }; }
    const forBill = await orders.loadOrderForBill(db, r.orderId);
    forBill.ordered_at = now;
    // Short: number, delivery, the most she pays and what she saves. The full
    // itemised bill is one tap away (founder, 20 Nov) - and every tap is kept
    // (the button press is saved with the message) to see who stops checking.
    await send.buttons(phone, T.short(forBill, forBill.bill_label, r.merged, bill.deliveryPhrase(forBill.delivery_date)),
      [B.fullBill(r.orderId), B.change(r.orderId)]);
    return { did: "ordered", draft: draftId, orderId: r.orderId, orderNumber: forBill.order_number,
             merged: Boolean(r.merged), billLabel: forBill.bill_label || null };
  } catch (e) {
    await db.query(`UPDATE order_drafts SET status = 'failed', note = $2, decided_at = now() WHERE id = $1`, [draftId, String(e.message).slice(0, 300)]);
    await send.text(phone, T.failed(e.userFacing ? e.message : "system mein masla aa gaya."));
    return { did: "failed", draft: draftId, error: e.message };
  }
}

/** A draft waiting for its separate-bill name: the bot's last message (last hour) asked for it. */
async function awaitingLabel(db, phone) {
  const last = (await db.query(
    `SELECT body_preview FROM whatsapp_messages
      WHERE phone = $1 AND direction = 'outbound' AND agent = 'order bot'
        AND COALESCE(sent_at, received_at) > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  const body = String(last?.body_preview || "");
  if (!body.startsWith("Theek hai! Ye alag bill") && !body.startsWith("Naam thora chhota")) return null;
  return (await db.query(
    `SELECT id FROM order_drafts WHERE phone = $1 AND status = 'shown' AND note = 'awaiting_label'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0] || null;
}

// ---------------------------------------------------------------------------
// "Kaunsa lehsan?" - items that come in several kinds are asked, never guessed
// (founder, 20 Nov). The understood items wait in a draft; the questions wait
// in its note, one at a time; when the last is answered she sees the order.
// ---------------------------------------------------------------------------
async function askChoices(db, { phone, source, lines, choose, notes = [], send, changeOf = null, repeatLabel = null }) {
  const id = await newDraft(db, phone, source, lines);
  await db.query(`UPDATE order_drafts SET note = $2 WHERE id = $1`, [id, "choose:" + JSON.stringify({ queue: choose, notes, changeOf, repeatLabel })]);
  return askNext(db, { phone, id, choose, send });
}

async function askNext(db, { phone, id, choose, send }) {
  const c = choose[0];
  const products = await forSale(db);
  const by = new Map(products.map((p) => [p.sku, p]));
  const rows = c.options.map((o) => {
    const p = by.get(o.sku);
    const amt = p ? bill.money(p.asb_price * o.packs) : "";
    // WhatsApp list titles hold 24 characters: "Desi Garlic (Desi Lehsan)" -> "Desi Lehsan"
    const nm = String(o.name);
    const inner = /\(([^)]+)\)/.exec(nm)?.[1];
    const title = nm.length <= 24 ? nm : (inner && inner.length <= 24 ? inner : nm.slice(0, 24));
    return { id: `order:pick:${id}:${o.sku}`, title,
             description: `${p ? spoken(o.packs, p.unit, p.min_qty) : ""}${amt ? " — " + amt : ""}`.slice(0, 72) };
  });
  await send.list(phone, T.whichKind(c.said), T.whichKindBtn, rows, "Qisam");
  return { did: "which_kind", draft: id, item: c.said, options: rows.length };
}

/** The draft waiting for a "which kind" answer, with its queue. */
async function choosingDraft(db, phone, draftId = null) {
  const d = (await db.query(
    `SELECT id, source, lines, note FROM order_drafts
      WHERE phone = $1 AND status = 'shown' AND note LIKE 'choose:%' ${draftId ? "AND id = $2" : ""}
        AND created_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, draftId ? [phone, draftId] : [phone])).rows[0];
  if (!d) return null;
  const st = JSON.parse(d.note.slice("choose:".length));
  const lines = typeof d.lines === "string" ? JSON.parse(d.lines) : d.lines;
  return { id: d.id, source: d.source, lines: lines || [], queue: st.queue || [], notes: st.notes || [], changeOf: st.changeOf || null, repeatLabel: st.repeatLabel || null };
}

/** She picked a kind (tap, or typed its name): add it, then the next question or the order. */
async function pickKind(db, { phone, d, sku, send, now }) {
  const c = d.queue[0];
  const opt = c.options.find((o) => o.sku === sku);
  if (!opt) return askNext(db, { phone, id: d.id, choose: d.queue, send });
  const lines = d.lines.map((l) => ({ ...l }));
  const have = lines.find((l) => l.sku === sku);
  if (have) have.packs = Math.round((Number(have.packs) + opt.packs) * 1e6) / 1e6; else lines.push({ sku, packs: opt.packs });
  const queue = d.queue.slice(1);
  if (queue.length) {
    await db.query(`UPDATE order_drafts SET lines = $2, note = $3 WHERE id = $1`,
      [d.id, JSON.stringify(lines), "choose:" + JSON.stringify({ queue, notes: d.notes, changeOf: d.changeOf, repeatLabel: d.repeatLabel })]);
    return askNext(db, { phone, id: d.id, choose: queue, send });
  }
  await db.query(`UPDATE order_drafts SET status = 'expired', note = NULL, decided_at = now() WHERE id = $1`, [d.id]);
  if (!lines.length) { await send.text(phone, T.notUnderstood); return { did: "not_understood" }; }
  return showDraft(db, { phone, source: d.source, lines, send, now, notes: d.notes, changeOf: d.changeOf, repeatLabel: d.repeatLabel });
}

/** Her typed answer to "kaunsa?" - matched to one option by its name, or null. */
function matchKind(text, options) {
  const t = " " + String(text || "").toLowerCase().replace(/[^a-z\u0600-\u06ff]+/g, " ") + " ";
  const words = (s) => String(s).toLowerCase().replace(/[^a-z\u0600-\u06ff]+/g, " ").split(" ").filter((w) => w.length >= 3);
  const all = options.map((o) => words(o.name));
  const shared = (w) => all.every((ws) => ws.includes(w));
  const hits = options.filter((o, i) => all[i].some((w) => !shared(w) && t.includes(" " + w + " ")));
  return hits.length === 1 ? hits[0].sku : null;
}

/** The draft she is changing: the bot's last message (last hour) asked for the change, and that draft is 'changed'. */
async function editingDraft(db, phone) {
  const last = (await db.query(
    `SELECT body_preview FROM whatsapp_messages
      WHERE phone = $1 AND direction = 'outbound' AND agent = 'order bot'
        AND COALESCE(sent_at, received_at) > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  const body = String(last?.body_preview || "");
  if (!body.startsWith("Koi baat nahi! Poora order") && !body.startsWith("Maazrat, ye tabdeeli") &&
      !/^✏️ Order \*[^*]+\* \(/.test(body)) return null;
  const d = (await db.query(
    `SELECT id, source, lines, note FROM order_drafts
      WHERE phone = $1 AND status = 'changed' AND decided_at > now() - interval '1 hour'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  if (!d) return null;
  const lines = typeof d.lines === "string" ? JSON.parse(d.lines) : d.lines;
  return lines?.length ? { id: d.id, source: d.source, lines, changeOf: changeOfNote(d.note), repeatLabel: repeatLabelOf(d.note) } : null;
}

/**
 * The order on her screen right now, still waiting for Theek hai: her newest
 * draft is 'shown' (not waiting for a bill name), under an hour old, and the
 * bot has said nothing since showing it.
 */
async function pendingDraft(db, phone) {
  const d = (await db.query(
    `SELECT id, source, lines, status, note, created_at FROM order_drafts
      WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  const ch = changeOfNote(d?.note);
  if (!d || d.status !== "shown" || (d.note && !/^(change|repeat):/.test(String(d.note))) ||
      new Date(d.created_at) < new Date(Date.now() - 3600e3)) return null;
  const later = (await db.query(
    `SELECT 1 FROM whatsapp_messages
      WHERE phone = $1 AND direction = 'outbound' AND agent = 'order bot'
        AND COALESCE(sent_at, received_at) > $2::timestamptz + interval '60 seconds' LIMIT 1`, [phone, d.created_at])).rowCount;
  if (later) return null;
  const lines = typeof d.lines === "string" ? JSON.parse(d.lines) : d.lines;
  return lines?.length ? { id: d.id, source: d.source, lines, pending: true, changeOf: ch, repeatLabel: repeatLabelOf(d?.note) } : null;
}

function sameLines(a, b) {
  const key = (xs) => xs.map((l) => `${l.sku}:${Math.round(Number(l.packs) * 1e4)}`).sort().join("|");
  return key(a || []) === key(b || []);
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
  remindFrequentChangers, billTapReport, matchKind, missingReport, spoken, on, isAsk, T, B, ready, forSale, listSections, draftText, pastBills, cartLines, confirm, onInbound };
