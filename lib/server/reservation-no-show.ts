import 'server-only'
import { getPendingCheckInDeadline } from '@/lib/server/pending-reservation-expiry'
import { getDatabaseNow } from '@/lib/server/database-time'
import { createSupabaseServerAdminClient } from '@/lib/supabase/server'

type NoShowCandidateSlot = {
  date: string
  start_time: string
  end_time: string
}

/**
 * True when a pending, never-activated reservation's check-in window has
 * closed (more than CHECK_IN_LATE_MINUTES have passed since the slot's start,
 * capped at the slot's end) and it should be treated as a no-show.
 *
 * Reuses the same deadline math as pending-reservation-expiry.ts — a pending
 * reservation past its check-in deadline is, by definition, a no-show.
 */
export function isNoShowExpired(reservation: NoShowCandidateSlot, now: Date): boolean {
  return now.getTime() > getPendingCheckInDeadline(reservation).getTime()
}

type NoShowReservationRow = NoShowCandidateSlot & { id: string }

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
  const admin = createSupabaseServerAdminClient()
  const nowUtc = await getDatabaseNow(admin)

  const { data, error } = await admin
    .from('reservations')
    .select('id, date, start_time, end_time')
    .eq('status', 'pending')
    .is('activated_at', null)

  if (error) {
    console.error('markExpiredReservationsAsNoShow failed (non-fatal):', error)
    return 0
  }

  const expiredIds = ((data ?? []) as NoShowReservationRow[])
    .filter((row) => isNoShowExpired(row, nowUtc))
    .map((row) => row.id)

  let markedCount = 0
  for (const id of expiredIds) {
    const { error: updateError } = await admin
      .from('reservations')
      .update({ status: 'no_show' })
      .eq('id', id)
      .eq('status', 'pending')
      .is('activated_at', null)

    if (updateError) {
      console.error('markExpiredReservationsAsNoShow failed (non-fatal):', updateError)
      continue
    }
    markedCount += 1
  }

  return markedCount
}
