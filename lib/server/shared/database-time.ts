import 'server-only'
import { sql } from 'drizzle-orm'
import { getAdminDb } from '@/lib/db'
import { serviceError } from '@/lib/server/shared/service-error'

type SupabaseRpcClient = {
  rpc: (fn: string, args?: unknown) => Promise<{ data?: unknown; error?: unknown } | undefined>
}

type DrizzleExecutableClient = {
  execute: (query: unknown) => Promise<{ rows: unknown[] }>
}

/**
 * Duck-types the resolved client: Drizzle clients expose `.execute()` and no
 * `.rpc()`; legacy Supabase clients expose `.rpc()`. Kept intentionally
 * loose (not imported types) so this helper keeps working for both the
 * legacy Supabase clients still passed in by the 11 not-yet-migrated
 * services (KIM-434 PR2-PR5) and the new Drizzle clients.
 */
function isDrizzleClient(candidate: unknown): candidate is DrizzleExecutableClient {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof (candidate as { execute?: unknown }).execute === 'function' &&
    typeof (candidate as { rpc?: unknown }).rpc !== 'function'
  )
}

function parseDatabaseNow(rawValue: unknown) {
  if (rawValue === undefined || rawValue === null) {
    serviceError('Internal server error', 500)
  }

  const value = new Date(String(rawValue))
  if (isNaN(value.getTime())) {
    serviceError('Internal server error', 500)
  }

  return value
}

async function getDatabaseNowFromDrizzle(db: DrizzleExecutableClient) {
  const result = await db.execute(sql`select now() as now`)
  const row = result.rows[0] as { now?: unknown } | undefined
  return parseDatabaseNow(row?.now)
}

async function getDatabaseNowFromSupabase(client: unknown) {
  const admin = client as Partial<SupabaseRpcClient>

  if (typeof admin.rpc !== 'function') {
    serviceError('Internal server error', 500)
  }

  const response = await admin.rpc('get_database_time')
  if (!response || typeof response !== 'object') {
    serviceError('Internal server error', 500)
  }

  const { data, error } = response

  if (error || !data) {
    serviceError('Internal server error', 500)
  }

  return parseDatabaseNow(data)
}

/**
 * Returns the current database server time (used instead of app-server time
 * to avoid clock-skew issues, e.g. when deciding if a pending reservation
 * has expired).
 *
 * KIM-434 (F3c) note: this helper now understands BOTH the legacy Supabase
 * seam and the new Drizzle/Neon seam (see `lib/db/index.ts`). The DEFAULT
 * (no `client` argument) still resolves via the legacy `getAdminDb()` —
 * unchanged from before this PR. That default is intentionally NOT switched
 * to Drizzle here: `checkUserSlotOverlap()` in
 * `lib/server/reservations/reservations-service.ts` (one of the 11 services
 * not yet migrated, out of scope for this PR) calls `getDatabaseNow()` with
 * no arguments, so redirecting the default path to Neon would silently
 * change that untouched file's runtime behavior (and would throw if
 * `POSTGRES_URL` isn't configured in an environment that still only has
 * Supabase set up). Once every caller is migrated (KIM-434 PR2-PR5), this
 * default can safely switch to `getDrizzleAdminDb()` and the Supabase branch
 * can be deleted.
 *
 * Migrated/new callers (e.g. once a future service moves to Drizzle) should
 * pass a Drizzle client explicitly: `getDatabaseNow(getDrizzleAdminDb())`.
 */
export async function getDatabaseNow(client?: unknown) {
  const resolved = client ?? getAdminDb()

  if (isDrizzleClient(resolved)) {
    return getDatabaseNowFromDrizzle(resolved)
  }

  return getDatabaseNowFromSupabase(resolved)
}
