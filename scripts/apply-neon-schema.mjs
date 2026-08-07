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

  console.log(`Applying ${files.length} schema file(s) from lib/db/schema/ ...`);

  for (const file of files) {
    const filePath = join(schemaDir, file);
    const text = readFileSync(filePath, "utf8");
    const statements = splitStatements(text);
    console.log(`-> ${file} (${statements.length} statement(s))`);
    for (const stmt of statements) {
      await sql.query(stmt);
    }
  }

  console.log("Schema applied successfully.");
}

main().catch((err) => {
  console.error("Failed to apply schema:", err.message);
  process.exit(1);
});
