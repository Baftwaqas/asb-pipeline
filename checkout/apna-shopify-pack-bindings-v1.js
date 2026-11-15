// Shopify Admin catalogue -> exact, release-scoped Apna pack bindings.
// Caller must fetch shop-specific products from Admin API on server, not user
// JSON. A founder-signed release authorizes PACK RULES, not stale SKUs/prices.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");
const PRODUCT=/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const VARIANT=/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
function check(v,code){if(!v)throw new QuoteError(code);}
function parseShopifyPack(variantTitle,productTitle){
  const t=String(variantTitle||"");
  const source=t&&t!=="Default Title"?t:String(productTitle||"");
  const matches=[...source.matchAll(/(\d+(?:\.\d+)?)\s*(kg|kilo|g|gm|gms|grams?|pieces?|pcs|adad|dana|dozen|darjan|gaddi|bunch|bundle)\b/gi)];
  if(matches.length!==1)return null;
  const number=Number(matches[0][1]),suffix=matches[0][2].toLowerCase();
  let unit,qty;
  if(["kg","kilo","g","gm","gms","gram","grams"].includes(suffix)){
    unit="g";qty=number*(["kg","kilo"].includes(suffix)?1000:1);
  }else if(["dozen","darjan"].includes(suffix)){
    unit="piece";qty=number*12;
  }else{
    unit="piece";qty=number;
  }
  return Number.isSafeInteger(qty)&&qty>0?{unit,qty}:null;
}

// The caller must explicitly attest that Shopify Admin data was fetched for
// the SAME shop, not from a browser or a hand-edited CSV. Do not construct
// that attestation from request parameters.
function prepareApprovedApnaBindings({release,shopDomain,verifiedProducts,
  serverCatalogVerified}={}){
  check(serverCatalogVerified===true&&release?.shop===shopDomain&&
    release?.mappedCanonicalByProduct instanceof Map,
    "APNA_SHOPIFY_CATALOG_NOT_VERIFIED");
  check(Array.isArray(verifiedProducts)&&verifiedProducts.length>0&&
    verifiedProducts.length<=4000,"APNA_CATALOG_EMPTY_OR_TOO_LARGE");
  const seenProducts=new Map();
  for(const p of verifiedProducts){
    check(p&&PRODUCT.test(p.id)&&!seenProducts.has(p.id)&&p.status==="ACTIVE"&&
      typeof p.title==="string"&&p.variants&&
      Array.isArray(p.variants.nodes)&&p.variants.nodes.length>0&&
      p.variants.nodes.length<=100&&p.variants.pageInfo?.hasNextPage===false,
      "APNA_INCOMPLETE_OR_INACTIVE_SHOPIFY_PRODUCT");
    seenProducts.set(p.id,p);
  }
  check(seenProducts.size===release.mappedCanonicalByProduct.size,
    "APNA_PRODUCT_CATALOG_SIZE_MISMATCH");
  const bindings=[],globalVariantIds=new Set();
  for(const [gid,canonicalProductId] of release.mappedCanonicalByProduct){
    const product=seenProducts.get(gid);
    check(product,"APNA_APPROVED_PRODUCT_NOT_FOUND_IN_SHOPIFY");
    const rule=release.limitsByProduct[canonicalProductId];
    check(rule&&Array.isArray(rule.allowedSizes),"APNA_SIGNED_RULE_MISSING");
    const present=new Set();
    for(const v of product.variants.nodes){
      check(VARIANT.test(v?.id)&&!globalVariantIds.has(v.id),
        "APNA_DUPLICATE_OR_INVALID_SHOPIFY_VARIANT");
      globalVariantIds.add(v.id);
      const parsed=parseShopifyPack(v.title,product.title);
      check(parsed,"APNA_UNRECOGNIZED_SHOPIFY_PACK");
      check(parsed.unit===rule.unit,"APNA_VARIANT_UNIT_MISMATCH");
      if(!rule.allowedSizes.includes(parsed.qty))continue; // not approved
      present.add(parsed.qty);
      bindings.push({
        shopDomain,productGid:gid,variantGid:v.id,
        canonicalProductId,unit:rule.unit,packQuantity:parsed.qty,
        sku:typeof v.sku==="string"?v.sku:null,active:true
      });
    }
    check(rule.allowedSizes.every(q=>present.has(q)),
      "APNA_APPROVED_PACK_MISSING_CURRENT_SHOPIFY_VARIANT");
  }
  return {policyVersion:release.policyVersion,shopDomain,
    bindings:bindings.sort((a,b)=>a.variantGid.localeCompare(b.variantGid,"en"))};
}
module.exports={parseShopifyPack,prepareApprovedApnaBindings};
