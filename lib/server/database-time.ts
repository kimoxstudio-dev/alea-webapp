import 'server-only'
import { sql } from '@/lib/db/client'
import { serviceError } from '@/lib/server/service-error'

export async function getDatabaseNow(query: typeof sql = sql): Promise<Date> {
  let rows: { now: string | Date }[]
  try {
    rows = await query`SELECT now() AS now` as { now: string | Date }[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const value = new Date(rows[0]?.now ?? '')
  if (isNaN(value.getTime())) {
    serviceError('Internal server error', 500)
  }

  return value
}
