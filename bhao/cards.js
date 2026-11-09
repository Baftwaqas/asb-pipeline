// ============================================================================
// ASB PIPELINE — bhao/cards.js
// Seth Ji's picture cards, drawn on the server as JPG (founder, 9 Nov):
//   * the Bhao Card - the header image above his first tap buttons;
//   * the victory card - "Aap ne Seth Ji ko hara diya!", the one customers
//     screenshot and forward to their society groups.
// Plain JPG so any phone shows it (the founder's rule for customer images).
// Fonts ship with the code (Noto Sans, SIL OFL - assets/fonts). No emoji are
// drawn (no colour-emoji font on the server); shapes stand in for them.
// If the drawing library is missing, every function returns null and the
// caller sends the same words as text - a card is never load-bearing.
// ============================================================================
"use strict";

const path = require("path");

let lib = null, ready = false;
function canvasLib() {
  if (ready) return lib;
  ready = true;
  try {
    lib = require("@napi-rs/canvas");
    const dir = path.join(__dirname, "assets", "fonts");
    lib.GlobalFonts.registerFromPath(path.join(dir, "noto-sans-latin-400-normal.woff2"), "ASB Sans");
    lib.GlobalFonts.registerFromPath(path.join(dir, "noto-sans-latin-700-normal.woff2"), "ASB Sans Bold");
    lib.GlobalFonts.registerFromPath(path.join(dir, "noto-sans-latin-900-normal.woff2"), "ASB Sans Black");
  } catch (e) {
    console.warn("[bhao] cards: drawing library unavailable, sending text instead:", e.message);
    lib = null;
  }
  return lib;
}

const C = Object.freeze({
  green: "#0f5c43", greenDeep: "#0a4232", cream: "#fff7e6", gold: "#f2b632", goldDeep: "#c98a0c",
  ink: "#16231d", paper: "#fffdf7", muted: "#5b6b62", chip: "#e4f1ea", red: "#c0392b",
});
const rs = (paisa) => "Rs " + Math.round(paisa / 100).toLocaleString("en-US");
// labels arrive with emoji ("Gold customer ⭐"); the server font has none
const plain = (s) => String(s || "").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();

function fit(g, text, maxWidth, font, startPx, minPx = 18) {
  let px = startPx;
  do { g.font = `${px}px "${font}"`; if (g.measureText(text).width <= maxWidth) return px; px -= 2; } while (px > minPx);
  g.font = `${minPx}px "${font}"`;
  return minPx;
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function star(g, cx, cy, r, color) {
  g.fillStyle = color; g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r;
    g[i ? "lineTo" : "moveTo"](cx + rr * Math.cos(a), cy + rr * Math.sin(a));
  }
  g.closePath(); g.fill();
}
/** A bazaar awning across the top: the shop, not an app. */
function awning(g, w, h, a = C.green, b = C.cream) {
  const n = 12, sw = w / n;
  for (let i = 0; i < n; i++) {
    g.fillStyle = i % 2 ? b : a;
    g.beginPath(); g.moveTo(i * sw, 0); g.lineTo((i + 1) * sw, 0); g.lineTo((i + 1) * sw, h);
    g.arc(i * sw + sw / 2, h, sw / 2, 0, Math.PI); g.closePath(); g.fill();
  }
}

/**
 * The Bhao Card, 1200x628 (WhatsApp's header ratio, 1.91:1).
 * { itemName, askPaisa, perks: [labels], more: [labels], title }
 */
function bhaoCard({ itemName, askPaisa, perks = [], more = [], title = null }) {
  const L = canvasLib(); if (!L) return null;
  const W = 1200, H = 628, cv = L.createCanvas(W, H), g = cv.getContext("2d");
  g.fillStyle = C.paper; g.fillRect(0, 0, W, H);
  awning(g, W, 70);
  // left: who she is today
  g.fillStyle = C.ink; g.font = '30px "ASB Sans Bold"'; g.fillText("SETH JI KI DUKAAN", 60, 150);
  g.fillStyle = C.green; fit(g, "Aap ka Bhao Card", 640, "ASB Sans Black", 66); g.fillText("Aap ka Bhao Card", 56, 222);
  let y = 290;
  for (const label of perks.map(plain).filter(Boolean).slice(0, 4)) {
    g.font = '30px "ASB Sans Bold"';
    const w = Math.min(640, g.measureText(label).width + 70);
    g.fillStyle = C.chip; roundRect(g, 56, y - 38, w, 54, 27); g.fill();
    star(g, 88, y - 11, 13, C.goldDeep);
    g.fillStyle = C.ink; fit(g, label, w - 70, "ASB Sans Bold", 30); g.fillText(label, 112, y);
    y += 70;
  }
  if (title) { g.fillStyle = C.muted; g.font = '26px "ASB Sans"'; g.fillText("Darja: " + plain(title), 60, Math.min(y + 6, 560)); }
  // right: the price tag
  const tx = 760, ty = 130, tw = 380, th = 330;
  g.fillStyle = C.green; roundRect(g, tx, ty, tw, th, 28); g.fill();
  g.fillStyle = C.cream; g.beginPath(); g.arc(tx + tw / 2, ty + 34, 12, 0, 2 * Math.PI); g.fill();
  g.fillStyle = C.cream; g.font = '28px "ASB Sans"'; fit(g, plain(itemName), tw - 50, "ASB Sans", 28);
  g.textAlign = "center"; g.fillText(plain(itemName), tx + tw / 2, ty + 100);
  g.font = '26px "ASB Sans"'; g.fillText("Seth Ji ka daam", tx + tw / 2, ty + 160);
  g.fillStyle = C.gold; fit(g, rs(askPaisa), tw - 40, "ASB Sans Black", 84); g.fillText(rs(askPaisa), tx + tw / 2, ty + 250);
  g.fillStyle = C.cream; g.font = '22px "ASB Sans"'; g.fillText("Ab aap apna daam lagayein", tx + tw / 2, ty + 300);
  g.textAlign = "left";
  // bottom strip: what gives more room
  g.fillStyle = C.greenDeep; g.fillRect(0, H - 76, W, 76);
  g.fillStyle = C.cream; const strip = more.length ? "Aur gunjaish:  " + more.map(plain).join("   |   ") : "Har sauda alag hota hai - aap ka card aap ka bhao";
  fit(g, strip, W - 120, "ASB Sans Bold", 28); g.fillText(strip, 60, H - 28);
  return cv.toBuffer("image/jpeg", 88);
}

/**
 * The victory card, 1080x1080 - made to be forwarded.
 * { itemName, openPaisa, unitPaisa, qty, title, itemCode }
 */
function victoryCard({ itemName, openPaisa, unitPaisa, qty = 1, title = null, itemCode }) {
  const L = canvasLib(); if (!L) return null;
  if (!(openPaisa > unitPaisa)) return null;
  const W = 1080, H = 1080, cv = L.createCanvas(W, H), g = cv.getContext("2d");
  g.fillStyle = C.green; g.fillRect(0, 0, W, H);
  // sunburst
  g.save(); g.translate(W / 2, 360); g.fillStyle = "rgba(255,247,230,0.07)";
  for (let i = 0; i < 24; i++) { g.rotate(Math.PI / 12); g.beginPath(); g.moveTo(0, 0); g.lineTo(-60, -900); g.lineTo(60, -900); g.closePath(); g.fill(); }
  g.restore();
  awning(g, W, 64, C.gold, C.cream);
  // trophy
  g.fillStyle = C.gold; g.beginPath(); g.moveTo(450, 170); g.lineTo(630, 170); g.quadraticCurveTo(630, 330, 540, 345); g.quadraticCurveTo(450, 330, 450, 170); g.fill();
  g.lineWidth = 16; g.strokeStyle = C.gold; g.beginPath(); g.arc(450, 225, 42, Math.PI / 2, 1.5 * Math.PI); g.stroke(); g.beginPath(); g.arc(630, 225, 42, 1.5 * Math.PI, Math.PI / 2); g.stroke();
  g.fillRect(522, 340, 36, 50); roundRect(g, 470, 385, 140, 34, 8); g.fill();
  star(g, 540, 245, 34, C.cream);
  g.textAlign = "center";
  g.fillStyle = C.cream; fit(g, "Aap ne Seth Ji ko hara diya!", W - 120, "ASB Sans Black", 70); g.fillText("Aap ne Seth Ji ko hara diya!", W / 2, 500);
  g.font = '32px "ASB Sans"'; fit(g, plain(itemName), W - 160, "ASB Sans", 32); g.fillText(plain(itemName) + (qty > 1 ? `  x ${qty}` : ""), W / 2, 556);
  // the numbers
  const bx = 120, by = 600, bw = W - 240, bh = 270;
  g.fillStyle = C.paper; roundRect(g, bx, by, bw, bh, 30); g.fill();
  g.fillStyle = C.muted; g.font = '30px "ASB Sans"'; g.fillText("Seth Ji ne kaha", bx + bw * 0.27, by + 62);
  g.fillText("Aap ka sauda", bx + bw * 0.73, by + 62);
  g.font = '58px "ASB Sans Bold"'; const o = rs(openPaisa); g.fillText(o, bx + bw * 0.27, by + 140);
  const ow = g.measureText(o).width; g.strokeStyle = C.red; g.lineWidth = 7; g.beginPath(); g.moveTo(bx + bw * 0.27 - ow / 2 - 6, by + 120); g.lineTo(bx + bw * 0.27 + ow / 2 + 6, by + 120); g.stroke();
  g.fillStyle = C.green; g.font = '64px "ASB Sans Black"'; g.fillText(rs(unitPaisa), bx + bw * 0.73, by + 142);
  const saved = (openPaisa - unitPaisa) * qty, pct = Math.round(((openPaisa - unitPaisa) / openPaisa) * 100);
  g.fillStyle = C.gold; roundRect(g, bx + 60, by + 175, bw - 120, 66, 33); g.fill();
  g.fillStyle = C.ink; g.font = '36px "ASB Sans Black"'; g.fillText(`Bachat ${rs(saved)}  (${pct}%)`, W / 2, by + 220);
  g.fillStyle = C.cream; g.font = '30px "ASB Sans Bold"';
  if (title) g.fillText("Darja: " + plain(title), W / 2, 930);
  g.font = '26px "ASB Sans"'; g.fillText(`Aap bhi try karein: WhatsApp pe likhein  BHAO ${itemCode}`, W / 2, 990);
  g.font = '24px "ASB Sans Bold"'; g.fillStyle = C.gold; g.fillText("APNA SASTA BAZAAR", W / 2, 1040);
  g.textAlign = "left";
  return cv.toBuffer("image/jpeg", 88);
}

module.exports = { bhaoCard, victoryCard, plain, available: () => !!canvasLib() };
