"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bill = require("../bill");
const T = require("../templates");

function checkoutOrder() {
  return {
    customer_name: "Waqas",
    order_number: "ASB-001017",
    ordered_at: "2026-10-17T11:01:00.000Z",
    delivery_date: "2026-10-19",
    lines: [
      {
        sku: "KHAJOOR-500",
        name_en: "Khajoor",
        qty_ordered: 1,
        unit: "g",
        pack_size: 500,
        ceiling_unit_price: 650,
        market_unit_price: 800,
      },
      {
        sku: "TARBOOZ-1KG",
        name_en: "Anarkali Tarbooz",
        qty_ordered: 1,
        unit: "kg",
        pack_size: 1,
        ceiling_unit_price: 80,
        market_unit_price: 200,
      },
    ],
  };
}

test("bill UX v3 compares Market vs ASB on the exact same weight/pack", () => {
  const out = bill.orderConfirmationV3(checkoutOrder());

  assert.equal(out.comparisonReady, true);
  assert.equal(out.totalSaving, 270);

  assert.match(out.rich, /\*Khajoor — aadha kg\*/);
  assert.match(out.rich, /🔴 Market Rate: Rs 800/);
  assert.match(out.rich, /🟢 \*ASB Rate: Rs 650\*/);
  assert.match(out.rich, /🎉 \*Aap ki Bachat: Rs 150\*/);

  assert.match(out.rich, /\*Anarkali Tarbooz — 1 kg\*/);
  assert.match(out.rich, /🔴 Market Rate: Rs 200/);
  assert.match(out.rich, /🟢 \*ASB Rate: Rs 80\*/);
  assert.match(out.rich, /🎉 \*Aap ki Bachat: Rs 120\*/);

  assert.match(out.rich, /🔴 Market Total: Rs 1,000/);
  assert.match(out.rich, /🟢 \*ASB Total: Rs 730\*/);
  assert.match(out.rich, /🎉 \*Aap ki Total Bachat: Rs 270\*/);

  // The old confusing cross-weight comparison must not return in v3.
  assert.doesNotMatch(out.rich, /Rs 1,300\/kg/);
  assert.doesNotMatch(out.rich, /Rs 1,600\/kg/);
  assert.doesNotMatch(out.rich, /delivery charge/i);
});

test("bill UX v3 template-safe flat list keeps the same Market -> ASB -> Bachat hierarchy", () => {
  const out = bill.orderConfirmationV3(checkoutOrder());
  const params = T.orderBillV3Params(out);

  assert.match(out.flat, /Khajoor — aadha kg: 🔴 Market Rate Rs 800 \| 🟢 \*ASB Rate Rs 650\* \| 🎉 \*Aap ki Bachat Rs 150\*/);
  assert.match(out.flat, /Anarkali Tarbooz — 1 kg: 🔴 Market Rate Rs 200 \| 🟢 \*ASB Rate Rs 80\* \| 🎉 \*Aap ki Bachat Rs 120\*/);

  assert.equal(params[5].name, "market_total");
  assert.equal(params[5].value, "Rs 1,000");
  assert.equal(params[6].name, "asb_total");
  assert.equal(params[6].value, "Rs 730");
  assert.equal(params[7].name, "total_bachat");
  assert.equal(params[7].value, "Rs 270");
});

test("v3 is staged without replacing the approved production v2 template", () => {
  assert.equal(T.TEMPLATES.orderBill.name, "asb_order_bill_v2");
  assert.equal(T.TEMPLATES.finalBill.name, "asb_final_bill_v2");
  assert.equal(T.TEMPLATES.orderBillV3.name, "asb_order_bill_v3");
  assert.equal(T.TEMPLATES.finalBillV3.name, "asb_final_bill_v3");

  assert.match(T.TEMPLATES.orderBillV3.body, /🔴 Market Total/);
  assert.match(T.TEMPLATES.orderBillV3.body, /🟢 \*ASB Total/);
  assert.match(T.TEMPLATES.orderBillV3.body, /🎉 \*Aap ki Total Bachat/);
});

test("final bill v3 compares the same final packed quantity", () => {
  const order = checkoutOrder();
  order.lines = [{
    ...order.lines[0],
    qty_packed: 1,
    billed_unit_price: 640,
  }];

  const out = bill.finalBillV3(order);

  assert.equal(out.comparisonReady, true);
  assert.equal(out.totalSaving, 160);
  assert.match(out.rich, /\*Khajoor — aadha kg\*/);
  assert.match(out.rich, /🔴 Market Rate: Rs 800/);
  assert.match(out.rich, /🟢 \*ASB Rate: Rs 640\*/);
  assert.match(out.rich, /🎉 \*Aap ki Bachat: Rs 160\*/);
  assert.match(out.rich, /🟢 \*ASB Final Total: Rs 640\*/);
});

test("v3 never invents a market comparison when market data is missing", () => {
  const order = checkoutOrder();
  order.lines[0].market_unit_price = null;

  const out = bill.orderConfirmationV3(order);

  assert.equal(out.comparisonReady, false);
  assert.match(out.rich, /Khajoor — aadha kg/);
  assert.match(out.rich, /🔴 Market Rate: rate available nahi/);
  assert.match(out.rich, /🟢 \*ASB Rate: Rs 650\*/);
  assert.match(out.rich, /Aap ki Total Bachat: market rates complete hone ke baad/);
});
