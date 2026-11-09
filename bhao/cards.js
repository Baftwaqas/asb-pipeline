// ============================================================================
// ASB PIPELINE — bhao/cards.js
// Seth Ji's picture cards, drawn on the server as JPG (founder, 9 Nov):
//   * the Bhao Card - the header image above his first tap buttons;
//   * the victory card - "Aap ne Seth Ji ko hara diya!", the one customers
//     screenshot and forward to their society groups.
//
// In ASB's own brand (founder, 9 Nov: "why have you not used our logo, brand
// colors and font?"): the Vermilion & Ice palette on Ink - the same as the
// website header, intro and WhatsApp profile - the real ASB logo
// (assets/brand, from the ASB-Logo set), and Poppins, the wordmark's own
// typeface (SIL OFL, assets/fonts). Colours live in BRAND below, one place.
//
// Plain JPG so any phone shows it (the founder's rule for customer images).
// Both functions are async (the logo decodes asynchronously).
// No emoji are drawn (no colour-emoji font on the server); the ASB mark and
// simple shapes stand in. If the drawing library is missing, every function
// returns null and the caller sends the same words as text - a card is never
// load-bearing.
// ============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const BRAND = Object.freeze({
  vermilion: "#FF4825",
  ink: "#151515",
  inkSoft: "#232323",
  ice: "#86F3FF",
  white: "#FFFFFF",
  blush: "#FFF6F3",
  grey: "#9A9A9A",
  strike: "#FF4825",
});

let lib = null, ready = false, logosReady = Promise.resolve();
const logos = {};
function canvasLib() {
  if (ready) return lib;
  ready = true;
  try {
    lib = require("@napi-rs/canvas");
    const fonts = path.join(__dirname, "assets", "fonts");
    lib.GlobalFonts.registerFromPath(path.join(fonts, "poppins-latin-400-normal.woff2"), "Poppins Regular");
    lib.GlobalFonts.registerFromPath(path.join(fonts, "poppins-latin-600-normal.woff2"), "Poppins SemiBold");
    lib.GlobalFonts.registerFromPath(path.join(fonts, "poppins-latin-800-normal.woff2"), "Poppins ExtraBold");
    // decoded asynchronously (an Image given a buffer draws nothing until it has loaded)
    logosReady = Promise.all([["horizontal", "asb-logo-horizontal-ice-on-dark.png"], ["stacked", "asb-logo-stacked-ice-on-dark.png"]]
      .map(([k, f]) => lib.loadImage(fs.readFileSync(path.join(__dirname, "assets", "brand", f))).then((img) => { logos[k] = img; })))
      .catch((e) => console.warn("[bhao] cards: logo not loaded:", e.message));
  } catch (e) {
    console.warn("[bhao] cards: drawing library unavailable, sending text instead:", e.message);
    lib = null;
  }
  return lib;
}

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
/** The ASB mark (three heads joined by one wave body), from the logo set's geometry. */
function mark(g, x, y, scale, color) {
  g.save(); g.translate(x, y); g.scale(scale, scale);
  g.fillStyle = color; g.strokeStyle = color;
  for (const cx of [70, 150, 230]) { g.beginPath(); g.arc(cx, 54, 31, 0, 2 * Math.PI); g.fill(); }
  g.lineWidth = 30; g.lineCap = "round"; g.beginPath();
  g.moveTo(22, 168);
  g.bezierCurveTo(36, 138, 50, 100, 70, 100); g.bezierCurveTo(90, 100, 96, 140, 110, 140);
  g.bezierCurveTo(124, 140, 130, 100, 150, 100); g.bezierCurveTo(170, 100, 176, 140, 190, 140);
  g.bezierCurveTo(204, 140, 210, 100, 230, 100); g.bezierCurveTo(250, 100, 264, 138, 278, 168);
  g.stroke(); g.restore();
}
function logo(g, kind, x, y, w) {
  const img = logos[kind]; if (!img) return 0;
  const h = (img.height / img.width) * w;
  g.drawImage(img, x, y, w, h);
  return h;
}

/**
 * The Bhao Card, 1200x628 (WhatsApp's header ratio, 1.91:1).
 * { itemName, askPaisa, perks: [labels], more: [labels], title }
 */
async function bhaoCard({ itemName, askPaisa, perks = [], more = [], title = null }) {
  const L = canvasLib(); if (!L) return null;
  await logosReady;
  const W = 1200, H = 628, cv = L.createCanvas(W, H), g = cv.getContext("2d");
  g.fillStyle = BRAND.ink; g.fillRect(0, 0, W, H);
  // a big, quiet mark behind the price - the brand, not decoration
  g.globalAlpha = 0.07; mark(g, 700, 40, 1.9, BRAND.vermilion); g.globalAlpha = 1;
  logo(g, "horizontal", 56, 44, 330);
  // left: who she is today
  g.fillStyle = BRAND.ice; g.font = '24px "Poppins SemiBold"'; g.fillText("SETH JI KI DUKAAN", 58, 150);
  g.fillStyle = BRAND.white; fit(g, "Aap ka Bhao Card", 620, "Poppins ExtraBold", 64); g.fillText("Aap ka Bhao Card", 54, 222);
  let y = 296;
  for (const label of perks.map(plain).filter(Boolean).slice(0, 3)) {
    g.font = '28px "Poppins SemiBold"';
    const w = Math.min(620, g.measureText(label).width + 76);
    g.strokeStyle = BRAND.ice; g.lineWidth = 2.5; roundRect(g, 56, y - 38, w, 56, 28); g.stroke();
    g.fillStyle = BRAND.vermilion; g.beginPath(); g.arc(90, y - 10, 9, 0, 2 * Math.PI); g.fill();
    g.fillStyle = BRAND.white; fit(g, label, w - 76, "Poppins SemiBold", 28); g.fillText(label, 114, y);
    y += 72;
  }
  if (title) { g.fillStyle = BRAND.grey; g.font = '24px "Poppins Regular"'; g.fillText("Darja: " + plain(title), 58, Math.min(y + 2, 540)); }
  // right: the price tag, in vermilion
  const tx = 740, ty = 120, tw = 404, th = 350;
  g.fillStyle = BRAND.vermilion; roundRect(g, tx, ty, tw, th, 30); g.fill();
  g.fillStyle = BRAND.ink; g.beginPath(); g.arc(tx + tw / 2, ty + 34, 12, 0, 2 * Math.PI); g.fill();
  g.textAlign = "center";
  g.fillStyle = BRAND.white; fit(g, plain(itemName), tw - 50, "Poppins SemiBold", 28); g.fillText(plain(itemName), tx + tw / 2, ty + 100);
  g.font = '24px "Poppins Regular"'; g.fillText("Seth Ji ka daam", tx + tw / 2, ty + 158);
  g.fillStyle = BRAND.white; fit(g, rs(askPaisa), tw - 40, "Poppins ExtraBold", 86); g.fillText(rs(askPaisa), tx + tw / 2, ty + 252);
  g.fillStyle = BRAND.ink; g.font = '22px "Poppins SemiBold"'; g.fillText("Ab aap apna daam lagayein", tx + tw / 2, ty + 312);
  g.textAlign = "left";
  // bottom strip: what gives more room, in ice
  g.fillStyle = BRAND.ice; g.fillRect(0, H - 74, W, 74);
  g.fillStyle = BRAND.ink;
  const strip = more.length ? "Aur gunjaish:  " + more.map(plain).join("   |   ") : "Har sauda alag hota hai - aap ka card aap ka bhao";
  fit(g, strip, W - 120, "Poppins SemiBold", 27); g.fillText(strip, 58, H - 27);
  return cv.toBuffer("image/jpeg", 90);
}

/**
 * The victory card, 1080x1080 - made to be forwarded.
 * { itemName, openPaisa, unitPaisa, qty, title, itemCode }
 */
async function victoryCard({ itemName, openPaisa, unitPaisa, qty = 1, title = null, itemCode }) {
  const L = canvasLib(); if (!L) return null;
  await logosReady;
  if (!(openPaisa > unitPaisa)) return null;
  const W = 1080, H = 1080, cv = L.createCanvas(W, H), g = cv.getContext("2d");
  g.fillStyle = BRAND.ink; g.fillRect(0, 0, W, H);
  // rays in vermilion, very faint
  g.save(); g.translate(W / 2, 300); g.fillStyle = "rgba(255,72,37,0.08)";
  for (let i = 0; i < 24; i++) { g.rotate(Math.PI / 12); g.beginPath(); g.moveTo(0, 0); g.lineTo(-55, -900); g.lineTo(55, -900); g.closePath(); g.fill(); }
  g.restore();
  // trophy in vermilion, the ASB mark on it in ink
  const v = BRAND.vermilion;
  g.fillStyle = v; g.beginPath(); g.moveTo(445, 120); g.lineTo(635, 120); g.quadraticCurveTo(635, 290, 540, 305); g.quadraticCurveTo(445, 290, 445, 120); g.fill();
  g.lineWidth = 16; g.strokeStyle = v; g.beginPath(); g.arc(445, 178, 44, Math.PI / 2, 1.5 * Math.PI); g.stroke(); g.beginPath(); g.arc(635, 178, 44, 1.5 * Math.PI, Math.PI / 2); g.stroke();
  g.fillRect(522, 300, 36, 50); roundRect(g, 468, 345, 144, 34, 8); g.fill();
  mark(g, 487, 150, 0.36, BRAND.ink);
  g.textAlign = "center";
  g.fillStyle = BRAND.white; fit(g, "Aap ne Seth Ji ko hara diya!", W - 120, "Poppins ExtraBold", 66); g.fillText("Aap ne Seth Ji ko hara diya!", W / 2, 462);
  g.fillStyle = BRAND.ice; fit(g, plain(itemName), W - 160, "Poppins SemiBold", 30);
  g.fillText(plain(itemName) + (qty > 1 ? `  x ${qty}` : ""), W / 2, 514);
  // the numbers on white
  const bx = 110, by = 556, bw = W - 220, bh = 280;
  g.fillStyle = BRAND.white; roundRect(g, bx, by, bw, bh, 30); g.fill();
  g.fillStyle = "#6b6b6b"; g.font = '28px "Poppins Regular"';
  g.fillText("Seth Ji ne kaha", bx + bw * 0.27, by + 62); g.fillText("Aap ka sauda", bx + bw * 0.73, by + 62);
  g.fillStyle = "#6b6b6b"; g.font = '54px "Poppins SemiBold"'; const o = rs(openPaisa); g.fillText(o, bx + bw * 0.27, by + 140);
  const ow = g.measureText(o).width; g.strokeStyle = BRAND.strike; g.lineWidth = 7;
  g.beginPath(); g.moveTo(bx + bw * 0.27 - ow / 2 - 6, by + 122); g.lineTo(bx + bw * 0.27 + ow / 2 + 6, by + 122); g.stroke();
  g.fillStyle = BRAND.ink; g.font = '62px "Poppins ExtraBold"'; g.fillText(rs(unitPaisa), bx + bw * 0.73, by + 144);
  const saved = (openPaisa - unitPaisa) * qty, pct = Math.round(((openPaisa - unitPaisa) / openPaisa) * 100);
  g.fillStyle = BRAND.ice; roundRect(g, bx + 60, by + 180, bw - 120, 68, 34); g.fill();
  g.fillStyle = BRAND.ink; g.font = '34px "Poppins ExtraBold"'; g.fillText(`Bachat ${rs(saved)}  (${pct}%)`, W / 2, by + 226);
  g.fillStyle = BRAND.white; g.font = '28px "Poppins SemiBold"';
  if (title) g.fillText("Darja: " + plain(title), W / 2, 892);
  g.fillStyle = BRAND.grey; g.font = '24px "Poppins Regular"'; g.fillText(`Aap bhi try karein: WhatsApp pe likhein  BHAO ${itemCode}`, W / 2, 940);
  g.textAlign = "left";
  logo(g, "horizontal", (W - 360) / 2, 984, 360);
  return cv.toBuffer("image/jpeg", 90);
}

module.exports = { BRAND, bhaoCard, victoryCard, plain, available: () => !!canvasLib() };
