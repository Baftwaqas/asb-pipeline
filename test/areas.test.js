// Karachi areas (founder, 19 Nov 2026): every phone gets an area; the bot asks
// new people to verify their delivery location; out-of-area people hear "we'll
// tell you first"; the team can set it; the send chooser targets an area.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, wa, A, broadcast;
let n = 0;
const hook = (phone, message) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    contacts: [{ wa_id: phone, profile: { name: "Test" } }],
    messages: [{ from: phone, id: `wamid.area${++n}`, timestamp: String(1795000000 + n), ...message }],
  } }] }],
});
const say = (phone, text) => H.postWhatsApp(base, hook(phone, { type: "text", text: { body: text } }));
const tap = (phone, id, title) => H.postWhatsApp(base, hook(phone, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } }));
const pin = (phone, lat, lng, extra = {}) => H.postWhatsApp(base, hook(phone, { type: "location", location: { latitude: lat, longitude: lng, ...extra } }));
const to = (phone) => sent.filter((s) => s.phone === phone);
const settle = (phone, k) => H.waitFor(async () => to(phone).length >= k);
const loc = async (phone) => (await db.query(`SELECT l.*, a.name FROM customer_locations l LEFT JOIN karachi_areas a ON a.id = l.area_id WHERE phone = $1`, [phone])).rows[0];

before(async () => {
  const url = await H.createDatabase("asb_t_areas", ROOT);
  H.setEnv(url);
  process.env.AREA_BOT = "on";
  process.env.INBOX_PASSWORD = "local-test-only";
  process.env.INBOX_COOKIE_SECRET = "local-test-only-secret";
  sent = H.stubOutside(ROOT);
  wa = require(path.join(ROOT, "whatsapp.js"));
  let k = 0;
  wa.sendButtons = async (phone, text, buttons) => { sent.push({ kind: "buttons", phone, text, buttons }); return { ok: true, wamid: `wamid.B${++k}`, data: {} }; };
  wa.sendLocationRequest = async (phone, text) => { sent.push({ kind: "location", phone, text }); return { ok: true, wamid: `wamid.L${++k}`, data: {} }; };
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  A = require(path.join(ROOT, "areas.js"));
  broadcast = require(path.join(ROOT, "broadcast.js"));
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 200));
  await db?.shutdown();
});

test("the list: all 7 districts, ~90 areas, names unique, Gulistan-e-Johar served", async () => {
  const list = await A.all(db);
  assert.equal(new Set(list.map((a) => a.district)).size, 7);
  assert.ok(list.length >= 90);
  assert.deepEqual(list.filter((a) => a.served).map((a) => a.name), ["Gulistan-e-Johar"]);
});

test("typed areas match the way people write them", async () => {
  const list = await A.all(db);
  const m = (t) => A.matchText(list, t)?.name || null;
  assert.equal(m("johar block 13"), "Gulistan-e-Johar");
  assert.equal(m("Gulistan e Jauhar"), "Gulistan-e-Johar");
  assert.equal(m("GULSHAN-E-IQBAL block 6"), "Gulshan-e-Iqbal");
  assert.equal(m("north nazimabad block h"), "North Nazimabad");
  assert.equal(m("nazimabad no 3"), "Nazimabad");
  assert.equal(m("DHA phase 6"), "DHA (Defence)");
  assert.equal(m("gulshan e maymar"), "Gulshan-e-Maymar");
  assert.equal(m("F.B Area"), "Federal B Area");
  assert.equal(m("Gulshann iqbal"), "Gulshan-e-Iqbal");   // one-letter slip
  assert.equal(m("2 kg aloo aur pyaz"), null);
});

test("a pin suggests the nearest area (within 8 km), or nothing", async () => {
  const list = await A.all(db);
  assert.equal(A.matchPoint(list, 24.9185, 67.1290).name, "Gulistan-e-Johar");
  assert.equal(A.matchPoint(list, 24.8010, 67.0660).name, "DHA (Defence)");
  assert.equal(A.matchPoint(list, 25.40, 68.36), null);   // Hyderabad
});

test("new customer in Gulistan-e-Johar: asked to verify, types her area, confirms, welcomed", async () => {
  const p = "923007000001";
  await say(p, "Assalam o alaikum, rate list bhej dein");
  await settle(p, 1);
  assert.equal(to(p)[0].kind, "location");
  assert.match(to(p)[0].text, /delivery location verify kar dein/);
  await say(p, "johar block 15");
  await settle(p, 2);
  assert.equal(to(p)[1].kind, "buttons");
  assert.match(to(p)[1].text, /Gulistan-e-Johar/);
  assert.equal((await loc(p)).area_id, null, "nothing saved before she says yes");
  await tap(p, "area:yes", "Ji haan");
  await settle(p, 3);
  assert.match(to(p)[2].text, /deliver karte hain/);
  assert.equal((await loc(p)).name, "Gulistan-e-Johar");
  // never asked again
  await say(p, "2 kg tamatar");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(to(p).length, 3);
  // the bot's messages show in the chat for the team
  const logged = (await db.query(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE phone = $1 AND agent = 'area bot'`, [p])).rows[0].n;
  assert.equal(logged, 3);
});

test("outside our areas: a pin, she confirms, and hears we will tell her first", async () => {
  const p = "923007000002";
  await say(p, "salam");
  await settle(p, 1);
  await pin(p, 24.9420, 67.0400);              // North Nazimabad
  await settle(p, 2);
  assert.match(to(p)[1].text, /North Nazimabad/);
  await say(p, "ji haan");
  await settle(p, 3);
  assert.match(to(p)[2].text, /deliver nahi karte, lekin jaise hi shuru karenge aap ko sab se pehle batayenge/);
  const l = await loc(p);
  assert.equal(l.name, "North Nazimabad");
  assert.equal(l.source, "bot");
  assert.ok(l.lat);
});

test("'Nahi' then a name; two misses hand over to the team", async () => {
  const p = "923007000003";
  await say(p, "hello");
  await settle(p, 1);
  await say(p, "gulshan");
  await settle(p, 2);
  await tap(p, "area:no", "Nahi");
  await settle(p, 3);
  assert.equal(to(p)[2].kind, "location");     // asked again
  await say(p, "mera ghar masjid ke paas hai");
  await settle(p, 4);
  assert.match(to(p)[3].text, /team aap ka area dekh kar/);
  assert.equal((await loc(p)).bot_state, "staff");
});

test("society customers count as their area without being asked; switch off = silent", async () => {
  const soc = (await db.query(`INSERT INTO societies (code, name, area) VALUES ('AR1', 'Test Towers', 'Gulistan-e-Johar') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO customers (phone, society_id) VALUES ('923007000004', $1)`, [soc]);
  await say("923007000004", "salam");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(to("923007000004").length, 0);
  assert.equal((await A.areaOf(db, "923007000004")).name, "Gulistan-e-Johar");

  process.env.AREA_BOT = "off";
  await say("923007000005", "salam");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(to("923007000005").length, 0);
  process.env.AREA_BOT = "on";
  process.env.INBOX_PASSWORD = "local-test-only";
  process.env.INBOX_COOKIE_SECRET = "local-test-only-secret";
});

test("counts per area, and phones by area or district (STOP left out at send time)", async () => {
  const list = await A.all(db);
  const gulshan = list.find((a) => a.name === "Gulshan-e-Iqbal");
  await A.setArea(db, "923007000010", gulshan.id, { by: "Waqas" });
  await A.setArea(db, "923007000011", gulshan.id, { by: "Waqas" });
  const c = await A.counts(db);
  assert.equal(c.find((x) => x.name === "Gulshan-e-Iqbal").people, 2);
  assert.ok(c.find((x) => x.name === "Gulistan-e-Johar").people >= 2);
  assert.deepEqual((await A.phonesIn(db, { areaId: gulshan.id })).sort(), ["923007000010", "923007000011"]);
  const east = await A.phonesIn(db, { district: "Karachi East" });
  assert.ok(east.includes("923007000010") && east.includes("923007000001"));
  assert.ok(!east.includes("923007000002"));   // North Nazimabad is Karachi Central

  await db.query(`INSERT INTO marketing_opt_outs (phone, source) VALUES ('923007000011', 'replied STOP')`);
  const pick = await broadcast.pickFromChats(db, { who: "area", areaId: gulshan.id });
  assert.deepEqual(pick.phones, ["923007000010"]);
  assert.equal(pick.leftOut, 1);
});

test("the team: sets an area from the chat, adds a new area, marks an area served", async () => {
  const r = await fetch(`${base}/api/inbox/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "local-test-only", name: "Waqas" }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  const api = async (u, body) => (await fetch(`${base}${u}`, {
    method: body ? "POST" : "GET", headers: { cookie, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json();

  const list = (await api("/api/inbox/areas")).areas;
  const clifton = list.find((a) => a.name === "Clifton");
  // the "two misses" customer from earlier: the team sets her area
  await api("/api/inbox/area", { phone: "923007000003", areaId: clifton.id, agent: "Waqas" });
  let t = await api("/api/inbox/thread/923007000003");
  assert.equal(t.area.name, "Clifton");
  assert.equal(t.area.source, "staff");

  const added = (await api("/api/inbox/areas/new", { name: "Naval Colony", district: "Keamari", agent: "Waqas" })).area;
  assert.equal(added.district, "Keamari");
  assert.equal((await api(`/api/inbox/areas/${clifton.id}/served`, { served: true, agent: "Waqas" })).area.served, true);
  const after = (await api("/api/inbox/areas")).areas;
  assert.equal(after.find((a) => a.name === "Clifton").people, 1);
  assert.ok(after.find((a) => a.name === "Naval Colony"));
});
