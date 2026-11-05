// F05 / F14 / quote contract R2 — the asal bill never charges a line above the
// amount accepted at checkout; every printed amount adds up to the paisa; cash
// on delivery is the FULL order total rounded DOWN once. Pure: no database.
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
  assert.equal(b.subtotalPaisa, 10000);
  assert.equal(b.payablePaisa, 10000);
  assert.equal(b.roundingCreditPaisa, 0);
  assert.match(b.rich, /= Rs 100 \(pehlay tha Rs 100\/kg, wazan zyada nikla, wade se zyada nahi liya\)/);
  assert.match(b.rich, /Asal bill: \*Rs 100\*/);
  assert.doesNotMatch(b.rich, /Rs 103|Rs 102/);
  assert.equal(b.params.asal_bill, "Rs 100");
  assert.ok(bill.templateSafe(b.params.bill_items).ok);
});

test("a capped bill's footer does not contradict the cap (review note)", () => {
  const b = bill.finalBill(order([onion({ qty_packed: "1.080" })]));
  assert.doesNotMatch(b.rich, /jitna nikla, utna hi laga/);
  assert.match(b.rich, /zyada nikla to wade se zyada nahi liya/);
  const under = bill.finalBill(order([onion({ qty_packed: "0.920" })]));
  assert.match(under.rich, /jitna nikla, utna hi laga/);
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
  assert.equal(bill.billedLinePaisa(onion({ qty_packed: "1.080", final_unit_price: null, billed_unit_price: "100.00" })), 10000);
});

test("0.92 kg packed bills the delivered weight, printed exactly", () => {
  const l = onion({ qty_packed: "0.920" });
  assert.equal(bill.billedLinePaisa(l), 8740);
  const b = bill.finalBill(order([l]));
  assert.match(b.rich, /= Rs 87\.40/);
  assert.match(b.rich, /Saman: Rs 87\.40\nPaisay ki chhoot: −Rs 0\.40\nAsal bill: \*Rs 87\*/);
  assert.equal(b.params.asal_bill, "Rs 87");
});

test("exact weight bills exactly; no breakdown when nothing sits between lines and cash", () => {
  const b = bill.finalBill(order([onion({ qty_packed: "1.000" })]));
  assert.equal(b.payablePaisa, 9500);
  assert.equal(b.roundingCreditPaisa, 0);
  assert.doesNotMatch(b.rich, /chhoot|Saman:/);
});

test("Rs 237.50 is collected as Rs 237 (money() alone would say Rs 238)", () => {
  const mango = { name_en: "Mango", unit: "kg", pack_size: 1, qty_ordered: "1.000", qty_packed: "0.950",
    ceiling_unit_price: "250.00", final_unit_price: "250.00", billed_unit_price: "250.00" };
  const b = bill.finalBill(order([mango]));
  assert.equal(b.subtotalPaisa, 23750);
  assert.equal(b.payablePaisa, 23700);
  assert.equal(b.roundingCreditPaisa, 50);
  assert.match(b.rich, /= Rs 237\.50/);
  assert.match(b.rich, /Asal bill: \*Rs 237\*/);
});

test("B5: two Rs 1.49 lines print Rs 1.49 each, Saman Rs 2.98, one order-level credit Rs 0.98", () => {
  const tiny = (sku) => ({ sku, name_en: sku, unit: "pcs", pack_size: 1, qty_ordered: "1.000", qty_packed: "1.000",
    ceiling_unit_price: "1.49", billed_unit_price: "1.49" });
  const b = bill.finalBill(order([tiny("A"), tiny("B")]));
  assert.equal((b.rich.match(/= Rs 1\.49/g) || []).length, 2);
  assert.match(b.rich, /Saman: Rs 2\.98\nPaisay ki chhoot: −Rs 0\.98\nAsal bill: \*Rs 2\*/);
  assert.equal(b.linePaisa.reduce((s, p) => s + p, 0), b.subtotalPaisa);
});

test("B1: delivery fee and discount are in the cash total, floored once", () => {
  const l = onion({ qty_packed: "0.920" }); // Rs 87.40
  const b = bill.finalBill(order([l], { delivery_fee: "50.00", discount: "20.00" }));
  assert.equal(b.subtotalPaisa, 8740);
  assert.equal(b.totalPaisa, 11740); // 87.40 + 50 - 20
  assert.equal(b.payablePaisa, 11700);
  assert.equal(b.roundingCreditPaisa, 40);
  assert.match(b.rich, /Saman: Rs 87\.40\nDelivery: Rs 50\nDiscount: −Rs 20\nPaisay ki chhoot: −Rs 0\.40\nAsal bill: \*Rs 117\*/);
  assert.equal(b.params.asal_bill, "Rs 117");
  // The reviewer's case: Rs 100 line, Rs 50 fee, Rs 20 discount -> Rs 130, not Rs 100.
  const r = bill.finalBill(order([onion({ qty_packed: "1.080" })], { delivery_fee: 50, discount: 20, grand_total: "130.00" }));
  assert.equal(r.payablePaisa, 13000);
  assert.match(r.rich, /Asal bill: \*Rs 130\*/);
});

test("B1: a discount larger than the bill gives zero, never negative (= SQL GREATEST)", () => {
  const b = bill.finalBill(order([onion({ qty_packed: "1.000" })], { discount: "500.00" }));
  assert.equal(b.totalPaisa, 0);
  assert.equal(b.payablePaisa, 0);
});

test("B3: a stale header that disagrees with the lines is refused, not billed", () => {
  // Order billed Rs 102.60 before 022; its line is now Rs 100.00.
  const l = onion({ qty_packed: "1.080", line_total: "100.00" });
  assert.throws(() => bill.finalBill(order([l], { billed_total: "102.60" })), /BILL_HEADER_MISMATCH/);
  assert.throws(() => bill.finalBill(order([l], { billed_total: "100.00", grand_total: "102.60" })), /BILL_HEADER_MISMATCH/);
  assert.equal(bill.finalBill(order([l], { billed_total: "100.00", grand_total: "100.00" })).payablePaisa, 10000);
});

test("a stored line_total above the accepted ceiling is refused", () => {
  assert.throws(() => bill.billedLinePaisa(onion({ qty_packed: "1.080", line_total: "102.60" })), /BILL_LINE_ABOVE_CEILING/);
});

test("B4: an unavailable line prints as Rs 0 and is not counted", () => {
  const gone = { name_en: "Lemon", unit: "kg", pack_size: 1, qty_ordered: "0.250", ceiling_unit_price: "400.00",
    billed_unit_price: "400.00", line_total: "100.00", is_unavailable: true };
  const b = bill.finalBill(order([onion({ qty_packed: "1.000", line_total: "95.00" }), gone], { billed_total: "95.00" }));
  assert.equal(b.subtotalPaisa, 9500);
  assert.deepEqual(b.linePaisa, [9500]);
  assert.match(b.rich, /Lemon — is dafa dastiyab nahi, Rs 0/);
  assert.doesNotMatch(b.rich, /= Rs 100/);
});

test("B6: exact decimals in BigInt; invalid or over-precise money is refused, never clamped", () => {
  // 0.3 kg at Rs 33.33/kg = 999.9 paisa -> 1000; floats would give 9.999000000000001.
  const l = { qty_ordered: "0.300", qty_packed: "0.300", ceiling_unit_price: "33.33", billed_unit_price: "33.33" };
  assert.equal(bill.billedLinePaisa(l), 1000);
  // Largest values the columns allow: NUMERIC(10,3) x NUMERIC(12,2) exceeds 2^53 as a product.
  const big = { qty_ordered: "9999999.999", qty_packed: "9999999.999", ceiling_unit_price: "9999999999.99",
    billed_unit_price: "9999999999.99" };
  assert.throws(() => bill.billedLinePaisa(big), /too large/); // refused, not silently wrong
  for (const bad of ["-1", "NaN", "Infinity", "1e3", "", null, "1.0001", 0.1 + 0.2]) {
    assert.throws(() => bill.billedLinePaisa({ ...l, qty_packed: bad ?? "x" }), /MONEY_INPUT_INVALID/, String(bad));
  }
  assert.throws(() => bill.codPayable(-1), /MONEY_INPUT_INVALID/);
  assert.throws(() => bill.codPayable(10.5), /MONEY_INPUT_INVALID/);
  assert.throws(() => bill.codPayable(Number.MAX_SAFE_INTEGER + 2), /MONEY_INPUT_INVALID/);
});

test("no bill line is ever above its accepted line ceiling (randomised)", () => {
  let seed = 22;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 5000; i++) {
    const ordered = (1 + Math.floor(rnd() * 5000)) / 1000;
    const packed = Math.round(ordered * (0.8 + rnd() * 0.4) * 1000) / 1000;
    const ceiling = (100 + Math.floor(rnd() * 40000)) / 100;
    const final = Math.round(ceiling * (0.7 + rnd() * 0.5) * 100) / 100;
    const l = { qty_ordered: ordered.toFixed(3), qty_packed: packed.toFixed(3), ceiling_unit_price: ceiling.toFixed(2),
      billed_unit_price: Math.min(ceiling, final).toFixed(2) };
    assert.ok(bill.billedLinePaisa(l) <= bill.acceptedLineCeilingPaisa(l), JSON.stringify(l));
  }
});

test("codPayable is floor to the rupee with the remainder as credit", () => {
  assert.deepEqual(bill.codPayable(176000), { payablePaisa: 176000, roundingCreditPaisa: 0 });
  assert.deepEqual(bill.codPayable(10260), { payablePaisa: 10200, roundingCreditPaisa: 60 });
  assert.deepEqual(bill.codPayable(99), { payablePaisa: 0, roundingCreditPaisa: 99 });
});

test("moneyExact prints paisa only when there are any", () => {
  assert.equal(bill.moneyExact(10000), "Rs 100");
  assert.equal(bill.moneyExact(8740), "Rs 87.40");
  assert.equal(bill.moneyExact(124005), "Rs 1,240.05");
});
