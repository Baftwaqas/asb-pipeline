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
