import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * KIM-417: Smoke tests for F1 Drizzle schema + generated migrations.
 *
 * Validates structural consistency between:
 * - lib/db/schema/profiles.ts (Drizzle schema definitions)
 * - lib/db/migrations/0000_fine_magma.sql (initial migration)
 * - lib/db/migrations/0001_exclusion_constraints.sql (constraints + extensions)
 *
 * Catches cross-file drift (e.g. missing columns, extension ordering, schema/SQL misalignment)
 * without requiring a real database or applying migrations.
 */

const MIGRATION_DIR = join(__dirname, '../../../lib/db/migrations')

function readMigration(filename: string): string {
  const path = join(MIGRATION_DIR, filename)
  return readFileSync(path, 'utf-8')
}

describe('F1 Drizzle Schema Smoke Tests', () => {
  describe('Migration 0000_fine_magma.sql', () => {
    it('creates pgcrypto extension before any table definitions with gen_random_uuid', () => {
      const sql = readMigration('0000_fine_magma.sql')

      // Find the CREATE EXTENSION "pgcrypto" statement (not in comments)
      const pgcryptoStatement = 'CREATE EXTENSION IF NOT EXISTS "pgcrypto"'
      const pgcryptoIndex = sql.indexOf(pgcryptoStatement)

      // Find first CREATE TABLE statement with gen_random_uuid default
      const firstTableMatch = sql.match(/CREATE\s+TABLE\s+"[^"]+"\s*\([^)]*DEFAULT\s+gen_random_uuid/)
      const firstTableIndex = firstTableMatch ? sql.indexOf(firstTableMatch[0]) : -1

      expect(pgcryptoIndex).toBeGreaterThan(-1)
      expect(firstTableIndex).toBeGreaterThan(-1)
      expect(pgcryptoIndex).toBeLessThan(firstTableIndex)
    })

    it('includes profiles table with password_hash column', () => {
      const sql = readMigration('0000_fine_magma.sql')

      // Check for CREATE TABLE "profiles"
      expect(sql).toMatch(/CREATE\s+TABLE\s+"profiles"\s*\(/)

      // Check for password_hash column (text, nullable)
      expect(sql).toMatch(/"password_hash"\s+text/)

      // Ensure it's within the profiles table block (before the closing paren + semicolon for profiles)
      const profilesStart = sql.indexOf('CREATE TABLE "profiles"')
      const profilesEnd = sql.indexOf(';--> statement-breakpoint', profilesStart)
      const profilesBlock = sql.substring(profilesStart, profilesEnd)

      expect(profilesBlock).toContain('"password_hash" text')
    })

    it('defines profiles table with required columns for Auth.js credentials provider', () => {
      const sql = readMigration('0000_fine_magma.sql')
      const profilesStart = sql.indexOf('CREATE TABLE "profiles"')
      const profilesEnd = sql.indexOf(';--> statement-breakpoint', profilesStart)
      const profilesBlock = sql.substring(profilesStart, profilesEnd)

      // The credentials provider selects these columns
      // See: PR #170 (KIM-416) Auth.js implementation
      expect(profilesBlock).toContain('"id" uuid PRIMARY KEY')
      expect(profilesBlock).toContain('"auth_email" text')
      expect(profilesBlock).toContain('"password_hash" text')
    })

    it('profiles table id column is primary key (required for auth identity)', () => {
      const sql = readMigration('0000_fine_magma.sql')
      const profilesStart = sql.indexOf('CREATE TABLE "profiles"')
      const profilesEnd = sql.indexOf(';--> statement-breakpoint', profilesStart)
      const profilesBlock = sql.substring(profilesStart, profilesEnd)

      expect(profilesBlock).toMatch(/"id"\s+uuid\s+PRIMARY\s+KEY/)
    })
  })

  describe('Migration 0001_exclusion_constraints.sql', () => {
    it('creates btree_gist extension (required for GIST index operators)', () => {
      const sql = readMigration('0001_exclusion_constraints.sql')
      expect(sql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"btree_gist"/)
    })

    it('pgcrypto is NOT created here (already created in 0000)', () => {
      const sql = readMigration('0001_exclusion_constraints.sql')
      // Should NOT create pgcrypto (it's already in 0000)
      // Check specifically for CREATE EXTENSION statements
      const createExtensions = sql.match(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"[^"]+"/g) || []
      const hasPgcrypto = createExtensions.some((ext) => ext.includes('pgcrypto'))
      expect(hasPgcrypto).toBe(false)
    })

    it('applies EXCLUDE constraints requiring btree_gist for UUID operators', () => {
      const sql = readMigration('0001_exclusion_constraints.sql')

      // Should have reservations constraints with GIST and UUID operations
      expect(sql).toContain('ALTER TABLE "reservations"')
      expect(sql).toContain('EXCLUDE USING gist')
      expect(sql).toContain('"table_id" WITH =')
    })
  })

  describe('Schema/Migration alignment', () => {
    it('Drizzle schema profiles.ts defines password_hash matching the SQL', () => {
      // Read the Drizzle schema file
      const schemaPath = join(__dirname, '../../../lib/db/schema/profiles.ts')
      const schemaTsContent = readFileSync(schemaPath, 'utf-8')

      // The TS schema must include passwordHash (maps to password_hash in SQL)
      expect(schemaTsContent).toContain("passwordHash: text('password_hash')")
    })

    it('profiles.ts passwordHash column is nullable (for pre-cutover rows)', () => {
      const schemaPath = join(__dirname, '../../../lib/db/schema/profiles.ts')
      const schemaTsContent = readFileSync(schemaPath, 'utf-8')

      // Should NOT have .notNull() on passwordHash (it's nullable by design)
      // This regex checks that the line defining passwordHash does NOT end with .notNull()
      const passwordHashLine = schemaTsContent.match(/passwordHash:\s*text\([^)]+\)([^,}]*)/)?.[0]
      expect(passwordHashLine).toBeDefined()
      // Nullable by default in Drizzle (no .notNull()), and confirmed in SQL as just 'text'
      expect(passwordHashLine).not.toMatch(/\.notNull\(\)/)
    })

    it('defines a nullable Clerk identity mapping with a unique partial index', () => {
      const schemaPath = join(__dirname, '../../../lib/db/schema/profiles.ts')
      const schemaTsContent = readFileSync(schemaPath, 'utf-8')

      expect(schemaTsContent).toContain("clerkUserId: text('clerk_user_id')")
      expect(schemaTsContent).toContain("uniqueIndex('profiles_clerk_user_id_key')")
      expect(schemaTsContent).toContain('.where(sql`${t.clerkUserId} is not null`)')

      const clerkUserIdLine = schemaTsContent.match(/clerkUserId:\s*text\([^)]+\)([^,}]*)/)?.[0]
      expect(clerkUserIdLine).toBeDefined()
      expect(clerkUserIdLine).not.toMatch(/\.notNull\(\)/)
    })

    it('keeps the schema-drift manifest aligned with the Clerk identity column', () => {
      const driftScriptPath = join(__dirname, '../../../scripts/check-schema-drift.mjs')
      const driftScriptContent = readFileSync(driftScriptPath, 'utf-8')

      expect(driftScriptContent).toContain("clerk_user_id: 'text'")
    })

    it('migrations directory structure is complete (0000 + 0001 + meta)', () => {
      const fs = require('fs')
      const files = fs.readdirSync(MIGRATION_DIR)

      expect(files).toContain('0000_fine_magma.sql')
      expect(files).toContain('0001_exclusion_constraints.sql')
      expect(files).toContain('meta')
    })
  })

  describe('Consistency with PR #170 (Auth.js credentials provider)', () => {
    it('profiles table schema satisfies Auth.js credentials provider query requirements', () => {
      // PR #170 (KIM-416) implements a credentials provider that runs:
      // SELECT password_hash FROM profiles WHERE auth_email = $1 LIMIT 1
      // This test verifies the schema supports that query.

      const sql = readMigration('0000_fine_magma.sql')
      const profilesStart = sql.indexOf('CREATE TABLE "profiles"')
      const profilesEnd = sql.indexOf(';--> statement-breakpoint', profilesStart)
      const profilesBlock = sql.substring(profilesStart, profilesEnd)

      // Must have:
      // - password_hash column (to select)
      // - auth_email column (to filter by)
      // - Both must exist and be readable
      expect(profilesBlock).toContain('"password_hash" text')
      expect(profilesBlock).toContain('"auth_email" text')
    })
  })

  describe('Transitional Auth.js schema compatibility', () => {
    it('password_hash column exists in profiles until Clerk replaces Auth.js', () => {
      // KIM-451 removes the transitional Auth.js runtime. Until then, its
      // credentials provider still requires profiles.password_hash.

      const sql = readMigration('0000_fine_magma.sql')
      const profilesStart = sql.indexOf('CREATE TABLE "profiles"')
      const profilesEnd = sql.indexOf(';--> statement-breakpoint', profilesStart)
      const profilesBlock = sql.substring(profilesStart, profilesEnd)

      expect(profilesBlock).toContain('"password_hash" text')
    })
  })
})
