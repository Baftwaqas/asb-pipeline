// ============================================================================
// ASB PIPELINE — bhao/understand.js
// Seth Ji HEARS before he speaks. Founder, 10 Nov live test: "there is no
// purpose of using an API if the basic conversation is not picked up by our
// system - it is natural conversation and the answer should be natural too."
//
// What went wrong with rules alone: "Sirf 70 rupay ka discount?" was read as
// an OFFER of Rs 70 (the first number in the message), and Seth Ji answered
// a complaint with "itne kam mein nuqsan ho jayega". A person reads the
// sentence, not the first number in it.
//
// So the model reads her LATEST message (with the last few lines for
// context) and says what it is: an offer (and how much), agreeing to his
// price, a question, a complaint, a claim about someone else's price,
// committing to / asking about advance payment, a quantity, or her answer to
// "aap ko kya keh ke bulaun?".
//
// The model only READS. It never decides a price (the engine does), and
// what it reads is checked against her actual words before anything uses
// it: an offer or a claimed price must be a number she really wrote; a
// quantity must be one she said; "agreeing" needs words of agreement in the
// message. If the model is off, slow or wrong, the old rules read the
// message instead - she is always answered.
// ============================================================================
"use strict";

const V = require("./voice");
const P = require("./perks");

// "theek hai", "chalo de do", "done", "pakka", "manzoor", "bhej do", "haan ji"
const AGREE_WORDS = /\b(?:theek|thik|tik|ok|okay|done|pakka|manzoor|chalo|chalein|chaliye|haan|han|ji\s+haan|de\s*do|dedo|bhej\s*do|bhejdo|pack\s+kar\w*|le\s+lun?g[aie]|le\s+leti|le\s+lete|deal|sauda)\b/i;

/** Who the customer said to call them: a short word or name, never an instruction. */
function cleanAddress(a) {
  const s = String(a || "").normalize("NFKC").replace(/[^\p{L}\s.-]/gu, "").trim().replace(/\s+/g, " ");
  if (!s || s.length > 20 || s.split(" ").length > 3) return null;
  return s;
}
const FEMALE = /^(?:baji|baaji|apa|aapa|apaa|behan|bahen|behen|sister|didi|madam|maam|mam|aunty|aunti|khala|bhabhi|bhabi|begum|amma|ammi|beti|bibi)$/;
const MALE = /^(?:bhai|bhaijan|bhai\s*jan|bhaiya|bhaya|sir|janab|uncle|chacha|bhaisahab|bhai\s*sahab|sahab|saheb|bhaijaan|beta)$/;
/** { word, gender: "f" | "m" | null } for an address she chose. */
function addressInfo(a) {
  const raw = cleanAddress(a);
  if (!raw) return { word: null, gender: null, known: false };
  const low = raw.toLowerCase();
  // titles in lower case ("bhai"); a name keeps its own capitals ("Ahmed sahab")
  const word = FEMALE.test(low) || MALE.test(low) || /^(?:aap|ap|kuch\s+nahi|koi\s+nahi|naam\s+se|sirf\s+aap)$/.test(low) ? low : raw;
  if (/^(?:aap|ap|kuch\s+nahi|koi\s+nahi|naam\s+se|sirf\s+aap)$/.test(word)) return { word: null, gender: null, known: true };
  return { word, gender: FEMALE.test(low) ? "f" : MALE.test(low) ? "m" : null, known: true };
}

/** Rules-only reading: the old way, used when the model cannot be asked. */
function byRules(latest, { readOffer, readQty, held = [], addressAsked = false }) {
  const gained = P.perksFromText(latest, held);
  const asked = P.perksAskedAbout(latest, held);
  let address = null;
  if (addressAsked) {
    const m = /^\s*(?:mujhe\s+|mujhay\s+|mughe\s+|mughay\s+)?([a-z\s]{2,20}?)\s*(?:kahein|kahen|kahiye|kehna|bulayen|bulaein|bolein|boliye|kaho)?\s*[.!]*\s*$/i.exec(latest);
    if (m && (FEMALE.test(m[1].trim().toLowerCase()) || MALE.test(m[1].trim().toLowerCase()) || /^aap$/i.test(m[1].trim()))) address = m[1].trim().toLowerCase();
  }
  return {
    source: "rules", offerPaisa: readOffer(latest), qty: readQty(latest), accept: false,
    advance: gained.some((g) => g.key === "advance") ? "commit" : asked.some((g) => g.key === "advance") ? "ask" : null,
    claimPaisa: null, claimWhere: null, address, kind: null, note: null,
  };
}

const SYSTEM = [
  "You read ONE WhatsApp message a customer sent to Seth Ji, a shopkeeper bargaining over one item, and say what it means. Roman Urdu / Urdu / English, Karachi style, spelling is loose ('hae'='hai', 'nhi'='nahi', 'dae'='de', 'mughay'='mujhe').",
  "Analyse ONLY the LATEST message. Earlier lines are context.",
  "Reply with ONE JSON object and nothing else:",
  '{"kind": "offer|accept|question|complaint|claim|fairness|walk_away|chat|address|cancel", "offer": number|null, "qty": number|null, "accept": true|false,',
  ' "advance": "commit|ask|null", "claim_price": number|null, "claim_where": "us|elsewhere|null", "address": string|null, "note": string}',
  "offer: ONLY a price SHE proposes to pay for one piece now ('300', '2400 mein de do', '1200 last'). NOT a discount size ('sirf 70 rupay ka discount?' -> offer null), NOT a price she quotes back from Seth Ji or a total she is questioning ('2500 rate hai aur 2430 bol rahe ho' -> offer null), NOT what someone else paid (that is claim_price).",
  "accept: true ONLY if she clearly agrees to pay Seth Ji's CURRENT PRICE (given below) - 'theek hai de do', 'done', 'pakka', 'chalo bhej do'. If she wants it at HER lower number ('bas pack karo' right after offering less), accept is false.",
  "advance: 'commit' if she says she WILL pay in advance; 'ask' if she asks about it or what it would get her; else null.",
  "kind 'walk_away': she ends the bargain - not interested, does not want it any more, 'rehne do', 'nahi chahiye' (NOT when she only rejects his number and is still bargaining, e.g. 'itne mein nahi, 2000 mein do').",
  "kind 'fairness': she asks WHY prices differ, why the same thing has different bhao, or why SHE should pay more than someone else ('aik hi cheez ke alag alag bhao kyun?', 'usko kam mein kyun mili?').",
  "claim_price / claim_where: if she says she or someone else got it for less - 'us' if from this shop, 'elsewhere' if from a market, website or another shop (e.g. 'Joria bazaar se laei hae' -> elsewhere).",
  "address: if Seth Ji asked how to address her/him and this message answers it, the word or name they want ('baji', 'bhai', 'Ahmed sahab', 'aap'). Else null. Never guess it from other words.",
  "note: a few words on what she actually wants answered (e.g. 'complains advance discount is only Rs 70; asks if worth it').",
].join("\n");

function parseJson(raw) {
  const m = /\{[\s\S]*\}/.exec(String(raw || ""));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Read her latest message. Never throws; falls back to rules.
 * ctx: { latest, earlier: [her unanswered earlier lines], lastSeth, askPaisa, itemName, addressAsked, held,
 *        readOffer, readQty, env, fetchImpl }
 */
async function understand(ctx) {
  const { latest, earlier = [], lastSeth = null, askPaisa = null, itemName = "", addressAsked = false, held = [],
          readOffer, readQty, env = process.env, fetchImpl = fetch } = ctx;
  const rules = byRules(latest, { readOffer, readQty, held, addressAsked });
  const provider = String(env.BHAO_VOICE_PROVIDER || "off").toLowerCase();
  if (!V.PROVIDERS[provider] || String(env.BHAO_UNDERSTAND || "").toLowerCase() === "off") return rules;

  const user = [
    `ITEM: ${itemName}`,
    askPaisa ? `SETH JI'S CURRENT PRICE: Rs ${Math.round(askPaisa / 100)}` : "SETH JI'S CURRENT PRICE: not said yet",
    addressAsked ? "Seth Ji has asked how to address the customer and has no answer yet." : "",
    lastSeth ? `SETH JI'S LAST MESSAGE: ${JSON.stringify(String(lastSeth).slice(0, 300))}` : "",
    earlier.length ? "HER EARLIER UNANSWERED LINES: " + earlier.slice(-3).map((e) => JSON.stringify(String(e).slice(0, 200))).join(" / ") : "",
    `HER LATEST MESSAGE: ${JSON.stringify(String(latest).slice(0, 500))}`,
  ].filter(Boolean).join("\n");

  let j;
  try {
    j = parseJson(await V.callProvider(provider, { system: SYSTEM, user }, env, fetchImpl, { temperature: 0, maxTokens: 700 }));
  } catch (e) {
    return { ...rules, aiError: e.code || "provider_error" };
  }
  if (!j || typeof j !== "object") return { ...rules, aiError: "unreadable" };

  // Check every reading against her actual words.
  const said = V.numbersIn(latest);
  const rupees = (n) => (Number.isFinite(Number(n)) && said.includes(Number(n)) ? Math.round(Number(n) * 100) : null);
  const offerPaisa = j.offer == null ? null : rupees(j.offer);
  const qtyN = Number(j.qty);
  const qty = Number.isInteger(qtyN) && qtyN >= 1 && qtyN <= 99 && (said.includes(qtyN) || readQty(latest) === qtyN) ? qtyN : null;
  const accept = j.accept === true && offerPaisa == null && AGREE_WORDS.test(latest);
  const advance = j.advance === "commit" || j.advance === "ask" ? j.advance : null;
  const claimPaisa = j.claim_price == null ? null : rupees(j.claim_price);
  const claimWhere = claimPaisa != null && (j.claim_where === "us" || j.claim_where === "elsewhere") ? j.claim_where : null;
  const address = addressAsked && j.address ? cleanAddress(j.address) : null;
  return {
    source: "ai", offerPaisa: offerPaisa != null && offerPaisa >= 1000 ? offerPaisa : null, qty, accept,
    advance: advance && P.offered("advance") ? advance : null, claimPaisa, claimWhere, address,
    kind: typeof j.kind === "string" ? j.kind.slice(0, 20) : null,
    note: typeof j.note === "string" ? j.note.slice(0, 200) : null,
    // what the model said that her words did not back (logged, never used)
    dropped: [j.offer != null && offerPaisa == null ? "offer " + j.offer : null,
              j.claim_price != null && claimPaisa == null ? "claim " + j.claim_price : null,
              j.accept === true && !accept ? "accept" : null].filter(Boolean),
  };
}

// ---------------------------------------------------------------------------
// Speaking to her the way she asked to be spoken to.
// ---------------------------------------------------------------------------
// her verbs -> the respectful plural, which fits anyone ("aap kitne mein lenge?")
const FEM_TO_NEUTRAL = [
  [/\b(l|d|kar|aay|aa|bhej|rakh|chal)engi\b/gi, "$1enge"], [/\brahi\s+hain\b/gi, "rahe hain"],
  [/\b(chah|sak|rakh|kar|de|le)ti\s+hain\b/gi, "$1te hain"], [/\b(chah|sak)ti\b/gi, "$1te"],
];
const cap = (w, like) => (like && like[0] === like[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w);
/**
 * Put her chosen address into a line written for "baji": "baji" becomes her
 * word (or disappears when we do not know it yet), and feminine verbs become
 * the respectful plural unless she chose a woman's address.
 */
function addressify(text, addr = {}) {
  let t = String(text || "");
  const word = addr.word || null;
  if (word !== "baji") {
    t = word
      ? t.replace(/\bbaji\b/gi, (m) => cap(word, m))
      : t.replace(/,\s*baji\b/gi, "").replace(/\bbaji\s*,\s*/gi, "").replace(/\s*\bbaji\b/gi, "");
    t = t.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  if (addr.gender !== "f") for (const [re, to] of FEM_TO_NEUTRAL) t = t.replace(re, to);
  return t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

/** Her chosen address: the latest one any of her conversations recorded. */
async function addressOf(db, phone) {
  const r = (await db.query(
    `SELECT state->>'address' AS a FROM bhao_conversations WHERE phone = $1 AND state ? 'address'
      ORDER BY id DESC LIMIT 1`, [phone])).rows[0];
  return r ? addressInfo(r.a) : { word: null, gender: null, known: false };
}

module.exports = { understand, byRules, addressInfo, cleanAddress, addressify, addressOf, AGREE_WORDS, SYSTEM };
