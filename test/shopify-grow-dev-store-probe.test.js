'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {normalizeDomain,verifyDevIdentity,parsePaisa,displayRs,sampleCase,
  reconcileCalculation,runProbe,SHOP_QUERY,CALCULATE_MUTATION} =
  require('../scripts/shopify-grow-dev-store-probe');

const DOMAIN='asb-recipe-master-dev.myshopify.com';
function dev(plan='Grow') { return {myshopifyDomain:DOMAIN,name:'ASB isolated dev',currencyCode:'PKR',
  plan:{publicDisplayName:plan,partnerDevelopment:true,shopifyPlus:false}}; }
function bag(rupees) {return {shopMoney:{amount:String(rupees),currencyCode:'PKR'}};}
function calc(rupees) {
 return {draftOrderCalculate:{userErrors:[],calculatedDraftOrder:{
  currencyCode:'PKR',subtotalPriceSet:bag(rupees),totalDiscountsSet:bag('0.00'),
  totalShippingPriceSet:bag('0.00'),totalTaxSet:bag('0.00'),totalPriceSet:bag(rupees)}}};
}
function fakeFetch(shopResponse=dev(),calcResponse=calc('145.00')) {
 const calls=[];
 const fetchImpl=async (url,options)=>{
  calls.push({url,options});
  const payload=JSON.parse(options.body);
  return {ok:true,json:async()=>({data:
   payload.query.includes('draftOrderCalculate')?calcResponse:{shop:shopResponse}})};
 };
 return {calls,fetchImpl};
}

test('only .myshopify.com dev-marked domain can be targeted',()=>{
 assert.equal(normalizeDomain(' ASB-RECIPE-MASTER-DEV.myshopify.com '),DOMAIN);
 for(const domain of ['0du4xf-6j.myshopify.com','apnasastabazaar.com',
   'apnasastabazaar.myshopify.com','regular.myshopify.com','http://asb-dev.myshopify.com',
   'asb-dev.myshopify.com.evil.com','a-dev.example.com']) {
  assert.throws(()=>normalizeDomain(domain));
 }
});
test('shop identity requires verified dev store, PKR and non-Plus Grow',()=>{
 assert.equal(verifyDevIdentity(dev(),DOMAIN).isDevelopmentStore,true);
 assert.throws(()=>verifyDevIdentity({...dev(),myshopifyDomain:'other-dev.myshopify.com'},DOMAIN),/DOMAIN_MISMATCH/);
 assert.throws(()=>verifyDevIdentity({...dev(),plan:{...dev().plan,partnerDevelopment:false}},DOMAIN),/NOT_VERIFIED/);
 assert.throws(()=>verifyDevIdentity({...dev(),plan:{...dev().plan,shopifyPlus:true}},DOMAIN),/NOT_GROW/);
 assert.throws(()=>verifyDevIdentity(dev('Plus'),DOMAIN),/NOT_GROW/);
 assert.throws(()=>verifyDevIdentity({...dev(),currencyCode:'USD'},DOMAIN),/NOT_PKR/);
});
test('money parser is integer paisa and rejects fractional, exponent and overflow inputs',()=>{
 assert.equal(parsePaisa('1199.99'),119999);
 assert.equal(parsePaisa('1200'),120000);
 assert.equal(parsePaisa('0.01'),1);
 assert.equal(displayRs(14501),'145.01');
 for(const bad of ['12.001','1e10','-1','1,000',null,'NaN']) assert.throws(()=>parsePaisa(bad));
 assert.throws(()=>parsePaisa('90071992547409999.99'),/OVERFLOW/);
});
test('sample cases pass only local trusted fixture preflight and leave enforcement false',()=>{
 for(const [name,expected] of [['apna145',14500],['community1200',120000]]) {
  const sample=sampleCase(name);
  assert.equal(sample.quote.allowed,true);
  assert.equal(sample.quote.enforcedInShopify,false);
  assert.equal(sample.quote.payablePaisa,expected);
  assert.equal(sample.input.allowDiscountCodesInCheckout,false);
  assert.equal(sample.input.acceptAutomaticDiscounts,false);
  assert.equal(sample.input.taxExempt,true);
  assert.equal(sample.input.visibleToCustomer,false);
  assert.equal(sample.input.lineItems[0].taxable,false);
 }
 assert.throws(()=>sampleCase('not-a-real-scenario'),/UNKNOWN_SAMPLE/);
});
test('GraphQL operations contain only read-only shop and NON-PERSISTENT draft calculation',()=>{
 assert.match(SHOP_QUERY,/partnerDevelopment/);
 assert.match(CALCULATE_MUTATION,/draftOrderCalculate/);
 for(const op of [SHOP_QUERY,CALCULATE_MUTATION])
  assert.doesNotMatch(op,/draftOrderCreate|draftOrderComplete|draftOrderInvoiceSend|orderCreate|refundCreate/);
});
test('draft arithmetic must exactly match local quote with zero tax and shipping',()=>{
 const q=sampleCase('apna145').quote;
 assert.equal(reconcileCalculation(calc('145.00').draftOrderCalculate,q).payablePaisa,14500);
 for(const key of ['totalTaxSet','totalShippingPriceSet','totalPriceSet']) {
  const result=calc('145.00').draftOrderCalculate;
  result.calculatedDraftOrder[key]=bag(key==='totalPriceSet'?'145.01':'1.00');
  assert.throws(()=>reconcileCalculation(result,q),/RECONCILIATION_FAILURE/);
 }
 const withError=calc('145.00').draftOrderCalculate;
 withError.userErrors=[{message:'not allowed'}];
 assert.throws(()=>reconcileCalculation(withError,q),/USER_ERRORS/);
});
test('correct Shopify shop identity is checked before any draft calculation',async()=>{
 const {calls,fetchImpl}=fakeFetch();
 const result=await runProbe({domain:DOMAIN,token:'dev-secret-test-only',fetchImpl});
 assert.equal(result.mode,'check');assert.equal(result.noOrderCreated,true);
 assert.equal(result.calculated,false);assert.equal(calls.length,1);
 assert.ok(calls[0].url.includes('/admin/api/2026-10/graphql.json'));
 assert.equal(calls[0].options.headers['X-Shopify-Access-Token'],'dev-secret-test-only');
 assert.doesNotMatch(JSON.stringify(result),/dev-secret-test-only/);
});
test('calculation mode only runs AFTER dev identity verification',async()=>{
 const {calls,fetchImpl}=fakeFetch();
 const r=await runProbe({domain:DOMAIN,token:'dev-secret-test-only',mode:'calculate',
   scenario:'apna145',fetchImpl});
 assert.equal(calls.length,2);assert.equal(r.noOrderCreated,true);
 assert.equal(r.totals.payablePaisa,14500);
 const second=JSON.parse(calls[1].options.body);
 assert.match(second.query,/draftOrderCalculate/);
 assert.equal(second.variables.input.lineItems[0].originalUnitPriceWithCurrency.amount,'145.00');
});
test('Community 1200 can be calculated with a representative custom item',async()=>{
 const {calls,fetchImpl}=fakeFetch(dev(),calc('1200.00'));
 const r=await runProbe({domain:DOMAIN,token:'dev-secret-test-only',mode:'calculate',
   scenario:'community1200',fetchImpl});
 assert.equal(r.totals.payablePaisa,120000);
 assert.equal(calls.length,2);
 assert.match(r.warning,/does NOT prove/i);
});
test('live shop guard rejects before any network request, including spoofed dev credentials',async()=>{
 const {calls,fetchImpl}=fakeFetch();
 await assert.rejects(()=>runProbe({domain:'0du4xf-6j.myshopify.com',token:'secret',mode:'calculate',fetchImpl}));
 assert.equal(calls.length,0);
});
test('unverified shop identity stops second API request',async()=>{
 const {calls,fetchImpl}=fakeFetch({...dev(),plan:{...dev().plan,partnerDevelopment:false}});
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'secret',mode:'calculate',fetchImpl}),/NOT_VERIFIED/);
 assert.equal(calls.length,1);
});
test('wrong shop host stops draft calculation',async()=>{
 const {calls,fetchImpl}=fakeFetch({...dev(),myshopifyDomain:'unexpected-dev.myshopify.com'});
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'secret',mode:'calculate',fetchImpl}),/DOMAIN_MISMATCH/);
 assert.equal(calls.length,1);
});
test('API missing token fails without request',async()=>{
 const {calls,fetchImpl}=fakeFetch();
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'',fetchImpl}),/DEV_STORE_TOKEN_REQUIRED/);
 assert.equal(calls.length,0);
});
test('unexpected API HTTP and GraphQL errors must fail closed',async()=>{
 const errHttp=async()=>({ok:false,json:async()=>({})});
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'abc',fetchImpl:errHttp}),/HTTP_ERROR/);
 const errGql=async()=>({ok:true,json:async()=>({errors:[{message:'not permitted'}]})});
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'abc',fetchImpl:errGql}),/GRAPHQL_ERROR/);
});
test('invalid mode and missing store cannot send calculation',async()=>{
 const {calls,fetchImpl}=fakeFetch();
 await assert.rejects(()=>runProbe({domain:DOMAIN,token:'abc',mode:'create-draft',fetchImpl}),/UNSUPPORTED_MODE/);
 await assert.rejects(()=>runProbe({domain:undefined,token:'abc',mode:'calculate',fetchImpl}),/STORE_DOMAIN_MISSING/);
 assert.equal(calls.length,0);
});
