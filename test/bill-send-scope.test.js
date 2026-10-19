// Only pure scope parsing and identity checks; no DB, Shopify or Meta.
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const gate = require("../grocery/bill-send-scope");

const src = { id: "25", shopify_order_id: "7581509419266", origin: "live" };
const single = {
  GROCERY_BILL_SEND_SCOPE: "single",
  GROCERY_BILL_TARGET_SOURCE_ID: src.id,
  GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID: src.shopify_order_id,
};

test("fail closed when mode and targets are absent", () => {
  const cfg = gate.config({});
  assert.equal(cfg.mode, "off");
  assert.equal(cfg.valid, false);
  assert.equal(gate.allowsSource(src, {}), false);
});

test("single mode requires BOTH independent exact identifiers", () => {
  assert.equal(gate.config(single).valid, true);
  assert.equal(gate.allowsSource(src, single), true);
  assert.equal(gate.allowsSource({ ...src, id: "26" }, single), false);
  assert.equal(gate.allowsSource({ ...src, shopify_order_id: "7581509419267" }, single), false);
  assert.equal(gate.allowsSource({ ...src, origin: "backfill" }, single), false);
  assert.equal(gate.allowsSource({ ...src, origin: undefined }, single), false);
  assert.equal(gate.allowsSource(null, single), false);
  assert.equal(gate.allowsSource({ ...src, id: null }, single), false);
});

test("invalid, ambiguous or incomplete modes never permit a send", () => {
  const settings = [
    { ...single, GROCERY_BILL_SEND_SCOPE: "" },
    { ...single, GROCERY_BILL_SEND_SCOPE: "off" },
    { ...single, GROCERY_BILL_SEND_SCOPE: "ALL" },
    { ...single, GROCERY_BILL_SEND_SCOPE: "all" },
    { ...single, GROCERY_BILL_SEND_SCOPE: "single " },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "" },
    { ...single, GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID: "" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "025" },
    { ...single, GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID: "07581509419266" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "-25" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "2.5e1" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "25; SELECT 1" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: "9223372036854775808" },
    { ...single, GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID: "9223372036854775808" },
    { ...single, GROCERY_BILL_TARGET_SOURCE_ID: " 25" },
  ];
  for (const env of settings) {
    assert.equal(gate.config(env).valid, false, JSON.stringify(env));
    assert.equal(gate.allowsSource(src, env), false, JSON.stringify(env));
  }
});

test("global billing requires explicit ALL mode and no target IDs", () => {
  const all = { GROCERY_BILL_SEND_SCOPE: "all" };
  assert.equal(gate.config(all).valid, true);
  assert.equal(gate.allowsSource(src, all), true);
  assert.equal(gate.allowsSource({ ...src, id: "26" }, all), true);
  for (const env of [
    { ...all, GROCERY_BILL_TARGET_SOURCE_ID: "25" },
    { ...all, GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID: "7581509419266" },
  ]) {
    assert.equal(gate.config(env).valid, false);
    assert.equal(gate.allowsSource(src, env), false);
  }
});
