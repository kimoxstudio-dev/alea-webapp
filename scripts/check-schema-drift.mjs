#!/usr/bin/env node
/**
 * scripts/check-schema-drift.mjs — cheap post-rebuild schema sanity check
 * (KIM-434, F3c Drizzle/Neon seam).
 *
 * Context: the user is rebuilding their Neon DB from scratch via
 * `lib/db/migrations/0000_fine_magma.sql` + `0001_exclusion_constraints.sql`,
 * then running `pnpm db:seed` (KIM-432). After that rebuild, the live DB is
 * expected to match `lib/db/schema/*.ts` exactly by construction — this
 * script is NOT an exhaustive audit, just a quick "did the rebuild actually
 * produce what the Drizzle schema declares" smoke test the user can run
 * themselves.
 *
 * This is plain Node ESM (not TypeScript) so it needs no extra dev
 * dependency (no `tsx`/`ts-node`) — same convention as
 * `scripts/cutover-rehearsal-runner.mjs`. It intentionally does NOT import
 * `lib/db/schema/*.ts` directly (that would require a TS loader); instead
 * the expected shape is a small manifest below, hand-derived from those
 * files. Keep the manifest in sync when schema files change.
 *
 * Connects to Postgres using `POSTGRES_URL` (same env var read by
 * `lib/db/index.ts` / `lib/authjs/db.ts`). Never logs the connection
 * string. Read-only: only ever issues SELECTs against
 * `information_schema.columns`. Never mutates data or schema.
 *
 * This script does NOT run automatically as part of any agent workflow or
 * CI — it is prepare-only tooling for the user to run manually, after the
 * DB rebuild, from a shell that has `POSTGRES_URL` configured.
 *
 * Usage:
 *   pnpm exec node scripts/check-schema-drift.mjs
 *
 * Exit code 0 = live DB matches the manifest. Non-zero = at least one
 * mismatch found; see the printed report for details.
 */
import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

/**
 * Expected shape, hand-derived from lib/db/schema/*.ts. `type` values are
 * the `information_schema.columns.data_type` strings Postgres reports for
 * each Drizzle pg-core column builder used in that file (uuid -> 'uuid',
 * text -> 'text', varchar -> 'character varying', integer -> 'integer',
 * boolean -> 'boolean', timestamp/{timezone:true} -> 'timestamp with time
 * zone', date -> 'date', time -> 'time without time zone', numeric ->
 * 'numeric', pgEnum -> 'USER-DEFINED').
 *
 * @type {Record<string, Record<string, string>>}
 */
const EXPECTED_SCHEMA = {
  profiles: {
    id: 'uuid',
    member_number: 'character varying',
    email: 'text',
    role: 'USER-DEFINED',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    is_active: 'boolean',
    no_show_count: 'integer',
    blocked_until: 'timestamp with time zone',
    auth_email: 'text',
    full_name: 'text',
    active_from: 'timestamp with time zone',
    psw_changed: 'timestamp with time zone',
    phone: 'text',
    password_hash: 'text',
  },
  rooms: {
    id: 'uuid',
    name: 'text',
    table_count: 'integer',
    description: 'text',
    created_at: 'timestamp with time zone',
  },
  tables: {
    id: 'uuid',
    room_id: 'uuid',
    name: 'text',
    type: 'USER-DEFINED',
    qr_code: 'text',
    pos_x: 'integer',
    pos_y: 'integer',
    created_at: 'timestamp with time zone',
    qr_code_inf: 'text',
  },
  reservations: {
    id: 'uuid',
    table_id: 'uuid',
    user_id: 'uuid',
    date: 'date',
    start_time: 'time without time zone',
    end_time: 'time without time zone',
    surface: 'USER-DEFINED',
    status: 'USER-DEFINED',
    created_at: 'timestamp with time zone',
    activated_at: 'timestamp with time zone',
  },
  equipment: {
    id: 'uuid',
    name: 'text',
    description: 'text',
    created_at: 'timestamp with time zone',
  },
  room_default_equipment: {
    room_id: 'uuid',
    equipment_id: 'uuid',
  },
  reservation_equipment: {
    reservation_id: 'uuid',
    equipment_id: 'uuid',
  },
  events: {
    id: 'uuid',
    title: 'text',
    description: 'text',
    date: 'date',
    start_time: 'time without time zone',
    end_time: 'time without time zone',
    created_by: 'uuid',
    created_at: 'timestamp with time zone',
    title_es: 'text',
    title_en: 'text',
    blurb_es: 'text',
    blurb_en: 'text',
    description_es: 'text',
    description_en: 'text',
    date_kind: 'text',
    end_date: 'date',
    recurrence_label_es: 'text',
    recurrence_label_en: 'text',
    image_url: 'text',
    link_url: 'text',
    category_es: 'text',
    category_en: 'text',
  },
  event_room_blocks: {
    id: 'uuid',
    event_id: 'uuid',
    room_id: 'uuid',
    date: 'date',
    start_time: 'time without time zone',
    end_time: 'time without time zone',
    all_day: 'boolean',
    table_id: 'uuid',
  },
  event_equipment: {
    event_id: 'uuid',
    equipment_id: 'uuid',
    quantity: 'integer',
  },
  saved_games: {
    id: 'uuid',
    table_id: 'uuid',
    user_id: 'uuid',
    start_date: 'date',
    end_date: 'date',
    status: 'text',
    attendance_count: 'integer',
    renewed_from_id: 'uuid',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  saved_game_attendances: {
    id: 'uuid',
    saved_game_id: 'uuid',
    play_reservation_id: 'uuid',
    attended_on: 'date',
    scanned_at: 'timestamp with time zone',
  },
  activation_tokens: {
    id: 'uuid',
    profile_id: 'uuid',
    token_hash: 'text',
    expires_at: 'timestamp with time zone',
    used_at: 'timestamp with time zone',
    created_by: 'uuid',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  partners: {
    id: 'uuid',
    name: 'text',
    img_url: 'text',
    link_url: 'text',
    desc_es: 'text',
    desc_en: 'text',
    sort_order: 'integer',
    active: 'boolean',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
  },
  library_games: {
    id: 'uuid',
    title: 'text',
    category_es: 'text',
    category_en: 'text',
    players: 'text',
    play_time: 'text',
    weight: 'numeric',
    sort_order: 'integer',
    active: 'boolean',
    created_at: 'timestamp with time zone',
    updated_at: 'timestamp with time zone',
    img_url: 'text',
  },
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} table
 * @returns {Promise<Record<string, string>>}
 */
async function fetchLiveColumns(pool, table) {
  const { rows } = await pool.query(
    `select column_name, data_type
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  )

  /** @type {Record<string, string>} */
  const columns = {}
  for (const row of rows) {
    columns[row.column_name] = row.data_type
  }
  return columns
}

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error(
      '✗ POSTGRES_URL is not configured. Set it in .env.local (see .env.example) before running this check.',
    )
    process.exitCode = 1
    return
  }

  const pool = new Pool({ connectionString: process.env.POSTGRES_URL })

  let hadMismatch = false

  try {
    console.log('━━━ Schema drift check — live DB vs lib/db/schema/*.ts ━━━\n')

    for (const [table, expectedColumns] of Object.entries(EXPECTED_SCHEMA)) {
      const liveColumns = await fetchLiveColumns(pool, table)

      if (Object.keys(liveColumns).length === 0) {
        console.log(`✗ ${table}: table not found in public schema`)
        hadMismatch = true
        continue
      }

      const missing = Object.keys(expectedColumns).filter((col) => !(col in liveColumns))
      const extra = Object.keys(liveColumns).filter((col) => !(col in expectedColumns))
      const typeMismatches = Object.keys(expectedColumns)
        .filter((col) => col in liveColumns && liveColumns[col] !== expectedColumns[col])
        .map((col) => `${col} (expected ${expectedColumns[col]}, got ${liveColumns[col]})`)

      if (missing.length === 0 && extra.length === 0 && typeMismatches.length === 0) {
        console.log(`✓ ${table}: ${Object.keys(expectedColumns).length} columns match`)
        continue
      }

      hadMismatch = true
      console.log(`✗ ${table}: mismatch`)
      if (missing.length > 0) console.log(`    missing columns: ${missing.join(', ')}`)
      if (extra.length > 0) console.log(`    extra columns (not in schema.ts): ${extra.join(', ')}`)
      if (typeMismatches.length > 0) console.log(`    type mismatches: ${typeMismatches.join(', ')}`)
    }

    console.log('')
    if (hadMismatch) {
      console.log('✗ Schema drift detected — see mismatches above.')
      process.exitCode = 1
    } else {
      console.log('✓ No drift detected — live DB matches lib/db/schema/*.ts for all checked tables.')
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error('✗ Schema drift check failed to run:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
