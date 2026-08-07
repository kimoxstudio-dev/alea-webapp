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

// Schemas known to come from a previous/other stack (e.g. Supabase) that has
// nothing to do with this project's own schema. Their presence means the
// target database is not a fresh/owned-by-us database.
const KNOWN_LEFTOVER_SCHEMAS = [
  "auth",
  "storage",
  "drizzle",
  "supabase_migrations",
  "realtime",
  "internal",
  "pgbouncer",
  "graphql",
  "graphql_public",
  "vault",
];

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

  const leftoverSchemas = await sql.query(
    `SELECT "nspname" FROM "pg_catalog"."pg_namespace" WHERE "nspname" = ANY($1)`,
    [KNOWN_LEFTOVER_SCHEMAS],
  );
  if (leftoverSchemas.length > 0) {
    const names = leftoverSchemas.map((row) => row.nspname).join(", ");
    console.error(
      `Preflight check failed: target database has pre-existing non-Alea schema(s): ${names}.\n` +
        "This script only replays CREATE/IF NOT EXISTS statements and does not verify a clean target on its own.\n" +
        "Run it against a fresh empty database, or pass --force / set ALLOW_NON_EMPTY_DB=1 if you have already verified this is expected.",
    );
    process.exit(1);
  }

  const publicTables = await sql.query(
    `SELECT "tablename" FROM "pg_catalog"."pg_tables" WHERE "schemaname" = 'public'`,
  );
  const unexpectedTables = publicTables
    .map((row) => row.tablename)
    .filter((name) => !expectedTables.has(name));
  if (unexpectedTables.length > 0) {
    console.error(
      `Preflight check failed: "public" schema has pre-existing table(s) not defined by lib/db/schema/: ${unexpectedTables.join(", ")}.\n` +
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
