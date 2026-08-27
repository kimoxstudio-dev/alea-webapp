import type { GameTable, Room, TableAvailability } from '@/lib/types'
import { createSupabaseServerAdminClient, createSupabaseServerClient } from '@/lib/supabase/server'
import { serviceError } from '@/lib/server/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/availability'
import type { Tables, TablesInsert, TablesUpdate } from '@/lib/supabase/types'
import { regenerateQrCodes } from '@/lib/server/tables-service'
import { toGameTable } from '@/lib/server/table-mappers'
import { getDatabaseNow } from '@/lib/server/database-time'
import { isPendingReservationExpired } from '@/lib/server/pending-reservation-expiry'

type RoomRow = Tables<'rooms'>
type TableRow = Tables<'tables'>
type ReservationRow = Tables<'reservations'>
type EventBlockRow = Tables<'event_room_blocks'>
type RoomsTableClient = {
  select: (columns: string) => {
    order: (column: string, options: { ascending: boolean }) => Promise<{ data: RoomRow[] | null; error: unknown }>
  }
  insert: (values: TablesInsert<'rooms'>) => {
    select: (columns: string) => {
      maybeSingle: () => Promise<{ data: RoomRow | null; error: unknown }>
    }
  }
  update: (values: TablesUpdate<'rooms'>) => {
    eq: (column: 'id', value: string) => {
      select: (columns: string) => {
        maybeSingle: () => Promise<{ data: RoomRow | null; error: unknown }>
      }
    }
  }
}
type TablesByRoomClient = {
  select: (columns: string) => {
    eq: (column: 'room_id', value: string) => {
      order: (column: string, options: { ascending: boolean }) => Promise<{ data: TableRow[] | null; error: unknown }>
    }
  }
}
type TablesInsertClient = {
  insert: (values: TablesInsert<'tables'>) => {
    select: (columns: string) => {
      maybeSingle: () => Promise<{ data: TableRow | null; error: unknown }>
    }
  }
}
type ReservationsByTableClient = {
  select: (columns: string) => {
    eq: (column: 'date', value: string) => {
      in: (column: 'status', values: string[]) => {
        in: (column: 'table_id', values: string[]) => Promise<{ data: ReservationRow[] | null; error: unknown }>
      }
    }
  }
}

const ROOM_COLUMNS = 'id, name, table_count, description'
const TABLE_COLUMNS = 'id, room_id, name, type, qr_code, qr_code_inf, pos_x, pos_y'

function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    tableCount: row.table_count,
    description: row.description ?? undefined,
  }
}

async function listTablesByRoom(roomId: string) {
  const supabase = await createSupabaseServerClient()
  const tables = supabase.from('tables') as unknown as TablesByRoomClient
  const { data, error } = await tables
    .select(TABLE_COLUMNS)
    .eq('room_id', roomId)
    .order('name', { ascending: true })

  if (error) {
    serviceError('Internal server error', 500)
  }

  return ((data ?? []) as TableRow[]).map(toGameTable)
}

export async function listAllRooms() {
  const supabase = await createSupabaseServerClient()
  const rooms = supabase.from('rooms') as unknown as RoomsTableClient
  const { data, error } = await rooms
    .select(ROOM_COLUMNS)
    .order('created_at', { ascending: true })

  if (error) {
    serviceError('Internal server error', 500)
  }

  return ((data ?? []) as RoomRow[]).map(toRoom)
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

  const supabase = createSupabaseServerAdminClient()
  const insert: TablesInsert<'rooms'> = {
    name,
    table_count: tableCount,
    description: body.description ? String(body.description) : null,
  }
  const rooms = supabase.from('rooms') as unknown as RoomsTableClient
  const { data, error } = await rooms
    .insert(insert)
    .select(ROOM_COLUMNS)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }
  if (!data) {
    serviceError('Internal server error', 500)
  }

  return toRoom(data as RoomRow)
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

  const supabase = createSupabaseServerAdminClient()
  const updates: TablesUpdate<'rooms'> = {
    name: body.name ? String(body.name) : undefined,
    description:
      body.description === undefined
        ? undefined
        : body.description === null
          ? null
          : String(body.description),
    ...(tableCount !== undefined ? { table_count: tableCount } : {}),
  }
  const rooms = supabase.from('rooms') as unknown as RoomsTableClient
  const { data, error } = await rooms
    .update(updates)
    .eq('id', id)
    .select(ROOM_COLUMNS)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }
  if (!data) {
    serviceError('Room not found', 404)
  }

  return toRoom(data as RoomRow)
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

  const admin = createSupabaseServerAdminClient()
  const reservations = admin.from('reservations') as unknown as ReservationsByTableClient

  const [reservationsResult, eventBlocksResult, savedGamesResult, nowUtc] = await Promise.all([
    reservations
      .select('id, table_id, date, start_time, end_time, status, surface, user_id, activated_at, created_at')
      .eq('date', effectiveDate)
      .in('status', ['active', 'pending'])
      .in('table_id', tables.map((table) => table.id)),
    admin
      .from('event_room_blocks')
      .select('id, event_id, room_id, table_id, date, start_time, end_time, all_day')
      .eq('room_id', roomId)
      .eq('date', effectiveDate),
    admin
      .from('saved_games')
      .select('table_id')
      .eq('status', 'active')
      .lte('start_date', effectiveDate)
      .gte('end_date', effectiveDate)
      .in('table_id', tables.map((table) => table.id)),
    getDatabaseNow(),
  ])

  const { data, error } = reservationsResult

  if (error) {
    serviceError('Internal server error', 500)
  }

  const activeReservations = ((data ?? []) as ReservationRow[]).filter((row) =>
    row.status !== 'pending' || row.activated_at !== null || !isPendingReservationExpired(row, nowUtc),
  )
  const eventBlocks = (eventBlocksResult.data ?? []) as EventBlockRow[]

  if (eventBlocksResult.error) {
    serviceError('Internal server error', 500)
  }
  if (savedGamesResult.error) serviceError('Internal server error', 500)
  const savedGameTableIds = new Set((savedGamesResult.data ?? []).map((row) => row.table_id))

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
      reservationsByTable.get(table.id) ?? [],
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

  const supabase = createSupabaseServerAdminClient()
  const insert: TablesInsert<'tables'> = {
    room_id: roomId,
    name,
    type,
  }
  const tables = supabase.from('tables') as unknown as TablesInsertClient
  const { data, error } = await tables
    .insert(insert)
    .select(TABLE_COLUMNS)
    .maybeSingle()

  if (error) {
    const pgError = error as { code?: string }
    if (pgError.code === '23503') {
      // Foreign-key violation: the provided roomId does not reference an existing room.
      serviceError('Invalid room ID', 400)
    }
    serviceError('Internal server error', 500)
  }
  if (!data) {
    serviceError('Internal server error', 500)
  }

  const tableRow = data as TableRow

  // Fire-and-forget: generate QR codes without blocking the POST response.
  // If QR generation fails the admin can regenerate later via the dashboard.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (appUrl) {
    regenerateQrCodes(tableRow.id).catch((qrErr: unknown) => {
      console.error('[createTableEntry] QR generation failed in background:', qrErr)
    })
  }

  return toGameTable(tableRow)
}
