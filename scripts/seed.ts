#!/usr/bin/env tsx
/**
 * scripts/seed.ts — dev-only seed + admin bootstrap on Neon (KIM-432).
 *
 * Part of the Supabase→Neon migration (Linear KIM-393..422). All Supabase
 * dev data is throwaway — there is no data migration. This script seeds a
 * minimal, working fixture set directly on the target Neon/Postgres
 * database via Drizzle so a human can manually test admin flows (e.g. admin
 * image upload) once the app runs against Neon.
 *
 * This is intentionally NOT `supabase/seed.sql`: that file is Supabase-era
 * (writes into `auth.users` / the old `public.profiles` shape) and is out of
 * scope here — see the `supabase/seed.sql` header for the legacy flow. This
 * script is Drizzle/Neon-native TypeScript and talks to `lib/db/schema`
 * directly with its own local `pg.Pool` + `drizzle-orm/node-postgres`
 * client (see `createSeedDbClient` below). It intentionally does NOT reuse
 * `lib/db/index.ts` (still Supabase-backed) or `lib/authjs/db.ts` (raw SQL
 * only, explicitly avoids importing Drizzle) — both are unrelated seams and
 * must not be touched by this script.
 *
 * SAFETY: this script refuses to run unless BOTH `NODE_ENV !== 'production'`
 * AND `DEV_SEED_CONFIRM` is set to the exact confirmation value below (see
 * `assertDevSeedAllowed`). Never set `DEV_SEED_CONFIRM` in a shared,
 * staging, or production environment — it exists only to make running this
 * against the wrong database a deliberate, explicit action.
 *
 * Idempotency:
 *  - `profiles` rows are upserted keyed on `authEmail` (the schema's natural
 *    unique identity column, backed by the `profiles_auth_email_key` unique
 *    index) via `onConflictDoUpdate`, so re-running this script updates the
 *    existing dev fixtures in place instead of duplicating them.
 *  - `rooms` / `tables` have no unique business key in the Drizzle schema.
 *    This script uses an explicit check-then-insert by `name` (and, for
 *    tables, `roomId` + `name`) instead of a DB-level upsert, so re-running
 *    it does not pile up duplicate fixture rows. This is a deliberate
 *    trade-off for a dev-only fixture script — do not copy this pattern for
 *    production data paths.
 *
 * Usage:
 *   DEV_SEED_CONFIRM=<see below> pnpm db:seed
 *
 * Requires `POSTGRES_URL` (or `POSTGRES_URL_NON_POOLING`) to be set, e.g. in
 * `.env.local`. Never logs, prints, or otherwise surfaces either value.
 */
import { config as loadEnv } from 'dotenv'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { profiles, rooms, tables, tableTypeEnum } from '../lib/db/schema'

type TableType = (typeof tableTypeEnum.enumValues)[number]

// Load `.env.local` (the repo's documented local-env convention, see
// .env.example) so `pnpm db:seed` works the same way `pnpm dev` does,
// without requiring callers to export vars manually.
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })

/**
 * Exact value `DEV_SEED_CONFIRM` must be set to for this script to proceed.
 * Deliberately not a bare "true"/"1" so it can't be flipped on by accident
 * (e.g. copy-pasting an unrelated boolean env block).
 */
const DEV_SEED_CONFIRM_VALUE = 'YES_SEED_NEON_DEV_DB'

/** Dev-only password shared by all seeded profiles. Not a real secret —
 * documented in README.md's "Local seed data" section, never stored in any
 * `.env*` file. Hashed with bcryptjs before being written to
 * `profiles.password_hash`. */
const DEV_SEED_PASSWORD = 'dev-only-Seed123!'

function assertDevSeedAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[seed] Refusing to run: NODE_ENV=production. This script seeds throwaway dev fixtures ' +
        'and must never run against a production database.'
    )
    process.exit(1)
  }

  if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
    console.error(
      '[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM.\n' +
        `  Set DEV_SEED_CONFIRM=${DEV_SEED_CONFIRM_VALUE} to confirm you intend to seed the ` +
        'database currently configured via POSTGRES_URL / POSTGRES_URL_NON_POOLING.\n' +
        '  Never set this variable in a shared, staging, or production environment.'
    )
    process.exit(1)
  }
}

/**
 * Builds a local, one-off Drizzle client for this seed script only. Reads
 * `POSTGRES_URL` / `POSTGRES_URL_NON_POOLING` by name only — never logs
 * either value. Intentionally not shared with any other module (see file
 * header).
 */
function createSeedDbClient() {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL

  if (!connectionString) {
    console.error(
      '[seed] Refusing to run: neither POSTGRES_URL nor POSTGRES_URL_NON_POOLING is set. ' +
        'Configure one in .env.local (see .env.example).'
    )
    process.exit(1)
  }

  const pool = new Pool({ connectionString })
  const db = drizzle(pool, { schema: { profiles, rooms, tables } })

  return { db, pool }
}

type SeedDb = ReturnType<typeof createSeedDbClient>['db']

interface SeedProfileInput {
  memberNumber: string
  email: string
  role: 'admin' | 'member'
  fullName: string
}

/**
 * Upserts a dev profile keyed on `authEmail`. `email` is set to the same
 * value as `authEmail` for consistency with real profile rows (which also
 * carry both columns set to the same value in practice) — not because it's
 * required for lookup. `lib/authjs/credentials-user.ts`'s
 * `verifyCredentials()` looks up rows by the uniquely-indexed `authEmail`
 * column (KIM-433), so these seeded rows are found via `authEmail`
 * regardless of what `email` is set to.
 */
async function upsertDevProfile(db: SeedDb, input: SeedProfileInput): Promise<void> {
  const passwordHash = await bcrypt.hash(DEV_SEED_PASSWORD, 10)

  await db
    .insert(profiles)
    .values({
      id: randomUUID(),
      memberNumber: input.memberNumber,
      email: input.email,
      authEmail: input.email,
      role: input.role,
      isActive: true,
      fullName: input.fullName,
      passwordHash,
    })
    .onConflictDoUpdate({
      target: profiles.authEmail,
      set: {
        memberNumber: input.memberNumber,
        email: input.email,
        role: input.role,
        isActive: true,
        fullName: input.fullName,
        passwordHash,
        updatedAt: new Date(),
      },
    })

  console.log(`[seed] upserted profile ${input.email} (role=${input.role})`)
}

/** Check-then-insert by `name` — see file header "Idempotency" note. */
async function findOrCreateRoom(
  db: SeedDb,
  input: { name: string; description: string; tableCount: number }
): Promise<string> {
  const existing = await db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.name, input.name))
    .limit(1)

  if (existing[0]) {
    console.log(`[seed] room "${input.name}" already exists, skipping insert`)
    return existing[0].id
  }

  const [inserted] = await db
    .insert(rooms)
    .values({
      name: input.name,
      description: input.description,
      tableCount: input.tableCount,
    })
    .returning({ id: rooms.id })

  console.log(`[seed] created room "${input.name}"`)
  return inserted.id
}

/** Check-then-insert by `roomId` + `name` — see file header "Idempotency" note. */
async function findOrCreateTable(
  db: SeedDb,
  input: { roomId: string; name: string; type: TableType }
): Promise<void> {
  const existing = await db
    .select({ id: tables.id })
    .from(tables)
    .where(and(eq(tables.roomId, input.roomId), eq(tables.name, input.name)))
    .limit(1)

  if (existing[0]) {
    console.log(`[seed] table "${input.name}" already exists, skipping insert`)
    return
  }

  await db.insert(tables).values({
    roomId: input.roomId,
    name: input.name,
    type: input.type,
  })

  console.log(`[seed] created table "${input.name}" (type=${input.type})`)
}

async function main(): Promise<void> {
  assertDevSeedAllowed()

  const { db, pool } = createSeedDbClient()

  try {
    await upsertDevProfile(db, {
      memberNumber: 'DEV-ADMIN-001',
      email: 'admin@devseed.local',
      role: 'admin',
      fullName: 'Dev Seed Admin',
    })

    await upsertDevProfile(db, {
      memberNumber: 'DEV-MEM-001',
      email: 'member1@devseed.local',
      role: 'member',
      fullName: 'Dev Seed Member One',
    })

    await upsertDevProfile(db, {
      memberNumber: 'DEV-MEM-002',
      email: 'member2@devseed.local',
      role: 'member',
      fullName: 'Dev Seed Member Two',
    })

    await upsertDevProfile(db, {
      memberNumber: 'DEV-MEM-003',
      email: 'member3@devseed.local',
      role: 'member',
      fullName: 'Dev Seed Member Three',
    })

    const room1Id = await findOrCreateRoom(db, {
      name: 'Dev Seed Room 1',
      description: 'Seeded fixture room for local/dev manual QA.',
      tableCount: 3,
    })

    const room2Id = await findOrCreateRoom(db, {
      name: 'Dev Seed Room 2',
      description: 'Seeded fixture room for local/dev manual QA.',
      tableCount: 2,
    })

    await findOrCreateTable(db, { roomId: room1Id, name: 'Dev Table 1', type: 'small' })
    await findOrCreateTable(db, { roomId: room1Id, name: 'Dev Table 2', type: 'large' })
    await findOrCreateTable(db, { roomId: room1Id, name: 'Dev Table 3', type: 'removable_top' })
    await findOrCreateTable(db, { roomId: room2Id, name: 'Dev Table 4', type: 'small' })
    await findOrCreateTable(db, { roomId: room2Id, name: 'Dev Table 5', type: 'removable_top' })

    console.log('[seed] done — dev fixtures seeded successfully.')
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('[seed] failed:', error instanceof Error ? error.message : error)
  process.exit(1)
})
