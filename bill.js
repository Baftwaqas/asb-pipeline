// ============================================================================
// ASB PIPELINE — bill.js
//
// Turns order rows into the two WhatsApp messages a customer actually reads:
//
//   1. orderConfirmation()  sent at checkout. Quotes the ZYADA SE ZYADA total
//                           - the most the customer can ever be asked to pay.
//   2. finalBill()          sent after the mandi run and the weigh station.
//                           Shows the ASAL (real) bill and the BACHAT.
//
// LANGUAGE
// Product names come out of the database in Urdu script, which is what the
// customer recognises on a shelf. Everything around them is Roman Urdu,
// because that is how Karachi actually types on WhatsApp. No English concept
// words: "ceiling" became "zyada se zyada", "final bill" became "asal bill",
// "savings" became "bachat". A customer should never need a translation to
// understand what she owes.
//
// TWO SHAPES, ONE BILL
// WhatsApp template parameters reject newlines, tabs and runs of spaces, so a
// multi-line itemised list cannot be passed as a template variable. Every
// renderer here therefore produces BOTH:
//
//   .rich  full layout, line breaks and bold. Legal in a free-form message,
//          i.e. inside the 24-hour customer service window.
//   .flat  same content, single line, bullet separated. Legal as a template
//          parameter, so it works when the window is shut.
//
// The wording is identical in both. The customer gets the same promise either
// way; only the typography changes.
//
// This module is PURE. It touches no database and no network, which is what
// makes it testable without a Meta permission or a live order.
// ============================================================================

"use strict";

// ---------------------------------------------------------------------------
// Vocabulary
//
// The unit column is an enum written by engineers. These are the words a
// Karachi household uses out loud. 'dozen' is read as darjan, a bunch of
// coriander is a gaddi, a single papaya is one adad.
// ---------------------------------------------------------------------------
const UNIT_WORD = {
  kg: "kg",
  g: "g",
  pao: "pao",
  pcs: "adad",
  bundle: "gaddi",
  dozen: "darjan",
  packet: "packet",
};

// Weights people say rather than weights people calculate. 500 g is never
// "500 g" in a Karachi kitchen; it is aadha kg.
const SPOKEN_GRAMS = {
  250: "pao",
  500: "aadha kg",
  750: "pauna kg",
};

/**
 * "1 kg" · "aadha kg" · "1 darjan" · "2 gaddi"
 *
 * PACK SIZE MATTERS, and getting this wrong put "1 g" of spinach on a test
 * bill. Shopify sells a PACK: spinach is a 500 g bag, so an order for one bag
 * arrives as quantity 1 while the product's unit is 'g'. Rendering the raw
 * quantity reads as one gram.
 *
 * So the phrase is built from the TOTAL: packs x pack size. One bag of spinach
 * is "aadha kg"; two bags are "1 kg"; two 1 kg mangoes are "2 kg". The rate
 * beside it stays per pack, which keeps the arithmetic on the line honest -
 * "1 kg x Rs 50 = Rs 100" is exactly what two half-kilo bags cost.
 *
 * packSize comes from products.min_qty. When it is missing the quantity is
 * used as-is, which is the old behaviour and correct for anything sold singly.
 */
function qtyPhrase(qty, unit, packSize) {
  const packs = Number(qty);
  const size = Number(packSize) > 0 ? Number(packSize) : 1;
  const total = packs * size;
  const word = UNIT_WORD[unit] || unit;

  if (unit === "g") {
    const spoken = SPOKEN_GRAMS[total];
    if (spoken) return spoken;
    // Past a kilo, people say kilos.
    if (total >= 1000) return `${trimNum(total / 1000)} kg`;
    return `${trimNum(total)} g`;
  }
  return `${trimNum(total)} ${word}`;
}

function trimNum(n) {
  const r = Math.round(Number(n) * 1000) / 1000;
  return String(r);
}

/**
 * Rs 1,240 — three-digit grouping, no paisa.
 *
 * Deliberately not toLocaleString('en-PK'): some ICU builds group Pakistani
 * style (1,23,456) and some do not, so the same bill would look different
 * depending on which machine rendered it. A bill must not change shape.
 */
function money(n) {
  const v = Math.round(Number(n) || 0);
  return "Rs " + String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}


/**
 * The rate as a customer reads it on a paper bill.
 *
 * Weight goods are quoted PER KG, whatever the pack size. Without this the
 * line "1 kg x Rs 50 = Rs 100" appears for two 500 g bags of spinach - the
 * rate is per bag but sits next to the total weight, and the multiplication
 * on the customer's own line does not add up. Per kg it reads
 * "1 kg x Rs 100/kg = Rs 100", which does.
 *
 * Everything sold by count (gaddi, darjan, adad, packet) keeps its per-unit
 * rate, because there the pack IS the unit.
 */
function ratePhrase(ratePerPack, unit, packSize) {
  const r = Number(ratePerPack);
  const size = Number(packSize) > 0 ? Number(packSize) : 1;
  if (unit === "g") return `${money((r / size) * 1000)}/kg`;
  if (unit === "kg") return `${money(r / size)}/kg`;
  return money(r);
}


// Day and month names exactly as Waqas writes them to customers:
// "Monday, 5 October". Everyone reads these; no translation needed.
const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January","February","March","April","May","June","July",
               "August","September","October","November","December"];
const PKT_OFFSET_MS = 5 * 60 * 60 * 1000; // Pakistan: UTC+5 all year, no DST

/** "Monday, 5 October" from a DATE value ('2026-10-05' or a Date). */
function deliveryPhrase(d) {
  if (!d) return null;
  const iso = d instanceof Date
    ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`
    : String(d).slice(0, 10);
  const [y, m, day] = iso.split("-").map(Number);
  if (!y || !m || !day) return null;
  // A calendar date has no time zone; read it at UTC noon so no offset can
  // tip it into the neighbouring day.
  const dow = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay();
  return `${DAY[dow]}, ${day} ${MONTH[m - 1]}`;
}

/**
 * "Saturday, 3 October, 9:00 PM" - when the customer placed the order, in
 * Karachi time whatever time zone the server runs in. This is the moment that
 * decides her delivery day, so it is printed right above it: she can see for
 * herself why a Sunday 8:15pm order arrives on Thursday, not Monday.
 */
function orderedPhrase(ts) {
  if (!ts) return null;
  const t = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(t.getTime())) return null;
  const k = new Date(t.getTime() + PKT_OFFSET_MS);
  const h24 = k.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(k.getUTCMinutes()).padStart(2, "0");
  return `${DAY[k.getUTCDay()]}, ${k.getUTCDate()} ${MONTH[k.getUTCMonth()]}, ` +
         `${h12}:${mm} ${h24 < 12 ? "AM" : "PM"}`;
}

/** Name the customer recognises: Urdu if we have it, English otherwise. */
function productLabel(line) {
  return (line.name_ur && line.name_ur.trim()) || line.name_en || line.sku;
}

// ---------------------------------------------------------------------------
// MESSAGE 1 — order confirmation
//
// Sent the moment Shopify accepts the order. Its whole job is to state the
// ceiling promise in a way that cannot be misread: this number is the worst
// case, and the real bill can only come in lower.
// ---------------------------------------------------------------------------
function orderConfirmation(order) {
  const name = firstName(order.customer_name);
  const delivery = deliveryPhrase(order.delivery_date);
  const ordered = orderedPhrase(order.ordered_at || order.placed_at);

  const lines = (order.lines || []).map((l) => {
    const qty = qtyPhrase(l.qty_ordered, l.unit, l.pack_size);
    const rate = ratePhrase(l.ceiling_unit_price, l.unit, l.pack_size);
    const total = money(Number(l.qty_ordered) * Number(l.ceiling_unit_price));
    // The bazaar rate only prints when we actually have one AND it is higher.
    // A missing rate prints nothing rather than implying parity.
    const mkt = Number(l.market_unit_price || 0);
    const bazaar = mkt > Number(l.ceiling_unit_price)
      ? ratePhrase(mkt, l.unit, l.pack_size)
      : null;
    return { label: productLabel(l), qty, rate, total, bazaar };
  });

  const ceiling = Number(order.ceiling_total || 0);
  const market = Number(order.market_total || 0);
  const communitySaved = Math.max(0, Math.round(market - ceiling));

  const body = lines.map((l) =>
    l.bazaar
      ? `${l.label} · ${l.qty} × ${l.rate} = ${l.total} (Avg bazaar rate ${l.bazaar})`
      : `${l.label} · ${l.qty} × ${l.rate} = ${l.total}`
  );
  const bodyFlat = lines.map((l) =>
    l.bazaar
      ? `${l.label} ${l.qty} × ${l.rate} = ${l.total} (Avg bazaar rate ${l.bazaar})`
      : `${l.label} ${l.qty} × ${l.rate} = ${l.total}`
  );

  // The community saving is stated HERE, at checkout, because that is when it
  // becomes certain. It does not depend on the mandi run, on a target being
  // met, or on anything that can still go wrong.
  const savingBlock = communitySaved > 0
    ? [
        `Avg bazaar rate par yehi saman: ${money(market)}`,
        `Zyada se zyada aap denge: *${money(ceiling)}*`,
        `Abhi se bachat: *${money(communitySaved)}* ✅`,
      ]
    : [`Zyada se zyada: *${money(ceiling)}*`];

  const rich = [
    `Assalam-o-Alaikum ${name} 🌿`,
    `Aap ka order mil gaya — *${order.order_number}*`,
    ...(ordered ? [`Order diya: ${ordered}`] : []),
    ...(delivery ? [`Delivery: *${delivery}*`] : []),
    ``,
    ...body,
    ``,
    ...savingBlock,
    ``,
    `Is se zyada aap kabhi nahi denge — ye hamara wada hai.`,
    `Delivery ke din rate aur kam hua to aap aur kam denge.`,
    ``,
    `Apna Sasta Bazaar`,
  ].join("\n");

  return {
    rich,
    flat: bodyFlat.join(" • "),
    communitySaved,
    params: {
      customer_name: name,
      order_id: order.order_number,
      ordered: ordered || "-",
      delivery: delivery || "-",
      order_items: bodyFlat.join(" • "),
      bazaar_total: money(market),
      zyada_se_zyada: money(ceiling),
      abhi_se_bachat: money(communitySaved),
    },
  };
}

// ---------------------------------------------------------------------------
// MESSAGE 2 — the asal bill
//
// Sent after the mandi run and the weigh station. This is the message that
// proves the promise was kept, so it shows the ceiling next to the real price
// on any line where the two differ. A line that came in at the ceiling shows
// one number, not two - noise dilutes the lines that matter.
// ---------------------------------------------------------------------------
function finalBill(order) {
  const name = firstName(order.customer_name);

  const lines = (order.lines || []).map((l) => {
    const qty = Number(l.qty_packed ?? l.qty_ordered);
    const ceilingRate = Number(l.ceiling_unit_price);
    const billedRate = Number(l.billed_unit_price ?? l.ceiling_unit_price);
    const lineTotal = qty * billedRate;
    const cheaper = billedRate < ceilingRate;
    const reweighed =
      l.qty_packed != null && Number(l.qty_packed) !== Number(l.qty_ordered);

    return {
      label: productLabel(l),
      qty: qtyPhrase(qty, l.unit, l.pack_size),
      rate: ratePhrase(billedRate, l.unit, l.pack_size),
      wasRate: ratePhrase(ceilingRate, l.unit, l.pack_size),
      total: money(lineTotal),
      cheaper,
      reweighed,
    };
  });

  const billed = Number(order.billed_total ?? order.grand_total ?? 0);
  const ceiling = Number(order.ceiling_total ?? 0);
  const market = Number(order.market_total ?? 0);

  // Two savings, earned differently, and the difference matters.
  //
  //   community : bazaar - ASB rate. Certain from checkout. Survives a flat
  //               mandi, survives a missed community target. Never zero on a
  //               normal cycle.
  //   mandi     : ASB rate - what was actually billed. Often zero. A zero here
  //               is an ordinary outcome, NOT a failure, and the message must
  //               not read like one - which is the bug this replaces.
  const communitySaved = Math.max(0, Math.round(market - ceiling));
  const mandiSaved = Math.max(0, Math.round(ceiling - billed));
  const saved = communitySaved + mandiSaved;

  // The " · " after the name reads well stacked in the rich layout, but once
  // the lines are joined onto one line for a template it collides with the
  // " • " between items and the eye cannot tell which dot separates what.
  // So the flat form drops the inner dot.
  const body = lines.map((l) =>
    l.cheaper
      ? `${l.label} · ${l.qty} × ${l.rate} = ${l.total} (pehlay tha ${l.wasRate})`
      : `${l.label} · ${l.qty} × ${l.rate} = ${l.total}`
  );
  const bodyFlat = lines.map((l) =>
    l.cheaper
      ? `${l.label} ${l.qty} × ${l.rate} = ${l.total} (pehlay tha ${l.wasRate})`
      : `${l.label} ${l.qty} × ${l.rate} = ${l.total}`
  );

  // The ceiling is NOT repeated here, deliberately.
  //
  // It was already promised in the confirmation message. Restating it invites
  // a comparison the customer will lose: when an item is re-weighed lighter,
  // the recomputed ceiling drops too (1 kg mango promised at Rs 250 becomes
  // 0.95 kg at Rs 250 = Rs 237.50), so the printed "zyada se zyada" would be
  // LOWER than the number she was quoted at checkout. Arithmetically right,
  // and it reads as though the promise moved - the exact impression this
  // message exists to prevent. Two numbers, asal bill and bachat, say
  // everything and cannot be misread.
  const tail = [`Asal bill: *${money(billed)}*`];

  if (market > billed) tail.push(`Avg bazaar rate par yehi saman: ${money(market)}`);

  if (saved > 0) {
    tail.push(`Aap ki kul bachat: *${money(saved)}* 🎉`);
    // Only break the saving down when both halves exist. On a flat-mandi cycle
    // a two-line breakdown with a zero in it draws the eye straight to the zero.
    if (communitySaved > 0 && mandiSaved > 0) {
      tail.push(`  • Community rate se: ${money(communitySaved)}`);
      tail.push(`  • Mandi rate girne se: ${money(mandiSaved)}`);
    }
  }

  if (mandiSaved === 0 && communitySaved > 0) {
    tail.push(``);
    tail.push(`Is dafa mandi ka rate wohi raha, is liye ASB rate hi laga —`);
    tail.push(`lekin avg bazaar rate se aap ne phir bhi ${money(communitySaved)} kam diye.`);
  }

  const reweighedAny = lines.some((l) => l.reweighed);

  const rich = [
    `Assalam-o-Alaikum ${name} 🌿`,
    `Aap ka asal bill — *${order.order_number}*`,
    ``,
    ...body,
    ``,
    ...tail,
    ``,
    reweighedAny
      ? `Wazan tolne ke baad ka hisaab hai — jitna nikla, utna hi laga.`
      : `Jo wada kiya tha, wohi liya.`,
    ``,
    `Shukriya — Apna Sasta Bazaar`,
  ].join("\n");

  return {
    rich,
    flat: bodyFlat.join(" • "),
    saved,
    communitySaved,
    mandiSaved,
    params: {
      customer_name: name,
      order_id: order.order_number,
      bill_items: bodyFlat.join(" • "),
      asal_bill: money(billed),
      bazaar_total: money(market),
      zyada_se_zyada: money(ceiling),
      bachat: money(saved),
    },
  };
}

// ---------------------------------------------------------------------------
function firstName(full) {
  if (!full) return "Ji";
  return String(full).trim().split(/\s+/)[0];
}

/**
 * Guard for anything destined for a template parameter. Meta rejects newlines,
 * tabs and runs of spaces in variables, and the rejection arrives as a generic
 * error hours later. Cheaper to catch it here.
 */
function templateSafe(value) {
  const s = String(value == null ? "" : value);
  return {
    ok: !/[\n\t]/.test(s) && !/ {5,}/.test(s),
    value: s.replace(/[\n\t]+/g, " ").replace(/ {5,}/g, "    "),
  };
}

module.exports = {
  orderConfirmation,
  finalBill,
  templateSafe,
  // exported for tests
  qtyPhrase,
  ratePhrase,
  deliveryPhrase,
  orderedPhrase,
  money,
};
