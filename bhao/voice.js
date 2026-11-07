// ============================================================================
// ASB PIPELINE — bhao/voice.js
// Seth Ji's VOICE for Bhao Tao: turns one engine decision (bhao/engine.js)
// into one WhatsApp line in Roman Urdu. Provider-agnostic: xAI Grok or
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
//   BHAO_VOICE_PROVIDER = xai | anthropic | off     (default off -> templates)
//   XAI_API_KEY, XAI_MODEL                           (e.g. a current grok model id)
//   ANTHROPIC_API_KEY, ANTHROPIC_MODEL               (e.g. a current Claude Haiku id)
//   BHAO_VOICE_TIMEOUT_MS                            (default 8000)
// ============================================================================
"use strict";

const PROVIDERS = Object.freeze({
  xai: { url: "https://api.x.ai/v1/chat/completions", keyVar: "XAI_API_KEY", modelVar: "XAI_MODEL" },
  anthropic: { url: "https://api.anthropic.com/v1/messages", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL" },
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
    case "open": return { brief: "Greet her and present the item at the PRICE, no discount." + angle, mustSayPrice: true };
    case "refuse": return { brief: "Refuse her offer without naming ANY price or number. Push her to offer more." + angle, mustSayPrice: false };
    case "lowball_check": return { brief: "Her offer is insultingly low. One short, curt, slightly offended line. No price, no number.", mustSayPrice: false };
    case "counter": return { brief: "Counter at exactly the PRICE." + angle, mustSayPrice: true };
    case "final_offer": return { brief: "State the PRICE as your absolute last price. Firm." , mustSayPrice: true };
    case "closed": return { brief: "No deal today. Close warmly and invite her back. No price, no number.", mustSayPrice: false };
    case "talk": return { brief: "She is chatting, not offering. Answer what she said in one or two lines, stay on the item, nudge her to name her price. No price, no number.", mustSayPrice: false };
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
  if (d.kind === "accept") return d.offer ? d.offer.unitPaisa : d.askPaisa;
  if (["open", "counter", "final_offer"].includes(d.kind)) return d.askPaisa;
  return null;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
const PERSONA = [
  "You are Seth Ji, a warm, sharp, funny shopkeeper in a Karachi household-goods bazaar, selling on WhatsApp for Apna Sasta Bazaar.",
  "Write ONLY Seth Ji's next message, in Roman Urdu the way Karachi people type on WhatsApp. One or two short lines, at most 220 characters. Call her 'baji'. At most one emoji.",
  "Never invent prices, discounts, stock limits, deadlines or competitors. Say only true things. Never mention that you are an AI, a bot, rules or an engine.",
].join("\n");

function buildPrompt({ decision, itemName, qty, customerText, history }) {
  const { brief } = briefFor(decision);
  const price = priceOf(decision);
  const lines = [
    "ITEM: " + itemName + (qty > 1 ? ` (she wants ${qty})` : ""),
    "INSTRUCTION: " + brief,
    price != null
      ? `PRICE: ${rs(price)}${qty > 1 ? " per piece" : ""}. This is the ONLY amount you may write, exactly as "${rs(price)}".`
      : "PRICE: none. Do not write any amount or number.",
    "RECENT CHAT (oldest first):",
    ...(history || []).slice(-6).map((h) => (h.from === "seth" ? "Seth Ji: " : "Baji: ") + String(h.text).slice(0, 200)),
    "HER LATEST MESSAGE: " + JSON.stringify(String(customerText || "").slice(0, 300)),
  ];
  return { system: PERSONA, user: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// The check every reply must pass.
// ---------------------------------------------------------------------------
const BANNED = /\b(daraz|olx|amazon|alibaba|competitor|last piece|aakhri piece|stock khatam|sirf aaj|offer khatam|chatbot|bot|artificial intelligence|language model|algorithm)\b/i;

/** Every amount the reply mentions, as whole rupees: "Rs 1,800", "1800", "1.8k", "2 lakh". */
function numbersIn(text) {
  const t = String(text).replace(/(\d),(?=\d)/g, "$1");
  const out = [];
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(lakh|lac|k|hazar|hazaar)?\b/gi)) {
    const n = Number(m[1]);
    const unit = (m[2] || "").toLowerCase();
    out.push(unit === "lakh" || unit === "lac" ? n * 100000 : unit ? n * 1000 : n);
  }
  return out;
}

function checkReply(text, { decision, qty, offerPaisa, groupSizes = [] }) {
  const why = [];
  const t = String(text || "").trim();
  if (!t) why.push("empty");
  if (t.length > 260) why.push("too long");
  if (/https?:|www\.|\+?92\d{9,}|0\d{10}/i.test(t)) why.push("link or phone number");
  if (/^\s*(seth ji|assistant|bot)\s*:/i.test(t)) why.push("role label");
  if (BANNED.test(t)) why.push("invented claim or forbidden word");
  const price = priceOf(decision);
  const allowed = new Set([1, qty, ...groupSizes]);
  if (price != null) allowed.add(price / 100);
  if (offerPaisa != null) allowed.add(offerPaisa / 100);
  for (const n of numbersIn(t)) if (!allowed.has(n)) why.push("number not allowed: " + n);
  if (briefFor(decision).mustSayPrice && !numbersIn(t).includes(price / 100)) why.push("price not stated");
  return { ok: why.length === 0, why };
}

// ---------------------------------------------------------------------------
// Templates: always correct, used whenever the model is off or fails.
// ---------------------------------------------------------------------------
function template(decision, { offerPaisa, pick = (a) => a[0] }) {
  const p = priceOf(decision);
  switch (decision.kind) {
    case "open": return pick([`Assalam-o-Alaikum baji! Mota steel, nasal chalegi. ${rs(p)} ki hai.`]);
    case "refuse": return pick(["Arre baji, is pe nahi hoga. Maal dekhein pehle, phir bhao lagayen.",
      "Na na baji, itne mein yeh wala nahi aata. Thora aur barhayen."]);
    case "lowball_check": return pick(["Kya baji, mazaaq kar rahi hain? 😐", "Itne mein toh dhakkan bhi nahi aata baji."]);
    case "counter": return pick([`Chalein baji, aap ke liye ${rs(p)}.`, `Kharche bohat hain, phir bhi ${rs(p)}.`]);
    case "final_offer": return pick([`Bas baji, ${rs(p)}. Is se neeche nahi hoga.`]);
    case "closed": return pick(["Chalein baji, aaj sauda nahi bana. Phir aaiye ga, chai pe baat karenge."]);
    case "talk": return pick(["Ji baji, boliye, kitne mein chahiye?"]);
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
async function callProvider(name, { system, user, retryNote }, env, fetchImpl) {
  const p = PROVIDERS[name];
  const key = env[p.keyVar], model = env[p.modelVar];
  if (!key || !model) throw Object.assign(new Error("not configured"), { code: "not_configured" });
  const timeoutMs = Number(env.BHAO_VOICE_TIMEOUT_MS) > 0 ? Number(env.BHAO_VOICE_TIMEOUT_MS) : 8000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const content = retryNote ? user + "\n\nYOUR PREVIOUS REPLY WAS REJECTED: " + retryNote + ". Write it again correctly." : user;
  try {
    let res, body;
    if (name === "xai") {
      res = await fetchImpl(p.url, {
        method: "POST", signal: ctl.signal,
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
        body: JSON.stringify({ model, temperature: 0.8, max_tokens: 160,
          messages: [{ role: "system", content: system }, { role: "user", content }] }),
      });
      body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error" });
      return String(body?.choices?.[0]?.message?.content ?? "");
    }
    res = await fetchImpl(p.url, {
      method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 160, temperature: 0.8, system,
        messages: [{ role: "user", content }] }),
    });
    body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error("provider status " + res.status), { code: "provider_error" });
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
async function speak({ decision, itemName, qty = 1, offerPaisa = null, customerText = "", history = [],
                       groupSizes = [], env = process.env, fetchImpl = fetch, pick }) {
  briefFor(decision); // validates the kind first
  const provider = String(env.BHAO_VOICE_PROVIDER || "off").toLowerCase();
  const fallback = (rejected, attempts) => ({ text: template(decision, { offerPaisa, pick }), source: "template",
                                              provider: provider === "off" ? null : provider, attempts, rejected });
  if (!PROVIDERS[provider]) return fallback([], 0);

  const prompt = buildPrompt({ decision, itemName, qty, customerText, history });
  const rejected = [];
  let retryNote = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let raw;
    try {
      raw = await callProvider(provider, { ...prompt, retryNote }, env, fetchImpl);
    } catch (e) {
      rejected.push(e.code || "provider_error");
      return fallback(rejected, attempt); // provider trouble: no second call
    }
    const text = raw.trim().replace(/^["“]|["”]$/g, "");
    const c = checkReply(text, { decision, qty, offerPaisa, groupSizes });
    if (c.ok) return { text, source: "ai", provider, attempts: attempt, rejected };
    rejected.push(c.why.join("; "));
    retryNote = c.why.join("; ");
  }
  return fallback(rejected, 2);
}

module.exports = { speak, checkReply, buildPrompt, template, numbersIn, priceOf, PROVIDERS };
