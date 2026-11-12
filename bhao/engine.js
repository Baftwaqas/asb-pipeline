// ============================================================================
// ASB PIPELINE — bhao/engine.js
// ADR-002 Lane C: Bhao Tao, the rule-based bargaining engine for NON-grocery
// items (contract §1.5). PURE: no database, no clock, no network, no AI.
//
// Division of labour. This engine alone decides every PRICE and every
// TIMING: whether to refuse, check a lowball, counter, settle or close; the
// ask; the reply delay; which conversational angle to use. A language model
// (or a human) only PHRASES the reply from that decision, in the local
// shopkeeper's voice. Nothing the model says can move a price, because the
// model never sees a number it may choose.
//
// The founder's bargaining rules (memory, 17 Sep 2026), as code:
//   * open at the anchor with no discount; pitch quality, not a cut;
//   * do not counter first: the first rounds REFUSE without naming a price,
//     so the customer names hers;
//   * a lowball gets a deliberately long pause and a sharp check, no counter;
//   * when ASB does counter, the steps are large and varied, not crumbs;
//   * group / bulk asks unlock a lower floor (Community-style);
//   * the customer should feel she won: past a few rounds, a fair offer is
//     accepted rather than squeezed to the last rupee;
//   * replies are not instant, and no two conversations read the same.
//
// Hard guarantees (tested):
//   * never below the item's floor for that quantity (founder-set);
//   * the ask only ever goes DOWN within a conversation;
//   * a settle is never above the current ask, and never above what the
//     customer offered (she is never charged more than she said);
//   * deterministic: the same seed and the same offers give the same
//     conversation (replayable for audit and for the data study).
// ============================================================================
"use strict";

class BhaoError extends Error {
  constructor(code, detail) { super(code + (detail ? ": " + detail : "")); this.code = code; }
}

const pos = (n, name) => { if (!Number.isSafeInteger(n) || n <= 0) throw new BhaoError("INVALID_INTEGER", name); return n; };
const nonneg = (n, name) => { if (!Number.isSafeInteger(n) || n < 0) throw new BhaoError("INVALID_INTEGER", name); return n; };
const str = (s, name) => { if (typeof s !== "string" || !s.trim()) throw new BhaoError("INVALID_STRING", name); return s; };

// ---------------------------------------------------------------------------
// Deterministic randomness: a seeded PRNG per conversation and round, so a
// conversation can be replayed exactly. Not for security.
// ---------------------------------------------------------------------------
function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function rng(seed) {
  let a = hash32(seed);
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r, [lo, hi]) => lo + Math.floor(r() * (hi - lo + 1));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ANGLES = Object.freeze([
  "quality_vs_market",   // the founder's opening pitch: compare the item, not the price
  "running_costs",       // petrol, delivery, running the system
  "already_tight",       // the margin is already thin
  "disappointment",      // mild drama: "aap se yeh umeed nahi thi"
  "belonging",           // "aap ke liye" - you are one of us
  "group_hint",          // more pieces / neighbours together get a better rate
  "last_word",           // this is the final word
]);

function validateItem(item) {
  if (!item || typeof item !== "object") throw new BhaoError("NO_ITEM");
  str(item.itemId, "itemId");
  str(item.variantGid, "variantGid");
  if (item.bhaoTaoEnabled !== true) throw new BhaoError("NOT_A_BHAO_TAO_ITEM", item.itemId);
  if (item.isGrocery !== false) throw new BhaoError("GROCERY_NEVER_BARGAINED", item.itemId); // contract §1.5
  pos(item.anchorPaisa, "anchorPaisa");
  pos(item.floorPaisa, "floorPaisa");
  if (item.floorPaisa > item.anchorPaisa) throw new BhaoError("FLOOR_ABOVE_ANCHOR", item.itemId);
  if (item.costPaisa != null) {
    nonneg(item.costPaisa, "costPaisa");
    if (item.floorPaisa < item.costPaisa) throw new BhaoError("FLOOR_BELOW_COST", item.itemId);
  }
  str(item.approvedBy, "approvedBy"); // floors are founder decisions, attributed
  let lastQty = 1, lastFloor = item.floorPaisa;
  for (const t of item.groupTiers || []) {
    pos(t.minQty, "groupTiers.minQty");
    pos(t.floorPaisa, "groupTiers.floorPaisa");
    if (t.minQty <= lastQty) throw new BhaoError("GROUP_TIERS_NOT_ASCENDING", item.itemId);
    if (t.floorPaisa >= lastFloor) throw new BhaoError("GROUP_FLOOR_NOT_LOWER", item.itemId);
    if (item.costPaisa != null && t.floorPaisa < item.costPaisa) throw new BhaoError("FLOOR_BELOW_COST", item.itemId);
    lastQty = t.minQty; lastFloor = t.floorPaisa;
  }
  pos(item.maxQty, "maxQty");
  return item;
}

function validatePolicy(p) {
  if (!p || typeof p !== "object") throw new BhaoError("NO_POLICY");
  str(p.version, "policy.version");
  const frac = (x, name) => { if (typeof x !== "number" || !(x > 0 && x < 1)) throw new BhaoError("INVALID_POLICY", name); };
  frac(p.lowballRatio, "lowballRatio");            // offer < anchor x ratio = lowball
  nonneg(p.refuseRounds, "refuseRounds");          // rounds that refuse before ASB names a price
  pos(p.maxRounds, "maxRounds");
  if (p.refuseRounds >= p.maxRounds) throw new BhaoError("INVALID_POLICY", "refuseRounds >= maxRounds");
  if (!Array.isArray(p.stepPlan) || !p.stepPlan.length) throw new BhaoError("INVALID_POLICY", "stepPlan");
  p.stepPlan.forEach((s, i) => frac(s, "stepPlan[" + i + "]"));
  if (typeof p.stepJitter !== "number" || p.stepJitter < 0 || p.stepJitter >= 0.5) throw new BhaoError("INVALID_POLICY", "stepJitter");
  frac(p.settleBand, "settleBand");                // settle if offer >= floor + band x (ask - floor) ...
  nonneg(p.settleAfterRounds, "settleAfterRounds");// ... once this many rounds have passed
  pos(p.roundToPaisa, "roundToPaisa");             // asks are round numbers (e.g. 1000 = Rs 10)
  for (const k of ["normal", "lowball", "settle"]) {
    const d = p.delaySeconds && p.delaySeconds[k];
    if (!Array.isArray(d) || d.length !== 2 || !Number.isSafeInteger(d[0]) || !Number.isSafeInteger(d[1]) || d[0] < 0 || d[1] < d[0])
      throw new BhaoError("INVALID_POLICY", "delaySeconds." + k);
  }
  pos(p.offerTtlMinutes, "offerTtlMinutes");
  if (typeof p.settleAtLastRound !== "boolean") throw new BhaoError("INVALID_POLICY", "settleAtLastRound");
  // Stubborn bargains (founder, 12 Nov): in about stubbornRate of bargains
  // Seth Ji stops part-way - stubbornStopAt of the way from the floor up to
  // the anchor - holds there and lets her walk. Optional; 0 = never.
  if (p.stubbornRate !== undefined) {
    if (typeof p.stubbornRate !== "number" || p.stubbornRate < 0 || p.stubbornRate >= 1) throw new BhaoError("INVALID_POLICY", "stubbornRate");
    if (p.stubbornRate > 0) frac(p.stubbornStopAt, "stubbornStopAt");
  }
  return p;
}

/** The floor for this many pieces: the lowest group tier whose minQty is met. */
function floorFor(item, qty) {
  let f = item.floorPaisa;
  for (const t of item.groupTiers || []) if (qty >= t.minQty) f = t.floorPaisa;
  return f;
}

/**
 * The lowest he will go in THIS bargain: the floor, or - in a stubborn
 * bargain - a point part-way up from it, which he holds and lets her walk.
 */
function floorOf(item, qty, state, policy) {
  const f = floorFor(item, qty);
  const ratio = Number(state.stubbornRatio) || 0;
  if (!(ratio > 0)) return f;
  return Math.min(item.anchorPaisa, Math.max(f, roundUp(f + ratio * (item.anchorPaisa - f), policy.roundToPaisa)));
}

const roundDown = (x, step) => Math.floor(x / step) * step;
const roundUp = (x, step) => Math.ceil(x / step) * step;

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
function open({ conversationId, item, qty, policy, seed }) {
  validateItem(item); validatePolicy(policy);
  str(conversationId, "conversationId"); str(seed, "seed");
  pos(qty, "qty");
  if (qty > item.maxQty) throw new BhaoError("QTY_ABOVE_MAX", `${qty} > ${item.maxQty}`);
  const state = {
    conversationId, seed, itemId: item.itemId, policyVersion: policy.version,
    qty, round: 0, askPaisa: item.anchorPaisa, bestOfferPaisa: 0, status: "open",
    lastAngle: null, events: [],
  };
  // Decided once, privately, as she walks in - she cannot see or game it.
  const rate = Number(policy.stubbornRate) || 0;
  if (rate > 0 && rng(seed + ":stubborn")() < rate) state.stubbornRatio = policy.stubbornStopAt;
  const r = rng(seed + ":open");
  const action = { kind: "open", askPaisa: item.anchorPaisa, angle: "quality_vs_market",
                   delaySeconds: between(r, policy.delaySeconds.normal) };
  state.lastAngle = action.angle;
  state.events.push({ round: 0, kind: "open", askPaisa: item.anchorPaisa, qty });
  return { state, action };
}

function pickAngle(r, state, preferred) {
  const pool = preferred.filter((a) => a !== state.lastAngle);
  return pool[Math.floor(r() * pool.length)] || preferred[0];
}

/**
 * The customer names a price (per piece), optionally changing the quantity.
 * Returns the new state and the action for the phrasing layer.
 */
function offer(prev, { item, policy, pricePaisa, qty = prev.qty, now }) {
  validateItem(item); validatePolicy(policy);
  if (prev.status !== "open") throw new BhaoError("CONVERSATION_CLOSED", prev.status);
  if (item.itemId !== prev.itemId) throw new BhaoError("WRONG_ITEM");
  if (policy.version !== prev.policyVersion) throw new BhaoError("POLICY_CHANGED_MID_CONVERSATION");
  pos(pricePaisa, "pricePaisa");
  pos(qty, "qty");
  if (qty > item.maxQty) throw new BhaoError("QTY_ABOVE_MAX", `${qty} > ${item.maxQty}`);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new BhaoError("INVALID_NOW");

  const state = { ...prev, events: [...prev.events], round: prev.round + 1, qty };
  const r = rng(`${state.seed}:${state.round}`);
  const floor = floorOf(item, qty, state, policy);
  // The ask never rises for the same quantity. If she drops to fewer pieces
  // than a group rate was given for, that group rate no longer applies: the
  // ask returns to this quantity's floor, and the action says why.
  state.askReset = false;
  if (floor > state.askPaisa) { state.askPaisa = floor; state.askReset = true; }
  const askReset = state.askReset;
  const offerPaisa = pricePaisa;
  state.bestOfferPaisa = Math.max(prev.qty === qty ? prev.bestOfferPaisa : 0, offerPaisa);

  const settle = (unit, why) => {
    // Never above the ask, never above the best price she herself named.
    const unitPaisa = Math.min(unit, state.askPaisa, state.bestOfferPaisa);
    if (unitPaisa < floor) throw new BhaoError("INTERNAL_BELOW_FLOOR"); // unreachable by construction
    state.status = "accepted";
    const offerId = "BHO-" + hash32(`${state.conversationId}:${state.round}:${unitPaisa}:${qty}`).toString(16).padStart(8, "0");
    const expiresAt = new Date(now.getTime() + policy.offerTtlMinutes * 60000).toISOString();
    const linePaisa = unitPaisa * qty;
    if (!Number.isSafeInteger(linePaisa)) throw new BhaoError("OVERFLOW");
    const accepted = { offerId, itemId: item.itemId, variantGid: item.variantGid, qty, unitPaisa, linePaisa,
                       expiresAt, policyVersion: policy.version, conversationId: state.conversationId, why };
    state.accepted = accepted;
    state.events.push({ round: state.round, kind: "accept", offerPaisa, unitPaisa, qty, why });
    return { state, action: { kind: "accept", askPaisa: unitPaisa, angle: "belonging", askReset: state.askReset,
                              delaySeconds: between(r, policy.delaySeconds.settle), offer: accepted } };
  };

  // 1. At or above the ask: done, at the lower of the two.
  //    She offered MORE than the ask: take only the ask, and say so. The
  //    phrasing layer must not thank her as if she won a bargain.
  if (offerPaisa > state.askPaisa) return settle(state.askPaisa, "offer_above_ask_extra_refused");
  if (offerPaisa === state.askPaisa) return settle(state.askPaisa, "offer_meets_ask");

  // She did not move: the same number again (or lower), after he has
  // started countering. Founder, 12 Nov: "just repeat the same number"
  // must never win - concessions go both ways, so he holds his price too.
  const noMove = prev.round > policy.refuseRounds && prev.qty === qty && offerPaisa <= prev.bestOfferPaisa;

  // 2. Fair offer after enough rounds: let her win - if she moved up to it.
  //    (offerPaisa >= floor is checked explicitly: the band is above the floor.)
  const settleLine = floor + Math.ceil(policy.settleBand * (state.askPaisa - floor));
  if (!noMove && state.round > policy.settleAfterRounds && offerPaisa >= settleLine && offerPaisa >= floor)
    return settle(offerPaisa, "fair_offer_after_rounds");

  // 2b. Last round: a deal at or above the floor beats no deal, if the
  //     policy says so (founder decision). Settles at HER best offer.
  if (policy.settleAtLastRound === true && state.round >= policy.maxRounds && state.bestOfferPaisa >= floor)
    return settle(state.bestOfferPaisa, "last_round_best_offer");

  // 3. Lowball: long pause, sharp check, no counter, no movement.
  if (offerPaisa < Math.floor(item.anchorPaisa * policy.lowballRatio)) {
    state.events.push({ round: state.round, kind: "lowball_check", offerPaisa, qty });
    return maybeClose(state, policy, r, { kind: "lowball_check", askPaisa: null, angle: "disappointment",
                                           delaySeconds: between(r, policy.delaySeconds.lowball) });
  }

  // 4. The first rounds: refuse without naming a price.
  if (state.round <= policy.refuseRounds) {
    const angle = pickAngle(r, state, ["quality_vs_market", "running_costs", "already_tight", "belonging"]);
    state.lastAngle = angle;
    state.events.push({ round: state.round, kind: "refuse", offerPaisa, qty });
    return maybeClose(state, policy, r, { kind: "refuse", askPaisa: null, angle,
                                           delaySeconds: between(r, policy.delaySeconds.normal) });
  }

  // 4b. She did not move: he holds his last price (no step toward her).
  if (noMove && state.askPaisa > floor) {
    const angle = pickAngle(r, state, ["already_tight", "running_costs", "belonging", "disappointment"]);
    state.lastAngle = angle;
    state.events.push({ round: state.round, kind: "counter", offerPaisa, askPaisa: state.askPaisa, qty, held: true });
    return maybeClose(state, policy, r, { kind: "counter", askPaisa: state.askPaisa, angle, held: true,
                                           delaySeconds: between(r, policy.delaySeconds.normal) });
  }

  // 5. Counter: a large, varied step toward her best offer, never below the floor.
  const target = Math.max(state.bestOfferPaisa, floor);
  let ask;
  if (state.askPaisa <= floor) {
    ask = floor; // nothing left to give
  } else {
    const gap = state.askPaisa - target; // > 0 here
    const planIdx = Math.min(state.round - policy.refuseRounds - 1, policy.stepPlan.length - 1);
    const jitter = 1 + (r() * 2 - 1) * policy.stepJitter;
    const step = Math.max(policy.roundToPaisa, Math.floor(gap * policy.stepPlan[planIdx] * jitter));
    ask = roundDown(state.askPaisa - step, policy.roundToPaisa);
    if (ask < floor) ask = floor;
    if (ask >= state.askPaisa) ask = Math.max(floor, state.askPaisa - policy.roundToPaisa);
  }
  if (ask <= state.bestOfferPaisa) return settle(state.bestOfferPaisa, "counter_reached_offer");

  const atFloor = ask === floor;
  state.askPaisa = ask;
  const preferred = atFloor ? ["last_word"]
    : (item.groupTiers || []).some((t) => t.minQty > qty) ? ["running_costs", "already_tight", "group_hint", "belonging"]
    : ["running_costs", "already_tight", "belonging", "disappointment"];
  const angle = atFloor ? "last_word" : pickAngle(r, state, preferred);
  state.lastAngle = angle;
  state.events.push({ round: state.round, kind: atFloor ? "final_offer" : "counter", offerPaisa, askPaisa: ask, qty });
  const nextGroup = (item.groupTiers || []).find((t) => t.minQty > qty) || null;
  return maybeClose(state, policy, r, { kind: atFloor ? "final_offer" : "counter", askPaisa: ask, angle, askReset,
    delaySeconds: between(r, policy.delaySeconds.normal),
    groupHint: nextGroup && angle === "group_hint" ? { minQty: nextGroup.minQty } : null });
}

function maybeClose(state, policy, r, action) {
  action = { ...action, askReset: state.askReset === true };
  if (state.round >= policy.maxRounds) {
    state.status = "closed";
    state.events.push({ round: state.round, kind: "closed" });
    return { state, action: { ...action, kind: "closed", closingAskPaisa: state.askPaisa, angle: "last_word" } };
  }
  return { state, action };
}

/**
 * The accepted offer as a quote-contract v1 line (door bhao_tao). Refused
 * after expiry; the caller passes the database clock.
 */
function toQuoteLine(accepted, { now, lineId = "B1" }) {
  if (!accepted) throw new BhaoError("NO_ACCEPTED_OFFER");
  if (!(now instanceof Date) || now.getTime() > Date.parse(accepted.expiresAt)) throw new BhaoError("OFFER_EXPIRED", accepted.offerId);
  return {
    lineId, door: "bhao_tao", shopifyVariantGid: accepted.variantGid, canonicalProductId: accepted.itemId, sku: null,
    unit: "piece", qty: accepted.qty, sellUnitLabel: `${accepted.qty} adad`, heroTier: null,
    provenance: { kind: "bhao_offer", offerId: accepted.offerId },
    ceilingLinePaisa: accepted.linePaisa, quotedLinePaisa: accepted.linePaisa,
    shopifyLine: {
      variantId: accepted.variantGid, quantity: accepted.qty,
      priceSet: { shopMoney: { amount: (accepted.unitPaisa / 100).toFixed(2), currencyCode: "PKR" } },
      properties: [{ name: "_asb_door", value: "bhao_tao" }, { name: "_asb_offer_id", value: accepted.offerId }],
    },
  };
}

module.exports = { BhaoError, ANGLES, validateItem, validatePolicy, floorFor, floorOf, open, offer, toQuoteLine };
