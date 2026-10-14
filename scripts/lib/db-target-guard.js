"use strict";

// Exact target guard for operator scripts that can mutate a database.
//
// Loopback PostgreSQL is allowed automatically for CI/rehearsals.
// Every non-loopback mutation requires BOTH:
//   ASB_MUTATION_DB_HOST = exact hostname
//   ASB_MUTATION_DB_NAME = exact database name
//
// These authorization values are deliberately separate from DATABASE_URL so a
// copied/pasted URL cannot authorize itself. Neon pooled endpoints are refused
// for migrations/backfills; use the branch's DIRECT endpoint.

class Refused extends Error {}

function targetOf(databaseUrl) {
  if (!databaseUrl) throw new Refused("DATABASE_URL is not set");
  let u;
  try { u = new URL(databaseUrl); }
  catch { throw new Refused("DATABASE_URL is not a valid URL"); }
  const host = String(u.hostname || "").toLowerCase();
  const database = decodeURIComponent(String(u.pathname || "").replace(/^\//, ""));
  if (!host) throw new Refused("DATABASE_URL has no hostname");
  if (!database) throw new Refused("DATABASE_URL has no database name");
  return { host, database };
}

function isLoopback(host) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(String(host).toLowerCase());
}

function assertMutationTarget({
  databaseUrl,
  expectedHost = process.env.ASB_MUTATION_DB_HOST,
  expectedDatabase = process.env.ASB_MUTATION_DB_NAME,
  operation = "database mutation",
} = {}) {
  const target = targetOf(databaseUrl);
  if (isLoopback(target.host)) return { ...target, local: true };

  if (/-pooler\./i.test(target.host) && /\.neon\.tech$/i.test(target.host)) {
    throw new Refused(`${operation}: pooled Neon endpoint ${target.host} is refused; use the DIRECT endpoint`);
  }

  const authorizedHost = String(expectedHost || "").trim().toLowerCase();
  const authorizedDatabase = String(expectedDatabase || "").trim();

  if (!authorizedHost || !authorizedDatabase) {
    throw new Refused(
      `${operation}: remote writes require ASB_MUTATION_DB_HOST and ASB_MUTATION_DB_NAME`
    );
  }
  if (target.host !== authorizedHost) {
    throw new Refused(
      `${operation}: DATABASE_URL host ${target.host} != authorized host ${authorizedHost}`
    );
  }
  if (target.database !== authorizedDatabase) {
    throw new Refused(
      `${operation}: DATABASE_URL database ${target.database} != authorized database ${authorizedDatabase}`
    );
  }

  return { ...target, local: false };
}

module.exports = { Refused, targetOf, isLoopback, assertMutationTarget };
