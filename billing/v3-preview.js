// ASB WhatsApp Billing V3 — OFFLINE PREVIEW. Does not send or register Meta
// templates. No migration or changes to frozen V2 snapshots. Amounts: paisa.
"use strict";

const GROCERY = new Set(["apna_order","community_bulk_buying","dish_to_cart","budget_to_cart"]);
const DEFAULT_FRESHNESS_HOURS = 24; // Proposal, NOT an approved ASB market-survey SLA.
function amt(v,label) {
  if (!Number.isSafeInteger(v) || v<0) throw new TypeError(label+" must be nonnegative integer paisa");
  return v;
}
function rs(paisa) {
  return "Rs "+(paisa/100).toLocaleString("en-US",{maximumFractionDigits:2});
}
function clean(s) {
  return String(s??"").replace(/[\r\n\t]+/g," ").replace(/\s{2,}/g," ").trim();
}
function comparisonValid(line, now, maxAgeHours) {
  const ev=line.marketObservation;
  if (!ev || ev.comparableQuality!==true || !clean(ev.source) ||
      !Number.isSafeInteger(line.bazaarLinePaisa) || line.bazaarLinePaisa<0 ||
      typeof ev.checkedAt!=="string") return false;
  const checked=Date.parse(ev.checkedAt);
  return Number.isFinite(checked) && checked<=now && now-checked<=maxAgeHours*3600*1000;
}

function preview({phase="confirmation",feature="apna_order",orderNumber,customerName,
                  deliveryDate,lines,discountPaisa=0,deliveryPaisa=0,
                  now="2026-10-19T08:00:00Z",maxMarketAgeHours=DEFAULT_FRESHNESS_HOURS,
                  displayLineLimit=4}={}) {
  if (!["confirmation","final"].includes(phase)) throw new TypeError("invalid phase");
  if (!GROCERY.has(feature)) throw new TypeError("V3 grocery bills do not apply to Bhao Tao");
  if (!Array.isArray(lines) || !lines.length) throw new TypeError("nonempty item list required");
  if (!Number.isInteger(displayLineLimit)||displayLineLimit<1 || displayLineLimit>30) throw new TypeError("invalid display limit");
  if (!Number.isFinite(Date.parse(now))) throw new TypeError("invalid now");
  if (!Number.isFinite(maxMarketAgeHours)||maxMarketAgeHours<=0) throw new TypeError("invalid evidence freshness");
  amt(deliveryPaisa,"deliveryPaisa");
  if (deliveryPaisa!==0) throw new Error("FREE_DELIVERY_POLICY_CONFLICT: no grocery charges permitted");
  const discount=amt(discountPaisa,"discountPaisa");
  let asbGross=0, refTotal=0, referencedAsb=0, covered=0;
  const rows=[];
  for(const item of lines) {
    const name=clean(item.name),quantity=clean(item.quantity);
    if(!name||!quantity) throw new TypeError("name and purchased quantity required");
    const amount=phase==="final"?amt(item.finalLinePaisa,"finalLinePaisa"):amt(item.ceilingLinePaisa,"ceilingLinePaisa");
    asbGross+=amount;
    if(!Number.isSafeInteger(asbGross))throw new RangeError("basket too large");
    const hasMarket=comparisonValid(item,Date.parse(now),maxMarketAgeHours);
    const bazaar=hasMarket?item.bazaarLinePaisa:null;
    if (hasMarket) {covered++;refTotal+=bazaar;referencedAsb+=amount;}
    rows.push({name,quantity,asbLinePaisa:amount,bazaarLinePaisa:bazaar,
      marketCompared:hasMarket,marketSource:hasMarket?clean(item.marketObservation.source):null,
      differencePaisa:hasMarket?bazaar-amount:null});
  }
  if (discount>asbGross)throw new TypeError("discount exceeds basket");
  const payable=asbGross-discount;
  const fullCoverage=covered===rows.length;
  const basketDifference=fullCoverage?refTotal-payable:null;
  // Partial coverage: never advertise "whole basket savings" or silently
  // allocate an order-level discount to only the compared lines.
  const headline=fullCoverage?
    (basketDifference>=0?"POORI BASKET KI BACHAT: "+rs(basketDifference):
     "Bazaar reference se ASB basket "+rs(-basketDifference)+" zyada"):
    "Basket bachat: abhi tasdeeq nahi hui ("+covered+"/"+rows.length+" items compare hue)";
  const itemText=rows.map(x=> {
    const basic=x.name+" ("+x.quantity+"): ASB "+rs(x.asbLinePaisa);
    if(!x.marketCompared)return basic+" | Bazaar rate verify nahi hua";
    return basic+" | Bazaar "+rs(x.bazaarLinePaisa)+
      (x.differencePaisa>=0?" | Bachat "+rs(x.differencePaisa):
       " | ASB "+rs(-x.differencePaisa)+" zyada");
  });
  const shown=itemText.slice(0,displayLineLimit);
  if (rows.length>displayLineLimit) shown.push("...aur "+(rows.length-displayLineLimit)+" items (details alag).");
  const linesOut=[
    "🛒 APNA SASTA BAZAAR",
    "Assalam-o-Alaikum "+clean(customerName||"Ji")+"!",
    (phase==="confirmation"?"Order mil gaya":"Final bill")+" — "+clean(orderNumber),
    "💚 "+headline,
    "",
    "🧺 SAMAN",
    ...shown,
    "",
    ...(fullCoverage?["Bazaar total: "+rs(refTotal)]:["Bazaar: partial/unverified"]),
    "ASB saman: "+rs(asbGross),
    ...(discount?["Discount: -"+rs(discount)]:[]),
    "🚚 Delivery: FREE",
    (phase==="confirmation"?"Zyada se zyada denge: ":"Asal bill: ")+rs(payable),
    ...(deliveryDate?["Delivery: "+clean(deliveryDate)]:[]),
    phase==="confirmation"?"Delivery ke din rate kam hua to final bill kam ho sakta hai.":"Shukriya — Apna Sasta Bazaar"
  ];
  const whatsappDraft=linesOut.join("\n");
  return {
    phase,feature,payablePaisa:payable,asbGrossPaisa:asbGross,discountPaisa:discount,
    deliveryPaisa:0,marketComparedCount:covered,itemCount:rows.length,
    comparisonComplete:fullCoverage,marketReferenceTotalPaisa:fullCoverage?refTotal:null,
    netBasketSavingPaisa:basketDifference,headline,items:rows,detailText:itemText.join("\n"),
    whatsappDraft,
    previewTooLong:whatsappDraft.length>1024,
    warning:"DRAFT ONLY: needs Meta template approval, comparison provenance validation, and storefront/backend integration."
  };
}
module.exports={preview,comparisonValid,DEFAULT_FRESHNESS_HOURS};
