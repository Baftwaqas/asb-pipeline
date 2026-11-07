// Seth Ji's voice (bhao/voice.js): the model only speaks; every reply is
// checked against the engine's decision before a customer sees it.
// No network: providers are faked.  node --test test/bhao-voice.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const V = require("../bhao/voice");
const B = require("../bhao/engine");

const POT = Object.freeze({
  itemId: "ASB-NG-POT-5L", variantGid: "gid://shopify/ProductVariant/900001", bhaoTaoEnabled: true, isGrocery: false,
  anchorPaisa: 180000, floorPaisa: 85000, costPaisa: 60000, maxQty: 20, approvedBy: "founder",
  groupTiers: [{ minQty: 5, floorPaisa: 75000 }],
});
const POLICY = Object.freeze({
  version: "BHAO-TEST-1", lowballRatio: 0.35, refuseRounds: 2, maxRounds: 10, stepPlan: [0.35, 0.25, 0.2, 0.15],
  stepJitter: 0.2, settleBand: 0.25, settleAfterRounds: 4, roundToPaisa: 1000,
  delaySeconds: { normal: [20, 90], lowball: [180, 420], settle: [10, 40] }, offerTtlMinutes: 120, settleAtLastRound: true,
});
const NOW = new Date("2026-11-07T06:00:00Z");
const XAI = { BHAO_VOICE_PROVIDER: "xai", XAI_API_KEY: "test-key-not-real", XAI_MODEL: "grok-test" };
const ANT = { BHAO_VOICE_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_MODEL: "claude-test" };

/** A fake provider that answers with the given replies in turn and records requests. */
function fake(replies, { status = 200, shape = "xai" } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const text = replies[Math.min(calls.length - 1, replies.length - 1)];
    const body = shape === "xai" ? { choices: [{ message: { content: text } }] } : { content: [{ type: "text", text }] };
    return { ok: status < 400, status, json: async () => body };
  };
  return { fn, calls };
}
const counter = (ask) => ({ kind: "counter", askPaisa: ask, angle: "running_costs" });
const base = { itemName: "Steel ki Degchi 5 litre", groupSizes: [5] };

test("a good Grok reply is used as written, with the key only in the auth header", async () => {
  const f = fake(["Baji petrol ka kharcha alag hai, phir bhi aap ke liye Rs 1,540. Ab khush?"]);
  const r = await V.speak({ ...base, decision: counter(154000), offerPaisa: 90000, customerText: "900 mein de do",
                            env: XAI, fetchImpl: f.fn });
  assert.equal(r.source, "ai");
  assert.equal(r.provider, "xai");
  assert.match(r.text, /Rs 1,540/);
  assert.equal(f.calls[0].url, "https://api.x.ai/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer test-key-not-real");
  assert.equal(f.calls[0].body.model, "grok-test");
  assert.doesNotMatch(JSON.stringify(f.calls[0].body), /test-key-not-real/);
  assert.doesNotMatch(JSON.stringify(r), /test-key-not-real/);
});

test("Groq works through its OpenAI-compatible API", async () => {
  const f = fake(["Chalein baji, Rs 1,540 aap ke liye."]);
  const r = await V.speak({ ...base, decision: counter(154000),
    env: { BHAO_VOICE_PROVIDER: "groq", GROQ_API_KEY: "test-key-not-real", GROQ_MODEL: "groq-test" }, fetchImpl: f.fn });
  assert.equal(r.source, "ai");
  assert.equal(r.provider, "groq");
  assert.equal(f.calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer test-key-not-real");
  assert.equal(f.calls[0].body.model, "groq-test");
});

test("Anthropic works the same way through its own API", async () => {
  const f = fake(["Chalein baji, Rs 1,540 aap ke liye."], { shape: "anthropic" });
  const r = await V.speak({ ...base, decision: counter(154000), env: ANT, fetchImpl: f.fn });
  assert.equal(r.source, "ai");
  assert.equal(f.calls[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(f.calls[0].init.headers["x-api-key"], "test-key-not-real");
});

test("a reply with a price the engine did not give is rejected, retried once with the reason", async () => {
  const f = fake(["Baji aap ke liye Rs 1,200, bas!", "Theek hai baji, Rs 1,540 aap ke liye."]);
  const r = await V.speak({ ...base, decision: counter(154000), offerPaisa: 90000, env: XAI, fetchImpl: f.fn });
  assert.equal(r.source, "ai");
  assert.equal(r.attempts, 2);
  assert.match(r.rejected[0], /number not allowed: 1200/);
  assert.match(f.calls[1].body.messages[1].content, /PREVIOUS REPLY WAS REJECTED: number not allowed: 1200/);
});

test("two bad replies fall back to the template; the customer never sees a wrong price", async () => {
  const f = fake(["Rs 999 le lo baji", "Rs 1,000 final"]);
  const r = await V.speak({ ...base, decision: counter(154000), env: XAI, fetchImpl: f.fn });
  assert.equal(r.source, "template");
  assert.match(r.text, /Rs 1,540/);
  assert.equal(r.rejected.length, 2);
});

test("waqas case 1: Rs 2,000 against Rs 1,800 - the extra is refused, honestly", async () => {
  const { state } = B.open({ conversationId: "W1", item: POT, qty: 1, policy: POLICY, seed: "w1" });
  const step = B.offer(state, { item: POT, policy: POLICY, pricePaisa: 200000, now: NOW });
  const prompt = V.buildPrompt({ decision: step.action, itemName: base.itemName, qty: 1, customerText: "Rs 2000" });
  assert.match(prompt.user, /offered MORE than your price/);
  assert.match(prompt.user, /PRICE: Rs 1,800/);
  // a model that thanks her for Rs 2,000 as if she won is still allowed to quote both numbers...
  const ok = V.checkReply("Arre baji, Rs 2,000 nahi! Daam Rs 1,800 hai, utna hi lunga 😄",
    { decision: step.action, qty: 1, offerPaisa: 200000, groupSizes: [5] });
  assert.equal(ok.ok, true);
  // ...but one that takes Rs 2,000 cannot get through without stating Rs 1,800
  const bad = V.checkReply("Shukriya baji, Rs 2,000 mein sauda pakka!", { decision: step.action, qty: 1, offerPaisa: 200000 });
  assert.equal(bad.ok, false);
  assert.ok(bad.why.includes("price not stated"));
  const t = V.template(step.action, { offerPaisa: 200000 });
  assert.match(t, /Rs 2,000 nahi! Daam Rs 1,800/);
});

test("waqas case 2: 'Rs 200,000' is an amount, and any figure the reply makes up is caught", () => {
  assert.deepEqual(V.numbersIn("Rs 200,000 de doon?"), [200000]);
  assert.deepEqual(V.numbersIn("2 lakh mein?"), [200000]);
  assert.deepEqual(V.numbersIn("1.2k chalega"), [1200]);
  const d = { kind: "accept", askPaisa: 180000, offer: { unitPaisa: 180000, why: "offer_above_ask_extra_refused" } };
  assert.equal(V.checkReply("Baji Rs 200,000?! 😂 Degchi Rs 1,800 ki hai.", { decision: d, qty: 1, offerPaisa: 20000000 }).ok, true);
  assert.equal(V.checkReply("Baji 100 degchiyan de doon? Degchi Rs 1,800 ki hai.", { decision: d, qty: 1, offerPaisa: 20000000 }).ok, false);
});

test("'aakhri daam' on a counter is bazaar custom and allowed; invented scarcity is not (founder's call, 7 Nov)", () => {
  assert.equal(V.checkReply("Baji, aakhri daam Rs 1,540, is se neeche nahi.", { decision: counter(154000), qty: 1 }).ok, true);
  assert.equal(V.checkReply("Baji last price Rs 1,540!", { decision: counter(154000), qty: 1 }).ok, true);
  assert.equal(V.checkReply("Baji last piece hai, Rs 1,540 le lo", { decision: counter(154000), qty: 1 }).ok, false);
  const p = V.buildPrompt({ decision: counter(154000), itemName: "Degchi", qty: 1, itemFacts: ["mota steel"] });
  assert.match(p.user, /ITEM FACTS \(the only claims you may make\): mota steel/);
  assert.match(V.buildPrompt({ decision: counter(154000), itemName: "D", qty: 1 }).system, /aakhri daam/);
});

test("counts in words are numbers too: no invented 2-3 piece discount (Groq live run, 7 Nov)", () => {
  const d = counter(152000);
  const live = "Chalein baji, ek piece Rs 1,520, lekin do‑teen le lo to thoda aakhri daam kam kar dunga. 😄";
  assert.equal(V.checkReply(live, { decision: d, qty: 1, groupSizes: [5] }).ok, false);
  assert.equal(V.checkReply("Baji, paanch le lo toh aur kam ho jayega. Abhi Rs 1,520.", { decision: d, qty: 1, groupSizes: [5] }).ok, true);
  assert.equal(V.checkReply("Baji, teen le lo toh kam kar doon. Rs 1,520.", { decision: d, qty: 1, groupSizes: [5] }).ok, false);
  assert.equal(V.checkReply("Baji, Rs 1,520 de do, sauda pakka.", { decision: d, qty: 1 }).ok, true, "'de do' is a verb, not a count");
});

test("refuse, lowball, closed and talk may not name any number at all", () => {
  for (const kind of ["refuse", "lowball_check", "closed", "talk"]) {
    const d = { kind, askPaisa: 180000 };
    assert.equal(V.checkReply("Baji is pe Rs 1,500 kar deta hoon", { decision: d, qty: 1, offerPaisa: 90000 }).ok, false, kind);
    assert.equal(V.checkReply("Na baji, is pe nahi hoga. Thora barhayen.", { decision: d, qty: 1, offerPaisa: 90000 }).ok, true, kind);
  }
});

test("no invented scarcity, competitors, links, phone numbers, labels or long essays", () => {
  const d = counter(154000);
  const bad = [
    "Baji last piece hai, Rs 1,540 le lo",
    "Daraz pe mehenga hai, Rs 1,540 yahan",
    "Rs 1,540 baji, details www.example.com pe",
    "Rs 1,540 baji, call karein 03001234567",
    "Seth Ji: Rs 1,540 baji",
    "Main ek chatbot hoon, Rs 1,540",
    "Rs 1,540 " + "bohat ".repeat(60),
  ];
  for (const t of bad) assert.equal(V.checkReply(t, { decision: d, qty: 1 }).ok, false, t);
});

test("provider trouble falls straight back to the template without a second call", async () => {
  for (const f of [fake(["x"], { status: 500 }), { fn: async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); }, calls: [] }]) {
    const r = await V.speak({ ...base, decision: counter(154000), env: XAI, fetchImpl: f.fn });
    assert.equal(r.source, "template");
    assert.match(r.text, /Rs 1,540/);
  }
});

test("off, unknown provider or a missing key/model means templates, never an error", async () => {
  let called = false;
  const spy = async () => { called = true; throw new Error("should not be called"); };
  for (const env of [{}, { BHAO_VOICE_PROVIDER: "off" }, { BHAO_VOICE_PROVIDER: "openai" },
                     { BHAO_VOICE_PROVIDER: "xai", XAI_MODEL: "m" }, { BHAO_VOICE_PROVIDER: "xai", XAI_API_KEY: "k" }]) {
    const r = await V.speak({ ...base, decision: counter(154000), env, fetchImpl: spy });
    assert.equal(r.source, "template");
  }
  assert.equal(called, false);
});

test("every engine decision in 300 random conversations gets a valid line from the templates", async () => {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let c = 0; c < 300; c++) {
    let { state, action } = B.open({ conversationId: "T" + c, item: POT, qty: 1, policy: POLICY, seed: "t" + c });
    let last = action, offer = null;
    for (;;) {
      const t = V.template(last, { offerPaisa: offer });
      const ck = V.checkReply(t, { decision: last, qty: state.qty, offerPaisa: offer, groupSizes: [5] });
      assert.equal(ck.ok, true, `${last.kind}: ${t} (${ck.why})`);
      if (state.status !== "open") break;
      offer = 1000 * (30 + Math.floor(rnd() * 200));
      const step = B.offer(state, { item: POT, policy: POLICY, pricePaisa: offer, now: NOW });
      state = step.state; last = step.action;
    }
  }
});

test("an unknown decision kind is a programming error", async () => {
  await assert.rejects(V.speak({ ...base, decision: { kind: "free_gift" }, env: {} }), /unknown decision kind/);
});
