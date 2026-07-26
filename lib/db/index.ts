import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Pool } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import {
  createSupabaseServerAdminClient,
  createSupabaseServerClient,
} from '@/lib/supabase/server'
import type { Database } from '@/lib/supabase/types'
import * as schema from '@/lib/db/schema'

/**
 * lib/db — single seam for Postgres access.
 *
 * KIM-434 (F3c, "swap the lib/db seam from Supabase to Drizzle/Neon") is a
 * 5-PR stack. This file (PR1) is the pilot: it introduces the real
 * Drizzle/Neon client (`getDrizzleDb()` / `getDrizzleAdminDb()`) and migrates
 * the first two consumers (`equipment-service.ts`,
 * `lib/server/shared/database-time.ts`) to it. The remaining 11 services
 * that still import `getDb()` / `getAdminDb()` from this file are migrated
 * one PR at a time across PR2-PR5.
 *
 * TRANSITIONAL STATE (temporary, removed once PR2-PR5 land):
 * `getDb()` / `getAdminDb()` are UNCHANGED — they still return live Supabase
 * clients. This is intentional, not an oversight: those 11 services call the
 * Supabase query-builder API directly on whatever these functions return
 * (`.from(...).select(...).eq(...)`, `.rpc(...)`, etc). Drizzle's query
 * builder is a structurally different, incompatible API (e.g. `.from()`
 * takes a table object, not a string; there is no chained `.eq()`), so no
 * amount of TypeScript-level type gymnastics (union types, overloads, etc.)
 * can make a single returned object satisfy both call styles — and this is
 * a runtime concern, not just a compile-time one. Swapping `getDb()` /
 * `getAdminDb()` to Drizzle here would silently break those 11 services at
 * runtime as well as at compile time, which would violate the stacked-PR
 * convention that every PR in this chain must independently pass
 * typecheck/lint/test/build. See the KIM-434 PR1 description for the full
 * rationale.
 *
 * `getDrizzleDb()` / `getDrizzleAdminDb()` are the NEW seam: real
 * Drizzle clients over the Neon/Postgres connection pool
 * (`POSTGRES_URL`, see `.env.example`). Neon has no RLS, so — unlike the
 * Supabase clients above — there is no server-enforced distinction between
 * these two today; both currently return the same pooled connection. The
 * admin/user naming is kept anyway so authorization intent stays legible at
 * call sites and so PR2-PR5 don't need to rename anything when they migrate.
 * All privilege checks (ownership + role) must live in the service layer —
 * see e.g. `requireAdminSession()` in `lib/server/equipment/equipment-service.ts`.
 *
 * Once every consumer is migrated (end of the KIM-434 stack), the Supabase
 * path and `getDb`/`getAdminDb` will be removed, and `getDrizzleDb` /
 * `getDrizzleAdminDb` will be renamed to `getDb` / `getAdminDb` as the
 * final, single seam.
 */

/** @deprecated Legacy Supabase seam — see file header. Not used by new/migrated consumers. */
type LegacySupabaseDbClient = SupabaseClient<Database>

/** Drizzle/Neon client shape, parameterized with the full schema barrel for relational query support. */
export type DbClient = NodePgDatabase<typeof schema>
export type AdminDbClient = NodePgDatabase<typeof schema>

/**
 * Type of the transaction-scoped client passed to a `db.transaction(async
 * (tx) => ...)` callback (KIM-438). Exported so a service can accept an
 * already-open transaction as a parameter — e.g. a tx-aware variant of a
 * helper that normally opens its own connection — letting a caller compose
 * several writes (across different tables/services) into ONE atomic
 * transaction instead of each opening its own. See
 * `lib/server/events/events-service.ts`'s
 * `cancelOverlappingReservationsForBlocksTx()` for the first consumer.
 */
export type DbTransaction = Parameters<DbClient['transaction']>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never

let pgPool: Pool | null = null
let drizzleClient: NodePgDatabase<typeof schema> | null = null

/** Lazily creates (and reuses) a single `pg` Pool for the process. Never logs the connection string. */
function getPostgresPool(): Pool {
  if (!pgPool) {
    const connectionString = process.env.POSTGRES_URL
    if (!connectionString) {
      throw new Error(
        'POSTGRES_URL is not configured. Set it in .env.local (see .env.example) to use the Drizzle/Neon seam.',
      )
    }
    pgPool = new Pool({ connectionString })
  }
  return pgPool
}

function getDrizzleClient(): NodePgDatabase<typeof schema> {
  if (!drizzleClient) {
    drizzleClient = drizzle(getPostgresPool(), { schema })
  }
  return drizzleClient
}

/**
 * Drizzle/Neon client for reads/writes. See file header — currently
 * identical to `getDrizzleAdminDb()` since Neon has no RLS; use whichever
 * name best documents intent at the call site.
 */
export function getDrizzleDb(): DbClient {
  return getDrizzleClient()
}

/**
 * Drizzle/Neon client for admin-authorized operations. See file header —
 * currently identical to `getDrizzleDb()` since Neon has no RLS. Callers
 * are responsible for performing the authorization check themselves
 * (service layer), same convention as the legacy admin client below.
 */
export function getDrizzleAdminDb(): AdminDbClient {
  return getDrizzleClient()
}

/**
 * @deprecated Legacy Supabase seam, kept only for the 11 services not yet
 * migrated to Drizzle (see file header). New/migrated code should use
 * `getDrizzleDb()` instead.
 *
 * User-scoped, RLS-respecting client for Server Components / Route Handlers.
 */
export async function getDb(): Promise<LegacySupabaseDbClient> {
  return createSupabaseServerClient()
}

/**
 * @deprecated Legacy Supabase seam, kept only for the 11 services not yet
 * migrated to Drizzle (see file header). New/migrated code should use
 * `getDrizzleAdminDb()` instead.
 *
 * Admin client. Bypasses RLS — never expose to the browser.
 */
export function getAdminDb(): LegacySupabaseDbClient {
  return createSupabaseServerAdminClient()
}
