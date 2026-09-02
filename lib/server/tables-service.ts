import qrcode from 'qrcode'
import { put } from '@vercel/blob'
import type { GameTable } from '@/lib/types'
import { sql } from '@/lib/db/client'
import { serviceError } from '@/lib/server/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/availability'
import type { Tables } from '@/lib/supabase/types'
import { toGameTable } from '@/lib/server/table-mappers'
import { getDatabaseNow } from '@/lib/server/database-time'
import { isPendingReservationExpired } from '@/lib/server/pending-reservation-expiry'

type TableRow = Tables<'tables'>
type ReservationRow = Tables<'reservations'>
type EventBlockRow = Tables<'event_room_blocks'>

const QR_CODE_PREFIX = 'table-qr-codes'

async function uploadQrCodeToBlob(url: string, blobPath: string): Promise<string> {
  const buffer = await qrcode.toBuffer(url, { errorCorrectionLevel: 'M', width: 400, type: 'png' })

  try {
    // allowOverwrite: true — regenerateQrCodes re-uploads the same
    // `{tableId}.png` path on every regeneration (the old Supabase Storage
    // call used upsert: true for the same reason).
    // cacheControlMaxAge: 3600 — matches supabase-js's default TTL (1 hour),
    // which the old Supabase Storage call relied on implicitly. Without this,
    // @vercel/blob's put() defaults to 30 days, so a regenerated QR (same
    // URL, no cache-busting) would serve the stale PNG far longer than before.
    const blob = await put(`${QR_CODE_PREFIX}/${blobPath}`, buffer, {
      access: 'public',
      contentType: 'image/png',
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 3600,
    })
    return blob.url
  } catch (error) {
    console.error(
      '[tables-service] Vercel Blob QR upload failed:',
      error instanceof Error ? error.message : error
    )
    serviceError('Failed to upload QR code to storage', 500)
  }
}

export async function generateTableQrCode(tableId: string): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!appUrl) serviceError('NEXT_PUBLIC_APP_URL is not set — cannot generate QR code URL', 500)
  const url = `${appUrl}/check-in/${tableId}`
  return uploadQrCodeToBlob(url, `${tableId}.png`)
}

export async function regenerateQrCodes(tableId: string): Promise<{ qr_code: string; qr_code_inf: string | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tableId)) {
    serviceError('Invalid table ID', 400)
  }
  let tableRows: Array<Pick<TableRow, 'id' | 'type'>>
  try {
    tableRows = await sql`
      SELECT id, type
      FROM tables
      WHERE id = ${tableId}
      LIMIT 1
    ` as Array<Pick<TableRow, 'id' | 'type'>>
  } catch {
    serviceError('Internal server error', 500)
  }
  const table = tableRows[0]
  if (!table) {
    serviceError('Table not found', 404)
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (!appUrl) serviceError('NEXT_PUBLIC_APP_URL is not set — cannot generate QR code URL', 500)

  const qr_code = await uploadQrCodeToBlob(`${appUrl}/check-in/${tableId}`, `${tableId}.png`)

  try {
    await sql`
      UPDATE tables
      SET qr_code = ${qr_code}, qr_code_inf = NULL
      WHERE id = ${tableId}
    `
  } catch {
    serviceError('Internal server error', 500)
  }

  return { qr_code, qr_code_inf: null }
}

export async function getTableAvailability(tableId: string, date?: string | null) {
  let tableRows: TableRow[]
  try {
    tableRows = await sql`
      SELECT id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y
      FROM tables
      WHERE id = ${tableId}
      LIMIT 1
    ` as TableRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  const table = tableRows[0]
  if (!table) {
    serviceError('Table not found', 404)
  }

  const effectiveDate = resolveDate(date)
  let allReservations: ReservationRow[]
  let allEventBlocks: EventBlockRow[]
  let savedGameRows: Array<{ id: string }>
  let nowUtc: Date
  try {
    ;[allReservations, allEventBlocks, savedGameRows, nowUtc] = await Promise.all([
      sql`
        SELECT id, table_id, date, start_time, end_time, status, surface, user_id, activated_at, created_at
        FROM reservations
        WHERE table_id = ${tableId}
          AND date = ${effectiveDate}
          AND status IN ('active', 'pending')
      ` as unknown as Promise<ReservationRow[]>,
      sql`
        SELECT id, event_id, room_id, table_id, date, start_time, end_time, all_day
        FROM event_room_blocks
        WHERE room_id = ${table.room_id}
          AND date = ${effectiveDate}
      ` as unknown as Promise<EventBlockRow[]>,
      sql`
        SELECT id
        FROM saved_games
        WHERE table_id = ${tableId}
          AND status = 'active'
          AND start_date <= ${effectiveDate}
          AND end_date >= ${effectiveDate}
        LIMIT 1
      ` as unknown as Promise<Array<{ id: string }>>,
      getDatabaseNow(),
    ])
  } catch {
    serviceError('Internal server error', 500)
  }

  // Pending rows stop blocking availability only after their check-in deadline.
  const reservations = allReservations.filter((row) => {
    if (row.status === 'pending' && row.activated_at === null) {
      return !isPendingReservationExpired(row, nowUtc)
    }
    return true
  })

  // OIR-208: a block with a table_id only blocks that single table; NULL
  // (the pre-OIR-208 default) blocks every table of the room, unchanged.
  const eventBlocks = allEventBlocks
    .filter((block) => block.table_id == null || block.table_id === tableId)

  let eventTitleById = new Map<string, string>()
  const eventIds = [...new Set(eventBlocks.map((block) => block.event_id))]
  if (eventIds.length > 0) {
    let eventRows: Array<{ id: string; title: string }>
    try {
      eventRows = await sql`
        SELECT id, title
        FROM events
        WHERE id = ANY(${eventIds})
      ` as Array<{ id: string; title: string }>
    } catch {
      serviceError('Internal server error', 500)
    }

    eventTitleById = new Map(
      eventRows.map((event) => [event.id, event.title]),
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
    savedGameRows.length > 0,
  )
}
