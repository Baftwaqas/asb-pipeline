"use strict";

const path = require("path");

const [repoDir, url, role] = process.argv.slice(2);
if (!repoDir || !url || !role || !process.send) throw new Error("server helper needs repoDir, url, role and IPC");

const H = require(path.join(repoDir, "test", "support", "harness.js"));
H.setEnv(url);
process.env.PORT = "0";
process.env.GROCERY_SWEEP_MS = "60000";
H.stubOutside(repoDir);

const wa = require(path.join(repoDir, "whatsapp.js"));
let sendNo = 0;
const accepted = () => ({ ok: true, outcome: "accepted", retryable: false,
  wamid: `wamid.RACE.${role}.${process.pid}.${++sendNo}`, data: {}, code: null });
wa.sendText = async () => accepted();
wa.sendTemplate = async () => accepted();
wa.markRead = async () => ({ ok: true });

const mod = require(path.join(repoDir, "server.js"));
const db = require(path.join(repoDir, "db"));
const server = mod.app.listen(0, "127.0.0.1");

server.once("listening", () => {
  process.send({ type: "ready", role, port: server.address().port });
});

async function stop() {
  await new Promise((resolve) => server.close(resolve));
  if (db.shutdown) await db.shutdown();
  process.exit(0);
}

process.on("message", (m) => {
  if (m?.type === "stop") stop().catch((e) => { console.error(e); process.exit(1); });
});

process.on("uncaughtException", (e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
