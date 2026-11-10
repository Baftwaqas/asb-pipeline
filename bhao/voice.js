// ============================================================================
// ASB PIPELINE — bhao/voice.js
// Seth Ji's VOICE for Bhao Tao: turns one engine decision (bhao/engine.js)
// into one WhatsApp line in Roman Urdu. Provider-agnostic: Groq, xAI Grok or
// Anthropic Claude, chosen by environment; written templates otherwise.
//
// The engine decides; the voice only speaks. The model is told the single
// price it may say (or that it may say none), and EVERY reply is checked
// before a customer can see it:
//   * every number in the reply must be one the engine allowed (the ask,
//     her own offer, the quantity, the group size) - anything else, rejected;
//   * a counter / final offer / acceptance must actually state its price;
//   * no invented scarcity or competitors ("last piece", "Daraz", ...);
//   * short (WhatsApp), no role labels, no links, no phone numbers.
// A rejected reply is retried once with the reason; a second failure, a
// timeout, a provider error or a missing key falls back to a template. The
// customer always gets a correct line; the log says which path produced it.
//
// Keys live ONLY in the server environment (Render): XAI_API_KEY or
// ANTHROPIC_API_KEY. They are never logged, never returned, never sent
// anywhere but the provider's own API host.
//
//   BHAO_VOICE_PROVIDER = groq | xai | anthropic | off  (default off -> templates)
//   GROQ_API_KEY, GROQ_MODEL                         (a current Groq model id)
//   XAI_API_KEY, XAI_MODEL                           (e.g. a current grok model id)
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL               (e.g. a current Claude Haiku id)
//   BHAO_VOICE_TIMEOUT_MS                            (default 8000)
//   BHAO_VOICE_REASONING_EFFORT                      (optional: low | medium | high)
// ============================================================================
"use strict";

const PROVIDERS = Object.freeze({
  xai: { url: "https://api.x.ai/v1/chat/completions", keyVar: "XAI_API_KEY", modelVar: "XAI_MODEL", shape: "openai" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", shape: "openai" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", shape: "anthropic" },
});

const rs = (paisa) => "Rs " + Math.round(paisa / 100).toLocaleString("en-US");

// ---------------------------------------------------------------------------
// What each decision asks of the voice.
// ---------------------------------------------------------------------------
const ANGLE_TEXT = Object.freeze({
  quality_vs_market: "the degchi's quality versus thinner ones in the bazaar (only true claims)",
  running_costs: "real running costs: petrol, delivery, keeping the shop going",
  already_tight: "the margin is already thin",
  disappointment: "mild, playful disappointment",
  belonging: "she is like family, 'aap ke liye'",
  group_hint: "more pieces together (neighbours buying together) get a better rate",
  last_word: "this is the final word",
});

/** kind -> { brief, mustSayPrice } for one decision. */
function briefFor(d) {
  const angle = d.angle && ANGLE_TEXT[d.angle] ? " Angle: " + ANGLE_TEXT[d.angle] + "." : "";
  switch (d.kind) {
    case "open":
      if (d.askAddress) return { brief: "Greet the customer (Assalam-o-Alaikum), present the item at the PRICE, no discount, and POLITELY ask how they would like to be addressed - baji, bhai, or something else. Use no address word yourself yet. Do not mention advance payment or a Bhao Card.", mustSayPrice: true };
      if (d.resumed) return { brief: "Welcome her BACK: she bargained on this item recently, and the bargain continues from where it stopped - the PRICE, not the listed price. Say plainly that this is where you two left it, then ask what she will pay. Do not mention advance payment or her Bhao Card.", mustSayPrice: true };
      return { brief: "Greet her and present the item at the PRICE, no discount. Do not mention advance payment, conditions or her Bhao Card - a separate card message explains those." + angle, mustSayPrice: true };
    case "refuse": return { brief: "Refuse her offer without naming ANY price or number. Push her to offer more." + angle, mustSayPrice: false };
    case "lowball_check":
      if (d.lowballCount >= 2) return { brief: `This is her offer number ${d.lowballCount} far too low to consider. Do NOT repeat any earlier excuse (no 'nuqsan' again). Calmly remind her the price is the PRICE and her number is far away from it; ask for a serious number. Light, friendly, never rude.`, mustSayPrice: false };
      return { brief: "Her offer is insultingly low. One short, curt, slightly offended line. No price, no number.", mustSayPrice: false };
    case "counter": return { brief: "Counter at exactly the PRICE." + angle, mustSayPrice: true };
    case "final_offer": return { brief: "State the PRICE as your absolute last price. Firm." , mustSayPrice: true };
    case "closed": return { brief: "No deal today. Close warmly and invite her back. No price, no number.", mustSayPrice: false };
    case "talk":
      if (d.addressSet) return { brief: "The customer just told you how to be addressed. Thank them warmly using that word once (e.g. 'Ji bhai!'), then ask what they would like to pay. No number.", mustSayPrice: false };
      if (d.addressOther) return { brief: "The customer wants to be called something other than baji or bhai. Ask them kindly to type what you should call them. No number.", mustSayPrice: false };
      return { brief: "She is chatting, not offering. Answer what she said - every question in it - stay on the item, and nudge her to name her price. Only if she asks what it costs, tell her the PRICE.", mustSayPrice: false };
    case "abuse_warning": return { brief: "She used insulting language. Do NOT insult back, do not lecture, do not mock. One calm, dignified line: Seth Ji does business with izzat, and if she speaks respectfully the bargain continues. No price, no number.", mustSayPrice: false };
    case "abuse_close": return { brief: "End the bargain politely because of repeated insults.", mustSayPrice: false };
    case "cancel": return { brief: "She has just CANCELLED the deal she agreed. Accept it at once and graciously: say the order is cancelled, no pressure, no guilt, no sarcasm, and that she is welcome back anytime. If she says she got it cheaper somewhere or from someone, do not argue, do not call her a liar and do not match it - at most say kindly that your price was for this quality. No price of your own.", mustSayPrice: false };
    case "guarded":
      return { brief: `Seth Ji could not start a new bargain for this customer (${d.reason || "a fair-play limit"}) and already said why. Now answer what they wrote, kindly and plainly. If they say the reason is wrong (e.g. 'mera koi sauda nahi hua'), believe them politely: say our team will check it and fix it, and that they can bargain on another item meanwhile. Never argue, never name a price.`, mustSayPrice: false };
    case "aftercare":
      if (d.status === "cancelled")
        return { brief: `She cancelled this deal earlier. Answer what she says kindly. If she wants the item after all, tell her to write "BHAO ${d.itemCode || ""}" to start again. Never revive the old price.`, mustSayPrice: false };
      return { brief: "The deal is ALREADY DONE at the PRICE. Answer every question she asks; the price cannot change any more (not up, not down); our team will message her to confirm the order and delivery. Never invent delivery times or promises.", mustSayPrice: false };
    case "accept": {
      const why = d.offer && d.offer.why;
      if (why === "offer_above_ask_extra_refused")
        return { brief: "She offered MORE than your price. Laugh it off kindly, refuse the extra, take only the PRICE. Honest, gently teasing.", mustSayPrice: true };
      if (why === "offer_meets_ask")
        return { brief: "She accepted your price exactly. Close the deal warmly at the PRICE.", mustSayPrice: true };
      return { brief: "Agree to her deal at the PRICE, grudgingly but happily, as if she beat you.", mustSayPrice: true };
    }
    default: throw new Error("BHAO_VOICE: unknown decision kind " + d.kind);
  }
}

/** The single price this decision lets the voice say (paisa), or null. */
function priceOf(d) {
  if (d.herPriceInvited) return null; // her turn to name a number
  if (d.kind === "lowball_check" && d.lowballCount >= 2 && Number.isSafeInteger(d.askPaisa)) return d.askPaisa; // a reminder, never a new price
  if (d.kind === "accept") return d.offer ? d.offer.unitPaisa : d.askPaisa;
  if (["open", "counter", "final_offer"].includes(d.kind)) return d.askPaisa;
  // after a deal: he may repeat the agreed price (a cancelled deal has none)
  if (d.kind === "aftercare" && d.status === "accepted" && d.offer) return d.offer.unitPaisa;
  // chatting: he may repeat his CURRENT ask if she asks (never a new one)
  if (d.kind === "talk" && Number.isSafeInteger(d.askPaisa)) return d.askPaisa;
  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const PERSONA = [
  "You are Seth Ji, a warm, sharp, funny old shopkeeper in a Karachi household-goods bazaar, selling on WhatsApp for Apna Sasta Bazaar.",
  "Write ONLY Seth Ji's next message, in Roman Urdu the way a Karachi bazaar shopkeeper talks: desi, playful, a little dramatic, never corporate. One or two SHORT lines, at most 160 characters (up to 260 when she asked several things). Address the customer ONLY as the ADDRESS line says. At most one emoji.",
  "Be a real person, not a script: answer EVERY question and point in her messages, in order, in ONE reply - if she asks two things, answer both - and only then do the INSTRUCTION. Never ignore what she said.",
  "Never confirm, guess or explain what ANY other customer paid - not even to agree with her. Refer to the person exactly as she did (her 'behan' is her sister, never 'bhai').",
  "If she says someone else got it cheaper from US, be honest: every sauda is different - her BHAO CARD (being a regular or gold customer, the morning bohni, advance payment, self-pickup, neighbours buying together, and how hard she bargained) decides her price. Never deny prices differ, never say everyone pays the same, never reveal who bought or what anyone paid. Use CLAIM CHECK when given.",
  "If she says she found it cheaper elsewhere, online, or that a friend paid less, never call her a liar and never match it on your own: answer it warmly (e.g. 'aap ne jo dekhi woh aur maal hoga baji') and stay with the INSTRUCTION. Never name another shop or website unless CHECKED COMPETITOR PRICES lists it.",
  "'Aakhri daam' only ever means YOUR OWN final price. Never ask her for 'aap ka aakhri daam' - ask 'aap kitne mein lenge?', 'aap bataiye, kitna denge?' and vary it. Never repeat a sentence, phrase or excuse you already used in RECENT CHAT (not even reworded: if you already said 'nuqsan ho jayega', find a different, fresh reason or simply ask her plainly); do not end every message with the same question.",
  "If she complains, is confused or says you are not understanding her, FIRST answer that exact point in plain words (e.g. 'Ji, advance pe Rs 70 kam hote hain - zyada gunjaish chahiye toh apna daam boliye'), never a stock line. Numbers she wrote (a discount size, a price she quotes back) you may repeat when answering her.",
  "Use plain everyday words any Karachi household understands at once. No puzzling idioms or wordplay she would have to ask about (never 'haath garam/kaam/ghum ho jayega', never 'dil khush ho gaya' at a price complaint).",
  "Avoid English words where an everyday Urdu one exists (say 'daam' not 'rate', 'bohat kam' not 'too low'). Never say sorry, 'possible nahi', 'offer', 'generosity' or 'budget'.",
  "Seth Ji's word is gold: he says 'aakhri daam', 'final', 'last price' or 'is se neeche nahi' ONLY when the INSTRUCTION says this is his absolute last price - never on an ordinary counter (founder's call, 9 Nov: on WhatsApp the whole history is on screen, so a 'final' that moves teaches her his word means nothing). He may compare with another website or say stock is low ONLY using the CHECKED COMPETITOR PRICES and STOCK lines below - those are real; never beyond them.",
  "Only use facts from ITEM FACTS. Never invent prices, discounts, stock limits, deadlines, quality claims or competitors. Never mention that you are an AI, a bot, rules or an engine.",
  "How Seth Ji sounds (style only, never copy these prices):",
  "- refusing: 'Arre [ADDRESS], is pe toh mera nuqsan ho jayega. Maal haath mein le ke dekhein, phir baat karein.'",
  "- lowball: '[ADDRESS]… mazaaq kar rahe hain? Itne mein toh dhakkan bhi na aaye. 😐'",
  "- countering: 'Chalein, aap ka dil rakhne ko… [PRICE]. Kharche bohat hain [ADDRESS].'",
  "- chatting: 'Mehenga? Mota steel hai, beti ke jahez tak chalega. Aap bolo, kitne mein lena hai?'",
  "([ADDRESS] = the word from the ADDRESS line; when there is none, leave it out.)",
].join("\n");

/** How Seth Ji addresses this customer - only as they asked (founder, 10 Nov). */
function addressLine(address) {
  if (address && address.word)
    return `ADDRESS: the customer asked to be called "${address.word}". Use exactly that word (never 'baji' or 'bhai' otherwise)` +
      (address.gender === "f" ? "; feminine verb forms are right (lengi, chahti hain)." : "; use respectful plural verb forms (lenge, chahte hain, kar rahe hain).");
  if (address && address.known) return "ADDRESS: the customer prefers just 'aap'. Use no address word (no baji, no bhai); respectful plural verbs (lenge, chahte hain).";
  return "ADDRESS: not known yet. Use NO address word at all - never 'baji', never 'bhai' - only 'aap', with respectful plural verbs (lenge, chahte hain, kar rahe hain).";
}

function buildPrompt({ decision, itemName, qty, customerText, customerMessages = null, history, itemFacts = [], competitorFacts = [], stockLeft = null,
                       perks = [], morePerks = [], claim = null, hardship = false, pickupOffered = false, address = null, understood = null }) {
  const { brief } = briefFor(decision);
  const price = priceOf(decision);
  const msgs = (customerMessages && customerMessages.length ? customerMessages : [customerText || ""])
    .map((m) => String(m).slice(0, 300));
  const lines = [
    "ITEM: " + itemName + (qty > 1 ? ` (she wants ${qty})` : ""),
    "ITEM FACTS (the only claims you may make): " + (itemFacts.length ? itemFacts.join("; ") : "none - talk about the deal, not the product"),
    competitorFacts.length
      ? "CHECKED COMPETITOR PRICES (one listing each, which you yourself looked at; you MAY use one for drama, quoting it exactly, ALWAYS as 'maine Daraz pe dekhi, Rs X ki thi' (a listing you saw, never 'Daraz pe milti hai') - never claim it is the cheapest there or that you are the cheapest anywhere): " +
        competitorFacts.map((f) => `${f.marketplace[0].toUpperCase() + f.marketplace.slice(1)} ${rs(f.pricePaisa)}`).join("; ")
      : "CHECKED COMPETITOR PRICES: none - do not mention any other shop or website.",
    Number.isSafeInteger(stockLeft) && stockLeft > 0 && stockLeft <= STOCK_CLAIM_MAX
      ? `STOCK: only ${stockLeft} left - you MAY say so (e.g. 'bas ${stockLeft} bachi hain').`
      : "STOCK: not low - never claim it is the last piece or running out.",
    SHOP_FACTS(pickupOffered),
    perks.length ? "HER BHAO CARD (true; you may mention one naturally, e.g. 'aap toh purani customer hain'): " + perks.join("; ") : "HER BHAO CARD: nothing special yet.",
    morePerks.length ? "WHAT WOULD GIVE HER MORE ROOM (true; you may suggest one when she pushes): " + morePerks.join("; ") : "",
    decision.perksGained && decision.perksGained.length
      ? "SHE JUST COMMITTED TO: " + decision.perksGained.join("; ") + ". Thank her and tell her the price comes down for it" +
        (decision.kind === "talk" && decision.askPaisa ? ` - with it, her price is now ${rs(decision.askPaisa)}` : "") +
        ", as a condition of the deal ('advance ke saath')." : "",
    decision.continuing
      ? "SHE IS COMING BACK TO HER OPEN BARGAIN on this item. Welcome her back and remind her plainly where it stood: your last price to her was the PRICE (say it). Then ask what she will pay. Never present it as a new offer." : "",
    decision.herPriceInvited
      ? "SHE TAPPED 'APNA DAAM': she wants to name her own price. Invite her warmly to type it as a number. Do not name any price yourself or give an example amount." : "",
    decision.perkQuotes && decision.perkQuotes.length
      ? "SHE ASKED WHAT ADVANCE PAYMENT WOULD GET HER - answer straight in your first words, with the real number. Advance means she pays BEFORE delivery; without advance she pays cash on delivery (COD) at the normal price - never say both are COD. It is optional: " +
        decision.perkQuotes.map((q) => `${q.label.replace(/\s*\p{Extended_Pictographic}/gu, "")}: price becomes ${rs(q.askPaisa)} instead of ${rs(decision.askPaisa)}`).join("; ") +
        ". Nothing changes until she agrees." : "",
    claim
      ? claim.neverSoldThatLow
        ? `CLAIM CHECK: our records show this item has NEVER been sold by us at ${rs(claim.claimedPaisa)} or less. You may say so kindly ('yeh hamari dukaan se itne mein kabhi nahi gayi, shayad koi aur maal tha') - never call her a liar.`
        : "CLAIM CHECK: some customers did get it lower, through their own Bhao Card and bargaining. Admit prices differ and explain why in general terms; never reveal who or what they paid; offer her the ways to more room."
      : "",
    hardship
      ? "SHE MENTIONED A HARDSHIP (illness, money trouble, a family need). Be genuinely kind and respectful - never doubt or mock it, never use it for drama. The price does NOT change because of it (only the INSTRUCTION decides prices). You may say our team can talk to her personally ('hamari team aap se zaroor baat karegi')." : "",
    addressLine(address),
    understood && understood.note ? "WHAT SHE WANTS ANSWERED (read from her message): " + understood.note : "",
    understood && understood.claimWhere === "elsewhere" && understood.claimPaisa
      ? `SHE SAYS she/someone got it for Rs ${understood.claimPaisa / 100} somewhere else. Take it seriously and respectfully (never 'dil khush ho gaya'): that may be thinner or different maal; your price is for this quality. Do not match it.` : "",
    "INSTRUCTION: " + brief,
    price != null
      ? decision.kind === "talk"
        ? `PRICE (say it only if she asks what it costs): ${rs(price)}${qty > 1 ? " per piece" : ""}. The ONLY amount you may write, exactly as "${rs(price)}"` +
          ((decision.perkQuotes || []).length ? ` (and the advance price given above)` : "") + ` - never any other lower amount, never a discount.`
        : `PRICE: ${rs(price)}${qty > 1 ? " per piece" : ""}. This is the ONLY amount you may write, exactly as "${rs(price)}".`
      : "PRICE: none. Do not write any amount or number.",
    "RECENT CHAT (oldest first):",
    ...(history || []).slice(-6).map((h) => (h.from === "seth" ? "Seth Ji: " : "Customer: ") + String(h.text).slice(0, 200)),
    msgs.length > 1
      ? "HER MESSAGES SINCE YOUR LAST REPLY (answer all of them together, in one reply):\n" + msgs.map((m, i) => `${i + 1}. ${JSON.stringify(m)}`).join("\n")
      : "HER LATEST MESSAGE: " + JSON.stringify(msgs[0]),
  ];
  return { system: PERSONA, user: lines.filter(Boolean).join("\n") };
}

/** What ASB really offers - the voice may not promise anything else. */
// Founder, 9 Nov: "aap ki delivery tu wasay bhi free hae".
const SHOP = Object.freeze({ deliveryFree: true });
function SHOP_FACTS(pickupOffered) {
  return "SHOP FACTS (the only services you may mention): cash on delivery is available on every order; advance payment is OPTIONAL and only gives a little more room on the price; ASB delivers to her door" +
    (SHOP.deliveryFree ? ", and delivery is FREE for everyone, always - so never offer free delivery as a reward or condition" : "") +
    (pickupOffered ? "; she may also collect it herself (self-pickup)" : "; there is NO self-pickup") +
    "; the delivery day is confirmed by our team after the deal - if she asks when, say the team will confirm the day, never promise a day or time" +
    ". Never invent services or benefits - no 'priority packing', no faster delivery, no 'line ka wait nahi'. Do not repeat these facts unless she asks.";
}

// ---------------------------------------------------------------------------
// The check every reply must pass.
// ---------------------------------------------------------------------------
// Always banned: fake deadlines, and anything that breaks Seth Ji's character.
// "sab se sasta" / "cheapest" is a claim about EVERY seller, which no check
// of a few listings can prove: never, in either direction.
// Seth Ji never insults, shames or belittles her (her dignity is not part of the haggle).
const INSULT = /\b(bewaqoof|bewakoof|be\s*waqoof|pagal|paagal|jahil|jaahil|ghatiya|aukat|aukaat|sharam\s+kar\w*|besharam|kanjoos\s+aurat|ghareeb|faqeer|bhikari|bhikaari|kambakht|stupid|idiot)\b/i;
const BANNED = /\b(sirf aaj|aaj hi|offer khatam|chatbot|bot|artificial intelligence|language model|algorithm|sab se sast[ai]|sabse sast[ai]|cheapest|lowest price)\b/i;
// Allowed ONLY when backed by data passed in (competitorFacts / stockLeft).
const MARKETPLACES = /\b(daraz|olx|amazon|alibaba|aliexpress|shophive|telemart|priceoye|temu|competitor)\b/gi;
const SCARCITY = /\b(last piece|aakhri piece|akhri piece|stock khatam|khatam ho raha|bas \d+ (?:bach|reh)|sirf \d+ (?:bach|reh)|\d+ hi (?:bach|reh))/i;
const STOCK_CLAIM_MAX = 3;

/** Every amount the reply mentions, as whole rupees: "Rs 1,800", "1800", "1.8k", "2 lakh". */
function numbersIn(text) {
  const t = String(text).replace(/(\d),(?=\d)/g, "$1");
  const out = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(lakh|lac|k|hazar|hazaar)?\b/gi)) {
    const n = Number(m[1]);
    const unit = (m[2] || "").toLowerCase();
    out.push(unit === "lakh" || unit === "lac" ? n * 100000 : unit ? n * 1000 : n);
  }
  // Counts said in words. Groq's first live run promised "do-teen le lo to
  // aakhri daam kam kar dunga" - a 2-3 piece discount the engine never gave.
  // "do" alone is also a verb ("de do"), so it counts only beside another
  // count word ("do-teen", "do ya teen").
  const W = { teen: 3, chaar: 4, char: 4, paanch: 5, panch: 5, chhe: 6, chay: 6, saat: 7, aath: 8, nau: 9, das: 10, darjan: 12, dozen: 12 };
  for (const m of t.matchAll(/\b(teen|chaar|char|paanch|panch|chhe|chay|saat|aath|nau|das|darjan|dozen)\b/gi)) out.push(W[m[1].toLowerCase()]);
  if (/\bdo\s*(?:[-‑–]|ya|se|ya phir)\s*(?:teen|chaar|char)\b/i.test(t)) out.push(2);
  return out;
}

/** Room for the reply: more when she asked several things at once. */
function maxLengthFor(customerMessages = []) {
  const all = customerMessages.join("\n");
  return customerMessages.length > 1 || (all.match(/\?/g) || []).length > 1 ? 320 : 220;
}

// Invented services (live test, 9 Nov: "priority packing", "line ka wait nahi",
// "pickup se delivery charge bacha jaata hai" - none of it real).
// "padosi le aayenge to delivery free" - delivery is free for everyone anyway
const FREE_DELIVERY_AS_REWARD = /\b(?:agar|to|toh|tab)\b[^.?!\n]{0,50}\bdelivery\s+(?:bhi\s+)?(?:free|muft)|\b(?:free|muft)\s+delivery\b[^.?!\n]{0,40}\b(?:agar|to|toh)\b/i;
const INVENTED = /\bpriority\b|\bline\s+(?:ka|ki|mein)\s+(?:wait|intezar)|\bfree\s+delivery\b|\bdelivery\s+(?:charge|kharcha|fee)\w*\s+(?:bach|maaf|nahi)|\bjaldi\s+(?:deliver|pohanch|mil\s+jaye)|\bexpress\b|\bpehle\s+bhej/i;
const PICKUP_TALK = /\bpick\s*-?\s*up\b|\bkhud\s+(?:le|utha|aa)\w*/i;
// Founder, 9 Nov (option B): "aakhri / final / last price / is se neeche nahi"
// only when it truly is his last price (the engine's final_offer).
const FINAL_WORD = /\b(?:aakhri|aakhari|akhri|akhiri|final|last\s+price|is\s+se\s+neeche\s+nahi|is\s+se\s+kam\s+nahi|isse\s+(?:neeche|kam)\s+nahi)\b/i;
// "aap ka aakhri daam kya hai?" - his own final price is the only aakhri daam
const HER_LAST_PRICE = /\baap\s*k[ae]\s+aakhri\s+daam|\baapk[ae]\s+aakhri\s+daam|\baakhri\s+daam\s+kya\s+rakh/i;
const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

function checkReply(text, { decision, qty, offerPaisa, groupSizes = [], competitorFacts = [], stockLeft = null, maxLength = 220,
                            pickupOffered = false, lastSaid = null, claim = null, address = null, herNumbers = [], extraPrices = [] }) {
  const why = [];
  const t = String(text || "").trim();
  // Only the address the customer chose (founder, 10 Nov: a man was called
  // "baji" all through his bargain).
  const word = address && address.word;
  if (address && word !== "baji" && /\bbaji\b/i.test(t)) why.push(word ? `call them "${word}", not baji` : "address not known: no 'baji' - use only 'aap'");
  if (address && word !== "bhai" && !(word && /bhai/.test(word)) && /\bbhai\b/i.test(t)) why.push(word ? `call them "${word}", not bhai` : "address not known: no 'bhai' - use only 'aap'");
  if (/\bhaath\s+(?:garam|kaam|ghum|kat|tang)\b/i.test(t)) why.push("puzzling idiom - say it plainly");
  if (!t) why.push("empty");
  if (t.length > maxLength) why.push("too long");
  if (/https?:|www\.|\+?92\d{9,}|0\d{10}/i.test(t)) why.push("link or phone number");
  if (/^\s*(seth ji|assistant|bot)\s*:/i.test(t)) why.push("role label");
  if (BANNED.test(t)) why.push("invented claim or forbidden word");
  if (INSULT.test(t)) why.push("insulting her - never");
  if (INVENTED.test(t)) why.push("invented a service ASB does not offer");
  if (!pickupOffered && PICKUP_TALK.test(t)) why.push("self-pickup is not offered");
  if (FINAL_WORD.test(t) && !["final_offer", "accept", "closed", "abuse_close"].includes(decision.kind))
    why.push("'aakhri/final' only when it truly is your last price - this is not");
  if (HER_LAST_PRICE.test(t)) why.push("'aakhri daam' is only your own final price - ask 'aap kitne mein lengi?'");
  if (FREE_DELIVERY_AS_REWARD.test(t)) why.push("delivery is free for everyone - never a reward or condition");
  // No parroting: any run of 5 words he already used in his recent messages
  // (live test, 9 Nov: "cash on delivery se aapke darwaze tak" three times).
  // Live test, 10 Nov: "nuqsan ho jayega" seven times, each spelt a little
  // differently - the same excuse twice is a repeat, however it is spelt.
  if (lastSaid) {
    const STOCK = [[/nu(?:q|k)saa?n/i, "nuqsan"], [/mazaa?q/i, "mazaaq"], [/dhakk?an/i, "dhakkan"], [/kharch[ae]/i, "kharche"]];
    const before = (Array.isArray(lastSaid) ? lastSaid : [lastSaid]).join(" ");
    for (const [re, name] of STOCK) if (re.test(t) && re.test(before)) { why.push(`you already used the '${name}' line - say something new`); break; }
  }
  if (lastSaid) {
    const said = (Array.isArray(lastSaid) ? lastSaid : [lastSaid]).map(norm).join(" | ");
    const w = norm(t).split(" ");
    for (let i = 0; i + 5 <= w.length; i++) {
      const g = w.slice(i, i + 5).join(" ");
      if (said.includes(g)) { why.push("repeats what you already said: " + JSON.stringify(g)); break; }
    }
  }
  // Her claim about someone else's price: never confirmed, never detailed.
  if (claim && claim.claimedPaisa != null && numbersIn(t).includes(claim.claimedPaisa / 100)) {
    const denies = /\bkabhi\s+nahi\b|\bnahi\s+(?:gayi|gaya|di|diya|bik\w*|mili)\b/i.test(t);
    if (!claim.neverSoldThatLow || !denies) why.push("never confirm or repeat what someone else paid");
  }
  const backed = new Set(competitorFacts.map((f) => String(f.marketplace).toLowerCase()));
  let named = false;
  for (const m of t.matchAll(MARKETPLACES)) { named = true; if (!backed.has(m[1].toLowerCase())) why.push("unbacked competitor: " + m[1]); }
  // Founder's call, 7 Nov: always "maine dekhi/dekha", a listing he saw -
  // never a general fact about the marketplace ("Daraz pe milti hai").
  if (named && !/\bdekh(i|a|ee)\b/i.test(t)) why.push("competitor price must be said as 'maine dekhi'");
  const stockClaimOk = Number.isSafeInteger(stockLeft) && stockLeft > 0 && stockLeft <= STOCK_CLAIM_MAX;
  if (SCARCITY.test(t) && !stockClaimOk) why.push("unbacked scarcity");
  if (stockClaimOk) for (const m of t.matchAll(/(\d+)\s*(?:hi\s*)?(?:bach|reh)/gi))
    if (Number(m[1]) !== stockLeft) why.push("wrong stock count: " + m[1]);
  const price = priceOf(decision);
  const allowed = new Set([1, qty, ...groupSizes, ...herNumbers]);
  // differences between real prices ("advance pe Rs 70 kam") are true too
  const real = [price, offerPaisa, ...extraPrices, ...(decision.perkQuotes || []).map((q) => q.askPaisa)].filter((x) => Number.isSafeInteger(x));
  for (const a of real) for (const b of real) if (a > b) allowed.add((a - b) / 100);
  if (price != null) allowed.add(price / 100);
  if (offerPaisa != null) allowed.add(offerPaisa / 100);
  for (const f of competitorFacts) allowed.add(f.pricePaisa / 100);
  for (const q of decision.perkQuotes || []) allowed.add(q.askPaisa / 100);
  if (stockClaimOk) allowed.add(stockLeft);
  for (const n of numbersIn(t)) if (!allowed.has(n)) why.push("number not allowed: " + n);
  // He may repeat her number, never agree to it in words - only the engine
  // accepts a price.
  const herLower = numbersIn(t).filter((n) => herNumbers.includes(n) && (price == null || n * 100 < price));
  if (herLower.length && decision.kind !== "accept" && /\b(?:de\s*dun?g[aie]|de\s*deta|de\s*det[ie]|theek\s+hai|manzoor|pakka|chalo|chalein|done|bhej\s*dun?g[aie])\b/i.test(t))
    why.push("never agree to her number " + herLower[0] + " - only the INSTRUCTION decides a price");
  if (briefFor(decision).mustSayPrice && !numbersIn(t).includes(price / 100)) why.push("price not stated");
  return { ok: why.length === 0, why };
}

// ---------------------------------------------------------------------------
// Templates: always correct, used whenever the model is off or fails.
// ---------------------------------------------------------------------------
function template(decision, { offerPaisa, pick = (a) => a[0] }) {
  const p = priceOf(decision);
  switch (decision.kind) {
    case "open":
      if (decision.askAddress) return `Assalam-o-Alaikum! Yeh ${rs(p)} ki hai. Aap ko kya keh ke bulaun - baji, bhai, ya kuch aur? 🙂`;
      if (decision.resumed) return `Aaiye baji, phir se! Pichli dafa baat ${rs(p)} tak aayi thi - wahin se aage chalte hain.`;
      return pick([`Assalam-o-Alaikum baji! Mota steel, nasal chalegi. ${rs(p)} ki hai.`]);
    case "refuse": return pick(["Arre baji, is pe nahi hoga. Maal dekhein pehle, phir bhao lagayen.",
      "Na na baji, itne mein yeh wala nahi aata. Thora aur barhayen."]);
    case "lowball_check":
      if (decision.lowballCount >= 2 && p != null) return pick([`Baji, daam ${rs(p)} hai - aap ki baat us se bohat door hai. Koi sanjeeda daam boliye.`]);
      return pick(["Kya baji, mazaaq kar rahi hain? 😐", "Itne mein toh dhakkan bhi nahi aata baji."]);
    case "counter": return pick([`Chalein baji, aap ke liye ${rs(p)}.`, `Kharche bohat hain, phir bhi ${rs(p)}.`]);
    case "final_offer": return pick([`Bas baji, ${rs(p)}. Is se neeche nahi hoga.`]);
    case "closed": return pick(["Chalein baji, aaj sauda nahi bana. Phir aaiye ga, chai pe baat karenge."]);
    case "talk":
      if (decision.perksGained && decision.perksGained.length)
        return decision.askPaisa
          ? `Shukriya baji! Advance ke saath ab ${rs(decision.askPaisa)}. Boliye, kitne mein lengi?`
          : "Shukriya baji, advance ke saath thori aur gunjaish ban jati hai. Boliye, kitne mein lengi?";
      if (decision.continuing && p != null) return `Aaiye baji, phir se! Hamari pichli baat ${rs(p)} pe ruki thi. Aap bataiye, kitne mein lengi?`;
      if (decision.addressSet) return "Ji baji, bohat shukriya! Ab bataiye, kitne mein lengi?";
      if (decision.addressOther) return "Zaroor! Likh dein aap ko kya keh ke bulaun. 🙂";
      if (decision.herPriceInvited) return "Zaroor baji! Apna daam number mein likh dein. 🙂";
      if (decision.perkQuotes && decision.perkQuotes.length)
        return `Baji, advance dein toh daam ${rs(decision.perkQuotes[0].askPaisa)}; warna cash on delivery pe ${rs(decision.askPaisa)} - marzi aap ki.`;
      return pick(["Ji baji, boliye, kitne mein chahiye?", "Baji, aap ki baat samajh raha hoon. Aap bataiye, kitne mein lengi?", "Ji baji, aap apna daam boliye - phir baat karte hain."]);
    case "abuse_warning": return pick(["Baji, Seth Ji izzat se karobar karte hain. Aap tameez se baat karein toh bhao zaroor hoga. 🙏"]);
    case "abuse_close": return "Baji, is tarah baat nahi ho sakti. Aaj ka bhao yahin khatam - kuch din baad izzat se phir aaiye ga. Allah hafiz. 🙏";
    case "cancel": return pick(["Koi baat nahi baji, sauda cancel kar diya. Jab dil chahe phir aaiye ga. 🙏"]);
    case "guarded":
      return /cooldown/.test(decision.reason || "")
        ? "Ji, maafi - hamari team yeh check kar ke theek kar degi. Tab tak koi aur cheez dekhni ho toh \"BHAO\" likh dein. 🙏"
        : "Ji, hamari team aap ki baat dekh legi. Tab tak koi aur cheez dekhni ho toh \"BHAO\" likh dein. 🙏";
    case "aftercare":
      return decision.status === "accepted" && p != null
        ? `Ji baji, sauda ${rs(p)} pe pakka hai. Hamari team order confirm karne ke liye aap ko message karegi.`
        : `Ji baji, woh sauda cancel ho chuka hai. Phir lena ho toh "BHAO ${decision.itemCode || ""}" likh dein.`;
    case "accept": {
      const why = decision.offer && decision.offer.why;
      if (why === "offer_above_ask_extra_refused")
        return `Arre baji, ${rs(offerPaisa)} nahi! Daam ${rs(p)} hai, utna hi lunga. 😄`;
      if (why === "offer_meets_ask") return `Bas baji, sauda pakka! ${rs(p)}. 🤝`;
      return `Uff baji… chalein, ${rs(p)} pe aap ki baat rakh li. 🤝`;
    }
    default: throw new Error("BHAO_VOICE: unknown decision kind " + decision.kind);
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
async function callProvider(name, { system, user, retryNote }, env, fetchImpl, { temperature = 0.8, maxTokens = 600 } = {}) {
  const p = PROVIDERS[name];
  const key = env[p.keyVar], model = env[p.modelVar];
  if (!key || !model) throw Object.assign(new Error("not configured"), { code: "not_configured" });
  const timeoutMs = Number(env.BHAO_VOICE_TIMEOUT_MS) > 0 ? Number(env.BHAO_VOICE_TIMEOUT_MS) : 8000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const content = retryNote ? user + "\n\nYOUR PREVIOUS REPLY WAS REJECTED: " + retryNote + ". Write it again correctly." : user;
  try {
    let res, body;
    if (p.shape === "openai") {
      res = await fetchImpl(p.url, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        // Reasoning models (gpt-oss, qwen3) spend tokens thinking before they
        // write; 600 leaves room for a two-line reply. BHAO_VOICE_REASONING_EFFORT
        // (low | medium | high) is passed only when set, for providers that take it.
        body: JSON.stringify({ model, temperature, max_tokens: maxTokens,
          ...(env.BHAO_VOICE_REASONING_EFFORT ? { reasoning_effort: env.BHAO_VOICE_REASONING_EFFORT } : {}),
          messages: [{ role: "system", content: system }, { role: "user", content }] }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error_" + res.status });
      return String(body?.choices?.[0]?.message?.content ?? "");
    }
    res = await fetchImpl(p.url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: Math.min(maxTokens, 400), temperature, system,
        messages: [{ role: "user", content }] }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error_" + res.status });
    return (body?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
  } catch (e) {
    if (e.name === "AbortError") throw Object.assign(new Error("timeout"), { code: "timeout" });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seth Ji's line for one engine decision.
 * Returns { text, source: "ai" | "template", provider, attempts, rejected: [reasons] }.
 * Never throws for provider trouble; throws only for a programming error
 * (an unknown decision kind).
 */
async function speak({ decision, itemName, qty = 1, offerPaisa = null, customerText = "", customerMessages = null, history = [],
                       groupSizes = [], itemFacts = [], competitorFacts = [], stockLeft = null,
                       perks = [], morePerks = [], claim = null, hardship = false, pickupOffered = false,
                       address = null, understood = null, extraPrices = [],
                       env = process.env, fetchImpl = fetch, pick }) {
  briefFor(decision); // validates the kind first
  const provider = String(env.BHAO_VOICE_PROVIDER || "off").toLowerCase();
  const fallback = (rejected, attempts) => ({ text: template(decision, { offerPaisa, pick }), source: "template",
                                              provider: provider === "off" ? null : provider, attempts, rejected });
  if (!PROVIDERS[provider]) return fallback([], 0);

  const prompt = buildPrompt({ decision, itemName, qty, customerText, customerMessages, history, itemFacts, competitorFacts, stockLeft, perks, morePerks, claim, hardship, pickupOffered, address, understood });
  const herNumbers = numbersIn((customerMessages && customerMessages.length ? customerMessages : [customerText]).join("\n"));
  const lastSaid = (history || []).filter((h) => h.from === "seth").slice(-3).map((h) => h.text);
  const maxLength = maxLengthFor(customerMessages && customerMessages.length ? customerMessages : [customerText]);
  const rejected = [];
  let retryNote = null;
  // Three tries: a stock line is the last resort, not the second one
  // (live test, 10 Nov: two complaints got the same canned "Ji baji, boliye").
  for (let attempt = 1; attempt <= 3; attempt++) {
    let raw;
    try {
      raw = await callProvider(provider, { ...prompt, retryNote }, env, fetchImpl);
    } catch (e) {
      rejected.push(e.code || "provider_error");
      return fallback(rejected, attempt); // provider trouble: no second call
    }
    const text = raw.trim().replace(/^["“]|["”]$/g, "");
    const c = checkReply(text, { decision, qty, offerPaisa, groupSizes, competitorFacts, stockLeft, maxLength, pickupOffered, lastSaid, claim, address, herNumbers, extraPrices });
    if (c.ok) return { text, source: "ai", provider, attempts: attempt, rejected };
    rejected.push(c.why.join("; "));
    retryNote = c.why.join("; ");
  }
  return fallback(rejected, 3);
}

module.exports = { speak, checkReply, buildPrompt, template, numbersIn, priceOf, maxLengthFor, PROVIDERS, callProvider, addressLine };
