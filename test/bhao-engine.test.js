// ADR-002 Lane C — Bhao Tao rule-based bargaining engine (bhao/engine.js). Pure.
//   node --test test/bhao-engine.test.js
// The pot example is the founder's own (cost Rs 600, quoted Rs 1,800, a
// customer settling near Rs 900, five pots at about Rs 750). Floors and
// policy numbers here are TEST values, not approved prices.
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const B = require("../bhao/engine");

const POT = Object.freeze({
  itemId: "ASB-NG-POT-5L", variantGid: "gid://shopify/ProductVariant/900001", bhaoTaoEnabled: true, isGrocery: false,
  anchorPaisa: 180000, floorPaisa: 85000, costPaisa: 60000, maxQty: 20, approvedBy: "founder",
  groupTiers: [{ minQty: 5, floorPaisa: 75000 }],
});
const POLICY = Object.freeze({
  version: "BHAO-TEST-1", lowballRatio: 0.35, refuseRounds: 2, maxRounds: 10, stepPlan: [0.35, 0.25, 0.2, 0.15],
  stepJitter: 0.2, settleBand: 0.25, settleAfterRounds: 4, roundToPaisa: 1000,
  delaySeconds: { normal: [20, 90], lowball: [180, 420], settle: [10, 40] }, offerTtlMinutes: 120,
  settleAtLastRound: true,
});
const NOW = new Date("2026-11-06T10:00:00Z");
const start = (over = {}) => B.open({ conversationId: "C-1", item: POT, qty: 1, policy: POLICY, seed: "seed-1", ...over });
const say = (st, pricePaisa, qty) => B.offer(st, { item: POT, policy: POLICY, pricePaisa, qty, now: NOW });

test("opens at the anchor, no discount, quality pitch", () => {
  const { state, action } = start();
  assert.deepEqual([action.kind, action.askPaisa, action.angle], ["open", 180000, "quality_vs_market"]);
  assert.equal(state.askPaisa, 180000);
});

test("does not counter first: the first rounds refuse without naming a price", () => {
  let { state } = start();
  for (let i = 0; i < POLICY.refuseRounds; i++) {
    const r = say(state, 90000);
    assert.equal(r.action.kind, "refuse");
    assert.equal(r.action.askPaisa, null);
    assert.equal(r.state.askPaisa, 180000);
    state = r.state;
  }
  const r3 = say(state, 90000);
  assert.equal(r3.action.kind, "counter");
  assert.ok(r3.action.askPaisa < 180000);
});

test("a lowball gets a long pause and a sharp check, never a counter", () => {
  const r = say(start().state, 40000); // Rs 400 < 35% of Rs 1,800
  assert.equal(r.action.kind, "lowball_check");
  assert.equal(r.action.askPaisa, null);
  assert.ok(r.action.delaySeconds >= 180 && r.action.delaySeconds <= 420);
  assert.equal(r.state.askPaisa, 180000);
});

test("counters are big, varied steps, in round rupees", () => {
  let { state } = start();
  state = say(state, 90000).state; state = say(state, 90000).state;
  const asks = [];
  for (let i = 0; i < 4; i++) { const r = say(state, 90000); state = r.state; if (r.action.askPaisa) asks.push(r.action.askPaisa); }
  assert.ok(180000 - asks[0] >= 20000, "first counter moves at least Rs 200, not crumbs: " + asks[0]);
  for (const a of asks) assert.equal(a % 1000, 0);
  for (let i = 1; i < asks.length; i++) assert.ok(asks[i] <= asks[i - 1]);
});

test("the customer wins a fair offer after a few rounds (settle near Rs 900, never squeezed to the floor)", () => {
  let { state } = start();
  const offers = [70000, 80000, 85000, 90000, 92000, 95000, 98000];
  let last;
  for (const o of offers) { last = say(state, o); state = last.state; if (state.status !== "open") break; }
  assert.equal(state.status, "accepted");
  const a = state.accepted;
  assert.ok(a.unitPaisa >= POT.floorPaisa && a.unitPaisa <= 100000, String(a.unitPaisa));
  assert.ok(a.unitPaisa <= state.bestOfferPaisa);
  assert.equal(last.action.kind, "accept");
});

test("five pots unlock the group floor: Rs 760 a pot is a deal for five, never for one", () => {
  const drive = (qty) => {
    let { state } = start({ qty, seed: "g" + qty });
    for (let i = 0; i < POLICY.maxRounds && state.status === "open"; i++) state = say(state, 76000, qty).state;
    return state;
  };
  const one = drive(1), five = drive(5);
  assert.equal(one.status, "closed");               // Rs 760 < Rs 850 single floor: no deal
  assert.ok(one.askPaisa >= 85000);
  assert.equal(five.status, "accepted");            // Rs 760 >= Rs 750 group floor, held to the last round
  assert.equal(five.accepted.unitPaisa, 76000);
  assert.equal(five.accepted.why, "last_round_best_offer");
  assert.equal(five.accepted.linePaisa, 380000);
  assert.equal(B.floorFor(POT, 4), 85000);
  assert.equal(B.floorFor(POT, 5), 75000);
});

test("dropping from 5 pots to 1 restores the single-pot floor (the group rate was for 5)", () => {
  let { state } = start({ qty: 5 });
  for (let i = 0; i < 3; i++) state = say(state, 60000, 5).state; // keep it open, below every floor
  state = { ...state, askPaisa: 80000 };                         // an ask only a 5-pot order could get
  const r = say(state, 60000, 1);
  assert.equal(r.state.askPaisa >= 85000, true);
  assert.equal(r.action.askReset, true);
});

test("an offer at or above the ask settles at the ASK, not at her higher number", () => {
  let { state } = start();
  for (let i = 0; i < 3; i++) state = say(state, 90000).state;
  const ask = state.askPaisa;
  const r = say(state, ask + 50000);
  assert.equal(r.state.accepted.unitPaisa, ask);
});

test("without last-round settling, a firm Rs 760 for five pots closes with no deal", () => {
  const P = { ...POLICY, settleAtLastRound: false };
  let { state } = start({ qty: 5, seed: "g5" });
  for (let i = 0; i < P.maxRounds && state.status === "open"; i++)
    state = B.offer(state, { item: POT, policy: P, pricePaisa: 76000, qty: 5, now: NOW }).state;
  assert.equal(state.status, "closed");
});

test("closes after maxRounds with no deal below the floor", () => {
  let { state } = start();
  let r;
  for (let i = 0; i < POLICY.maxRounds; i++) { r = say(state, 70000); state = r.state; }
  assert.equal(state.status, "closed");
  assert.equal(r.action.kind, "closed");
  assert.throws(() => say(state, 90000), /CONVERSATION_CLOSED/);
});

test("deterministic: the same seed and offers replay the same conversation; another seed differs", () => {
  const play = (seed) => {
    let { state } = start({ seed }); const out = [];
    for (const o of [90000, 90000, 90000, 91000, 92000]) { const r = say(state, o); state = r.state; out.push([r.action.kind, r.action.askPaisa, r.action.angle, r.action.delaySeconds]); }
    return out;
  };
  assert.deepEqual(play("s-A"), play("s-A"));
  assert.notDeepEqual(play("s-A"), play("s-B"));
});

test("invariants hold for 2,000 random conversations", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let c = 0; c < 2000; c++) {
    let qty = 1 + Math.floor(rnd() * 8);
    let { state } = B.open({ conversationId: "R-" + c, item: POT, qty, policy: POLICY, seed: "r" + c });
    let lastAsk = state.askPaisa, lastQty = qty;
    while (state.status === "open") {
      if (rnd() < 0.1) qty = 1 + Math.floor(rnd() * 8);
      const price = 1000 * (30 + Math.floor(rnd() * 170));
      const r = say(state, price, qty);
      const floor = B.floorFor(POT, qty);
      assert.ok(r.state.askPaisa >= floor, "ask below floor");
      if (qty === lastQty && !r.action.askReset) assert.ok(r.state.askPaisa <= lastAsk, "ask rose");
      if (r.state.status === "accepted") {
        const a = r.state.accepted;
        assert.ok(a.unitPaisa >= floor && a.unitPaisa <= lastAsk && a.unitPaisa <= r.state.bestOfferPaisa);
        assert.equal(a.linePaisa, a.unitPaisa * a.qty);
      }
      assert.ok(r.state.round <= POLICY.maxRounds);
      lastAsk = r.state.askPaisa; lastQty = qty; state = r.state;
    }
  }
});

test("only founder-approved, non-grocery Bhao Tao items; floors never below cost", () => {
  const bad = (over, re) => assert.throws(() => start({ item: { ...POT, ...over } }), re);
  bad({ isGrocery: true }, /GROCERY_NEVER_BARGAINED/);
  bad({ isGrocery: undefined }, /GROCERY_NEVER_BARGAINED/);
  bad({ bhaoTaoEnabled: false }, /NOT_A_BHAO_TAO_ITEM/);
  bad({ floorPaisa: 50000 }, /FLOOR_BELOW_COST/);
  bad({ floorPaisa: 200000 }, /FLOOR_ABOVE_ANCHOR/);
  bad({ approvedBy: "" }, /approvedBy/);
  bad({ groupTiers: [{ minQty: 5, floorPaisa: 90000 }] }, /GROUP_FLOOR_NOT_LOWER/);
  bad({ groupTiers: [{ minQty: 5, floorPaisa: 50000 }] }, /FLOOR_BELOW_COST/);
  assert.throws(() => start({ qty: 21 }), /QTY_ABOVE_MAX/);
});

test("policy is explicit and cannot change mid-conversation", () => {
  assert.throws(() => B.validatePolicy({ ...POLICY, refuseRounds: 10 }), /INVALID_POLICY/);
  assert.throws(() => B.validatePolicy({ ...POLICY, stepPlan: [] }), /INVALID_POLICY/);
  assert.throws(() => B.validatePolicy({ ...POLICY, settleAtLastRound: undefined }), /INVALID_POLICY/);
  assert.throws(() => B.validatePolicy({ ...POLICY, delaySeconds: { normal: [5, 1], lowball: [1, 2], settle: [1, 2] } }), /INVALID_POLICY/);
  const { state } = start();
  assert.throws(() => B.offer(state, { item: POT, policy: { ...POLICY, version: "X" }, pricePaisa: 90000, now: NOW }), /POLICY_CHANGED/);
  for (const p of [0, -1, 1.5, "900"]) assert.throws(() => say(state, p), /INVALID_INTEGER/);
});

test("accepted offer becomes a bhao_tao quote line with an expiry", () => {
  let { state } = start({ qty: 2 });
  while (state.status === "open") state = say(state, 179000, 2).state;
  const line = B.toQuoteLine(state.accepted, { now: NOW });
  assert.equal(line.door, "bhao_tao");
  assert.deepEqual(line.provenance, { kind: "bhao_offer", offerId: state.accepted.offerId });
  assert.equal(line.ceilingLinePaisa, state.accepted.unitPaisa * 2);
  assert.equal(line.shopifyLine.quantity, 2);
  assert.throws(() => B.toQuoteLine(state.accepted, { now: new Date(NOW.getTime() + 121 * 60000) }), /OFFER_EXPIRED/);
});

test("angles vary and never repeat back to back", () => {
  let { state } = start({ seed: "angles" });
  let prev = state.lastAngle;
  for (let i = 0; i < 8 && state.status === "open"; i++) {
    const r = say(state, 88000);
    if (["refuse", "counter"].includes(r.action.kind)) assert.notEqual(r.action.angle, prev);
    prev = r.action.angle; state = r.state;
    assert.ok(B.ANGLES.includes(r.action.angle));
  }
});
