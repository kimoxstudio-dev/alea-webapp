import qrcode from 'qrcode'
import type { GameTable } from '@/lib/types'
import { createSupabaseServerAdminClient, createSupabaseServerClient } from '@/lib/supabase/server'
import { serviceError } from '@/lib/server/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/availability'
import type { Tables } from '@/lib/supabase/types'
import { toGameTable } from '@/lib/server/table-mappers'
import { getDatabaseNow } from '@/lib/server/database-time'
import { isPendingReservationExpired } from '@/lib/server/pending-reservation-expiry'

type TableRow = Tables<'tables'>
type ReservationRow = Tables<'reservations'>
type EventBlockRow = Tables<'event_room_blocks'>

const TABLE_COLUMNS = 'id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y'

async function uploadQrCodeToStorage(
  admin: ReturnType<typeof createSupabaseServerAdminClient>,
  url: string,
  storagePath: string,
): Promise<string> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl) serviceError('NEXT_PUBLIC_SUPABASE_URL is not set — cannot build QR code storage URL', 500)

  const buffer = await qrcode.toBuffer(url, { errorCorrectionLevel: 'M', width: 400, type: 'png' })

  const { error: uploadError } = await admin.storage
    .from('table-qr-codes')
    .upload(storagePath, buffer, { contentType: 'image/png', upsert: true })

  if (uploadError) {
    serviceError('Failed to upload QR code to storage', 500)
  }

  return `${supabaseUrl}/storage/v1/object/public/table-qr-codes/${storagePath}`
}

export async function generateTableQrCode(tableId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!appUrl) serviceError('NEXT_PUBLIC_APP_URL is not set — cannot generate QR code URL', 500)
  const url = `${appUrl}/check-in/${tableId}`
  const admin = createSupabaseServerAdminClient()
  return uploadQrCodeToStorage(admin, url, `${tableId}.png`)
}

export async function regenerateQrCodes(tableId: string): Promise<{ qr_code: string; qr_code_inf: string | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  const admin = createSupabaseServerAdminClient()

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

  const qr_code = await uploadQrCodeToStorage(admin, `${appUrl}/check-in/${tableId}`, `${tableId}.png`)

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
  const supabase = await createSupabaseServerClient()
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
  const admin = createSupabaseServerAdminClient()

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
    getDatabaseNow(),
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
