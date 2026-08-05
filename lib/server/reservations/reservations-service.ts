import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import type { AvailableEquipment, Equipment, Reservation, TableSurface } from '@/lib/types'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { SessionUser } from '@/lib/server/auth/auth'
import { CLUB_TIMEZONE, getCurrentClubDate, isValidDateOnlyString, zonedDateTimeToUtc } from '@/lib/club-time'
import { getDatabaseNow } from '@/lib/server/shared/database-time'
import { serviceError } from '@/lib/server/shared/service-error'
import { assertMemberRowsScoped } from '@/lib/server/shared/data-scoping'
import { getDrizzleAdminDb, getDrizzleDb, type DbClient } from '@/lib/db'
import {
  equipment,
  eventRoomBlocks,
  profiles,
  reservationEquipment,
  reservations,
  roomDefaultEquipment,
  rooms,
  savedGames,
  tables,
} from '@/lib/db/schema'
import { normalizeTime } from '@/lib/server/reservations/availability'
import {
  CHECK_IN_LATE_MINUTES,
  getPendingCheckInDeadline,
  isPendingReservationExpired,
} from '@/lib/server/reservations/pending-reservation-expiry'
import { recordSavedGameAttendance } from '@/lib/server/games/saved-games-service'

/**
 * GitHub #238 (KIM-434 F3c stack, remaining consumer): migrated off the
 * legacy Supabase `getDb()`/`getAdminDb()` seam onto the Drizzle/Neon client
 * (`getDrizzleDb()`/`getDrizzleAdminDb()`), following the pilot pattern from
 * `lib/server/equipment/equipment-service.ts` and
 * `lib/server/games/saved-games-service.ts`.
 *
 * This closes the split-brain bug tracked by GitHub #248: `saved_games` and
 * `event_room_blocks` conflict checks below used to read from Supabase while
 * `saved-games-service.ts` (KIM-441) had already moved saved-game writes to
 * Neon, making active saved games invisible to reservation conflict checks.
 * `reservations`, `reservation_equipment`, `room_default_equipment`,
 * `saved_games` and `event_room_blocks` are ALL read/written via Drizzle
 * below now — no cross-backend reads remain in this file.
 *
 * Member isolation policy (unchanged from the pre-migration version):
 *   - explicit `user_id = session.id` filter on member-scoped reads (see the
 *     non-admin branch of `listVisibleReservations` below)
 *   - explicit ownership checks (`session.id !== reservation.userId`) before
 *     mutations
 *   - `assertMemberRowsScoped()` (KIM-397) as defense-in-depth on the
 *     multi-row read in `listVisibleReservations`, run AFTER the DB fetch and
 *     BEFORE mapping rows to the public `Reservation` shape
 */

type ReservationRow = typeof reservations.$inferSelect
type TableRow = { id: string; type: 'small' | 'large' | 'removable_top'; roomId: string }
type EquipmentRow = typeof equipment.$inferSelect

type EnrichedReservationRow = ReservationRow & {
  memberNumber: string | null
  tableName: string | null
  roomName: string | null
  equipment: EquipmentRow[]
}

/** @deprecated Pending expiry is slot-relative; retained for compatibility. */
export const GRACE_PERIOD_MINUTES = CHECK_IN_LATE_MINUTES
// How many minutes before the reservation start time check-in is allowed.
export const CHECK_IN_EARLY_MINUTES = 5
// How many minutes after the reservation start time check-in is still allowed.
export { CHECK_IN_LATE_MINUTES }
export const BOOKING_WINDOW_DAYS = 7
const CANCELLATION_CUTOFF_MS = 60 * 60 * 1000 // 60 minutes

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

/**
 * `node-postgres` (the driver behind the Drizzle/Neon seam) throws raw `pg`
 * `DatabaseError` instances with a `code` shape on constraint violations; it
 * does not wrap them. Duck-typed here rather than importing `pg`'s error
 * class to keep this check dependency-light. 23P01 is the exclusion-
 * constraint violation raised by the overlap-guard EXCLUDE constraints on
 * `reservations` (see lib/db/schema/reservations.ts).
 */
function isConflictError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code } = error as { code?: unknown }
  return code === '23P01'
}

/** Bridges a Drizzle reservation row's `date`/`startTime`/`endTime` fields to
 * the snake_case `PendingReservationSlot` shape shared with the
 * (not-yet-migrated) `pending-reservation-expiry.ts` consumers. */
function toPendingSlot(row: { date: string; startTime: string; endTime: string }) {
  return { date: row.date, start_time: row.startTime, end_time: row.endTime }
}

/** Bridges a Drizzle reservation row (camelCase) to the snake_case shape
 * `recordSavedGameAttendance()` (saved-games-service.ts) expects — same
 * kind of conversion as `toPendingSlot()` above, for the same reason: that
 * service's shape predates this file's migration off the legacy Supabase
 * seam and hasn't been changed to avoid touching its other callers. */
function toAttendanceReservation(row: ReservationRow) {
  return {
    id: row.id,
    table_id: row.tableId,
    user_id: row.userId,
    date: row.date,
    surface: row.surface,
    status: row.status,
  }
}

function parseDate(value: string): string {
  if (!isValidDateOnlyString(value)) {
    serviceError('Invalid date value', 400)
  }
  return value
}

function parseHHMM(value: string, options?: { allow24HourBoundary?: boolean }): string {
  if (options?.allow24HourBoundary && value === '24:00') {
    return value
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    serviceError('Time must be in HH:MM format (00:00–23:59)', 400)
  }
  return value
}

function parseSurface(value: unknown): TableSurface | undefined {
  return value === 'top' || value === 'bottom' ? value : undefined
}

function requireString(value: unknown): string {
  return String(value ?? '')
}

function assertReservationNotInPast(date: string, startTime: string, now: Date = new Date()) {
  const todayInClub = getCurrentClubDate(now)
  if (date < todayInClub) {
    serviceError('Cannot make a reservation in the past', 400)
  }
  if (date === todayInClub) {
    const reservationStart = zonedDateTimeToUtc(date, startTime)
    if (reservationStart.getTime() < now.getTime()) {
      serviceError('Cannot make a reservation in the past', 400)
    }
  }
}

function addDaysToDateOnly(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + days))
  return next.toISOString().slice(0, 10)
}

function assertReservationWithinBookingWindow(date: string, now: Date = new Date()) {
  const todayInClub = getCurrentClubDate(now)
  const maxAllowedDate = addDaysToDateOnly(todayInClub, BOOKING_WINDOW_DAYS)
  if (date > maxAllowedDate) {
    serviceError(ERROR_CODES.BOOKING_WINDOW_EXCEEDED, 400)
  }
}

function toEquipment(row: EquipmentRow): Equipment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    tableId: row.tableId,
    userId: row.userId,
    date: row.date,
    startTime: normalizeTime(row.startTime),
    endTime: normalizeTime(row.endTime),
    status: row.status,
    surface: row.surface,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    equipment: [],
  }
}

function mapEnrichedReservation(row: EnrichedReservationRow): Reservation {
  return {
    id: row.id,
    tableId: row.tableId,
    userId: row.userId,
    date: row.date,
    startTime: normalizeTime(row.startTime),
    endTime: normalizeTime(row.endTime),
    status: row.status,
    surface: row.surface,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    memberNumber: row.memberNumber,
    roomName: row.roomName,
    tableName: row.tableName,
    equipment: row.equipment.map(toEquipment),
  }
}

async function getTable(tableId: string): Promise<TableRow | null> {
  const db = getDrizzleDb()
  const [table] = await runQuery(
    db
      .select({ id: tables.id, type: tables.type, roomId: tables.roomId })
      .from(tables)
      .where(eq(tables.id, tableId)),
  )

  return table ?? null
}

async function hasEventBlockConflict(input: {
  roomId: string
  tableId: string
  date: string
  startTime: string
  endTime: string
}) {
  const db = getDrizzleAdminDb()
  const blocks = await runQuery(
    db
      .select({ id: eventRoomBlocks.id, tableId: eventRoomBlocks.tableId })
      .from(eventRoomBlocks)
      .where(
        and(
          eq(eventRoomBlocks.roomId, input.roomId),
          eq(eventRoomBlocks.date, input.date),
          lt(eventRoomBlocks.startTime, input.endTime),
          gt(eventRoomBlocks.endTime, input.startTime),
        ),
      ),
  )

  // OIR-208: a block with a table_id only conflicts with that single table;
  // NULL (the pre-OIR-208 default) conflicts with every table of the room.
  return blocks.some((block) => block.tableId == null || block.tableId === input.tableId)
}

async function hasSavedGameBottomConflict(input: {
  tableId: string
  date: string
  surface?: TableSurface
}) {
  if (input.surface !== 'bottom') return false
  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db
      .select({ id: savedGames.id })
      .from(savedGames)
      .where(
        and(
          eq(savedGames.tableId, input.tableId),
          eq(savedGames.status, 'active'),
          lte(savedGames.startDate, input.date),
          gte(savedGames.endDate, input.date),
        ),
      )
      .limit(1),
  )

  return rows.length > 0
}

async function getReservationForAccess(reservationId: string) {
  const db = getDrizzleAdminDb()
  const [row] = await runQuery(db.select().from(reservations).where(eq(reservations.id, reservationId)))

  return row ?? null
}

async function listActiveReservationsForConflict(input: {
  tableId: string
  date: string
  ignoreReservationId?: string
}) {
  const db = getDrizzleAdminDb()
  const conditions = [
    eq(reservations.tableId, input.tableId),
    eq(reservations.date, input.date),
    inArray(reservations.status, ['active', 'pending']),
  ]
  if (input.ignoreReservationId) {
    conditions.push(ne(reservations.id, input.ignoreReservationId))
  }

  const rows = await runQuery(db.select().from(reservations).where(and(...conditions)))

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow(db)
  return rows.filter((row) => {
    if (row.status === 'pending' && row.activatedAt === null) {
      return !isPendingReservationExpired(toPendingSlot(row), nowUtc)
    }
    return true // Keep active reservations
  })
}

async function expireStalePendingReservations(tableId: string, date: string) {
  const db = getDrizzleAdminDb()
  const nowUtc = await getDatabaseNow(db)

  let rows: ReservationRow[]
  try {
    rows = await db
      .select()
      .from(reservations)
      .where(
        and(
          eq(reservations.status, 'pending'),
          eq(reservations.tableId, tableId),
          eq(reservations.date, date),
          isNull(reservations.activatedAt),
        ),
      )
  } catch (error) {
    console.error('expireStalePendingReservations failed (non-fatal):', error)
    return
  }

  const expiredIds = rows
    .filter((row) => isPendingReservationExpired(toPendingSlot(row), nowUtc))
    .map((row) => row.id)

  for (const id of expiredIds) {
    try {
      await db
        .update(reservations)
        .set({ status: 'cancelled' })
        .where(
          and(eq(reservations.id, id), eq(reservations.status, 'pending'), isNull(reservations.activatedAt)),
        )
    } catch (error) {
      console.error('expireStalePendingReservations failed (non-fatal):', error)
    }
  }
}

async function listOverlappingReservationIds(input: {
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  const db = getDrizzleAdminDb()
  const pageSize = 1000
  const reservationIds: string[] = []
  let from = 0

  // Capture DB time once before the pagination loop to avoid one round-trip
  // per page.
  const nowUtc = await getDatabaseNow(db)

  // Get full rows to enable lazy evaluation filtering
  while (true) {
    const conditions = [
      eq(reservations.date, input.date),
      inArray(reservations.status, ['pending', 'active']),
      lt(reservations.startTime, input.endTime),
      gt(reservations.endTime, input.startTime),
    ]
    if (input.ignoreReservationId) {
      conditions.push(ne(reservations.id, input.ignoreReservationId))
    }

    const rows = await runQuery(
      db
        .select()
        .from(reservations)
        .where(and(...conditions))
        .orderBy(asc(reservations.id))
        .limit(pageSize)
        .offset(from),
    )

    // Lazy evaluation: filter out expired pending reservations
    const filteredRows = rows.filter((row) => {
      if (row.status === 'pending' && row.activatedAt === null) {
        return !isPendingReservationExpired(toPendingSlot(row), nowUtc)
      }
      return true
    })

    reservationIds.push(...filteredRows.map((row) => row.id))

    if (rows.length < pageSize) break
    from += pageSize
  }

  return reservationIds
}

async function listRoomDefaultEquipment(roomId: string) {
  const db = getDrizzleAdminDb()
  return runQuery(
    db
      .select({
        id: equipment.id,
        name: equipment.name,
        description: equipment.description,
        createdAt: equipment.createdAt,
      })
      .from(roomDefaultEquipment)
      .innerJoin(equipment, eq(roomDefaultEquipment.equipmentId, equipment.id))
      .where(eq(roomDefaultEquipment.roomId, roomId)),
  )
}

async function listAllEquipment() {
  const db = getDrizzleAdminDb()
  return runQuery(db.select().from(equipment).orderBy(asc(equipment.name)))
}

async function listEquipmentLockedToOtherRooms(roomId: string): Promise<Set<string>> {
  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db
      .select({ equipmentId: roomDefaultEquipment.equipmentId, roomId: roomDefaultEquipment.roomId })
      .from(roomDefaultEquipment),
  )

  const lockedToOther = new Set<string>()
  for (const row of rows) {
    if (row.roomId !== roomId) {
      lockedToOther.add(row.equipmentId)
    }
  }
  return lockedToOther
}

async function listReservableEquipment(input: {
  roomId: string
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  const [allEquipment, lockedToOther] = await Promise.all([
    listAllEquipment(),
    listEquipmentLockedToOtherRooms(input.roomId),
  ])

  // Global pool minus equipment locked to other rooms
  const availablePool = allEquipment.filter((item) => !lockedToOther.has(item.id))
  const poolIds = availablePool.map((item) => item.id)

  if (poolIds.length === 0) {
    return []
  }

  const poolConflicts = await listConflictingEquipmentIds({
    equipmentIds: poolIds,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    ignoreReservationId: input.ignoreReservationId,
  })

  return availablePool.map((item) => ({
    ...item,
    available: !poolConflicts.has(item.id),
  }))
}

async function listConflictingEquipmentIds(input: {
  equipmentIds: string[]
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  if (input.equipmentIds.length === 0) {
    return new Set<string>()
  }

  const overlappingReservationIds = await listOverlappingReservationIds(input)
  if (overlappingReservationIds.length === 0) {
    return new Set<string>()
  }

  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db
      .select({ equipmentId: reservationEquipment.equipmentId })
      .from(reservationEquipment)
      .where(
        and(
          inArray(reservationEquipment.reservationId, overlappingReservationIds),
          inArray(reservationEquipment.equipmentId, input.equipmentIds),
        ),
      ),
  )

  return new Set(rows.map((row) => row.equipmentId))
}

async function assertEquipmentSelectionAllowed(input: {
  roomId: string
  equipmentIds: string[]
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  if (input.equipmentIds.length === 0) {
    return
  }

  // Check that all requested equipment actually exists in the global pool
  const [allEquipment, lockedToOther] = await Promise.all([
    listAllEquipment(),
    listEquipmentLockedToOtherRooms(input.roomId),
  ])

  const globalEquipmentIds = new Set(allEquipment.map((item) => item.id))

  // Reject any equipment that does not exist at all
  const unknownIds = input.equipmentIds.filter((id) => !globalEquipmentIds.has(id))
  if (unknownIds.length > 0) {
    serviceError(ERROR_CODES.INVALID_ROOM_EQUIPMENT, 400)
  }

  // Reject any equipment locked as default to a different room
  const lockedIds = input.equipmentIds.filter((id) => lockedToOther.has(id))
  if (lockedIds.length > 0) {
    serviceError(ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM, 400)
  }

  const conflictingEquipmentIds = await listConflictingEquipmentIds(input)
  if (conflictingEquipmentIds.size > 0) {
    serviceError(ERROR_CODES.EQUIPMENT_ALREADY_RESERVED, 409)
  }
}

async function saveReservationEquipment(reservationId: string, equipmentIds: string[]) {
  const db = getDrizzleAdminDb()
  await runQuery(db.delete(reservationEquipment).where(eq(reservationEquipment.reservationId, reservationId)))

  if (equipmentIds.length === 0) {
    return
  }

  await runQuery(
    db.insert(reservationEquipment).values(equipmentIds.map((equipmentId) => ({ reservationId, equipmentId }))),
  )
}

async function getReservationEquipmentIds(reservationId: string) {
  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db
      .select({ equipmentId: reservationEquipment.equipmentId })
      .from(reservationEquipment)
      .where(eq(reservationEquipment.reservationId, reservationId)),
  )

  return rows.map((row) => row.equipmentId)
}

function hasReservationConflict(
  existingReservations: ReservationRow[],
  input: {
    startTime: string
    endTime: string
    surface?: TableSurface
  },
) {
  return existingReservations.some((reservation) => {
    if (input.surface && reservation.surface && input.surface !== reservation.surface) {
      return false
    }

    const reservationStart = normalizeTime(reservation.startTime)
    const reservationEnd = normalizeTime(reservation.endTime)
    return reservationStart < input.endTime && input.startTime < reservationEnd
  })
}

function assertReservationAccess(
  session: SessionUser,
  reservation: ReservationRow | null,
): asserts reservation is ReservationRow {
  if (!reservation) {
    serviceError('Reservation not found', 404)
  }
  if (session.role !== 'admin' && reservation.userId !== session.id) {
    serviceError('Forbidden', 403)
  }
}

function throwSlotTaken(): never {
  serviceError(ERROR_CODES.SLOT_TAKEN, 409)
}

/** Fetches equipment attached to a set of reservations in a single query, grouped by reservation id. */
async function fetchEquipmentByReservationIds(reservationIds: string[]): Promise<Map<string, EquipmentRow[]>> {
  const byReservationId = new Map<string, EquipmentRow[]>()
  if (reservationIds.length === 0) {
    return byReservationId
  }

  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db
      .select({
        reservationId: reservationEquipment.reservationId,
        id: equipment.id,
        name: equipment.name,
        description: equipment.description,
        createdAt: equipment.createdAt,
      })
      .from(reservationEquipment)
      .innerJoin(equipment, eq(reservationEquipment.equipmentId, equipment.id))
      .where(inArray(reservationEquipment.reservationId, reservationIds)),
  )

  for (const row of rows) {
    const list = byReservationId.get(row.reservationId) ?? []
    list.push({ id: row.id, name: row.name, description: row.description, createdAt: row.createdAt })
    byReservationId.set(row.reservationId, list)
  }

  return byReservationId
}

export async function listVisibleReservations(input: {
  session: SessionUser
  userId?: string | null
  tableId?: string | null
  date?: string | null
}) {
  // Admin client required: Neon has no RLS. Member isolation is enforced by
  // deriving effectiveUserId from session.id for non-admin callers (see line
  // below), ensuring members can only query their own reservations.
  const db = getDrizzleAdminDb()
  const effectiveUserId = input.session.role === 'admin' ? input.userId ?? undefined : input.session.id
  const effectiveDate = input.date != null && input.date !== '' ? parseDate(input.date) : undefined

  const conditions = []
  if (effectiveUserId) {
    conditions.push(eq(reservations.userId, effectiveUserId))
  }
  if (input.tableId) {
    conditions.push(eq(reservations.tableId, input.tableId))
  }
  if (effectiveDate) {
    conditions.push(eq(reservations.date, effectiveDate))
  }

  const joinedRows = await runQuery(
    db
      .select({
        id: reservations.id,
        tableId: reservations.tableId,
        userId: reservations.userId,
        date: reservations.date,
        startTime: reservations.startTime,
        endTime: reservations.endTime,
        status: reservations.status,
        surface: reservations.surface,
        activatedAt: reservations.activatedAt,
        createdAt: reservations.createdAt,
        memberNumber: profiles.memberNumber,
        tableName: tables.name,
        roomName: rooms.name,
      })
      .from(reservations)
      .innerJoin(profiles, eq(reservations.userId, profiles.id))
      .innerJoin(tables, eq(reservations.tableId, tables.id))
      .innerJoin(rooms, eq(tables.roomId, rooms.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(reservations.date), asc(reservations.startTime)),
  )

  const equipmentByReservationId = await fetchEquipmentByReservationIds(joinedRows.map((row) => row.id))
  const enrichedRows: EnrichedReservationRow[] = joinedRows.map((row) => ({
    ...row,
    equipment: equipmentByReservationId.get(row.id) ?? [],
  }))

  // Defense-in-depth: verify the query filter held before mapping rows out.
  // `assertMemberRowsScoped()` requires a `user_id` (snake_case) field; the
  // Drizzle row uses `userId` (camelCase), so it's bridged here rather than
  // changing the shared helper's contract (also used by other services).
  const rawRows = assertMemberRowsScoped(
    enrichedRows.map((row) => ({ ...row, user_id: row.userId })),
    input.session,
  )

  const isAdmin = input.session.role === 'admin'
  const nowUtc = await getDatabaseNow(db)

  return rawRows
    .filter((row) => {
      // Lazy evaluation: treat expired pending reservations as cancelled
      if (row.status === 'pending' && row.activatedAt === null) {
        if (isPendingReservationExpired(toPendingSlot(row), nowUtc)) {
          return false // Exclude expired pending reservations
        }
      }
      return true
    })
    .map((row) => {
      const reservation = mapEnrichedReservation(row)
      if (!isAdmin) {
        reservation.memberNumber = undefined
      }
      return reservation
    })
}

export async function listAvailableEquipmentForReservation(input: {
  roomId: string
  date?: string | null
  startTime?: string | null
  endTime?: string | null
}) {
  const date = parseDate(requireString(input.date))
  const startTime = parseHHMM(requireString(input.startTime))
  const endTime = parseHHMM(requireString(input.endTime), { allow24HourBoundary: true })

  if (startTime >= endTime) {
    serviceError('Invalid reservation time range', 400)
  }

  const reservableEquipment = await listReservableEquipment({ roomId: input.roomId, date, startTime, endTime })

  return reservableEquipment.map<AvailableEquipment>((item) => ({
    ...toEquipment(item),
    available: item.available,
    conflictReason: item.available ? null : 'EQUIPMENT_ALREADY_RESERVED',
  }))
}

async function checkUserSlotOverlap(
  userId: string,
  date: string,
  startTime: string,
  endTime: string,
  db: DbClient,
  ignoreReservationId?: string,
) {
  const conditions = [
    eq(reservations.userId, userId),
    eq(reservations.date, date),
    inArray(reservations.status, ['pending', 'active']),
    lt(reservations.startTime, endTime),
    gt(reservations.endTime, startTime),
  ]
  if (ignoreReservationId) {
    conditions.push(ne(reservations.id, ignoreReservationId))
  }

  const rows = await runQuery(db.select().from(reservations).where(and(...conditions)))

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow(db)
  const activeReservations = rows.filter((row) => {
    if (row.status === 'pending' && row.activatedAt === null) {
      return !isPendingReservationExpired(toPendingSlot(row), nowUtc)
    }
    return true
  })

  if (activeReservations.length > 0) {
    serviceError(ERROR_CODES.USER_ALREADY_HAS_RESERVATION_IN_SLOT, 409)
  }
}

export async function createReservationForSession(
  session: SessionUser,
  body: { tableId?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown; surface?: unknown; equipmentIds?: unknown },
) {
  const tableId = requireString(body.tableId)
  const rawDate = requireString(body.date)
  const rawStartTime = requireString(body.startTime)
  const rawEndTime = requireString(body.endTime)
  const surface = parseSurface(body.surface)
  const equipmentIds = Array.isArray(body.equipmentIds)
    ? [...new Set(body.equipmentIds.map((value) => String(value)).filter(Boolean))]
    : []

  if (!tableId || !rawDate || !rawStartTime || !rawEndTime) {
    serviceError('tableId, date, startTime and endTime are required', 400)
  }

  const date = parseDate(rawDate)
  const startTime = parseHHMM(rawStartTime)
  const endTime = parseHHMM(rawEndTime, { allow24HourBoundary: true })

  const table = await getTable(tableId)
  if (!table) {
    serviceError('Table not found', 404)
  }
  if (table.type === 'removable_top' && !surface) {
    serviceError('Surface is required for removable top tables', 400)
  }
  if (startTime >= endTime) {
    serviceError('Invalid reservation time range', 400)
  }

  assertReservationNotInPast(date, startTime)
  assertReservationWithinBookingWindow(date)

  const db = getDrizzleDb()

  await expireStalePendingReservations(tableId, date)
  await checkUserSlotOverlap(session.id, date, startTime, endTime, db)

  const conflictingReservations = await listActiveReservationsForConflict({ tableId, date })
  if (hasReservationConflict(conflictingReservations, { startTime, endTime, surface })) {
    throwSlotTaken()
  }
  if (await hasEventBlockConflict({ roomId: table.roomId, tableId, date, startTime, endTime })) {
    serviceError(ERROR_CODES.ROOM_BLOCKED_BY_EVENT, 409)
  }
  if (await hasSavedGameBottomConflict({ tableId, date, surface })) {
    serviceError(ERROR_CODES.SAVED_GAME_BOTTOM_RESERVED, 409)
  }
  await assertEquipmentSelectionAllowed({
    roomId: table.roomId,
    equipmentIds,
    date,
    startTime,
    endTime,
  })

  let insertedRow: ReservationRow | undefined
  try {
    ;[insertedRow] = await db
      .insert(reservations)
      .values({
        tableId,
        userId: session.id,
        date,
        startTime,
        endTime,
        surface: surface ?? null,
      })
      .returning()
  } catch (err) {
    if (isConflictError(err)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }

  if (!insertedRow) {
    serviceError('Internal server error', 500)
  }

  try {
    await saveReservationEquipment(insertedRow.id, equipmentIds)
  } catch {
    // Compensating delete: remove the just-created reservation to avoid a ghost
    // row with no equipment association. Ignore errors from the delete itself —
    // the original equipment error is what the caller needs to act on.
    try {
      const adminDb = getDrizzleAdminDb()
      await adminDb.delete(reservations).where(eq(reservations.id, insertedRow.id))
    } catch {
      // Intentionally ignored — see comment above.
    }
    serviceError('Failed to save equipment. Reservation was cancelled. Please try again.', 500)
  }

  const selectedEquipment = equipmentIds.length > 0
    ? (await listAllEquipment()).filter((item) => equipmentIds.includes(item.id)).map(toEquipment)
    : []

  return {
    ...mapReservation(insertedRow),
    equipment: selectedEquipment,
  }
}

export async function checkReservationAccess(session: SessionUser, reservationId: string) {
  assertReservationAccess(session, await getReservationForAccess(reservationId))
}

export async function updateReservationForSession(
  session: SessionUser,
  reservationId: string,
  body: { status?: unknown; date?: unknown; startTime?: unknown; endTime?: unknown; surface?: unknown },
) {
  const existingReservation = await getReservationForAccess(reservationId)
  assertReservationAccess(session, existingReservation)

  const nextStatus = body.status
  if (nextStatus != null && !['active', 'cancelled', 'completed', 'pending', 'no_show'].includes(String(nextStatus))) {
    serviceError('Invalid reservation status', 400)
  }
  if (nextStatus === 'active' && session.role !== 'admin') {
    serviceError(ERROR_CODES.STATUS_TRANSITION_FORBIDDEN, 403)
  }
  if ((nextStatus === 'completed' || nextStatus === 'no_show') && session.role !== 'admin') {
    serviceError('Only admins can mark a reservation as completed or no_show', 403)
  }

  if (nextStatus === 'cancelled' && session.role !== 'admin' && existingReservation.status !== 'cancelled') {
    const reservationStart = zonedDateTimeToUtc(
      existingReservation.date,
      normalizeTime(existingReservation.startTime),
    )
    if (isNaN(reservationStart.getTime())) {
      serviceError('Invalid reservation time format', 500)
    }
    const now = new Date()
    if (reservationStart.getTime() - now.getTime() < CANCELLATION_CUTOFF_MS) {
      serviceError(ERROR_CODES.CANCELLATION_CUTOFF, 403)
    }
  }

  const nextStartTime = body.startTime == null
    ? normalizeTime(existingReservation.startTime)
    : parseHHMM(String(body.startTime))
  const nextEndTime = body.endTime == null
    ? normalizeTime(existingReservation.endTime)
    : parseHHMM(String(body.endTime), { allow24HourBoundary: true })
  const nextDate = body.date == null ? existingReservation.date : parseDate(String(body.date))
  const nextSurface = body.surface === undefined || body.surface === null
    ? (existingReservation.surface ?? null)
    : (parseSurface(body.surface) ?? (existingReservation.surface ?? null))
  const table = await getTable(existingReservation.tableId)

  if (!table) {
    serviceError('Table not found', 404)
  }

  if (nextStartTime >= nextEndTime) {
    serviceError('Invalid reservation time range', 400)
  }

  const isScheduleChange = body.date != null || body.startTime != null || body.endTime != null
  const needsUserOverlapCheck = isScheduleChange || nextStatus === 'active'
  if (isScheduleChange) {
    assertReservationNotInPast(nextDate, nextStartTime)
    assertReservationWithinBookingWindow(nextDate)
  }

  await expireStalePendingReservations(existingReservation.tableId, nextDate)
  const conflictingReservations = await listActiveReservationsForConflict({
    tableId: existingReservation.tableId,
    date: nextDate,
    ignoreReservationId: existingReservation.id,
  })
  if (hasReservationConflict(conflictingReservations, {
    startTime: nextStartTime,
    endTime: nextEndTime,
    surface: nextSurface ?? undefined,
  })) {
    throwSlotTaken()
  }
  if (await hasEventBlockConflict({
    roomId: table.roomId,
    tableId: existingReservation.tableId,
    date: nextDate,
    startTime: nextStartTime,
    endTime: nextEndTime,
  })) {
    serviceError(ERROR_CODES.ROOM_BLOCKED_BY_EVENT, 409)
  }
  if (await hasSavedGameBottomConflict({
    tableId: existingReservation.tableId,
    date: nextDate,
    surface: nextSurface ?? undefined,
  })) {
    serviceError(ERROR_CODES.SAVED_GAME_BOTTOM_RESERVED, 409)
  }

  const db = getDrizzleDb()
  if (needsUserOverlapCheck) {
    await checkUserSlotOverlap(
      existingReservation.userId,
      nextDate,
      nextStartTime,
      nextEndTime,
      db,
      existingReservation.id,
    )
  }
  const existingEquipmentIds = await getReservationEquipmentIds(existingReservation.id)
  if (isScheduleChange && existingEquipmentIds.length > 0) {
    await assertEquipmentSelectionAllowed({
      roomId: table.roomId,
      equipmentIds: existingEquipmentIds,
      date: nextDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
      ignoreReservationId: existingReservation.id,
    })
  }

  let updatedRow: ReservationRow | undefined
  try {
    ;[updatedRow] = await db
      .update(reservations)
      .set({
        date: nextDate,
        startTime: nextStartTime,
        endTime: nextEndTime,
        surface: nextSurface,
        status: nextStatus == null ? existingReservation.status : (String(nextStatus) as ReservationRow['status']),
      })
      .where(eq(reservations.id, reservationId))
      .returning()
  } catch (err) {
    if (isConflictError(err)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }

  if (!updatedRow) {
    serviceError('Internal server error', 500)
  }

  return mapReservation(updatedRow)
}

/**
 * Sweeps stale pending reservations to `no_show`. Previously the
 * `mark_no_show_reservations` Postgres function (plpgsql, SECURITY DEFINER)
 * called via Supabase RPC — that function has no Drizzle schema-builder
 * equivalent (no RPC/stored-procedure support), so its logic is replicated
 * here as a raw parameterized `db.execute(sql\`...\`)` UPDATE instead. See
 * supabase/migrations/20260619000002_kim392_slot_relative_pending_expiry.sql
 * for the original function body this mirrors.
 */
export async function markNoShowReservations(): Promise<number> {
  const db = getDrizzleAdminDb()
  const result = await runQuery(
    db.execute(sql`
      UPDATE reservations
      SET status = 'no_show'
      WHERE status = 'pending'
        AND activated_at IS NULL
        AND LEAST(
              ((date::timestamp + start_time::time) AT TIME ZONE ${CLUB_TIMEZONE}) + (interval '1 minute' * ${CHECK_IN_LATE_MINUTES}),
              ((date::timestamp + end_time::time) AT TIME ZONE ${CLUB_TIMEZONE})
            ) < now()
    `),
  )

  return result.rowCount ?? 0
}

export async function activateReservationByTable(
  tableId: string,
  userId: string,
  side?: 'inf',
): Promise<Reservation> {
  // Anchor "today" in the club's local timezone so near-midnight requests on
  // DST transition days resolve to the correct calendar date.
  const today = getCurrentClubDate()

  // Look up the table via the session-scoped client to decide whether to apply
  // a surface filter. removable_top tables store surface='top'/'bottom'; all
  // other types store null — filtering by surface for those would always fail.
  const table = await getTable(tableId)
  if (!table) {
    serviceError('Table not found', 404)
  }
  const db = getDrizzleAdminDb()

  const pendingConditions = [
    eq(reservations.tableId, tableId),
    eq(reservations.date, today),
    eq(reservations.userId, userId),
    eq(reservations.status, 'pending'),
  ]
  if (side === 'inf') {
    pendingConditions.push(eq(reservations.surface, 'bottom'))
  }

  const [pendingRow] = await runQuery(db.select().from(reservations).where(and(...pendingConditions)))

  if (!pendingRow) {
    const activeConditions = [
      eq(reservations.tableId, tableId),
      eq(reservations.date, today),
      eq(reservations.userId, userId),
      eq(reservations.status, 'active'),
    ]
    if (side === 'inf') {
      activeConditions.push(eq(reservations.surface, 'bottom'))
    }

    const [activeRow] = await runQuery(db.select().from(reservations).where(and(...activeConditions)))

    if (activeRow) {
      serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
    }

    serviceError(ERROR_CODES.CHECK_IN_NO_RESERVATION, 404)
  }

  const reservation = pendingRow

  if (!reservation.endTime) {
    serviceError('Invalid reservation data', 500)
  }

  const nowUtc = await getDatabaseNow(db)
  const reservationStart = zonedDateTimeToUtc(reservation.date, normalizeTime(reservation.startTime))
  const reservationEnd = zonedDateTimeToUtc(reservation.date, normalizeTime(reservation.endTime))

  if (reservationEnd <= reservationStart) {
    serviceError('Invalid reservation data', 500)
  }

  // Allow check-in starting CHECK_IN_EARLY_MINUTES before the slot begins,
  // up to CHECK_IN_LATE_MINUTES after start (capped at reservation end).
  const windowStart = new Date(reservationStart.getTime() - CHECK_IN_EARLY_MINUTES * 60 * 1000)
  const windowEnd = getPendingCheckInDeadline(toPendingSlot(reservation))

  if (nowUtc < windowStart) {
    serviceError(ERROR_CODES.CHECK_IN_TOO_EARLY, 400)
  }
  if (nowUtc > windowEnd) {
    serviceError(ERROR_CODES.CHECK_IN_TOO_LATE, 400)
  }

  // Zero rows returned (rather than an error) means the reservation was
  // already activated by a concurrent request (TOCTOU race) between our read
  // and this UPDATE — handled the same way as "not found" below (409).
  //
  // The status UPDATE and the saved-game attendance recording below run
  // inside a single transaction so they commit or roll back together —
  // together they reimplement the dropped
  // `record_saved_game_attendance_after_activation` trigger (AFTER UPDATE OF
  // status ON reservations), which used to record check-in attendance
  // against an active saved_game in the same transaction as this activation
  // UPDATE. Running them as two separate `db.transaction()` calls would let
  // the activation commit while the attendance write failed, silently
  // diverging from the old trigger-based behavior (activated reservation,
  // missed attendance count). `recordSavedGameAttendance()` is passed this
  // transaction's `tx` handle (same pattern as `assertTableAndEventAvailability`
  // in saved-games-service.ts) so its writes participate in it rather than
  // opening a second, independent transaction.
  const updated = await db.transaction(async (tx) => {
    const [row] = await runQuery(
      tx
        .update(reservations)
        .set({ status: 'active', activatedAt: nowUtc })
        .where(and(eq(reservations.id, reservation.id), eq(reservations.status, 'pending')))
        .returning(),
    )

    if (!row) {
      serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
    }

    await recordSavedGameAttendance(tx, toAttendanceReservation(row))

    return row
  })

  return mapReservation(updated)
}
