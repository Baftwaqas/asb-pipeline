#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/community-review.js   (npm run community:review)
//
// Operator view of Community intake rows that need a person. READ-ONLY unless
// --requeue ... --apply is given.
//
//   npm run community:review                       # what needs attention now
//   npm run community:review -- --all              # every row, resolved too
//   npm run community:review -- --status review    # one state
//   npm run community:review -- --order 1030       # one order (#1030, 1030, or Shopify order id)
//   npm run community:review -- --json             # machine-readable
//
//   # after fixing the cause (e.g. registry), send ONE review row back to the
//   # worker. Guarded, audited, dry run without --apply:
//   npm run community:review -- --requeue <intake id> --by "Waqas" --reason "..." [--apply]
//
// "Needs attention" = status review, status retryable_error, or status
// received for longer than --stuck-min minutes (default 10: the sweeper runs
// every minute, so a row still 'received' after 10 means the worker is off or
// failing).
//
// Nothing here can move a row to grocery. Re-queue sends a review row back to
// the Community worker only; if the cause is not fixed it lands in review again.
// ============================================================================

"use strict";

const registry = require("../community/registry");

async function attentionRows(q, { all = false, status, order, stuckMin = 10, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (status) where.push(`i.status = ${p(status)}`);
  else if (!all) {
    where.push(`(i.status IN ('review','retryable_error')
                 OR (i.status = 'received' AND i.received_at < now() - make_interval(mins => ${p(Math.max(0, Math.floor(Number(stuckMin) || 0)))})))`);
  }
  if (order) {
    const o = String(order).replace(/^#/, "");
    where.push(`(i.shopify_order_id = ${p(o)} OR i.shopify_order_name = ${p("#" + o)})`);
  }
  const { rows } = await q.query(
    `SELECT i.id, i.shopify_order_name AS order_name, i.shopify_order_id AS order_id,
            i.shopify_line_item_id AS line_id, i.shopify_variant_id AS variant_id, i.sku,
            concat_ws(' / ', i.title, i.variant_title) AS item, i.quantity, i.customer_phone AS phone,
            i.classification, array_to_string(i.signals, '+') AS signals,
            i.status, i.review_reason AS reason, i.attempts, left(i.last_error, 120) AS last_error,
            i.order_created_at, i.received_at, i.updated_at, i.next_attempt_at, i.resolved_variant_gid
       FROM community_intake i
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY i.received_at, i.id
      LIMIT ${p(Math.max(1, Math.floor(Number(limit) || 200)))}`, params);
  return rows;
}

async function summary(q) {
  const byStatus = (await q.query(
    `SELECT status, coalesce(review_reason, '') AS reason, count(*)::int AS n
       FROM community_intake GROUP BY 1, 2 ORDER BY 1, 2`)).rows;
  const reg = (await q.query(
    `SELECT (SELECT count(*) FROM community_products)::int                         AS products,
            (SELECT count(*) FROM community_products WHERE NOT is_active)::int     AS products_deactivated,
            (SELECT count(*) FROM community_products WHERE NOT signals_ok)::int    AS products_signals_lost,
            (SELECT count(*) FROM community_variants)::int                         AS variants,
            (SELECT count(*) FROM community_variants WHERE NOT is_active)::int     AS variants_deactivated,
            (SELECT max(last_synced_at) FROM community_products)                   AS registry_last_synced,
            (SELECT string_agg(DISTINCT registered_via, ',') FROM community_products) AS registered_via`)).rows[0];
  return { intake: byStatus, registry: reg };
}

/** Send one review row back to the worker. Guarded + audited. Never touches grocery. */
async function requeue(db, { id, actor, reason, apply = false }) {
  registry.requireWho(actor, reason);
  const run = async (q) => {
    const r = (await q.query(
      `SELECT id, status, review_reason, attempts, last_error, shopify_order_name, sku
         FROM community_intake WHERE id = $1 ${apply ? "FOR UPDATE" : ""}`, [id])).rows[0];
    if (!r) throw new registry.GuardError(`intake row ${id} does not exist`);
    if (r.status !== "review") {
      throw new registry.GuardError(`intake row ${id} is '${r.status}' - only 'review' rows can be re-queued`);
    }
    const plan = { action: "requeue_intake", id: r.id, order: r.shopify_order_name, sku: r.sku,
                   from: { status: r.status, reason: r.review_reason, attempts: r.attempts, last_error: r.last_error },
                   to: { status: "received", attempts: 0 },
                   effect: "the Community worker re-checks it; if the cause is not fixed it returns to review" };
    if (!apply) return { applied: false, plan };
    await q.query(
      // attempts restart at 0 so a re-queued row gets the full retry budget;
      // the previous count and error are kept in the audit row.
      `UPDATE community_intake
          SET status = 'received', review_reason = NULL, attempts = 0, last_error = NULL, next_attempt_at = now()
        WHERE id = $1`, [r.id]);
    await registry.audit(q, { actor, action: "requeue_intake", targetType: "intake", targetId: r.id, reason,
                              before: plan.from, after: plan.to });
    return { applied: true, plan };
  };
  return apply ? db.tx(run) : run(db);
}

function fmt(v) {
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 19);
  return v === null || v === undefined ? "" : String(v);
}

function printTable(rows) {
  if (!rows.length) { console.log("  (nothing needs attention)"); return; }
  const cols = ["id", "order_name", "line_id", "variant_id", "sku", "item", "quantity", "status", "reason",
                "attempts", "last_error", "order_created_at", "received_at", "updated_at", "next_attempt_at"];
  for (const r of rows) {
    console.log("  " + cols.map((c) => `${c}=${fmt(r[c])}`).filter((s) => !s.endsWith("=")).join("  "));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
  const db = require("../db");
  try {
    if (args.includes("--requeue")) {
      const r = await requeue(db, { id: Number(val("--requeue")), actor: val("--by"), reason: val("--reason"),
                                    apply: args.includes("--apply") });
      console.log(JSON.stringify(r.plan, null, 2));
      console.log(r.applied ? "\nAPPLIED and recorded in community_audit." : "\nDry run - nothing written. Add --apply.");
      return;
    }
    const rows = await attentionRows(db, {
      all: args.includes("--all"), status: val("--status"), order: val("--order"),
      stuckMin: val("--stuck-min") ?? 10, limit: Math.max(1, Math.floor(Number(val("--limit")) || 200)),
    });
    const sum = await summary(db);
    if (args.includes("--json")) { console.log(JSON.stringify({ summary: sum, rows }, null, 2)); return; }
    console.log("Community intake by state:");
    for (const s of sum.intake) console.log(`  ${s.status.padEnd(16)} ${String(s.n).padStart(5)}  ${s.reason}`);
    const g = sum.registry;
    console.log(`Registry: ${g.products} products (${g.products_deactivated} deactivated, ${g.products_signals_lost} signals lost), ` +
                `${g.variants} variants (${g.variants_deactivated} deactivated); last synced ${fmt(g.registry_last_synced)} via ${g.registered_via || "-"}`);
    console.log(`\nRows ${args.includes("--all") || val("--status") ? "selected" : "needing attention"} (${rows.length}):`);
    printTable(rows);
  } catch (e) {
    console.error(`[community-review] ${e.code === "ASB_COMMUNITY_GUARD" ? "REFUSED" : "failed"}: ${e.message}`);
    process.exitCode = e.code === "ASB_COMMUNITY_GUARD" ? 3 : 1;
  } finally {
    await db.shutdown();
  }
}

if (require.main === module) main();

module.exports = { attentionRows, summary, requeue };
