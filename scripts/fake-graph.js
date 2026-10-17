#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/fake-graph.js
//
// A LOCAL stand-in for Meta's Graph API, for rehearsals only. Point the app at
// it with GRAPH_BASE=http://127.0.0.1:<port>/v25.0 and any dummy
// WHATSAPP_TOKEN / PHONE_NUMBER_ID: every WhatsApp send, read receipt and
// catalogue call then lands here, and nothing reaches Meta or a customer.
//
//   FAKE_GRAPH_PORT=4599 node scripts/fake-graph.js
//   FAKE_GRAPH_MODE=accept            every message accepted (default)
//   FAKE_GRAPH_MODE=window_first      the first TEXT message to each phone is
//                                     refused with 131047; templates accepted
//   FAKE_GRAPH_MODE=timeout_first     the first message to each phone never
//                                     answers (the app sees an ambiguous result)
//
// Every request is printed, so the rehearsal log shows exactly what the app
// would have sent.
// ============================================================================
"use strict";
const http = require("http");

function createFakeGraph({ mode = process.env.FAKE_GRAPH_MODE || "accept", log = console.log } = {}) {
  let n = 0;
  const seen = new Set();
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch (_) { /* not json */ }
      requests.push({ method: req.method, url: req.url, body: json });
      log(`[fake-graph] ${req.method} ${req.url} ${body.slice(0, 300)}`);
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!/\/messages$/.test(req.url) || json?.status === "read") return send(200, { success: true });
      const first = !seen.has(json?.to);
      seen.add(json?.to);
      if (mode === "timeout_first" && first) return;                  // never answers
      if (mode === "window_first" && first && json?.type === "text") {
        return send(400, { error: { code: 131047, message: "Re-engagement message (fake)", fbtrace_id: "fake" } });
      }
      send(200, { messaging_product: "whatsapp", contacts: [{ wa_id: json?.to }], messages: [{ id: `wamid.FAKE${Date.now()}${++n}` }] });
    });
  });
  return { server, requests };
}

if (require.main === module) {
  const port = Number(process.env.FAKE_GRAPH_PORT || 4599);
  const { server } = createFakeGraph();
  server.listen(port, "127.0.0.1", () => console.log(`[fake-graph] listening on http://127.0.0.1:${port} (mode ${process.env.FAKE_GRAPH_MODE || "accept"})`));
}

module.exports = { createFakeGraph };
