// ASB Checkout Lab Bridge: standalone SAFE-LOCKED HTTP health endpoint.
// No checkout route, no tokens, no real Shopify writes, and no production DB.
"use strict";
const http=require("node:http");
const EXPECTED="asb-checkout-lab.myshopify.com";
const actual=String(process.env.ASB_LAB_SHOP_DOMAIN||"").trim();
if(actual!==EXPECTED){
  console.error("[checkout-lab] REFUSED: dev shop must match ASB Checkout Lab exactly");
  process.exit(2);
}
if(process.env.ASB_LAB_WRITE_MODE && process.env.ASB_LAB_WRITE_MODE!=="disabled"){
  console.error("[checkout-lab] REFUSED: public health service cannot enable order writes");
  process.exit(3);
}
const port=Number(process.env.PORT||10000);
if(!Number.isSafeInteger(port)||port<1||port>65535){
  console.error("[checkout-lab] REFUSED: invalid PORT");
  process.exit(4);
}
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,"http://localhost").pathname;
  res.setHeader("Cache-Control","no-store, max-age=0");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method==="GET"&&(path==="/"||path==="/health")){
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({service:"ASB Checkout Lab Bridge",mode:"SAFE_LOCKED",
      shop:EXPECTED,ordersEnabled:false,shippingEnabled:false,notificationsEnabled:false,
      message:"API-only bridge online. Test order creation is not exposed over public HTTP."}));
    return;
  }
  res.writeHead(req.method==="POST"?405:404,{"Content-Type":"application/json"});
  res.end(JSON.stringify({error:"LAB_HTTP_ROUTE_DISABLED"}));
});
server.requestTimeout=10000;
server.headersTimeout=8000;
server.listen(port,"0.0.0.0",()=>console.log("[checkout-lab] safe-locked health server listening"));
