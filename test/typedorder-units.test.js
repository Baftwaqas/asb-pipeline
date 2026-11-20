"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { packsFor, SYSTEM } = require("../typedorder");

const banana = { sku: "ASB-FRT-002", unit: "dozen", min_qty: 1 };
const aloo = { sku: "A", unit: "kg", min_qty: 1 };
const egg = { sku: "E", unit: "pcs", min_qty: 1 };

test("dozen is understood in English and Urdu spellings", () => {
  for (const u of ["dozen", "darjan", "Dozen", "dazan"]) assert.equal(packsFor(banana, 1, u), 1, u);
  assert.equal(packsFor(banana, 2, "dozen"), 2);
});

test("pieces and dozens convert when they divide evenly", () => {
  assert.equal(packsFor(banana, 12, "pcs"), 1);
  assert.equal(packsFor(banana, 6, "pcs"), 0.5);
  assert.equal(packsFor(egg, 1, "dozen"), 12);
});

test("kilo spellings still work", () => {
  assert.equal(packsFor(aloo, 2, "kilo"), 2);
  assert.equal(packsFor(aloo, 500, "gram"), 0.5);
  assert.equal(packsFor(aloo, 2, "dozen"), null);
});

test("the AI is told fruit names", () => {
  assert.match(SYSTEM, /kalay\/kelly = banana/);
});

const { read } = require("../typedorder");
const fakeAi = (reply) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
const env = { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "m" };
const products = [
  { sku: "HP", name_en: "Hara Payaz", unit: "kg", min_qty: 1 },
  { sku: "TM", name_en: "Tamatar", unit: "kg", min_qty: 0.5 },
  { sku: "KL", name_en: "Kela", unit: "kg", min_qty: 1 },
];

test("any quantity (founder, 20 Nov): half a pack is half a pack, priced pro rata, nothing to report", async () => {
  const r = await read("adha kilo hara piyaz, aik pao tamatar", products, { env, fetchImpl: fakeAi({ items: [
    { sku: "HP", qty: 0.5, unit: "kg", said: "adha kilo hara piyaz" },
    { sku: "TM", qty: 1, unit: "pao", said: "aik pao tamatar" },
  ], unknown: [], unclear: [] }) });
  assert.deepEqual(r.lines, [{ sku: "HP", packs: 0.5 }, { sku: "TM", packs: 0.5 }]);
  assert.deepEqual(r.adjusted, []);
});

test("counted things stay whole, and that is reported", async () => {
  const kinno = [{ sku: "KN", name_en: "Kinno", unit: "pcs", min_qty: 1 }];
  const r = await read("dhai kinno", kinno, { env, fetchImpl: fakeAi({ items: [{ sku: "KN", qty: 2.5, unit: "piece", said: "dhai kinno" }] }) });
  assert.deepEqual(r.lines, [{ sku: "KN", packs: 3 }]);
  assert.deepEqual(r.adjusted.map((x) => x.sku), ["KN"]);
});

test("exact amounts are not reported", async () => {
  const r = await read("1 kg tamatar", products, { env, fetchImpl: fakeAi({ items: [{ sku: "TM", qty: 1, unit: "kg", said: "1 kg tamatar" }] }) });
  assert.deepEqual(r.adjusted, []);
});

test("pieces of something sold by the kilo: ask 'kitne kilo?'", async () => {
  const r = await read("12 kele", products, { env, fetchImpl: fakeAi({ items: [{ sku: "KL", qty: 12, unit: "piece", said: "12 kele" }] }) });
  assert.deepEqual(r.lines, []);
  assert.deepEqual(r.askUnit, [{ name: "Kela", unit: "kilo", said: "12 kele" }]);
});

test("kalay is banana, not kala tarbooz", () => {
  assert.match(SYSTEM, /never kala tarbooz/);
});

test("the order she checks says a pao and aadha darjan, not 0.25 kg", () => {
  const { spoken } = require("../autoorder");
  assert.equal(spoken(0.25, "kg", 1), "pao");
  assert.equal(spoken(0.3, "kg", 1), "300 g");
  assert.equal(spoken(0.5, "dozen", 1), "aadha darjan");
  assert.equal(spoken(2, "kg", 1), "2 kg");
});

test("the order-reader check is behind the inbox login", async () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "inbox.js"), "utf8");
  assert.match(src, /router\.post\("\/api\/inbox\/order-ai\/read", requireAuth,/);
});

test("objects in unclear/unknown become her words, never [object Object]", async () => {
  const r = await read("1 kg aloo, 2 kg chicken", products, { env, fetchImpl: fakeAi({ items: [],
    unclear: [{ said: "1 kg aloo", reason: "white or red?" }], unknown: [{ item: "chicken" }] }) });
  assert.deepEqual(r.unclear, ["1 kg aloo"]);
  assert.deepEqual(r.unknown, ["chicken"]);
});

test("one retry after a short 'too many requests'", async () => {
  const ai = require("../ai");
  let n = 0;
  const f = async () => (++n === 1)
    ? new Response(JSON.stringify({ error: { message: "Rate limit reached ... tokens per minute (TPM)" } }), { status: 429, headers: { "retry-after": "1" } })
    : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  const realErr = console.error; console.error = () => {};
  try { assert.equal(await ai.complete({ system: "s", user: "u", env, fetchImpl: f }), "ok"); } finally { console.error = realErr; }
  assert.equal(n, 2);
});

test("the compare option only accepts known model names, per call", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "inbox.js"), "utf8");
  assert.match(src, /anthropic: \/\^claude-\[a-z0-9.-\]\+\$\//);
  assert.match(src, /error: "bad_model"/);
});

test("openai: no temperature, max_completion_tokens, reasoning effort", async () => {
  const ai = require("../ai");
  let sent;
  const f = async (url, init) => { sent = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }); };
  const out = await ai.complete({ system: "s", user: "u", fetchImpl: f,
    env: { ORDER_AI_PROVIDER: "openai", OPENAI_API_KEY: "test-only", OPENAI_MODEL: "gpt-6-luna" } });
  assert.equal(out, "ok");
  assert.equal(sent.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent.body.temperature, undefined);
  assert.ok(sent.body.max_completion_tokens >= 3000);
  assert.equal(sent.body.reasoning_effort, "low");
});

test("the AI is told: kinds are asked (chicken too), mg = grams, moti mirch is not shimla, ditto marks", () => {
  assert.match(SYSTEM, /TYPES: .*do not pick one: put it in choose/);
  assert.match(SYSTEM, /chicken\/murghi -> Mix Boti \/ Boneless/);
  assert.match(SYSTEM, /250 mg = 250 g/);
  assert.match(SYSTEM, /'moti mirch' is Moti Mirch/);
  assert.match(SYSTEM, /ditto mark/);
});

test("Claude 5.x: no temperature, effort via output_config, room for thinking", async () => {
  const ai = require("../ai");
  let body;
  const f = async (_u, init) => { body = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "ok" }] }), { status: 200 }); };
  const out = await ai.complete({ system: "s", user: "u", fetchImpl: f,
    env: { ORDER_AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-only", ANTHROPIC_MODEL: "claude-haiku-5-5" } });
  assert.equal(out, "ok");
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.output_config, { effort: "low" });
  assert.ok(body.max_tokens >= 4000);
});
