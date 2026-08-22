#!/usr/bin/env node
/**
 * One-off script (#296) to apply lib/db/schema/*.sql against a Neon
 * database. Reads DATABASE_URL from the environment / .env.local — never
 * hardcode credentials here.
 *
 * Drift detection (#328): each schema file's content is fingerprinted with a
 * SHA-256 checksum recorded in the `schema_migrations` ledger table. A file
 * whose table(s) already exist is only skipped when its checksum still
 * matches the last-applied checksum — this is a *verified* no-op, not a
 * blind one. If a previously-applied file's content changed (e.g. a new
 * `ALTER TABLE` was added to schema-as-code) without the ledger being
 * updated, that is schema drift: the run fails loudly instead of silently
 * skipping the file, so changes never go silently missing from the database.
 *
 * Drift detection also covers two extra directions (PR #338 review): (1) a
 * ledger row whose .sql file was deleted/renamed — still fails loudly unless
 * explicitly acknowledged via --allow-removed <filename>[,<filename>...];
 * and (2) a fully-matched ledger is never trusted on its own — the tables
 * the current schema files describe are independently re-verified to exist
 * before "already up to date" is reported, catching a partially restored or
 * corrupted database whose ledger rows outlived its actual schema.
 *
 * Usage: node scripts/apply-neon-schema.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
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

// Ledger table (#328) tracking which schema files have been applied and
// with what content checksum, so a table already existing can be told apart
// from "this exact file content was already applied". Not defined via a
// lib/db/schema/*.sql file (it is infrastructure for this script itself),
// so it is treated as an always-expected/always-owned table by the
// preflight check below rather than picked up by extractExpectedTableNames.
const LEDGER_TABLE = "schema_migrations";

// Safely quotes a Postgres identifier for interpolation into SQL text.
// Only ever called with table names sourced from this script's own trusted
// inputs (pg_catalog.pg_tables query results, or names parsed out of this
// script's own lib/db/schema/*.sql files) — never external/user input.
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Parses one or more `--allow-removed <filename>[,<filename>...]` flags out
// of argv into a Set of filenames explicitly acknowledged as intentionally
// removed/renamed despite still having a ledger row. This is the explicit,
// audited bypass for the missing-file drift check below — removal of an
// already-applied migration file is never accepted silently.
function parseAllowRemovedFlag(argv) {
  const allowed = new Set();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--allow-removed") continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) continue;
    for (const name of value.split(",")) {
      const trimmed = name.trim();
      if (trimmed) allowed.add(trimmed);
    }
  }
  return allowed;
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

// Computes a SHA-256 checksum (hex digest) of a schema file's raw text.
// Used by the schema_migrations ledger to detect drift — content that
// changed since the file was last applied. Exported as a named export so
// qa-engineer can unit test it directly without spinning up a database.
export function computeChecksum(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

// Fetches the current table names in the "public" schema. Shared by the
// preflight check and by assertExpectedTablesArePresent below, so both stay
// in sync on how "what tables actually exist" is determined.
async function fetchPublicTableNames(sql) {
  const rows = await sql.query(
    `SELECT "tablename" FROM "pg_catalog"."pg_tables" WHERE "schemaname" = 'public'`,
  );
  return rows.map((row) => row.tablename);
}

// Read-only preflight: aborts if the target database has state that did not
// come from this script, so a "successful" run can't silently apply on top
// of (and thereby appear to validate) an unrelated/leftover database.
//
// `allowUnexpectedTables` (PR #338 follow-up): when the caller has already
// passed at least one `--allow-removed <filename>` flag, a table produced by
// that removed file (whose name we cannot recover — the ledger only stores
// filename + checksum, not the objects it created) is expected to still be
// physically present and would otherwise be misidentified as unowned
// leftover state here, permanently blocking the very acknowledgment flow
// meant to handle it. When true, step 2 below is downgraded from a hard
// failure to a warning; steps 1 (schema allowlist) and 3 (row-emptiness)
// still apply unchanged.
async function assertDatabaseIsCleanOrOwned(sql, expectedTables, { allowUnexpectedTables = false } = {}) {
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
  const publicTableNames = await fetchPublicTableNames(sql);
  const unexpectedTables = publicTableNames.filter((name) => !expectedTables.has(name));
  if (unexpectedTables.length > 0) {
    if (allowUnexpectedTables) {
      console.log(
        `Preflight note: "public" schema has table(s) not defined by the current lib/db/schema/ files: ${unexpectedTables.join(", ")}.\n` +
          "Not treated as a hard failure because --allow-removed was passed for this run — verify manually that these are explained by the acknowledged removed file(s) and not genuinely unrelated leftover state.",
      );
    } else {
      console.error(
        `Preflight check failed: "public" schema has pre-existing table(s) not defined by lib/db/schema/: ${unexpectedTables.join(", ")}.\n` +
          "Run it against a fresh empty database, or pass --force / set ALLOW_NON_EMPTY_DB=1 if you have already verified this is expected.",
      );
      process.exit(1);
    }
  }

  // 3. Row-emptiness check: an expected table that already exists must be
  // empty — non-empty means stale/leftover data from a prior run, not a
  // fresh database. Tables that don't exist yet (first run) have nothing to
  // check and are skipped. Uses a cheap EXISTS/LIMIT 1 probe per table
  // instead of COUNT(*), since expected tables could hold real data.
  // LEDGER_TABLE is exempt: it is expected to accumulate rows across runs
  // by design (one row per applied schema file), so a non-empty ledger on a
  // re-run is normal, not evidence of a leftover/dirty database.
  const existingExpectedTables = publicTableNames.filter(
    (name) => expectedTables.has(name) && name !== LEDGER_TABLE,
  );
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

// Creates the schema_migrations ledger table if it does not already exist.
// CREATE TABLE IF NOT EXISTS keeps this idempotent and safe to run on every
// invocation, mirroring the schema files it tracks.
async function ensureLedgerTable(sql) {
  await sql.query(
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(LEDGER_TABLE)} (
       "filename" text PRIMARY KEY,
       "checksum" text NOT NULL,
       "applied_at" timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

// Loads the current ledger contents into a Map of filename -> checksum.
async function loadLedger(sql) {
  const rows = await sql.query(
    `SELECT "filename", "checksum" FROM ${quoteIdent(LEDGER_TABLE)}`,
  );
  const ledger = new Map();
  for (const row of rows) {
    ledger.set(row.filename, row.checksum);
  }
  return ledger;
}

// Verifies the ledger table has this script's expected shape before it is
// queried or written to. LEDGER_TABLE ("schema_migrations") is a common name
// (golang-migrate, Knex, and Rails all default to it) — a pre-existing,
// unrelated table with that same name would otherwise pass
// `CREATE TABLE IF NOT EXISTS` silently (it no-ops on an existing table) and
// only surface later as a raw, unactionable Postgres "column does not exist"
// error the first time the ledger is queried or written to.
async function assertLedgerTableShape(sql) {
  const rows = await sql.query(
    `SELECT "column_name" FROM "information_schema"."columns"
     WHERE "table_schema" = 'public' AND "table_name" = $1`,
    [LEDGER_TABLE],
  );
  const columnNames = new Set(rows.map((row) => row.column_name));
  const requiredColumns = ["filename", "checksum", "applied_at"];
  const missingColumns = requiredColumns.filter((name) => !columnNames.has(name));
  if (missingColumns.length > 0) {
    console.error(
      `A "${LEDGER_TABLE}" table already exists but is missing expected column(s): ` +
        `${missingColumns.join(", ")}.\n` +
        `This usually means a pre-existing, unrelated table happens to share this name (a ` +
        `common one — e.g. golang-migrate, Knex, or Rails all default to "${LEDGER_TABLE}"). ` +
        "Rename or drop that table, or point DATABASE_URL at a different database, before running this script.",
    );
    process.exit(1);
  }
}

// A fully-matched ledger (every current schema file already has a matching,
// unchanged checksum row) is not, by itself, proof that the database is
// actually in the state those files describe — a partially restored or
// corrupted database could have schema_migrations rows without the tables
// those migrations were supposed to create. Independently re-checks that
// the tables the current schema files define are still present before the
// caller is allowed to trust "already up to date"; a missing table here is
// drift too, and must fail loudly rather than pass silently.
async function assertExpectedTablesArePresent(sql, expectedTables) {
  const publicTableNames = new Set(await fetchPublicTableNames(sql));
  const tablesToVerify = [...expectedTables].filter((name) => name !== LEDGER_TABLE);
  const missingTables = tablesToVerify.filter((name) => !publicTableNames.has(name));
  if (missingTables.length > 0) {
    console.error(
      `Schema drift detected: the "${LEDGER_TABLE}" ledger reports every current schema file ` +
        `as already applied, but the following expected table(s) are missing from the database:\n` +
        missingTables.map((name) => `  - ${name}`).join("\n") +
        `\n\nThis usually means the database was partially restored or corrupted (e.g. the ` +
        `"${LEDGER_TABLE}" table was restored without the schema objects it describes). ` +
        `Investigate the actual database state directly — this script has no automated repair ` +
        `path for a ledger that disagrees with the real schema.`,
    );
    process.exit(1);
  }
}

// Exported so tests can import and call it directly with mocks, without
// triggering the auto-run path below (mirrors scripts/seed-dev.mjs).
export async function main() {
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

  const expectedTables = extractExpectedTableNames(files);
  expectedTables.add(LEDGER_TABLE);

  // The ledger table/rows are loaded before the preflight check below, not
  // just parsed from argv (PR #338 review, finding 2): --allow-removed
  // downgrades a hard preflight failure to a warning for the whole run, so a
  // typo'd or never-actually-ledgered filename must not be able to trigger
  // that bypass. ensureLedgerTable is idempotent (CREATE TABLE IF NOT
  // EXISTS) and this table is already treated as always-expected and exempt
  // from the preflight's row-emptiness check, so creating it here — ahead of
  // the read-only checks below — does not affect their outcome.
  await ensureLedgerTable(sql);
  await assertLedgerTableShape(sql);
  const ledger = await loadLedger(sql);

  const allowedRemovedFiles = parseAllowRemovedFlag(process.argv);
  const unknownAllowedRemovedFiles = [...allowedRemovedFiles].filter(
    (filename) => !ledger.has(filename),
  );
  if (unknownAllowedRemovedFiles.length > 0) {
    console.error(
      `--allow-removed named file(s) that are not present in the "${LEDGER_TABLE}" ledger: ` +
        `${unknownAllowedRemovedFiles.join(", ")}.\n` +
        "Each --allow-removed filename must match a file that was actually applied and recorded " +
        "in the ledger before its removal can be acknowledged — a typo'd or never-ledgered " +
        "filename must not be able to silently downgrade the preflight's unexpected-table check " +
        "for the entire run. Check the filename(s) for typos and re-run.",
    );
    process.exit(1);
  }

  // A table produced by an acknowledged removed file is expected to still be
  // physically present, and the preflight's "unexpected table" check would
  // otherwise block the --allow-removed acknowledgment flow further down
  // before it ever runs (PR #338 follow-up). See assertDatabaseIsCleanOrOwned's
  // own comment.
  await assertDatabaseIsCleanOrOwned(sql, expectedTables, {
    allowUnexpectedTables: allowedRemovedFiles.size > 0,
  });

  // Reverse-direction drift check: a ledger row records a filename as
  // already applied, but its .sql file no longer exists on disk (deleted or
  // renamed). The migration's effect is still baked into the database (the
  // ledger row proves it ran), so silently ignoring this would let a later
  // run report "already up to date" even though the working tree no longer
  // has any record of what that migration did. Removing an already-applied
  // file must be an explicit, audited action via --allow-removed, never a
  // silent side effect of the file simply being gone.
  const missingFiles = [];
  const removedButAllowed = [];
  for (const filename of ledger.keys()) {
    if (files.includes(filename)) continue;
    if (allowedRemovedFiles.has(filename)) {
      removedButAllowed.push(filename);
    } else {
      missingFiles.push(filename);
    }
  }

  if (missingFiles.length > 0) {
    console.error(
      `Schema drift detected: the "${LEDGER_TABLE}" ledger records ${missingFiles.length} ` +
        `file(s) as already applied, but they no longer exist in lib/db/schema/:\n` +
        missingFiles.map((filename) => `  - ${filename}`).join("\n") +
        `\n\nTheir effect is still present in the database (the ledger row proves they ran), so ` +
        `this could mean a migration file was deleted or renamed without accounting for the ` +
        `schema change it represents. If this removal is intentional and already verified, ` +
        `re-run with --allow-removed <filename>[,<filename>...] to acknowledge it explicitly.`,
    );
    process.exit(1);
  }

  // The ledger row(s) for removedButAllowed are NOT deleted yet — deletion
  // is deferred until every other abort condition (drifted files, checked
  // below) has been evaluated, and is applied atomically with the rest of
  // this run's outcome (PR #338 follow-up). Deleting immediately here would
  // mean a run that ultimately aborts due to unrelated drift still leaves a
  // partial, uncommitted-in-spirit mutation behind — defeating this
  // script's "abort before any statements are executed" guarantee.
  if (removedButAllowed.length > 0) {
    console.log(
      `--allow-removed acknowledged for ${removedButAllowed.length} previously-applied file(s) ` +
        `no longer on disk; their ledger row(s) will be removed once no other abort condition is ` +
        `found: ${removedButAllowed.join(", ")}`,
    );
    for (const filename of removedButAllowed) {
      ledger.delete(filename);
    }
  }

  console.log(
    `Checking ${files.length} schema file(s) from lib/db/schema/ against the "${LEDGER_TABLE}" ledger...`,
  );

  // Classify every file up front — new (never applied), unchanged (checksum
  // matches the ledger, a verified no-op), or drifted (a ledger row exists
  // but the checksum no longer matches) — before applying anything. This
  // way a drifted file anywhere aborts the whole run before any statements
  // are executed, rather than leaving some files applied and others not.
  const filesToApply = [];
  const unchangedFiles = [];
  const driftedFiles = [];
  for (const file of files) {
    const filePath = join(schemaDir, file);
    const text = readFileSync(filePath, "utf8");
    const checksum = computeChecksum(text);
    const previousChecksum = ledger.get(file);

    if (previousChecksum === undefined) {
      const statements = splitStatements(text);
      console.log(`-> ${file} (${statements.length} statement(s)) [new — will apply]`);
      filesToApply.push({ file, checksum, statements });
    } else if (previousChecksum === checksum) {
      console.log(`-> ${file} (already applied, unchanged — skipping)`);
      unchangedFiles.push(file);
    } else {
      driftedFiles.push({ file, previousChecksum, checksum });
    }
  }

  if (driftedFiles.length > 0) {
    console.error(
      `Schema drift detected in ${driftedFiles.length} file(s) — content changed since ` +
        `it was last applied, and the "${LEDGER_TABLE}" ledger was never updated to match:\n` +
        driftedFiles
          .map(
            ({ file, previousChecksum, checksum }) =>
              `  - ${file}\n` +
              `      ledger checksum:  ${previousChecksum}\n` +
              `      current checksum: ${checksum}`,
          )
          .join("\n") +
        `\n\nThis means schema changes in the file(s) above may be silently missing from the ` +
        `database. Review the diff in each file above. This script has no automated re-apply ` +
        `path for a drifted file — if the change is intentional, verify it and apply it to the ` +
        `database manually, then update that file's row in "${LEDGER_TABLE}" to record its ` +
        `current checksum before re-running this script.`,
    );
    process.exit(1);
  }

  // Do not trust the ledger alone: independently verify the tables the
  // already-ledgered, unchanged files describe are actually present. Run
  // unconditionally — not only when there is nothing new to apply (PR #338
  // review, finding 1) — so a run that also has genuinely new schema file(s)
  // still catches drift on the unrelated ledgered files it is skipping,
  // rather than only re-verifying when filesToApply happens to be empty.
  // Restricted to unchangedFiles' own tables (not the full expectedTables
  // set) since a genuinely new file's table(s) do not exist yet at this
  // point in the run. Checked before any DB mutation below (both the
  // deferred removedButAllowed deletion and applying new files), so a
  // failure here still leaves zero DB mutations from this run.
  const unchangedExpectedTables = extractExpectedTableNames(unchangedFiles);
  await assertExpectedTablesArePresent(sql, unchangedExpectedTables);

  if (filesToApply.length === 0) {
    // Only now is the run fully committed to succeeding — safe to persist
    // the removedButAllowed ledger-row deletion(s) deferred above. Batched
    // into a single DELETE (one round-trip regardless of how many filenames
    // were acknowledged) rather than one query per file.
    if (removedButAllowed.length > 0) {
      try {
        await sql.query(`DELETE FROM ${quoteIdent(LEDGER_TABLE)} WHERE "filename" = ANY($1)`, [
          removedButAllowed,
        ]);
      } catch (err) {
        console.error(
          `Failed to remove "${LEDGER_TABLE}" ledger row(s) for acknowledged --allow-removed ` +
            `file(s): ${removedButAllowed.join(", ")}.\n` +
            "No schema DDL was involved in this run — only the ledger row cleanup failed.",
        );
        throw err;
      }
    }
    console.log("No new or changed schema files to apply. Database is already up to date.");
    return;
  }

  console.log(`Applying ${filesToApply.length} new schema file(s)...`);

  const allStatements = filesToApply.flatMap(({ statements }) => statements);

  // Apply every statement from every new file, the deferred removedButAllowed
  // ledger-row deletion (if any), plus a ledger row per applied file, as a
  // single Postgres transaction (one HTTP round-trip via the neon() driver's
  // transaction() helper), so a mid-way failure rolls back all of it — and
  // the ledger stays in sync with what was actually committed — instead of
  // leaving the database partially migrated.
  try {
    await sql.transaction((txn) => [
      ...(removedButAllowed.length > 0
        ? [
            txn.query(`DELETE FROM ${quoteIdent(LEDGER_TABLE)} WHERE "filename" = ANY($1)`, [
              removedButAllowed,
            ]),
          ]
        : []),
      ...allStatements.map((stmt) => txn.query(stmt)),
      ...filesToApply.map(({ file, checksum }) =>
        txn.query(
          `INSERT INTO ${quoteIdent(LEDGER_TABLE)} ("filename", "checksum")
           VALUES ($1, $2)
           ON CONFLICT ("filename")
           DO UPDATE SET "checksum" = EXCLUDED."checksum", "applied_at" = now()`,
          [file, checksum],
        ),
      ),
    ]);
  } catch (err) {
    console.error("Schema application failed — transaction rolled back, no changes were committed.");
    throw err;
  }

  console.log("Schema applied successfully.");
}

// Only run main() if this script is executed directly, not when imported for testing
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed to apply schema:", err.message);
    process.exit(1);
  });
}
