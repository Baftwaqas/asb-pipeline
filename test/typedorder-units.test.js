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
  assert.equal(packsFor(banana, 7, "pcs"), null);
  assert.equal(packsFor(egg, 1, "dozen"), 12);
});

test("kilo spellings still work", () => {
  assert.equal(packsFor(aloo, 2, "kilo"), 2);
  assert.equal(packsFor(aloo, 500, "gram"), 1);
  assert.equal(packsFor(aloo, 2, "dozen"), null);
});

test("the AI is told fruit names", () => {
  assert.match(SYSTEM, /kalay = banana/);
});

const { read } = require("../typedorder");
const fakeAi = (reply) => async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
const env = { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "m" };
const products = [
  { sku: "HP", name_en: "Hara Payaz", unit: "kg", min_qty: 1 },
  { sku: "TM", name_en: "Tamatar", unit: "kg", min_qty: 0.5 },
  { sku: "KL", name_en: "Kela", unit: "kg", min_qty: 1 },
];

test("rounding up to a pack is reported, never silent", async () => {
  const r = await read("adha kilo hara piyaz, aik pao tamatar, 1 kg tamatar", products, { env, fetchImpl: fakeAi({ items: [
    { sku: "HP", qty: 0.5, unit: "kg", said: "adha kilo hara piyaz" },
    { sku: "TM", qty: 1, unit: "pao", said: "aik pao tamatar" },
  ], unknown: [], unclear: [] }) });
  assert.deepEqual(r.lines, [{ sku: "HP", packs: 1 }, { sku: "TM", packs: 1 }]);
  assert.deepEqual(r.adjusted.map((x) => x.sku), ["HP", "TM"]);
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
