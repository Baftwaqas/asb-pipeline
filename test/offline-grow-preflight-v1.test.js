'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {preflight} = require('../checkout/offline-grow-preflight-v1');
const cat = {
  'G1':{variantId:'G1',productId:'ginger',kind:'grocery',unitPricePaisa:14500,active:true,sellable:true,taxable:false},
  'G2':{variantId:'G2',productId:'tomato',kind:'grocery',unitPricePaisa:12000,active:true,sellable:true,taxable:false},
  'G3':{variantId:'G3',productId:'ginger',kind:'grocery',unitPricePaisa:16000,active:true,sellable:true,taxable:false},
  'C5':{variantId:'C5',productId:'onion',kind:'community',unitPricePaisa:70000,allowedVariantIds:['C5','C10'],active:true,sellable:true,taxable:false},
  'C10':{variantId:'C10',productId:'onion',kind:'community',unitPricePaisa:120000,allowedVariantIds:['C5','C10'],active:true,sellable:true,taxable:false},
  'COTHER':{variantId:'COTHER',productId:'potato',kind:'community',unitPricePaisa:50000,allowedVariantIds:['COTHER'],active:true,sellable:true,taxable:false},
  'CBAD':{variantId:'CBAD',productId:'onion',kind:'community',unitPricePaisa:150000,allowedVariantIds:['C5','C10'],active:true,sellable:true,taxable:false},
};
const req=(lineRef,variantId,feature,quantity=1)=>({lineRef,variantId,claimedFeature:feature,quantity});
function run(lines, opt={}) {
 const bindings=Object.fromEntries(lines.map(x=>[x.lineRef,{feature:x.claimedFeature,variantId:x.variantId,quantity:x.quantity}]));
 return preflight({requestedLines:lines,catalogByVariant:cat,verifiedBindingsByLineRef:bindings,...opt});
}
const C='community_bulk_buying',A='apna_order',D='dish_to_cart',B='budget_to_cart',H='bhao_tao';
test('Apna Order Rs145, tax/shipping zero and no floor, but never falsely claims native checkout enforcement',()=>{
 const r=run([req('1','G1',A)]);
 assert.equal(r.allowed,true);assert.equal(r.payablePaisa,14500);assert.equal(r.enforcedInShopify,false);
 assert.equal(r.groups.length,1);assert.equal(r.groups[0].feature,A);
});
test('Dish-to-Cart ingredients can coexist with Apna Order and remain two feature lines',()=>{
 const r=run([req('1','G1',A),req('2','G1',D),req('3','G2',D)]);
 assert.equal(r.allowed,true);assert.equal(r.groups.length,2);assert.equal(r.quoteLines.length,3);
 assert.deepEqual(r.quoteLines.slice(0,2).map(x=>x.feature),[A,D]);
 assert.equal(r.payablePaisa,41000);
});
test('Community exact Rs 1200 succeeds as single offered 10kg pack',()=>{
 const r=run([req('1','C10',C)]);assert.equal(r.allowed,true);assert.equal(r.payablePaisa,120000);
});
test('Community Rs1199.99 fails with precise one-paisa shortfall',()=>{
 const modified={...cat,C10:{...cat.C10,unitPricePaisa:119999}};
 const r=run([req('1','C10',C)],{catalogByVariant:modified});
 assert.equal(r.code,'MINIMUM_NOT_REACHED');assert.equal(r.shortfallPaisa,1);
});
test('Community Rs1250 less Rs75 server-allocated discount fails after discount',()=>{
 const modified={...cat,C10:{...cat.C10,unitPricePaisa:125000}};
 const r=run([req('1','C10',C)],{catalogByVariant:modified,trustedDiscountByLineRef:{'1':7500}});
 assert.equal(r.code,'MINIMUM_NOT_REACHED');assert.equal(r.shortfallPaisa,2500);
});
test('Apna+Community cannot merge or satisfy Community minimum, even when total > Rs1200',()=>{
 const modified={...cat,G1:{...cat.G1,unitPricePaisa:80000},C5:{...cat.C5,unitPricePaisa:50000}};
 const r=run([req('1','G1',A),req('2','C5',C)],{catalogByVariant:modified});
 assert.equal(r.code,'MIXED_COMMUNITY_CHECKOUT_NOT_READY');assert.equal(r.featurePayablePaisa,50000);
});
test('5kg+5kg repeated product, including different line refs, is refused',()=>{
 const r=run([req('1','C5',C),req('2','C5',C)]);assert.equal(r.code,'COMMUNITY_ONE_PACK_PER_PRODUCT');
});
test('5kg + 10kg same product is refused',()=>{
 const r=run([req('1','C5',C),req('2','C10',C)]);assert.equal(r.code,'COMMUNITY_ONE_PACK_PER_PRODUCT');
});
test('10kg variant quantity 2 is refused',()=>{
 const r=run([req('1','C10',C,2)]);assert.equal(r.code,'COMMUNITY_ONE_PACK_PER_PRODUCT');
});
test('Unlisted pack variant refused despite real product identity',()=>{
 const r=run([req('1','CBAD',C)]);assert.equal(r.code,'COMMUNITY_UNOFFERED_PACK');
});
test('Community product spoofed into ordinary grocery feature refused',()=>{
 assert.equal(run([req('1','C10',A)]).code,'WRONG_FEATURE_PRODUCT');
});
test('Ordinary grocery product spoofed into Community refused',()=>{
 assert.equal(run([req('1','G1',C)]).code,'WRONG_FEATURE_PRODUCT');
});
test('Client cannot lower server authoritative unit price',()=>{
 const request={...req('1','G1',A),unitPricePaisa:1,subtotalPaisa:1};
 const r=run([request]);assert.equal(r.allowed,true);assert.equal(r.payablePaisa,14500);
});
test('Client cannot swap variant after server issued feature binding',()=>{
 const x=req('1','G2',A);
 const r=run([x],{verifiedBindingsByLineRef:{'1':{variantId:'G1',feature:A,quantity:1}}});
 assert.equal(r.code,'FEATURE_BINDING_MISMATCH');
});
test('Client cannot change feature identity after trusted context',()=>{
 const x=req('1','G1',D);
 const r=run([x],{verifiedBindingsByLineRef:{'1':{variantId:'G1',feature:A,quantity:1}}});
 assert.equal(r.code,'FEATURE_BINDING_MISMATCH');
});
test('Missing server bindings never default to Apna Order',()=>{
 assert.equal(run([req('1','G1',A)],{verifiedBindingsByLineRef:{}}).code,'UNVERIFIED_FEATURE_ORIGIN');
});
test('Duplicate line key never silently replaces trusted purchase line',()=>{
 assert.equal(run([req('x','G1',A),req('x','G1',A)]).code,'DUPLICATE_LINE_REFERENCE');
});
test('Unknown variant cannot be purchased just by supplying a SKU or price',()=>{
 assert.equal(run([req('1','FORGED',A)]).code,'UNKNOWN_VARIANT');
});
test('Unexpected trusted discount line is refused rather than silently excluded',()=>{
 assert.equal(run([req('1','G1',A)],{trustedDiscountByLineRef:{ghost:20}}).code,'UNMATCHED_SERVER_CONTEXT');
});
test('Overlarge line discount is refused',()=>{
 assert.equal(run([req('1','G1',A)],{trustedDiscountByLineRef:{'1':15000}}).code,'DISCOUNT_NOT_VERIFIED');
});
test('Nonzero Shopify shipping total or tax total is refused',()=>{
 assert.equal(run([req('1','G1',A)],{shippingPaisa:100}).code,'SHIPPING_CONFLICT');
 assert.equal(run([req('1','G1',A)],{taxPaisa:100}).code,'TAX_RECONCILIATION_REQUIRED');
});
test('A taxable product in trusted catalogue blocks grocery checkout proof',()=>{
 const mod={...cat,G1:{...cat.G1,taxable:true}};
 assert.equal(run([req('1','G1',A)],{catalogByVariant:mod}).code,'PRODUCT_TAX_CONFLICT');
});
test('Currency other than PKR is refused',()=>{
 assert.equal(run([req('1','G1',A)],{currency:'USD'}).code,'CURRENCY_CONFLICT');
});
test('Budget-To-Cart and Bhao Tao stay closed until independently approved',()=>{
 assert.equal(run([req('1','G1',B)]).code,'BUDGET_CHECKOUT_PENDING');
 assert.equal(run([req('1','G1',H)]).code,'BHAO_TAO_CHECKOUT_PENDING');
});
test('Zero line, untrusted request, stale unsellable product all refuse',()=>{
 assert.equal(run([]).code,'INVALID_CART');
 assert.equal(run([req('1','G1',A)],{catalogByVariant:{...cat,G1:{...cat.G1,active:false}}}).code,'CATALOG_QUOTE_INVALID');
 assert.equal(run([req('1','G1',A)],{verifiedBindingsByLineRef:null}).code,'TRUSTED_DATA_MISSING');
});
test('Discount allocated to Apna cannot be applied to Community by accident',()=>{
 const r=run([req('1','G1',A),req('2','G2',D)],{trustedDiscountByLineRef:{'1':1000,'2':2000}});
 assert.equal(r.allowed,true);
 assert.deepEqual(r.groups.map(x=>x.discountPaisa),[1000,2000]);
 assert.equal(r.payablePaisa,23500);
});
test('Large price or quantity integer overflow is refused',()=>{
 const mod={...cat,G1:{...cat.G1,unitPricePaisa:Number.MAX_SAFE_INTEGER}};
 assert.equal(run([req('1','G1',A,3)],{catalogByVariant:mod}).code,'MONEY_OVERFLOW');
});
