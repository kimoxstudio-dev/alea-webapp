#!/usr/bin/env node
/**
 * One-off script (#296) to apply lib/db/schema/*.sql against a Neon
 * database. Reads DATABASE_URL from the environment / .env.local — never
 * hardcode credentials here.
 *
 * Usage: node scripts/apply-neon-schema.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const schemaDir = join(rootDir, "lib", "db", "schema");

// Postgres-internal schemas that are always present in every database and
// are not evidence of leftover state from another stack/project. Anything
// else besides "public" (this project's own schema) fails the preflight
// check — an allowlist, not a denylist of specific known-bad names, so an
// arbitrary unlisted schema (e.g. "legacy") is caught too.
const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

// Safely quotes a Postgres identifier for interpolation into SQL text.
// Only ever called with table names sourced from this script's own trusted
// inputs (pg_catalog.pg_tables query results, or names parsed out of this
// script's own lib/db/schema/*.sql files) — never external/user input.
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function loadEnvLocal() {
  const envPath = join(rootDir, ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// Splits a .sql file into individual top-level statements on ";", while
// treating dollar-quoted blocks (e.g. `DO $$ ... $$;`, used for idempotent
// CREATE TYPE) as opaque — semicolons inside a dollar-quoted block never
// split the statement.
function splitStatements(sqlText) {
  const withoutComments = sqlText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const statements = [];
  let current = "";
  let dollarTag = null; // e.g. "$$" or "$tag$" when inside a dollar-quoted block

  for (let i = 0; i < withoutComments.length; i++) {
    const char = withoutComments[i];
    current += char;

    if (dollarTag) {
      if (withoutComments.startsWith(dollarTag, i)) {
        current += dollarTag.slice(1); // already added one char above
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (char === "$") {
      const match = withoutComments.slice(i).match(/^\$[a-zA-Z_]*\$/);
      if (match) {
        dollarTag = match[0];
        current += withoutComments.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
      }
      continue;
    }

    if (char === ";") {
      const stmt = current.slice(0, -1).trim();
      if (stmt) statements.push(stmt);
      current = "";
    }
  }

  const rest = current.trim();
  if (rest) statements.push(rest);

  return statements;
}

// Parses `CREATE TABLE [IF NOT EXISTS] "name"` out of this script's own
// schema files, so the preflight check always stays in sync with the actual
// schema definitions without needing a separately maintained list.
function extractExpectedTableNames(files) {
  const names = new Set();
  for (const file of files) {
    const text = readFileSync(join(schemaDir, file), "utf8");
    for (const match of text.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+"([^"]+)"/gi)) {
      names.add(match[1]);
    }
  }
  return names;
}

// Read-only preflight: aborts if the target database has state that did not
// come from this script, so a "successful" run can't silently apply on top
// of (and thereby appear to validate) an unrelated/leftover database.
async function assertDatabaseIsCleanOrOwned(sql, expectedTables) {
  if (process.argv.includes("--force") || process.env.ALLOW_NON_EMPTY_DB === "1") {
    console.log("Preflight check skipped (--force / ALLOW_NON_EMPTY_DB=1).");
    return;
  }

  console.log("Running preflight check (target database must be empty or already owned by this schema)...");

  // 1. Schema allowlist: only "public" plus Postgres-internal system schemas
  // are acceptable. Any other schema at all — a known leftover stack schema
  // (auth, storage, drizzle, ...) or an arbitrary one (legacy, ...) — means
  // the target database is not a fresh/owned-by-us database.
  const unexpectedSchemas = await sql.query(
    `SELECT "nspname" FROM "pg_catalog"."pg_namespace"
     WHERE "nspname" <> 'public'
       AND "nspname" <> ALL($1)
       AND "nspname" !~ '^pg_temp_'
       AND "nspname" !~ '^pg_toast_temp_'`,
    [SYSTEM_SCHEMAS],
  );
  if (unexpectedSchemas.length > 0) {
    const names = unexpectedSchemas.map((row) => row.nspname).join(", ");
    console.error(
      `Preflight check failed: target database has unexpected schema(s) not owned by this project: ${names}.\n` +
        'Only "public" plus Postgres-internal system schemas are allowed.\n' +
        "Run it against a fresh empty database, or pass --force / set ALLOW_NON_EMPTY_DB=1 if you have already verified this is expected.",
    );
    process.exit(1);
  }

  // 2. Unexpected-table check: any table in "public" whose name is not
  // produced by this script's own schema files is a hard fail.
  const publicTables = await sql.query(
    `SELECT "tablename" FROM "pg_catalog"."pg_tables" WHERE "schemaname" = 'public'`,
  );
  const publicTableNames = publicTables.map((row) => row.tablename);
  const unexpectedTables = publicTableNames.filter((name) => !expectedTables.has(name));
  if (unexpectedTables.length > 0) {
    console.error(
      `Preflight check failed: "public" schema has pre-existing table(s) not defined by lib/db/schema/: ${unexpectedTables.join(", ")}.\n` +
        "Run it against a fresh empty database, or pass --force / set ALLOW_NON_EMPTY_DB=1 if you have already verified this is expected.",
    );
    process.exit(1);
  }

  // 3. Row-emptiness check: an expected table that already exists must be
  // empty — non-empty means stale/leftover data from a prior run, not a
  // fresh database. Tables that don't exist yet (first run) have nothing to
  // check and are skipped. Uses a cheap EXISTS/LIMIT 1 probe per table
  // instead of COUNT(*), since expected tables could hold real data.
  const existingExpectedTables = publicTableNames.filter((name) => expectedTables.has(name));
  const nonEmptyTables = [];
  for (const tableName of existingExpectedTables) {
    const rows = await sql.query(
      `SELECT EXISTS (SELECT 1 FROM ${quoteIdent(tableName)} LIMIT 1) AS "has_rows"`,
    );
    if (rows[0]?.has_rows) {
      nonEmptyTables.push(tableName);
    }
  }
  if (nonEmptyTables.length > 0) {
    console.error(
      `Preflight check failed: pre-existing table(s) already contain data: ${nonEmptyTables.join(", ")}.\n` +
        "Run it against a fresh empty database, or pass --force / set ALLOW_NON_EMPTY_DB=1 if you have already verified this is expected.",
    );
    process.exit(1);
  }

  console.log("Preflight check passed.");
}

async function main() {
  loadEnvLocal();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is not set (checked process.env and .env.local).");
    process.exit(1);
  }

  const sql = neon(databaseUrl);

  const files = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await assertDatabaseIsCleanOrOwned(sql, extractExpectedTableNames(files));

  console.log(`Applying ${files.length} schema file(s) from lib/db/schema/ ...`);

  const allStatements = [];
  for (const file of files) {
    const filePath = join(schemaDir, file);
    const text = readFileSync(filePath, "utf8");
    const statements = splitStatements(text);
    console.log(`-> ${file} (${statements.length} statement(s))`);
    allStatements.push(...statements);
  }

  // Apply every statement from every file as a single Postgres transaction
  // (one HTTP round-trip via the neon() driver's transaction() helper), so a
  // mid-way failure rolls back all DDL instead of leaving the database
  // partially migrated.
  try {
    await sql.transaction((txn) => allStatements.map((stmt) => txn.query(stmt)));
  } catch (err) {
    console.error("Schema application failed — transaction rolled back, no changes were committed.");
    throw err;
  }

  console.log("Schema applied successfully.");
}

main().catch((err) => {
  console.error("Failed to apply schema:", err.message);
  process.exit(1);
});
