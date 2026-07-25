import qrcode from 'qrcode'
import type { GameTable } from '@/lib/types'
import { uploadToStorage, getPublicStorageUrl } from '@/lib/storage/qr'
import { getAdminDb, getDb } from '@/lib/db'
import { serviceError } from '@/lib/server/shared/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/reservations/availability'
import type { Tables } from '@/lib/supabase/types'
import { toGameTable } from '@/lib/server/tables/table-mappers'
import { getDatabaseNow } from '@/lib/server/shared/database-time'
import { isPendingReservationExpired } from '@/lib/server/reservations/pending-reservation-expiry'
import type { SessionUser } from '@/lib/server/auth/auth'

type TableRow = Tables<'tables'>
type ReservationRow = Tables<'reservations'>
type EventBlockRow = Tables<'event_room_blocks'>

const TABLE_COLUMNS = 'id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y'

// Privilege checks (role === 'admin') live here in the service layer, not in
// route handlers (repo convention). QR generation mutates the tables row and
// writes to the "table-qr-codes" storage bucket via the admin client
// (bypasses RLS/storage policies entirely), so this in-function check is the
// only authorization guard once RLS is removed as part of the Vercel/Postgres
// migration — mirrors tables_admin_update and qr_codes_service_* storage
// policies (service_role only).
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

async function uploadQrCodeToStorage(url: string, storagePath: string): Promise<string> {
  const buffer = await qrcode.toBuffer(url, { errorCorrectionLevel: 'M', width: 400, type: 'png' })

  const { error: uploadError } = await uploadToStorage('table-qr-codes', storagePath, buffer, {
    contentType: 'image/png',
    upsert: true,
  })

  if (uploadError) {
    serviceError('Failed to upload QR code to storage', 500)
  }

  // Resolve the public URL via the storage seam (lib/storage/qr) rather than
  // manually constructing a backend-specific path — this call site used to
  // hardcode a Supabase Storage URL, which would have silently pointed at a
  // nonexistent object once uploadToStorage() above started routing to
  // Vercel Blob instead (KIM-431 F3 cutover; documented follow-up from
  // KIM-421/lib/storage/qr/vercel-blob.ts's original doc comment).
  const { publicUrl } = getPublicStorageUrl('table-qr-codes', storagePath)
  if (!publicUrl) {
    serviceError('Failed to resolve QR code public URL', 500)
  }

  return publicUrl
}

export async function generateTableQrCode(session: SessionUser, tableId: string): Promise<string> {
  requireAdminSession(session)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!appUrl) serviceError('NEXT_PUBLIC_APP_URL is not set — cannot generate QR code URL', 500)
  const url = `${appUrl}/check-in/${tableId}`
  return uploadQrCodeToStorage(url, `${tableId}.png`)
}

export async function regenerateQrCodes(
  session: SessionUser,
  tableId: string,
): Promise<{ qr_code: string; qr_code_inf: string | null }> {
  requireAdminSession(session)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  const admin = getAdminDb()

  const { data: table, error: fetchError } = await admin
    .from('tables')
    .select('id, type')
    .eq('id', tableId)
    .maybeSingle()

  if (fetchError) {
    serviceError('Internal server error', 500)
  }
  if (!table) {
    serviceError('Table not found', 404)
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!appUrl) serviceError('NEXT_PUBLIC_APP_URL is not set — cannot generate QR code URL', 500)

  const qr_code = await uploadQrCodeToStorage(`${appUrl}/check-in/${tableId}`, `${tableId}.png`)

  const { error: updateError } = await admin
    .from('tables')
    .update({ qr_code, qr_code_inf: null })
    .eq('id', tableId)

  if (updateError) {
    serviceError('Internal server error', 500)
  }

  return { qr_code, qr_code_inf: null }
}

export async function getTableAvailability(tableId: string, date?: string | null) {
  const supabase = await getDb()
  const tableResult = await supabase
    .from('tables')
    .select(TABLE_COLUMNS)
    .eq('id', tableId)
    .maybeSingle()
  const table = tableResult.data as TableRow | null
  const tableError = tableResult.error

  if (tableError) {
    serviceError('Internal server error', 500)
  }
  if (!table) {
    serviceError('Table not found', 404)
  }

  const effectiveDate = resolveDate(date)
  const admin = getAdminDb()

  const [reservationsResult, eventBlocksResult, savedGameResult, nowUtc] = await Promise.all([
    admin
      .from('reservations')
      .select('id, table_id, date, start_time, end_time, status, surface, user_id, activated_at, created_at')
      .eq('table_id', tableId)
      .eq('date', effectiveDate)
      .in('status', ['active', 'pending']),
    admin
      .from('event_room_blocks')
      .select('id, event_id, room_id, table_id, date, start_time, end_time, all_day')
      .eq('room_id', table.room_id)
      .eq('date', effectiveDate),
    admin
      .from('saved_games')
      .select('id')
      .eq('table_id', tableId)
      .eq('status', 'active')
      .lte('start_date', effectiveDate)
      .gte('end_date', effectiveDate)
      .limit(1),
    getDatabaseNow(admin),
  ])

  const allReservations = (reservationsResult.data ?? []) as ReservationRow[]
  const reservationsError = reservationsResult.error

  if (reservationsError) {
    serviceError('Internal server error', 500)
  }

  // Pending rows stop blocking availability only after their check-in deadline.
  const reservations = allReservations.filter((row) => {
    if (row.status === 'pending' && row.activated_at === null) {
      return !isPendingReservationExpired(row, nowUtc)
    }
    return true
  })

  if (eventBlocksResult.error) {
    serviceError('Internal server error', 500)
  }
  if (savedGameResult.error) serviceError('Internal server error', 500)

  // OIR-208: a block with a table_id only blocks that single table; NULL
  // (the pre-OIR-208 default) blocks every table of the room, unchanged.
  const eventBlocks = ((eventBlocksResult.data ?? []) as EventBlockRow[])
    .filter((block) => block.table_id == null || block.table_id === tableId)

  let eventTitleById = new Map<string, string>()
  const eventIds = [...new Set(eventBlocks.map((block) => block.event_id))]
  if (eventIds.length > 0) {
    const eventsResult = await admin
      .from('events')
      .select('id, title')
      .in('id', eventIds)

    if (eventsResult.error) {
      serviceError('Internal server error', 500)
    }

    eventTitleById = new Map(
      ((eventsResult.data ?? []) as Array<{ id: string; title: string }>).map((event) => [event.id, event.title]),
    )
  }

  return buildAvailability(
    toGameTable(table),
    effectiveDate,
    reservations,
    eventBlocks.map((block) => ({
      start: block.start_time.slice(0, 5),
      end: block.end_time.slice(0, 5),
      label: eventTitleById.get(block.event_id) ?? null,
    })),
    Boolean(savedGameResult.data?.length),
  )
}
