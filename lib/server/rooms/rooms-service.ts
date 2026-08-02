import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { TableAvailability } from '@/lib/types'
import { getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { eventRoomBlocks, events, reservations, rooms, savedGames, tables } from '@/lib/db/schema'
import { serviceError } from '@/lib/server/shared/service-error'
import { resolveDate, buildAvailability } from '@/lib/server/reservations/availability'
import { regenerateQrCodes } from '@/lib/server/tables/tables-service'
import { toGameTable } from '@/lib/server/tables/table-mappers'
import { getDatabaseNow } from '@/lib/server/shared/database-time'
import { isPendingReservationExpired } from '@/lib/server/reservations/pending-reservation-expiry'
import type { SessionUser } from '@/lib/server/auth/auth'

/**
 * GitHub #244 (KIM-434 F3c stack, split-brain follow-up to #238): finishes
 * migrating this file off the legacy Supabase `getAdminDb()` seam onto the
 * Drizzle/Neon client (`getDrizzleDb()` / `getDrizzleAdminDb()`). PR2 (KIM-434)
 * already migrated `rooms`/`tables` reads/writes; `getRoomTablesAvailability()`
 * below was the last holdout reading `reservations`, `event_room_blocks` and
 * `saved_games` from Supabase — a live cross-backend read now that
 * `reservations-service.ts` (#238) writes those same tables to Neon. All
 * reads in this file now go through Drizzle/Neon; no Supabase client usage
 * remains.
 *
 * Row-shape convention: query results below are selected with explicit
 * snake_case column aliases (e.g. `table_id: reservations.tableId`) so they
 * keep matching the structural, backend-agnostic `ReservationRow` shape
 * `buildAvailability()` (lib/server/reservations/availability.ts) and
 * `isPendingReservationExpired()` (lib/server/reservations/pending-
 * reservation-expiry.ts) already expect — both were intentionally kept
 * snake_case-shaped so this migration wouldn't need to touch either shared
 * helper. See `tables-service.ts` for the identical convention.
 */

// Privilege checks (role === 'admin') live here in the service layer, not in
// route handlers (repo convention). These mutations use the admin client
// (bypasses RLS entirely), so this in-function check is the only
// authorization guard once RLS is removed as part of the Vercel/Postgres
// migration — mirrors rooms_admin_insert/update and tables_admin_insert
// RLS policies (is_admin()).
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

/**
 * Runs a Drizzle query, translating any thrown DB/driver error into a
 * uniform 500 ServiceError. Business-logic outcomes (e.g. "no row
 * returned" -> 404, validation -> 400) are handled by callers, outside this
 * wrapper, so their specific status codes aren't swallowed into a 500.
 */
async function runQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch {
    serviceError('Internal server error', 500)
  }
}

function toRoom(row: typeof rooms.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    tableCount: row.tableCount,
    description: row.description ?? undefined,
  }
}

async function listTablesByRoom(roomId: string) {
  const db = getDrizzleDb()
  const rows = await runQuery(
    db.select().from(tables).where(eq(tables.roomId, roomId)).orderBy(asc(tables.name)),
  )

  return rows.map(toGameTable)
}

export async function listAllRooms() {
  const db = getDrizzleDb()
  const rows = await runQuery(db.select().from(rooms).orderBy(asc(rooms.createdAt)))

  return rows.map(toRoom)
}

export async function createRoomEntry(
  session: SessionUser,
  body: { name?: unknown; tableCount?: unknown; description?: unknown },
) {
  requireAdminSession(session)
  const name = String(body.name ?? '').trim()
  if (!name) {
    serviceError('Room name is required', 400)
  }

  const rawCount = body.tableCount ?? 0
  const tableCount = Number(rawCount)
  if (!Number.isFinite(tableCount) || tableCount < 0 || !Number.isInteger(tableCount)) {
    serviceError('tableCount must be a non-negative integer', 400)
  }

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db
      .insert(rooms)
      .values({
        name,
        tableCount,
        description: body.description ? String(body.description) : null,
      })
      .returning(),
  )

  if (!row) {
    serviceError('Internal server error', 500)
  }

  return toRoom(row)
}

export async function updateRoom(
  session: SessionUser,
  id: string,
  body: { name?: unknown; description?: unknown; tableCount?: unknown },
) {
  requireAdminSession(session)
  let tableCount: number | undefined
  if (body.tableCount !== undefined && body.tableCount !== null && body.tableCount !== '') {
    const raw = Number(body.tableCount)
    if (!Number.isFinite(raw) || raw < 0 || !Number.isInteger(raw)) {
      serviceError('tableCount must be a non-negative integer', 400)
    }
    tableCount = raw
  }

  const updates: Partial<{ name: string; description: string | null; tableCount: number }> = {}
  if (body.name) updates.name = String(body.name)
  if (body.description !== undefined) {
    updates.description = body.description === null ? null : String(body.description)
  }
  if (tableCount !== undefined) updates.tableCount = tableCount

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(db.update(rooms).set(updates).where(eq(rooms.id, id)).returning())

  if (!row) {
    serviceError('Room not found', 404)
  }

  return toRoom(row)
}

export async function listRoomTables(roomId: string) {
  return listTablesByRoom(roomId)
}

export async function getRoomTablesAvailability(roomId: string, date?: string | null) {
  const effectiveDate = resolveDate(date)
  const roomTables = await listTablesByRoom(roomId)
  if (roomTables.length === 0) {
    return {}
  }

  const db = getDrizzleAdminDb()
  const tableIds = roomTables.map((table) => table.id)

  const [reservationRows, eventBlocks, savedGameRows, nowUtc] = await Promise.all([
    runQuery(
      db
        .select({
          table_id: reservations.tableId,
          date: reservations.date,
          start_time: reservations.startTime,
          end_time: reservations.endTime,
          status: reservations.status,
          surface: reservations.surface,
          activated_at: reservations.activatedAt,
        })
        .from(reservations)
        .where(
          and(
            eq(reservations.date, effectiveDate),
            inArray(reservations.status, ['active', 'pending']),
            inArray(reservations.tableId, tableIds),
          ),
        ),
    ),
    runQuery(
      db
        .select({
          event_id: eventRoomBlocks.eventId,
          table_id: eventRoomBlocks.tableId,
          start_time: eventRoomBlocks.startTime,
          end_time: eventRoomBlocks.endTime,
        })
        .from(eventRoomBlocks)
        .where(and(eq(eventRoomBlocks.roomId, roomId), eq(eventRoomBlocks.date, effectiveDate))),
    ),
    runQuery(
      db
        .select({ table_id: savedGames.tableId })
        .from(savedGames)
        .where(
          and(
            eq(savedGames.status, 'active'),
            lte(savedGames.startDate, effectiveDate),
            gte(savedGames.endDate, effectiveDate),
            inArray(savedGames.tableId, tableIds),
          ),
        ),
    ),
    getDatabaseNow(db),
  ])

  const activeReservations = reservationRows.filter((row) =>
    row.status !== 'pending' || row.activated_at !== null || !isPendingReservationExpired(row, nowUtc),
  )
  const savedGameTableIds = new Set(savedGameRows.map((row) => row.table_id))

  let eventTitleById = new Map<string, string>()
  const eventIds = [...new Set(eventBlocks.map((block) => block.event_id))]
  if (eventIds.length > 0) {
    const eventRows = await runQuery(
      db.select({ id: events.id, title: events.title }).from(events).where(inArray(events.id, eventIds)),
    )

    eventTitleById = new Map(eventRows.map((event) => [event.id, event.title]))
  }

  const reservationsByTable = new Map<string, typeof activeReservations>()
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

  return roomTables.reduce<Record<string, TableAvailability>>((acc, table) => {
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
  session: SessionUser,
  roomId: string,
  body: { name?: unknown; type?: unknown },
) {
  requireAdminSession(session)
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

  const db = getDrizzleAdminDb()
  let row: typeof tables.$inferSelect | undefined
  try {
    ;[row] = await db
      .insert(tables)
      .values({ roomId, name, type })
      .returning()
  } catch (err) {
    const pgError = err as { code?: string }
    if (pgError.code === '23503') {
      // Foreign-key violation: the provided roomId does not reference an existing room.
      serviceError('Invalid room ID', 400)
    }
    serviceError('Internal server error', 500)
  }

  if (!row) {
    serviceError('Internal server error', 500)
  }

  // Fire-and-forget: generate QR codes without blocking the POST response.
  // If QR generation fails the admin can regenerate later via the dashboard.
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '')
  if (appUrl) {
    regenerateQrCodes(session, row.id).catch((qrErr: unknown) => {
      console.error('[createTableEntry] QR generation failed in background:', qrErr)
    })
  }

  return toGameTable(row)
}
