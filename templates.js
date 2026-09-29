// ============================================================================
// ASB PIPELINE — templates.js
//
// The three WhatsApp templates ASB sends, defined ONCE. The same definitions
// are used to submit them to Meta (scripts/wa-templates.js) and to fill them
// in when sending (server.js, inbox.js). If the wording changes here, the
// template has to be re-submitted - a template is approved word for word.
//
//   asb_order_bill   UTILITY    the bill at checkout ("zyada se zyada")
//   asb_final_bill   UTILITY    the asal bill after the mandi run
//   asb_rate_list    MARKETING  the rate-list poster, with booking cut-off
//
// Why templates at all: WhatsApp lets a business send free text only to
// someone who wrote to it in the last 24 hours. A Shopify customer usually
// has not, and a rate-list broadcast goes to people who have not. Both need a
// template Meta has approved in advance.
//
// Meta's rules this file keeps to:
//   * a variable may not start or end the body, or sit next to another one
//   * variable VALUES may not contain newlines or tabs (bill.templateSafe)
//   * every variable needs an example when the template is submitted
// ============================================================================

"use strict";

const { templateSafe } = require("./bill");

// Roman Urdu is Urdu written in English letters; Meta files it under Urdu.
// The four templates AiSensy got approved on this account all use "ur".
const LANG = "ur";

// Long orders must not overflow the message. Meta caps a template message at
// 1024 characters of body; leave room for the fixed words around the list.
const ITEMS_MAX = 620;

const TEMPLATES = {
  orderBill: {
    name: "asb_order_bill",
    language: LANG,
    category: "UTILITY",
    body:
      "Assalam-o-Alaikum {{1}}, aap ka order mil gaya — *{{2}}*\n\n" +
      "Order diya: {{3}}\n" +
      "Delivery: *{{4}}*\n\n" +
      "Aap ka saman: {{5}}\n\n" +
      "Avg bazaar rate par yehi saman: {{6}}\n" +
      "Zyada se zyada aap denge: *{{7}}*\n" +
      "Abhi se bachat: *{{8}}*\n\n" +
      "Is se zyada aap kabhi nahi denge — ye hamara wada hai. " +
      "Delivery ke din rate aur kam hua to aap aur kam denge.",
    footer: "Apna Sasta Bazaar",
    example: [
      "Ayesha", "ASB-001001", "Sunday, 4 October, 8:15 PM", "Thursday, 8 October",
      "آلو 2 kg × Rs 50/kg = Rs 100 (Avg bazaar rate Rs 60/kg) • پودینہ 1 gaddi × Rs 22 = Rs 22",
      "Rs 150", "Rs 122", "Rs 28",
    ],
  },

  finalBill: {
    name: "asb_final_bill",
    language: LANG,
    category: "UTILITY",
    body:
      "Assalam-o-Alaikum {{1}}, aap ka asal bill — *{{2}}*\n\n" +
      "Saman: {{3}}\n\n" +
      "Asal bill: *{{4}}*\n" +
      "Avg bazaar rate par yehi saman: {{5}}\n" +
      "Aap ki kul bachat: *{{6}}*\n\n" +
      "{{7}} Hisaab mein koi sawal ho to isi number par likh dein. Shukriya!",
    footer: "Apna Sasta Bazaar",
    example: [
      "Ayesha", "ASB-001001",
      "چونسہ آم 1 kg × Rs 220/kg = Rs 220 (pehlay tha Rs 250/kg)",
      "Rs 220", "Rs 350", "Rs 130",
      "Jo wada kiya tha, wohi liya.",
    ],
  },

  rateList: {
    name: "asb_rate_list",
    language: LANG,
    category: "MARKETING",
    headerImage: true,
    body:
      "Assalam-o-Alaikum! 🌿 {{1}} ki delivery ke liye Apna Sasta Bazaar ka naya rate list haazir hai.\n\n" +
      "Order booking {{2}} tak khuli hai. Order ke liye isi number par apni list bhej dein.\n\n" +
      "Rate list nahi chahiye to STOP likh kar bhej dein.",
    footer: "Apna Sasta Bazaar",
    example: ["Monday, 5 October", "Sunday, 4 October, 8:00 PM"],
  },
};

// ---------------------------------------------------------------------------
// The component list Meta wants when a template is SUBMITTED.
// headerHandle: the upload handle of an example image (rate list only).
// ---------------------------------------------------------------------------
function definition(t, headerHandle) {
  const components = [];
  if (t.headerImage) {
    components.push({ type: "HEADER", format: "IMAGE", example: { header_handle: [headerHandle] } });
  }
  components.push({ type: "BODY", text: t.body, example: { body_text: [t.example] } });
  if (t.footer) components.push({ type: "FOOTER", text: t.footer });
  return { name: t.name, language: t.language, category: t.category, components };
}

// ---------------------------------------------------------------------------
// Values for SENDING. Each returns [{name, value}] in {{1}}..{{n}} order, the
// shape whatsapp.sendTemplate takes. Every value goes through templateSafe.
// ---------------------------------------------------------------------------
const safe = (v) => templateSafe(v == null || v === "" ? "-" : v).value;

// An item list longer than the message allows is cut at an item boundary,
// never mid-word, and says how many more there are.
function fitItems(flat) {
  const s = safe(flat);
  if (s.length <= ITEMS_MAX) return s;
  const parts = s.split(" • ");
  let out = "";
  let n = 0;
  for (const p of parts) {
    const next = out ? `${out} • ${p}` : p;
    if (next.length > ITEMS_MAX - 30) break;
    out = next;
    n++;
  }
  return `${out} • aur ${parts.length - n} cheezein`;
}

/** composed = bill.orderConfirmation(order) */
function orderBillParams(composed) {
  const p = composed.params;
  // No bazaar rate known for anything in the bag: show the ceiling in both
  // places rather than "Rs 0", which reads as a mistake.
  const bazaar = composed.communitySaved > 0 ? p.bazaar_total : p.zyada_se_zyada;
  return [
    { name: "customer_name", value: safe(p.customer_name) },
    { name: "order_id", value: safe(p.order_id) },
    { name: "ordered", value: safe(p.ordered) },
    { name: "delivery", value: safe(p.delivery) },
    { name: "order_items", value: fitItems(p.order_items) },
    { name: "bazaar_total", value: safe(bazaar) },
    { name: "zyada_se_zyada", value: safe(p.zyada_se_zyada) },
    { name: "abhi_se_bachat", value: safe(p.abhi_se_bachat) },
  ];
}

/** composed = bill.finalBill(order) */
function finalBillParams(composed, closingLine) {
  const p = composed.params;
  return [
    { name: "customer_name", value: safe(p.customer_name) },
    { name: "order_id", value: safe(p.order_id) },
    { name: "bill_items", value: fitItems(p.bill_items) },
    { name: "asal_bill", value: safe(p.asal_bill) },
    { name: "bazaar_total", value: safe(p.bazaar_total) },
    { name: "bachat", value: safe(p.bachat) },
    { name: "closing", value: safe(closingLine || "Jo wada kiya tha, wohi liya.") },
  ];
}

/** delivery: "Monday, 5 October"   cutoff: "Sunday, 4 October, 8:00 PM" */
function rateListParams(delivery, cutoff) {
  return [
    { name: "delivery", value: safe(delivery) },
    { name: "cutoff", value: safe(cutoff) },
  ];
}

/** The rate-list message as the customer reads it, for previews. */
function rateListText(delivery, cutoff) {
  return TEMPLATES.rateList.body
    .replace("{{1}}", delivery)
    .replace("{{2}}", cutoff) + "\n\n" + TEMPLATES.rateList.footer;
}

module.exports = {
  TEMPLATES,
  LANG,
  definition,
  orderBillParams,
  finalBillParams,
  rateListParams,
  rateListText,
  fitItems,
};
