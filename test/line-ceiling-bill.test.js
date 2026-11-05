// F05 / F14 / quote contract R2 — the asal bill never charges a line above the
// amount accepted at checkout, and cash on delivery is whole rupees rounded
// DOWN. Pure: no database.
//   node --test test/line-ceiling-bill.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const bill = require("../bill");

// Payaz, 1 kg ordered at a ceiling of Rs 100/kg; mandi came in at Rs 95/kg.
const onion = (over = {}) => ({
  sku: "ASB-VEG-ONION", name_en: "Onion", name_ur: "پیاز", unit: "kg", pack_size: 1,
  qty_ordered: "1.000", ceiling_unit_price: "100.00", final_unit_price: "95.00", billed_unit_price: "95.00",
  ...over,
});
const order = (lines, over = {}) => ({ order_number: "ASB-T-1", customer_name: "Ayesha Khan", lines, ...over });

test("1.08 kg packed at Rs 95/kg bills Rs 100, not Rs 102.60 (the preflight counterexample)", () => {
  const l = onion({ qty_packed: "1.080" });
  assert.equal(bill.billedLinePaisa(l), 10000);
  const b = bill.finalBill(order([l]));
  assert.equal(b.billedPaisa, 10000);
  assert.equal(b.payablePaisa, 10000);
  assert.equal(b.roundingCreditPaisa, 0);
  assert.match(b.rich, /= Rs 100 \(pehlay tha Rs 100\/kg, wazan zyada nikla, wade se zyada nahi liya\)/);
  assert.match(b.rich, /Asal bill: \*Rs 100\*/);
  assert.doesNotMatch(b.rich, /Rs 103|Rs 102/);
  assert.equal(b.params.asal_bill, "Rs 100");
  assert.ok(bill.templateSafe(b.params.bill_items).ok);
});

test("over-packed but still under the promise is billed by weight and not flagged", () => {
  const l = onion({ qty_packed: "1.080", final_unit_price: "90.00", billed_unit_price: "90.00" });
  assert.equal(bill.billedLinePaisa(l), 9720); // 1.08 x 90 = 97.20 <= 100
  const b = bill.finalBill(order([l]));
  assert.doesNotMatch(b.rich, /wazan zyada nikla/);
  assert.equal(b.payablePaisa, 9700);
  assert.equal(b.roundingCreditPaisa, 20);
});

test("over-packed before any mandi price (rate = ceiling) stops at the ceiling", () => {
  const l = onion({ qty_packed: "1.080", final_unit_price: null, billed_unit_price: "100.00" });
  assert.equal(bill.billedLinePaisa(l), 10000);
});

test("0.92 kg packed bills the delivered weight (customer benefits)", () => {
  const l = onion({ qty_packed: "0.920" });
  assert.equal(bill.billedLinePaisa(l), 8740);
  const b = bill.finalBill(order([l]));
  assert.match(b.rich, /Asal bill: \*Rs 87\*/);
  assert.match(b.rich, /Paisay ki chhoot: Rs 0\.40/);
  assert.equal(b.params.asal_bill, "Rs 87");
});

test("exact weight bills exactly", () => {
  const l = onion({ qty_packed: "1.000" });
  assert.equal(bill.billedLinePaisa(l), 9500);
  const b = bill.finalBill(order([l]));
  assert.equal(b.payablePaisa, 9500);
  assert.equal(b.roundingCreditPaisa, 0);
  assert.doesNotMatch(b.rich, /chhoot/);
});

test("cash is rounded DOWN, never up: Rs 237.50 is collected as Rs 237 (money() alone would say Rs 238)", () => {
  const mango = { name_en: "Mango", unit: "kg", pack_size: 1, qty_ordered: "1.000", qty_packed: "0.950",
    ceiling_unit_price: "250.00", final_unit_price: "250.00", billed_unit_price: "250.00" };
  const b = bill.finalBill(order([mango]));
  assert.equal(b.billedPaisa, 23750);
  assert.equal(b.payablePaisa, 23700);
  assert.equal(b.roundingCreditPaisa, 50);
  assert.match(b.rich, /Asal bill: \*Rs 237\*/);
  assert.match(b.rich, /Paisay ki chhoot: Rs 0\.50/);
});

test("the database line_total is the authority when present", () => {
  const l = onion({ qty_packed: "1.080", line_total: "100.00" });
  assert.equal(bill.billedLinePaisa(l), 10000);
  const b = bill.finalBill(order([l], { billed_total: "100.00" }));
  assert.equal(b.billedPaisa, 10000);
});

test("integer paisa: no floating-point drift on 1.08 x 95 or 0.1 + 0.2 shaped amounts", () => {
  // 3 x 0.1 kg at Rs 33.33/kg would be 9.999000000000001 in floats.
  const l = { unit: "kg", pack_size: 1, qty_ordered: "0.300", qty_packed: "0.300",
    ceiling_unit_price: "33.33", final_unit_price: "33.33", billed_unit_price: "33.33" };
  assert.equal(bill.billedLinePaisa(l), 1000); // round-half-up(999.9) = 1000
  assert.equal(bill.acceptedLineCeilingPaisa(l), 1000);
});

test("no bill line is ever above its accepted line ceiling (randomised)", () => {
  let seed = 22;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 5000; i++) {
    const ordered = (1 + Math.floor(rnd() * 5000)) / 1000;
    const packed = Math.round(ordered * (0.8 + rnd() * 0.4) * 1000) / 1000;
    const ceiling = (100 + Math.floor(rnd() * 40000)) / 100;
    const final = Math.round(ceiling * (0.7 + rnd() * 0.5) * 100) / 100;
    const l = { qty_ordered: ordered, qty_packed: packed, ceiling_unit_price: ceiling,
      billed_unit_price: Math.min(ceiling, final) };
    assert.ok(bill.billedLinePaisa(l) <= bill.acceptedLineCeilingPaisa(l), JSON.stringify(l));
  }
});

test("codPayable is floor to the rupee with the remainder as credit", () => {
  assert.deepEqual(bill.codPayable(176000), { payablePaisa: 176000, roundingCreditPaisa: 0 });
  assert.deepEqual(bill.codPayable(10260), { payablePaisa: 10200, roundingCreditPaisa: 60 });
  assert.deepEqual(bill.codPayable(99), { payablePaisa: 0, roundingCreditPaisa: 99 });
});
