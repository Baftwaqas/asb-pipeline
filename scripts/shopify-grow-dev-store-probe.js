// ASB Grow checkout: DEV-STORE-ONLY SAFE CALCULATION PROBE.
// - --check: read-only shop identity check.
// - --calculate: run Shopify draftOrderCalculate (non-persistent calculation);
//   this is a GraphQL mutation by schema, but creates NO order or draft.
// No codepath for draftOrderCreate, draftOrderComplete, invoiceSend, COD or
// WhatsApp. Never call this with production credentials.
'use strict';

const { preflight } = require('../checkout/offline-grow-preflight-v1');
const API_VERSION = '2026-10';
const PRODUCTION_DOMAINS = new Set(['0du4xf-6j.myshopify.com', 'apnasastabazaar.com']);
const SHOP_QUERY = [
  'query ASBIsolatedDevShop {',
  'shop { myshopifyDomain name currencyCode',
  'plan { publicDisplayName partnerDevelopment shopifyPlus }',
  '} }'
].join('\n');
const CALCULATE_MUTATION = [
  'mutation ASBDevOnlyDraftCalculation($input: DraftOrderInput!) {',
  'draftOrderCalculate(input: $input) {',
  'calculatedDraftOrder { currencyCode',
  'totalPriceSet { shopMoney { amount currencyCode } }',
  'subtotalPriceSet { shopMoney { amount currencyCode } }',
  'totalDiscountsSet { shopMoney { amount currencyCode } }',
  'totalShippingPriceSet { shopMoney { amount currencyCode } }',
  'totalTaxSet { shopMoney { amount currencyCode } }',
  '} userErrors { field message }',
  '} }'
].join('\n');

function normalizeDomain(value) {
  if (typeof value !== 'string') throw new Error('STORE_DOMAIN_MISSING');
  const x = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(x)) throw new Error('INVALID_MYSHOPIFY_DOMAIN');
  if (PRODUCTION_DOMAINS.has(x) || /apnasastabazaar/i.test(x)) throw new Error('PRODUCTION_STORE_FORBIDDEN');
  if (!/(dev|sandbox|staging|test)/i.test(x.split('.')[0])) throw new Error('DEV_NAME_MARKER_REQUIRED');
  return x;
}
function verifyDevIdentity(shop, expectedDomain) {
  const domain = normalizeDomain(expectedDomain);
  if (!shop || typeof shop !== 'object' || shop.myshopifyDomain?.toLowerCase() !== domain)
    throw new Error('SHOP_DOMAIN_MISMATCH');
  if (shop.plan?.partnerDevelopment !== true) throw new Error('NOT_VERIFIED_DEVELOPMENT_STORE');
  if (shop.plan?.shopifyPlus !== false || shop.plan?.publicDisplayName?.trim().toLowerCase() !== 'grow')
    throw new Error('NOT_GROW_NON_PLUS_PLAN');
  if (shop.currencyCode !== 'PKR') throw new Error('NOT_PKR_STORE');
  return { shopDomain: domain, plan: shop.plan.publicDisplayName, isDevelopmentStore: true,
    currency: shop.currencyCode };
}
function parsePaisa(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('INVALID_SHOPIFY_MONEY');
  const [whole, fraction=''] = value.split('.');
  const p = BigInt(whole) * 100n + BigInt((fraction+'00').slice(0,2));
  if (p > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('SHOPIFY_MONEY_OVERFLOW');
  return Number(p);
}
function displayRs(paisa) {
  if (!Number.isSafeInteger(paisa) || paisa < 0) throw new Error('INVALID_QUOTE_MONEY');
  return (Math.floor(paisa/100)) + '.' + String(paisa%100).padStart(2,'0');
}
function sampleCase(name) {
  const CASES = {
    apna145: {feature:'apna_order', variantId:'DEV-G1', productId:'dev-ginger',
      title:'ASB DEV ONLY Apna 145', kind:'grocery', price:14500},
    community1200: {feature:'community_bulk_buying', variantId:'DEV-C10',productId:'dev-onion',
      title:'ASB DEV ONLY Community 10kg 1200',kind:'community',price:120000}
  };
  const sample=CASES[name]; if(!sample) throw new Error('UNKNOWN_SAMPLE_CASE');
  const q = preflight({
    requestedLines:[{lineRef:'STAGING-L1',variantId:sample.variantId,quantity:1,claimedFeature:sample.feature}],
    catalogByVariant:{[sample.variantId]:{variantId:sample.variantId,productId:sample.productId,
      kind:sample.kind,unitPricePaisa:sample.price,allowedVariantIds:[sample.variantId],
      taxable:false,active:true,sellable:true}},
    verifiedBindingsByLineRef:{'STAGING-L1':{feature:sample.feature,variantId:sample.variantId,quantity:1}}
  });
  if (!q.allowed || q.enforcedInShopify !== false) throw new Error('LOCAL_PREFLIGHT_FAILED');
  // A custom Shopify Draft Order item is used ONLY to test Shopify's
  // arithmetic in a dev store. It does not prove variant/pack enforcement.
  const input = {presentmentCurrencyCode:'PKR',acceptAutomaticDiscounts:false,
    allowDiscountCodesInCheckout:false,taxExempt:true,visibleToCustomer:false,
    shippingLine:{title:'ASB DEV ONLY FREE',priceWithCurrency:{amount:'0.00',currencyCode:'PKR'}},
    lineItems:[{title:sample.title,quantity:1,requiresShipping:true,taxable:false,
      originalUnitPriceWithCurrency:{amount:displayRs(sample.price),currencyCode:'PKR'},
      customAttributes:[{key:'_asb_sample_feature',value:sample.feature}]}]
  };
  return {name,quote:q,input};
}
function readMoney(bag) {
  if (bag?.shopMoney?.currencyCode !== 'PKR') throw new Error('SHOPIFY_RESPONSE_CURRENCY_CONFLICT');
  return parsePaisa(bag.shopMoney.amount);
}
function reconcileCalculation(payload, quote) {
  if (!payload || !Array.isArray(payload.userErrors) || payload.userErrors.length)
    throw new Error('SHOPIFY_CALCULATION_USER_ERRORS');
  const d=payload.calculatedDraftOrder;
  if (!d || d.currencyCode!=='PKR') throw new Error('SHOPIFY_CALCULATION_CURRENCY_CONFLICT');
  const totals = {subtotalPaisa:readMoney(d.subtotalPriceSet),discountPaisa:readMoney(d.totalDiscountsSet),
    shippingPaisa:readMoney(d.totalShippingPriceSet),taxPaisa:readMoney(d.totalTaxSet),
    payablePaisa:readMoney(d.totalPriceSet)};
  if (totals.subtotalPaisa!==quote.subtotalPaisa || totals.discountPaisa!==quote.discountPaisa ||
      totals.shippingPaisa!==0 || totals.taxPaisa!==0 || totals.payablePaisa!==quote.payablePaisa)
    throw new Error('DRAFT_CALCULATION_RECONCILIATION_FAILURE');
  return totals;
}
async function graphql({domain,token,query,variables,fetchImpl=globalThis.fetch}) {
  if (!token || typeof token!=='string') throw new Error('DEV_STORE_TOKEN_REQUIRED');
  // Perform host validation BEFORE any network request.
  const checked=normalizeDomain(domain);
  if (typeof fetchImpl !== 'function') throw new Error('FETCH_NOT_AVAILABLE');
  const resp=await fetchImpl('https://'+checked+'/admin/api/'+API_VERSION+'/graphql.json',{
    method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},
    body:JSON.stringify({query,variables})
  });
  if (!resp || !resp.ok) throw new Error('SHOPIFY_API_HTTP_ERROR');
  const json=await resp.json();
  if (!json || json.errors?.length || !json.data) throw new Error('SHOPIFY_API_GRAPHQL_ERROR');
  return json.data;
}
async function runProbe({domain,token,mode='check',scenario='apna145',fetchImpl}={}) {
  const expected=normalizeDomain(domain);
  if (!['check','calculate'].includes(mode)) throw new Error('UNSUPPORTED_MODE');
  const shopData=await graphql({domain:expected,token,query:SHOP_QUERY,fetchImpl});
  const verified=verifyDevIdentity(shopData.shop,expected);
  if(mode==='check') return {mode,verified,calculated:false,noOrderCreated:true};
  const sample=sampleCase(scenario);
  const data=await graphql({domain:expected,token,query:CALCULATE_MUTATION,
    variables:{input:sample.input},fetchImpl});
  const totals=reconcileCalculation(data.draftOrderCalculate,sample.quote);
  return {mode,verified,scenario,totals,calculated:true,noOrderCreated:true,
    warning:'Non-persistent CUSTOM-ITEM calculation only. Does NOT prove real Shopify checkout/COD, feature provenance, or non-bypassable validation.'};
}
async function main() {
  const mode=process.argv.includes('--calculate')?'calculate':'check';
  const flag=process.argv.find(x=>x.startsWith('--scenario='));
  const scenario=flag?flag.slice('--scenario='.length):'apna145';
  try {
    const out=await runProbe({domain:process.env.ASB_DEV_MYSHOPIFY_DOMAIN,
      token:process.env.ASB_DEV_ADMIN_TOKEN,mode,scenario});
    console.log(JSON.stringify(out,null,2));
  }catch(e){
    // Never log response bodies or tokens. These may contain private API data.
    console.error('ASB_DEV_PROBE_FAILED: '+e.message);
    process.exitCode=1;
  }
}
if(require.main===module)main();
module.exports={normalizeDomain,verifyDevIdentity,parsePaisa,displayRs,sampleCase,
  reconcileCalculation,runProbe,graphql,SHOP_QUERY,CALCULATE_MUTATION};
