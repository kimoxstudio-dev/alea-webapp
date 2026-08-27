import type { GameTable, Room, TableAvailability } from '@/lib/types'
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import type { Tables } from '@/lib/supabase/types'
import { serviceError } from '@/lib/server/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/availability'
import { regenerateQrCodes } from '@/lib/server/tables-service'
import { toGameTable } from '@/lib/server/table-mappers'
import { getDatabaseNow } from '@/lib/server/database-time'
import { isPendingReservationExpired } from '@/lib/server/pending-reservation-expiry'

/**
 * Raw-SQL Neon port of the rooms/tables service (#302).
 *
 * Ported off Supabase (`createSupabaseServerAdminClient`/
 * `createSupabaseServerClient`) to the tagged-template `sql` export from
 * `lib/db/client.ts`, matching the established style from `auth-service.ts`
 * (#299) and `database-time.ts` (#308). Neon has no RLS, so the old
 * admin-vs-user-scoped client distinction collapses to a single `sql`.
 *
 * Out of scope (left untouched, still Supabase-based): default-equipment
 * resolution (`lib/server/equipment-service.ts`) and `regenerateQrCodes`
 * (`lib/server/tables-service.ts`).
 */

type RoomRow = {
  id: string
  name: string
  table_count: number
  description: string | null
}

type TableRow = {
  id: string
  room_id: string
  name: string
  type: 'small' | 'large' | 'removable_top'
  qr_code: string | null
  qr_code_inf: string | null
  pos_x: number | null
  pos_y: number | null
}

type ReservationRow = {
  id: string
  table_id: string
  date: string
  start_time: string
  end_time: string
  status: string
  surface: 'top' | 'bottom' | null
  user_id: string | null
  activated_at: string | null
  created_at: string
}

type EventBlockRow = {
  id: string
  event_id: string
  room_id: string
  table_id: string | null
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    tableCount: row.table_count,
    description: row.description ?? undefined,
  }
}

async function listTablesByRoom(roomId: string) {
  const rows = await sql`
    SELECT id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y
    FROM tables
    WHERE room_id = ${roomId}
    ORDER BY name ASC
  ` as TableRow[]

  return rows.map((row) => toGameTable(row as unknown as Tables<'tables'>))
}

export async function listAllRooms() {
  let rows: RoomRow[]
  try {
    rows = await sql`
      SELECT id, name, table_count, description
      FROM rooms
      ORDER BY created_at ASC
    ` as RoomRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return rows.map(toRoom)
}

export async function createRoomEntry(body: { name?: unknown; tableCount?: unknown; description?: unknown }) {
  const name = String(body.name ?? '').trim()
  if (!name) {
    serviceError('Room name is required', 400)
  }

  const rawCount = body.tableCount ?? 0
  const tableCount = Number(rawCount)
  if (!Number.isFinite(tableCount) || tableCount < 0 || !Number.isInteger(tableCount)) {
    serviceError('tableCount must be a non-negative integer', 400)
  }

  const description = body.description ? String(body.description) : null

  let rows: RoomRow[]
  try {
    rows = await sql`
      INSERT INTO rooms (name, table_count, description)
      VALUES (${name}, ${tableCount}, ${description})
      RETURNING id, name, table_count, description
    ` as RoomRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  if (!data) {
    serviceError('Internal server error', 500)
  }

  return toRoom(data)
}

export async function updateRoom(id: string, body: { name?: unknown; description?: unknown; tableCount?: unknown }) {
  let tableCount: number | undefined
  if (body.tableCount !== undefined && body.tableCount !== null && body.tableCount !== '') {
    const raw = Number(body.tableCount)
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      serviceError('tableCount must be a non-negative integer', 400)
    }
    tableCount = raw
  }

  const name = body.name ? String(body.name) : undefined
  const description =
    body.description === undefined
      ? undefined
      : body.description === null
        ? null
        : String(body.description)

  let rows: RoomRow[]
  try {
    rows = await sql`
      UPDATE rooms
      SET
        name = COALESCE(${name ?? null}, name),
        description = CASE WHEN ${description === undefined} THEN description ELSE ${description ?? null} END,
        table_count = COALESCE(${tableCount ?? null}, table_count)
      WHERE id = ${id}
      RETURNING id, name, table_count, description
    ` as RoomRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  if (!data) {
    serviceError('Room not found', 404)
  }

  return toRoom(data)
}

export async function listRoomTables(roomId: string) {
  return listTablesByRoom(roomId)
}

export async function getRoomTablesAvailability(roomId: string, date?: string | null) {
  const effectiveDate = resolveDate(date)
  const tables = await listTablesByRoom(roomId)
  if (tables.length === 0) {
    return {}
  }

  const tableIds = tables.map((table) => table.id)

  let reservationsRows: ReservationRow[]
  let eventBlocks: EventBlockRow[]
  let savedGameRows: { table_id: string }[]
  let nowUtc: Date
  try {
    ;[reservationsRows, eventBlocks, savedGameRows, nowUtc] = await Promise.all([
      sql`
        SELECT id, table_id, date, start_time, end_time, status, surface, user_id, activated_at, created_at
        FROM reservations
        WHERE date = ${effectiveDate}
          AND status IN ('active', 'pending')
          AND table_id = ANY(${tableIds})
      ` as unknown as Promise<ReservationRow[]>,
      sql`
        SELECT id, event_id, room_id, table_id, date, start_time, end_time, all_day
        FROM event_room_blocks
        WHERE room_id = ${roomId}
          AND date = ${effectiveDate}
      ` as unknown as Promise<EventBlockRow[]>,
      sql`
        SELECT table_id
        FROM saved_games
        WHERE status = 'active'
          AND start_date <= ${effectiveDate}
          AND end_date >= ${effectiveDate}
          AND table_id = ANY(${tableIds})
      ` as unknown as Promise<{ table_id: string }[]>,
      getDatabaseNow(),
    ])
  } catch {
    serviceError('Internal server error', 500)
  }

  const activeReservations = reservationsRows.filter((row) =>
    row.status !== 'pending' || row.activated_at !== null || !isPendingReservationExpired(row, nowUtc),
  )
  const savedGameTableIds = new Set(savedGameRows.map((row) => row.table_id))

  let eventTitleById = new Map<string, string>()
  const eventIds = [...new Set(eventBlocks.map((block) => block.event_id))]
  if (eventIds.length > 0) {
    let eventsRows: Array<{ id: string; title: string }>
    try {
      eventsRows = await sql`
        SELECT id, title
        FROM events
        WHERE id = ANY(${eventIds})
      ` as Array<{ id: string; title: string }>
    } catch {
      serviceError('Internal server error', 500)
    }

    eventTitleById = new Map(eventsRows.map((event) => [event.id, event.title]))
  }

  const reservationsByTable = new Map<string, ReservationRow[]>()
  for (const reservation of activeReservations) {
    const items = reservationsByTable.get(reservation.table_id) ?? []
    items.push(reservation)
    reservationsByTable.set(reservation.table_id, items)
  }

  // OIR-208: a block with a table_id only blocks that single table; NULL
  // (the pre-OIR-208 default) blocks every table of the room, unchanged.
  function eventSlotsForTable(tableId: string) {
    return eventBlocks
      .filter((block) => block.table_id == null || block.table_id === tableId)
      .map((block) => ({
        start: block.start_time.slice(0, 5),
        end: block.end_time.slice(0, 5),
        label: eventTitleById.get(block.event_id) ?? null,
      }))
  }

  return tables.reduce<Record<string, TableAvailability>>((acc, table) => {
    acc[table.id] = buildAvailability(
      table,
      effectiveDate,
      (reservationsByTable.get(table.id) ?? []) as unknown as Tables<'reservations'>[],
      eventSlotsForTable(table.id),
      savedGameTableIds.has(table.id),
    )
    return acc
  }, {})
}

export async function createTableEntry(
  roomId: string,
  body: { name?: unknown; type?: unknown },
) {
  const name = String(body.name ?? '').trim()
  if (!name) {
    serviceError('Table name is required', 400)
  }

  const rawType = String(body.type ?? 'small')
  const validTypes = ['small', 'large', 'removable_top'] as const
  type ValidType = typeof validTypes[number]
  if (!validTypes.includes(rawType as ValidType)) {
    serviceError('Invalid table type. Must be small, large, or removable_top', 400)
  }
  const type = rawType as ValidType

  let rows: TableRow[]
  try {
    rows = await sql`
      INSERT INTO tables (room_id, name, type)
      VALUES (${roomId}, ${name}, ${type})
      RETURNING id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y
    ` as TableRow[]
  } catch (error) {
    if (error instanceof NeonDbError && error.code === '23503') {
      // Foreign-key violation: the provided roomId does not reference an existing room.
      serviceError('Invalid room ID', 400)
    }
    serviceError('Internal server error', 500)
  }

  const tableRow = rows[0]
  if (!tableRow) {
    serviceError('Internal server error', 500)
  }

  // Fire-and-forget: generate QR codes without blocking the POST response.
  // If QR generation fails the admin can regenerate later via the dashboard.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (appUrl) {
    regenerateQrCodes(tableRow.id).catch((qrErr: unknown) => {
      console.error('[createTableEntry] QR generation failed in background:', qrErr)
    })
  }

  return toGameTable(tableRow as unknown as Tables<'tables'>)
}
