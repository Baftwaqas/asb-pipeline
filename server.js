// ============================================================
// ASB PIPELINE - Apna Sasta Bazaar
// Shopify -> WhatsApp order pipeline
// ============================================================
// This little server does 3 jobs:
//   1. Proves to Meta that we own our webhook URL (the "handshake")
//   2. Receives WhatsApp messages customers send us (inbound)
//   3. Receives new Shopify orders and sends the order_confirmed
//      WhatsApp template to the customer (outbound)
// ============================================================

const express = require("express");
const crypto = require("crypto");

const app = express();

// ------------------------------------------------------------
// SETTINGS - these come from "Environment Variables" set in
// the hosting dashboard (Render). NEVER write real secrets here.
// ------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "asb-verify-2026"; // our made-up password for Meta's handshake
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || ""; // access token from Meta dashboard
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || ""; // e.g. 1252083427990398 (test number id)
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || ""; // from Shopify webhook settings
const TEMPLATE_LANG = "en"; // language code of our approved templates

// ------------------------------------------------------------
// Shopify webhook needs the RAW body to check the signature,
// so we mount raw parsing on that path only.
// ------------------------------------------------------------
app.use("/webhooks/shopify", express.raw({ type: "application/json" }));
app.use(express.json());

// ------------------------------------------------------------
// Tiny helper: turn any Pakistani phone format into 923001234567
// "0300-1234567" -> "923001234567"
// "+92 300 1234567" -> "923001234567"
// ------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, ""); // keep only numbers
  if (digits.startsWith("0092")) digits = digits.slice(4);
  if (digits.startsWith("92")) return digits;
  if (digits.startsWith("0")) return "92" + digits.slice(1);
  // already without 0 or 92? assume local mobile like 3001234567
  if (digits.length === 10 && digits.startsWith("3")) return "92" + digits;
  return digits;
}

// ------------------------------------------------------------
// Tiny helper: send an approved template message via Cloud API
// ------------------------------------------------------------
async function sendTemplate(toPhone, templateName, params) {
  const url = `https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`;
  const body = {
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANG },
      components: [
        {
          type: "body",
          parameters: params.map((p) => ({
        type: "text",text: p.value,
          })),
        },
      ],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    console.error("WhatsApp send FAILED:", JSON.stringify(data));
  } else {
    console.log("WhatsApp send OK:", JSON.stringify(data));
  }
  return data;
}

// ------------------------------------------------------------
// ROUTE 0: Health check - visit in browser to see server alive
// ------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("ASB Pipeline is running. Sasta Bhi, Achha Bhi!");
});

// ------------------------------------------------------------
// ROUTE 1: Meta webhook VERIFICATION handshake (GET)
// When we register our webhook URL, Meta sends a challenge.
// We must echo it back if the verify token matches.
// ------------------------------------------------------------
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook VERIFIED by Meta ✔");
    return res.status(200).send(challenge);
  }
  console.warn("Webhook verification FAILED (wrong token)");
  return res.sendStatus(403);
});

// ------------------------------------------------------------
// ROUTE 2: Inbound WhatsApp events (POST)
// Every message a customer sends us arrives here as JSON.
// For now we just log it beautifully - this is our proof
// that the inbound leg works. Order parsing comes later.
// ------------------------------------------------------------
app.post("/webhooks/whatsapp", (req, res) => {
  // Always answer 200 fast, or Meta keeps retrying
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;

    // A real text message from a customer?
    const msg = change?.messages?.[0];
    if (msg) {
      const from = msg.from; // customer's number
      const type = msg.type; // text / image / audio ...
      const text = msg.text?.body || "(" + type + ")";
      console.log(`📩 INBOUND from ${from}: ${text}`);
      return;
    }

    // Or a status update (sent/delivered/read) for our messages?
    const status = change?.statuses?.[0];
    if (status) {
      console.log(`📊 STATUS: message to ${status.recipient_id} is now "${status.status}"`);
      return;
    }

    console.log("Webhook event (other):", JSON.stringify(req.body));
  } catch (e) {
    console.error("Error reading WhatsApp webhook:", e);
  }
});

// ------------------------------------------------------------
// ROUTE 3: Shopify orders/create webhook (POST)
// Shopify calls this the moment an order is placed.
// We verify it's really Shopify (HMAC), then send the
// order_confirmed template to the customer's WhatsApp.
// ------------------------------------------------------------
app.post("/webhooks/shopify", async (req, res) => {
  // ---- 1. Verify the HMAC signature (security!) ----
  const hmacHeader = req.get("X-Shopify-Hmac-Sha256") || "";
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(req.body) // raw body buffer
    .digest("base64");

  let valid = false;
  try {
    valid =
      hmacHeader.length > 0 &&
      crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch (_) {
    valid = false;
  }

  if (!valid) {
    console.warn("⛔ Shopify webhook REJECTED - bad HMAC signature");
    return res.sendStatus(401);
  }

  // Answer Shopify fast, process after
  res.sendStatus(200);

  // ---- 2. Read the order ----
  try {
    const order = JSON.parse(req.body.toString("utf8"));

    const orderName = order.name || `#${order.id}`; // e.g. #ASB1042
    const firstName =
      order.customer?.first_name ||
      order.shipping_address?.first_name ||
      "Customer";
    const rawPhone =
      order.shipping_address?.phone ||
      order.customer?.phone ||
      order.phone ||
      null;
    const phone = normalizePhone(rawPhone);

    const items = (order.line_items || [])
      .map((i) => `${i.title} x${i.quantity}`)
      .join(", ");

    const totalPKR = Math.round(Number(order.total_price || 0)).toLocaleString("en-PK");

    console.log(`🛒 NEW ORDER ${orderName} from ${firstName}, phone: ${rawPhone} -> ${phone}`);
    console.log(`   Items: ${items} | Max bill: Rs ${totalPKR}`);

    if (!phone) {
      console.error(`   ⚠ No phone on order ${orderName} - cannot send WhatsApp`);
      return;
    }

    // ---- 3. Send the order_confirmed template ----
    await sendTemplate(phone, "order_confirmed", [
      { name: "customer_name", value: firstName },
      { name: "order_id", value: orderName },
      { name: "order_items", value: items || "—" },
      { name: "max_bill", value: totalPKR },
    ]);
  } catch (e) {
    console.error("Error processing Shopify order:", e);
  }
});

// ------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`ASB Pipeline listening on port ${PORT}`);
});
