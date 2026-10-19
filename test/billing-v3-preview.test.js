"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {preview}=require("../billing/v3-preview");
const NOW="2026-10-19T08:00:00Z";
const evidence={source:"Johar bazaar field check",checkedAt:"2026-10-19T07:00:00Z",comparableQuality:true};
const ginger=(extra={})=>({name:"Adrak",quantity:"250 gram",ceilingLinePaisa:14500,finalLinePaisa:14000,
  bazaarLinePaisa:20000,marketObservation:evidence,...extra});
const bill=(overrides={})=>({feature:"apna_order",orderNumber:"ASB-001018",customerName:"Waqas",deliveryDate:"Thursday, 22 October",
 now:NOW,lines:[ginger()],...overrides});
test("Realistic #1037 preview: basket-level savings first and 250g prices (not per-kg multiplication)",()=>{
 const v=preview(bill());
 assert.equal(v.comparisonComplete,true);assert.equal(v.payablePaisa,14500);assert.equal(v.netBasketSavingPaisa,5500);
 assert.match(v.whatsappDraft,/POORI BASKET KI BACHAT: Rs 55/);
 assert.match(v.whatsappDraft,/Adrak \(250 gram\): ASB Rs 145 \| Bazaar Rs 200 \| Bachat Rs 55/);
 assert.doesNotMatch(v.whatsappDraft,/580\/kg|800\/kg|pao ×/);
 assert.match(v.whatsappDraft,/Delivery: FREE/);
 assert.match(v.whatsappDraft,/Zyada se zyada denge: Rs 145/);
 assert.equal(v.previewTooLong,false);
});
test("Whole-basket savings subtracts negative item comparisons, not only wins",()=>{
 const v=preview(bill({lines:[
  ginger(),{name:"Tamatar",quantity:"500 gram",ceilingLinePaisa:11000,bazaarLinePaisa:10000,marketObservation:evidence}
 ]}));
 assert.equal(v.marketReferenceTotalPaisa,30000);
 assert.equal(v.payablePaisa,25500);
 assert.equal(v.netBasketSavingPaisa,4500);
 assert.match(v.whatsappDraft,/Rs 45/);
 assert.match(v.whatsappDraft,/Tamatar .*ASB Rs 10 zyada/);
});
test("Missing or old observation never produces invented full-basket savings",()=>{
 for(const missing of [ginger({marketObservation:null}),
 ginger({marketObservation:{...evidence,checkedAt:"2026-10-10T07:00:00Z"}}),
 ginger({marketObservation:{...evidence,comparableQuality:false}}),
 ginger({marketObservation:{...evidence,source:""}})]) {
  const v=preview(bill({lines:[missing]}));
  assert.equal(v.comparisonComplete,false);assert.equal(v.netBasketSavingPaisa,null);
  assert.match(v.headline,/abhi tasdeeq nahi hui/);
  assert.match(v.whatsappDraft,/Bazaar rate verify nahi hua/);
 }
});
test("Partial coverage is explicitly partial; no whole-basket saving or wrongly allocated discount",()=>{
 const v=preview(bill({lines:[ginger(),{name:"Aloo",quantity:"1 kg",ceilingLinePaisa:8000}],
  discountPaisa:1000}));
 assert.equal(v.marketComparedCount,1);assert.equal(v.itemCount,2);
 assert.equal(v.netBasketSavingPaisa,null);
 assert.match(v.headline,/1\/2 items compare hue/);
 assert.equal(v.payablePaisa,21500);
});
test("Complete comparison includes discount in final basket total transparently",()=>{
 const v=preview(bill({discountPaisa:1000}));
 assert.equal(v.payablePaisa,13500);
 assert.equal(v.netBasketSavingPaisa,6500);
 assert.match(v.whatsappDraft,/Discount: -Rs 10/);
 assert.match(v.whatsappDraft,/Rs 135/);
});
test("If basket is pricier, say so instead of claiming a misleading Rs 0 saving",()=>{
 const v=preview(bill({lines:[ginger({ceilingLinePaisa:24000})]}));
 assert.equal(v.netBasketSavingPaisa,-4000);
 assert.match(v.headline,/Rs 40 zyada/);
 assert.doesNotMatch(v.headline,/BACHAT/);
});
test("All grocery delivery must be free; final bill distinct from maximum amount",()=>{
 assert.throws(()=>preview(bill({deliveryPaisa:30000})),/FREE_DELIVERY_POLICY_CONFLICT/);
 const v=preview(bill({phase:"final"}));
 assert.equal(v.payablePaisa,14000);
 assert.equal(v.netBasketSavingPaisa,6000);
 assert.match(v.whatsappDraft,/Asal bill: Rs 140/);
 assert.doesNotMatch(v.whatsappDraft,/Zyada se zyada denge/);
});
test("Large basket advertises exact item count and calls for separate details (not fake market sums)",()=>{
 const lines=Array.from({length:18},(_,i)=>ginger({name:"Item "+(i+1)}));
 const v=preview(bill({lines}));
 assert.equal(v.itemCount,18);assert.equal(v.marketComparedCount,18);
 assert.match(v.whatsappDraft,/aur 14 items/);
 assert.equal(v.items.length,18);
 assert.equal(v.detailText.split("\n").length,18);
 assert.equal(v.previewTooLong,false);
});
test("Do not confuse non-grocery Bhao Tao with free grocery billing",()=>{
 assert.throws(()=>preview(bill({feature:"bhao_tao"})),/do not apply/);
});
