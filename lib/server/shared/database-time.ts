import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { getDrizzleAdminDb } from '@/lib/db'
import { serviceError } from '@/lib/server/shared/service-error'

type DrizzleExecutableClient = {
  execute: (query: SQL) => PromiseLike<{ rows: unknown[] }>
}

function parseDatabaseNow(rawValue: unknown) {
  if (rawValue === undefined || rawValue === null) {
    serviceError('Internal server error', 500)
  }

  // node-postgres (used by the Drizzle/Neon seam) auto-parses `timestamptz`
  // columns into a JS `Date` before this helper ever sees the value. Legacy
  // Supabase RPC responses, on the other hand, arrive as an ISO string.
  // `Date.prototype.toString()` (invoked implicitly by `String(rawValue)`)
  // truncates to whole seconds, so coercing an already-parsed `Date` through
  // `String()` silently drops milliseconds. Use the `Date` directly instead.
  const value = rawValue instanceof Date ? rawValue : new Date(String(rawValue))
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

/**
 * Returns the current database server time (used instead of app-server time
 * to avoid clock-skew issues, e.g. when deciding if a pending reservation
 * has expired).
 * Defaults to the Drizzle/Neon admin client. A transaction/client may be
 * passed explicitly so the timestamp comes from the same database operation.
 */
export async function getDatabaseNow(client?: DrizzleExecutableClient) {
  return getDatabaseNowFromDrizzle(client ?? getDrizzleAdminDb())
}
