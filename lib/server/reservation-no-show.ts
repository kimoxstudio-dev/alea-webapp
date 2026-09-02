import 'server-only'
import { zonedDateTimeToUtc } from '@/lib/club-time'
import { getDatabaseNow } from '@/lib/server/database-time'
import { sql } from '@/lib/db/client'

/**
 * No-show threshold per #318's acceptance criteria: a pending, never-activated
 * reservation becomes a no-show once more than 59 minutes have passed since
 * its start time. This is intentionally distinct from
 * pending-reservation-expiry.ts's CHECK_IN_LATE_MINUTES (60), which governs a
 * different feature (#202/#203).
 */
export const NO_SHOW_LATE_MINUTES = 59

type NoShowCandidateSlot = {
  date: string
  start_time: string
  end_time: string
}

/**
 * Deadline after which a pending, never-activated reservation is treated as a
 * no-show: start time + NO_SHOW_LATE_MINUTES, capped at the slot's end (a
 * reservation whose slot has already ended without activation is
 * unambiguously a no-show regardless of the 59-minute window).
 */
function getNoShowDeadline(reservation: NoShowCandidateSlot): Date {
  const start = zonedDateTimeToUtc(reservation.date, reservation.start_time)
  const end = zonedDateTimeToUtc(reservation.date, reservation.end_time)
  const lateDeadline = new Date(start.getTime() + NO_SHOW_LATE_MINUTES * 60 * 1000)

  return lateDeadline < end ? lateDeadline : end
}

/**
 * True when a pending, never-activated reservation is past the no-show
 * deadline (more than NO_SHOW_LATE_MINUTES have passed since the slot's
 * start, capped at the slot's end) and should be treated as a no-show.
 */
export function isNoShowExpired(reservation: NoShowCandidateSlot, now: Date): boolean {
  return now.getTime() > getNoShowDeadline(reservation).getTime()
}

type NoShowReservationRow = { id: string; date: string | Date; start_time: string; end_time: string }

/**
 * Normalizes a `date` column value to `YYYY-MM-DD`. The SELECT below casts
 * with `date::text` so the Neon driver should already hand back a string,
 * but this is a second line of defense: node-postgres parses the raw `date`
 * OID (1082) as a UTC-midnight `Date` when uncast, and `isNoShowExpired` ->
 * `zonedDateTimeToUtc` throws on that shape (see the try/catch below).
 */
function normalizeDateOnly(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value
}

/**
 * Lazily marks stale pending reservations as 'no_show' at query time.
 *
 * Mirrors the pending-reservation-expiry lazy-evaluation pattern (#202/#203):
 * no cron, no polling — this runs inline from the reservations/rooms page
 * load path and the QR check-in flow. Replaces the Vercel cron previously at
 * app/api/cron/mark-no-show/route.ts, which the Hobby plan only allowed to
 * run once a day (#318).
 *
 * Failures are logged and swallowed (non-fatal) so a transient DB error never
 * blocks page rendering or check-in — the next trigger point will retry.
 */
export async function markExpiredReservationsAsNoShow(): Promise<number> {
  const nowUtc = await getDatabaseNow()

  // The `date::text` cast is load-bearing: without it the Neon driver parses
  // the `date` column (OID 1082) into a JS `Date` object, not a string, and
  // isNoShowExpired -> zonedDateTimeToUtc -> isValidDateOnlyString throws on
  // that shape. The filter below stays inside this same try/catch as a
  // second line of defense — a throw there must stay as non-fatal as a
  // failed SELECT, not escape and break every caller's page-load path.
  let expiredIds: string[]
  try {
    const rows = await sql`
      SELECT id, date::text AS date, start_time, end_time
      FROM reservations
      WHERE status = 'pending'
        AND activated_at IS NULL
    ` as NoShowReservationRow[]

    expiredIds = rows
      .filter((row) => isNoShowExpired({ ...row, date: normalizeDateOnly(row.date) }, nowUtc))
      .map((row) => row.id)
  } catch (error) {
    console.error('markExpiredReservationsAsNoShow failed (non-fatal):', error)
    return 0
  }

  if (expiredIds.length === 0) {
    return 0
  }

  let updatedRows: Array<{ id: string }>
  try {
    updatedRows = await sql`
      UPDATE reservations
      SET status = 'no_show'
      WHERE id = ANY(${expiredIds}::uuid[])
        AND status = 'pending'
        AND activated_at IS NULL
      RETURNING id
    ` as Array<{ id: string }>
  } catch (error) {
    console.error('markExpiredReservationsAsNoShow failed (non-fatal):', error)
    return 0
  }

  return updatedRows.length
}
