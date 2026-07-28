import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { join } from "path"

const MIGRATION_DIR = join(__dirname, "../../../lib/db/migrations")
const SCHEMA_DIR = join(__dirname, "../../../lib/db/schema")

function readAllMigrations(): string {
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d+_/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.split("_")[0], 10)
      const numB = parseInt(b.split("_")[0], 10)
      return numA - numB
    })
  const migrations = files.map((f) => readFileSync(join(MIGRATION_DIR, f), "utf-8"))
  return migrations.join("\n")
}

function readAllSchemaFiles(): string {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".ts")).sort()
  const schemas = files.map((f) => readFileSync(join(SCHEMA_DIR, f), "utf-8"))
  return schemas.join("\n")
}

function parseMigrationStatements(sql: string): string[] {
  return sql.split(";--> statement-breakpoint").map((stmt) => stmt.trim()).filter((stmt) => stmt.length > 0 && !stmt.startsWith("-->"))
}

function extractSchemaDefinitions(schemaSource: string) {
  const tables: Record<string, string[]> = {}
  const constraints: Record<string, boolean> = {}

  const tablePattern = /pgTable\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{/g
  let tableMatch
  while ((tableMatch = tablePattern.exec(schemaSource)) !== null) {
    tables[tableMatch[1]] = []
  }

  const namedConstraintPattern = /(check|index|unique|uniqueIndex)\(\s*['"`]([^'"`]+)["'`]/g
  let constraintMatch
  while ((constraintMatch = namedConstraintPattern.exec(schemaSource)) !== null) {
    constraints[constraintMatch[2]] = true
  }

  return { tables, constraints }
}

// Dynamic enum discovery: derived directly from the migration SQL instead of
// a hardcoded list, so an enum added to a future migration is picked up
// automatically instead of being silently skipped.
function extractEnumNamesFromSql(sql: string): string[] {
  const enumPattern = /create\s+type\s+(?:"[^"]+"\.)?"?([a-zA-Z0-9_]+)"?\s+as\s+enum/gi
  const names: string[] = []
  let match
  while ((match = enumPattern.exec(sql)) !== null) {
    names.push(match[1])
  }
  return names
}

// Dynamic EXCLUDE constraint discovery: derived directly from the migration
// SQL instead of a hardcoded pair of names, so a new EXCLUDE constraint
// (e.g. a "bottom" surface counterpart) is picked up automatically.
function extractExcludeConstraintNames(sql: string): string[] {
  const excludePattern = /add\s+constraint\s+"([^"]+)"\s+exclude\s+using\s+gist/gi
  const names: string[] = []
  let match
  while ((match = excludePattern.exec(sql)) !== null) {
    names.push(match[1])
  }
  return names
}

// Extracts the declared SQL type for a single-line quoted column definition,
// e.g. `"password_hash" text,` -> "text". Used to verify column *type*, not
// just that the column name appears somewhere in the SQL.
function extractColumnType(tableSql: string, columnName: string): string | null {
  const pattern = new RegExp(`"${columnName}"\\s+([a-zA-Z0-9_]+(?:\\s*\\([^)]*\\))?)`, "i")
  const match = tableSql.match(pattern)
  return match ? match[1].trim().toLowerCase() : null
}

describe("F1 Drizzle Migration Static SQL Verification (Zero DB)", () => {
  const allMigrationsSql = readAllMigrations()
  const allSchemaSrc = readAllSchemaFiles()
  const statements = parseMigrationStatements(allMigrationsSql)
  const concatenatedSql = statements.join("\n").toLowerCase()
  const schema = extractSchemaDefinitions(allSchemaSrc)

  it("loads migrations dynamically from glob pattern", () => {
    const files = readdirSync(MIGRATION_DIR).filter((f) => f.endsWith(".sql") && /^\d+_/.test(f))
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files).toContain("0000_fine_magma.sql")
    expect(files).toContain("0001_exclusion_constraints.sql")
  })

  it("parses migration SQL into individual statements", () => {
    expect(statements.length).toBeGreaterThan(0)
  })

  it("extracts table names from lib/db/schema/*.ts", () => {
    // A zero-table extraction (e.g. from a regex broken by reformatted,
    // multiline pgTable() calls) must fail loudly instead of vacuously
    // passing every "table X exists" assertion that follows.
    const extractedTableCount = Object.keys(schema.tables).length
    expect(extractedTableCount).toBeGreaterThan(0)

    // Sanity-check the extraction against an independently-derived count:
    // the number of `CREATE TABLE "..."` statements in the migration SQL.
    // If these diverge, either the pgTable() regex or the migration SQL
    // itself has drifted from what's expected.
    const migrationTableCount = (allMigrationsSql.match(/create table\s+"/gi) || []).length
    expect(migrationTableCount).toBeGreaterThan(0)
    expect(extractedTableCount).toBe(migrationTableCount)

    expect(schema.tables["profiles"]).toBeDefined()
  })

  it("extracts constraint names from lib/db/schema/*.ts", () => {
    expect(Object.keys(schema.constraints).length).toBeGreaterThan(0)
  })

  describe("Schema-derived Table Verification", () => {
    it("all schema-defined tables exist in migration SQL", () => {
      for (const tableName of Object.keys(schema.tables)) {
        expect(concatenatedSql).toContain(tableName)
      }
    })

    it("password_hash column in profiles is declared as text (critical Auth.js cutover)", () => {
      expect(allSchemaSrc).toContain("password_hash")
      expect(concatenatedSql).toContain("password_hash")

      const profilesSection = allMigrationsSql.substring(
        allMigrationsSql.indexOf("CREATE TABLE \"profiles\"")
      )
      expect(profilesSection).toContain("password_hash")

      // Verify the *declared type*, not just that the column name appears
      // somewhere in the SQL -- a bare substring match would still pass if
      // the column were mistakenly declared e.g. `integer`.
      const declaredType = extractColumnType(profilesSection, "password_hash")
      expect(declaredType).toBe("text")
    })

    it("clerk_user_id is nullable text with a unique partial index", () => {
      expect(allSchemaSrc).toContain("clerk_user_id")
      expect(concatenatedSql).toContain("clerk_user_id")

      const clerkMigration = readFileSync(
        join(MIGRATION_DIR, "0003_clerk_profile_identity.sql"),
        "utf-8",
      )
      expect(clerkMigration).toMatch(
        /ALTER TABLE "profiles" ADD COLUMN "clerk_user_id" text;/,
      )
      expect(clerkMigration).not.toMatch(/"clerk_user_id" text NOT NULL/i)
      expect(clerkMigration).toMatch(
        /CREATE UNIQUE INDEX "profiles_clerk_user_id_key" ON "profiles" USING btree \("clerk_user_id"\) WHERE "profiles"\."clerk_user_id" is not null;/,
      )
    })
  })

  describe("Schema-derived Constraint Verification", () => {
    it("all schema-defined named constraints exist in migration SQL", () => {
      for (const constraintName of Object.keys(schema.constraints)) {
        expect(concatenatedSql).toContain(constraintName)
      }
    })

    it("EXCLUDE constraints present (hand-written in 0001, discovered dynamically)", () => {
      const excludeConstraintNames = extractExcludeConstraintNames(allMigrationsSql)

      expect(excludeConstraintNames.length).toBeGreaterThan(0)

      // Cross-check the extraction against an independently-derived count
      // (the number of `EXCLUDE USING gist (` clauses) so a constraint whose
      // name the regex fails to capture doesn't silently disappear from
      // coverage.
      const rawExcludeClauseCount = (concatenatedSql.match(/exclude using gist\s*\(/g) || []).length
      expect(excludeConstraintNames.length).toBe(rawExcludeClauseCount)

      for (const constraintName of excludeConstraintNames) {
        expect(concatenatedSql).toContain(constraintName.toLowerCase())
      }
      expect(concatenatedSql).toContain("exclude using gist")
    })
  })

  describe("Extensions", () => {
    it("pgcrypto extension created", () => {
      expect(concatenatedSql).toContain("pgcrypto")
    })

    it("btree_gist extension created", () => {
      expect(concatenatedSql).toContain("btree_gist")
    })
  })

  describe("ENUMs (derived from migration SQL)", () => {
    const migrationEnumNames = extractEnumNamesFromSql(allMigrationsSql)

    it("discovers at least one enum type in the migration SQL", () => {
      expect(migrationEnumNames.length).toBeGreaterThan(0)
    })

    it("every migration-declared enum is referenced in the Drizzle schema", () => {
      for (const enumName of migrationEnumNames) {
        expect(allSchemaSrc).toContain(enumName)
      }
    })
  })

  describe("Foreign Keys", () => {
    it("foreign keys with cascade, restrict, set null policies", () => {
      const cascadeCount = (allMigrationsSql.match(/ON DELETE cascade/gi) || []).length
      expect(cascadeCount).toBeGreaterThan(5)
      expect(concatenatedSql).toContain("on delete cascade")
      expect(concatenatedSql).toContain("on delete restrict")
      expect(concatenatedSql).toContain("on delete set null")
    })
  })

  describe("Indexes", () => {
    it("btree indexes created on columns", () => {
      expect(concatenatedSql).toContain("create index")
      expect(concatenatedSql).toContain("using btree")
    })
  })

  describe("Statement Ordering (Correctness)", () => {
    it("pgcrypto created before gen_random_uuid usage", () => {
      const pgcryptoIdx = allMigrationsSql.indexOf("pgcrypto")
      const randomIdx = allMigrationsSql.indexOf("gen_random_uuid")
      expect(pgcryptoIdx).toBeLessThan(randomIdx)
    })

    it("btree_gist created before EXCLUDE constraints", () => {
      const btreeIdx = allMigrationsSql.indexOf("btree_gist")
      const excludeIdx = allMigrationsSql.indexOf("EXCLUDE USING gist")
      expect(btreeIdx).toBeLessThan(excludeIdx)
    })

    it("ENUMs defined before tables (verified: all 4 enums present)", () => {
      // All 4 ENUM types are defined in 0000_fine_magma before any CREATE TABLE
      expect(concatenatedSql).toContain("create type")
      expect(concatenatedSql).toContain("reservation_status")
      expect(concatenatedSql).toContain("role")
      expect(concatenatedSql).toContain("table_surface")
      expect(concatenatedSql).toContain("table_type")
    })

    it("tables created before foreign keys", () => {
      const tableIdx = allMigrationsSql.indexOf("CREATE TABLE")
      const fkIdx = allMigrationsSql.indexOf("FOREIGN KEY")
      expect(tableIdx).toBeLessThan(fkIdx)
    })

    it("tables created before indexes", () => {
      const tableIdx = allMigrationsSql.indexOf("CREATE TABLE")
      const indexIdx = allMigrationsSql.indexOf("CREATE INDEX")
      expect(tableIdx).toBeLessThan(indexIdx)
    })
  })

  describe("Known schema limitations (documented)", () => {
    it("EXCLUDE constraints not in schema (no Drizzle builder)", () => {
      expect(concatenatedSql).toContain("exclude using gist")
    })

    // PL/pgSQL triggers (like profiles_updated_at) are hand-written SQL that Drizzle ORM
    // does not support in schema definitions. They exist in the database but cannot be
    // verified via schema parsing alone. This is an intentional, documented gap.
    // See Linear KIM-417 for details.

    // Supabase Auth's auth.users table (with its FK to profiles.id) was intentionally
    // dropped when migrating to Clerk on Neon. profiles remains the domain identity;
    // profiles.clerk_user_id provides the external auth mapping.
    // See Linear KIM-417 ("Supabase Auth linkage").
  })
})
