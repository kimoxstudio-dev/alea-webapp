import type { AvailableEquipment, Equipment, Reservation, TableSurface } from '@/lib/types'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { SessionUser } from '@/lib/server/auth'
import { getCurrentClubDate, isValidDateOnlyString, zonedDateTimeToUtc } from '@/lib/club-time'
import { getDatabaseNow } from '@/lib/server/database-time'
import { serviceError } from '@/lib/server/service-error'
import { assertMemberRowsScoped } from '@/lib/server/data-scoping'
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import type { Tables } from '@/lib/supabase/types'
import { normalizeTime } from '@/lib/server/availability'
import {
  CHECK_IN_LATE_MINUTES,
  getPendingCheckInDeadline,
  isPendingReservationExpired,
} from '@/lib/server/pending-reservation-expiry'

type ReservationRow = Tables<'reservations'>
type TableRow = Tables<'tables'>
type EquipmentRow = Tables<'equipment'>
type ReservationListRow = ReservationRow & {
  member_number: string | null
  table_name: string | null
  room_name: string | null
}

/** @deprecated Pending expiry is slot-relative; retained for compatibility. */
export const GRACE_PERIOD_MINUTES = CHECK_IN_LATE_MINUTES
// How many minutes before the reservation start time check-in is allowed.
export const CHECK_IN_EARLY_MINUTES = 5
// How many minutes after the reservation start time check-in is still allowed.
export { CHECK_IN_LATE_MINUTES }
export const BOOKING_WINDOW_DAYS = 7
const CANCELLATION_CUTOFF_MS = 60 * 60 * 1000 // 60 minutes

const RESERVATION_COLUMNS = 'id, table_id, user_id, date, start_time, end_time, status, surface, activated_at, created_at'

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
    createdAt: row.created_at,
  }
}

function mapReservation(row: ReservationRow): Reservation {
  return {
    id: row.id,
    tableId: row.table_id,
    userId: row.user_id,
    date: row.date,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    status: row.status,
    surface: row.surface,
    activatedAt: row.activated_at ?? null,
    createdAt: row.created_at,
    equipment: [],
  }
}

function mapReservationListRow(row: ReservationListRow, equipment: Equipment[]): Reservation {
  return {
    id: row.id,
    tableId: row.table_id,
    userId: row.user_id,
    date: row.date,
    startTime: normalizeTime(row.start_time),
    endTime: normalizeTime(row.end_time),
    status: row.status,
    surface: row.surface,
    activatedAt: row.activated_at ?? null,
    createdAt: row.created_at,
    memberNumber: row.member_number,
    roomName: row.room_name,
    tableName: row.table_name,
    equipment,
  }
}

async function getTable(tableId: string) {
  let rows: TableRow[]
  try {
    rows = await sql`
      SELECT id, type, room_id
      FROM tables
      WHERE id = ${tableId}
      LIMIT 1
    ` as TableRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return rows[0] ?? null
}

async function hasEventBlockConflict(input: {
  roomId: string
  tableId: string
  date: string
  startTime: string
  endTime: string
}) {
  let rows: Array<{ id: string; table_id: string | null }>
  try {
    rows = await sql`
      SELECT id, table_id
      FROM event_room_blocks
      WHERE room_id = ${input.roomId}
        AND date = ${input.date}
        AND start_time < ${input.endTime}
        AND end_time > ${input.startTime}
    ` as Array<{ id: string; table_id: string | null }>
  } catch {
    serviceError('Internal server error', 500)
  }

  // OIR-208: a block with a table_id only conflicts with that single table;
  // NULL (the pre-OIR-208 default) conflicts with every table of the room.
  return rows.some(
    (block) => block.table_id == null || block.table_id === input.tableId,
  )
}

async function hasSavedGameBottomConflict(input: {
  tableId: string
  date: string
  surface?: TableSurface
}) {
  if (input.surface !== 'bottom') return false
  let rows: Array<{ id: string }>
  try {
    rows = await sql`
      SELECT id
      FROM saved_games
      WHERE table_id = ${input.tableId}
        AND status = 'active'
        AND start_date <= ${input.date}
        AND end_date >= ${input.date}
      LIMIT 1
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows.length > 0
}

async function getReservationForAccess(reservationId: string) {
  let rows: ReservationRow[]
  try {
    rows = await sql`
      SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
      FROM reservations
      WHERE id = ${reservationId}
      LIMIT 1
    ` as ReservationRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows[0] ?? null
}

async function listActiveReservationsForConflict(input: {
  tableId: string
  date: string
  ignoreReservationId?: string
}) {
  let rows: ReservationRow[]
  try {
    rows = await sql`
      SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
      FROM reservations
      WHERE table_id = ${input.tableId}
        AND date = ${input.date}
        AND status IN ('active', 'pending')
        AND (${input.ignoreReservationId ?? null}::uuid IS NULL OR id <> ${input.ignoreReservationId ?? null}::uuid)
    ` as ReservationRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow()
  return rows.filter((row) => {
    if (row.status === 'pending' && row.activated_at === null) {
      return !isPendingReservationExpired(row, nowUtc)
    }
    return true // Keep active reservations
  }) as ReservationRow[]
}

async function expireStalePendingReservations(tableId: string, date: string) {
  const nowUtc = await getDatabaseNow()
  let rows: ReservationRow[]
  try {
    rows = await sql`
      SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
      FROM reservations
      WHERE status = 'pending'
        AND table_id = ${tableId}
        AND date = ${date}
        AND activated_at IS NULL
    ` as ReservationRow[]
  } catch (error) {
    console.error('expireStalePendingReservations failed (non-fatal):', error)
    return
  }

  const expiredIds = rows
    .filter((row) => isPendingReservationExpired(row, nowUtc))
    .map((row) => row.id)

  if (expiredIds.length === 0) {
    return
  }

  try {
    await sql`
      UPDATE reservations
      SET status = 'cancelled'
      WHERE id = ANY(${expiredIds}::uuid[])
        AND status = 'pending'
        AND activated_at IS NULL
    `
  } catch (error) {
    console.error('expireStalePendingReservations failed (non-fatal):', error)
  }
}

async function listOverlappingReservationIds(input: {
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  const pageSize = 1000
  const reservationIds: string[] = []
  let from = 0

  // Capture DB time once before the pagination loop to avoid one query per page.
  const nowUtc = await getDatabaseNow()

  // Get full rows to enable lazy evaluation filtering
  while (true) {
    let rows: ReservationRow[]
    try {
      rows = await sql`
        SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
        FROM reservations
        WHERE date = ${input.date}
          AND status IN ('pending', 'active')
          AND start_time < ${input.endTime}
          AND end_time > ${input.startTime}
          AND (${input.ignoreReservationId ?? null}::uuid IS NULL OR id <> ${input.ignoreReservationId ?? null}::uuid)
        ORDER BY id ASC
        LIMIT ${pageSize}
        OFFSET ${from}
      ` as ReservationRow[]
    } catch {
      serviceError('Internal server error', 500)
    }

    // Lazy evaluation: filter out expired pending reservations
    const filteredRows = rows.filter((row) => {
      if (row.status === 'pending' && row.activated_at === null) {
        return !isPendingReservationExpired(row, nowUtc)
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
  let rows: EquipmentRow[]
  try {
    rows = await sql`
      SELECT equipment.id, equipment.name, equipment.description, equipment.created_at
      FROM room_default_equipment
      INNER JOIN equipment ON equipment.id = room_default_equipment.equipment_id
      WHERE room_default_equipment.room_id = ${roomId}
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows
}

async function listAllEquipment() {
  let rows: EquipmentRow[]
  try {
    rows = await sql`
      SELECT id, name, description, created_at
      FROM equipment
      ORDER BY name ASC
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows
}

async function listEquipmentLockedToOtherRooms(roomId: string): Promise<Set<string>> {
  let rows: Array<{ equipment_id: string; room_id: string }>
  try {
    rows = await sql`
      SELECT equipment_id, room_id
      FROM room_default_equipment
      WHERE room_id <> ${roomId}
    ` as Array<{ equipment_id: string; room_id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const lockedToOther = new Set<string>()
  for (const row of rows) {
    lockedToOther.add(row.equipment_id)
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

  let rows: Array<{ equipment_id: string }>
  try {
    rows = await sql`
      SELECT equipment_id
      FROM reservation_equipment
      WHERE reservation_id = ANY(${overlappingReservationIds}::uuid[])
        AND equipment_id = ANY(${input.equipmentIds}::uuid[])
    ` as Array<{ equipment_id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }
  return new Set(rows.map((row) => row.equipment_id))
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
  try {
    await sql`DELETE FROM reservation_equipment WHERE reservation_id = ${reservationId}`
  } catch {
    serviceError('Internal server error', 500)
  }

  if (equipmentIds.length === 0) {
    return
  }

  try {
    await sql`
      INSERT INTO reservation_equipment (reservation_id, equipment_id)
      SELECT ${reservationId}::uuid, UNNEST(${equipmentIds}::uuid[])
    `
  } catch {
    serviceError('Internal server error', 500)
  }
}

async function getReservationEquipmentIds(reservationId: string) {
  let rows: Array<{ equipment_id: string }>
  try {
    rows = await sql`
      SELECT equipment_id
      FROM reservation_equipment
      WHERE reservation_id = ${reservationId}
    ` as Array<{ equipment_id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows.map((row) => row.equipment_id)
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

    const reservationStart = normalizeTime(reservation.start_time)
    const reservationEnd = normalizeTime(reservation.end_time)
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
  if (session.role !== 'admin' && reservation.user_id !== session.id) {
    serviceError('Forbidden', 403)
  }
}

function isConflictError(error: unknown) {
  return error instanceof NeonDbError && error.code === '23P01'
}

function throwSlotTaken(): never {
  serviceError(ERROR_CODES.SLOT_TAKEN, 409)
}

export async function listVisibleReservations(input: {
  session: SessionUser
  userId?: string | null
  tableId?: string | null
  date?: string | null
}) {
  const effectiveUserId = input.session.role === 'admin' ? input.userId || undefined : input.session.id
  const effectiveTableId = input.tableId || undefined
  const effectiveDate = input.date != null && input.date !== '' ? parseDate(input.date) : undefined

  let rows: ReservationListRow[]
  try {
    rows = await sql`
      SELECT r.id, r.table_id, r.user_id, r.date, r.start_time, r.end_time, r.status, r.surface, r.activated_at, r.created_at,
        p.member_number, t.name AS table_name, rooms.name AS room_name
      FROM reservations r
      LEFT JOIN profiles p ON p.id = r.user_id
      LEFT JOIN tables t ON t.id = r.table_id
      LEFT JOIN rooms ON rooms.id = t.room_id
      WHERE (${effectiveUserId ?? null}::uuid IS NULL OR r.user_id = ${effectiveUserId ?? null}::uuid)
        AND (${effectiveTableId ?? null}::uuid IS NULL OR r.table_id = ${effectiveTableId ?? null}::uuid)
        AND (${effectiveDate ?? null}::date IS NULL OR r.date = ${effectiveDate ?? null}::date)
      ORDER BY r.date ASC, r.start_time ASC, r.id ASC
    ` as ReservationListRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  // Defense-in-depth: verify the query filter held before mapping rows out.
  const rawRows = assertMemberRowsScoped(
    rows,
    input.session,
  )

  const reservationIds = rawRows.map((row) => row.id)
  let equipmentRows: Array<{ reservation_id: string } & EquipmentRow> = []
  if (reservationIds.length > 0) {
    try {
      equipmentRows = await sql`
        SELECT re.reservation_id, e.id, e.name, e.description, e.created_at
        FROM reservation_equipment re
        INNER JOIN equipment e ON e.id = re.equipment_id
        WHERE re.reservation_id = ANY(${reservationIds}::uuid[])
        ORDER BY re.reservation_id ASC, e.name ASC
      ` as Array<{ reservation_id: string } & EquipmentRow>
    } catch {
      serviceError('Internal server error', 500)
    }
  }
  const equipmentByReservation = new Map<string, Equipment[]>()
  for (const row of equipmentRows) {
    const equipment = equipmentByReservation.get(row.reservation_id) ?? []
    equipment.push(toEquipment(row))
    equipmentByReservation.set(row.reservation_id, equipment)
  }

  const isAdmin = input.session.role === 'admin'
  const nowUtc = await getDatabaseNow()

  return rawRows
    .filter((row) => {
      // Lazy evaluation: treat expired pending reservations as cancelled
      if (row.status === 'pending' && row.activated_at === null) {
        if (isPendingReservationExpired(row, nowUtc)) {
          return false // Exclude expired pending reservations
        }
      }
      return true
    })
    .map((row) => {
      const reservation = mapReservationListRow(row, equipmentByReservation.get(row.id) ?? [])
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
  ignoreReservationId?: string,
) {
  let rows: ReservationRow[]
  try {
    rows = await sql`
      SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
      FROM reservations
      WHERE user_id = ${userId}
        AND date = ${date}
        AND status IN ('pending', 'active')
        AND start_time < ${endTime}
        AND end_time > ${startTime}
        AND (${ignoreReservationId ?? null}::uuid IS NULL OR id <> ${ignoreReservationId ?? null}::uuid)
    ` as ReservationRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow()
  const activeReservations = rows.filter((row) => {
    if (row.status === 'pending' && row.activated_at === null) {
      return !isPendingReservationExpired(row, nowUtc)
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

  await expireStalePendingReservations(tableId, date)
  await checkUserSlotOverlap(session.id, date, startTime, endTime)

  const conflictingReservations = await listActiveReservationsForConflict({ tableId, date })
  if (hasReservationConflict(conflictingReservations, { startTime, endTime, surface })) {
    throwSlotTaken()
  }
  if (await hasEventBlockConflict({ roomId: table.room_id, tableId, date, startTime, endTime })) {
    serviceError(ERROR_CODES.ROOM_BLOCKED_BY_EVENT, 409)
  }
  if (await hasSavedGameBottomConflict({ tableId, date, surface })) {
    serviceError(ERROR_CODES.SAVED_GAME_BOTTOM_RESERVED, 409)
  }
  await assertEquipmentSelectionAllowed({
    roomId: table.room_id,
    equipmentIds,
    date,
    startTime,
    endTime,
  })
  let rows: ReservationRow[]
  try {
    rows = await sql`
      INSERT INTO reservations (table_id, user_id, date, start_time, end_time, surface)
      VALUES (${tableId}, ${session.id}, ${date}, ${startTime}, ${endTime}, ${surface ?? null})
      RETURNING ${sql.unsafe(RESERVATION_COLUMNS)}
    ` as ReservationRow[]
  } catch (error) {
    if (isConflictError(error)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }
  const data = rows[0]
  if (!data) serviceError('Internal server error', 500)

  try {
    await saveReservationEquipment(data.id, equipmentIds)
  } catch {
    // Compensating delete: remove the just-created reservation to avoid a ghost
    // row with no equipment association. Ignore errors from the delete itself —
    // the original equipment error is what the caller needs to act on.
    try {
      await sql`DELETE FROM reservations WHERE id = ${data.id}`
    } catch (deleteError) {
      console.error('createReservationForSession: compensating delete failed (non-fatal):', deleteError)
    }
    serviceError('Failed to save equipment. Reservation was cancelled. Please try again.', 500)
  }

  const selectedEquipment = equipmentIds.length > 0
    ? (await listAllEquipment()).filter((item) => equipmentIds.includes(item.id)).map(toEquipment)
    : []

  return {
    ...mapReservation(data as ReservationRow),
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
      normalizeTime(existingReservation.start_time),
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
    ? normalizeTime(existingReservation.start_time)
    : parseHHMM(String(body.startTime))
  const nextEndTime = body.endTime == null
    ? normalizeTime(existingReservation.end_time)
    : parseHHMM(String(body.endTime), { allow24HourBoundary: true })
  const nextDate = body.date == null ? existingReservation.date : parseDate(String(body.date))
  const nextSurface = body.surface === undefined || body.surface === null
    ? (existingReservation.surface ?? null)
    : (parseSurface(body.surface) ?? (existingReservation.surface ?? null))
  const table = await getTable(existingReservation.table_id)

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

  await expireStalePendingReservations(existingReservation.table_id, nextDate)
  const conflictingReservations = await listActiveReservationsForConflict({
    tableId: existingReservation.table_id,
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
    roomId: table.room_id,
    tableId: existingReservation.table_id,
    date: nextDate,
    startTime: nextStartTime,
    endTime: nextEndTime,
  })) {
    serviceError(ERROR_CODES.ROOM_BLOCKED_BY_EVENT, 409)
  }
  if (await hasSavedGameBottomConflict({
    tableId: existingReservation.table_id,
    date: nextDate,
    surface: nextSurface ?? undefined,
  })) {
    serviceError(ERROR_CODES.SAVED_GAME_BOTTOM_RESERVED, 409)
  }

  if (needsUserOverlapCheck) {
    await checkUserSlotOverlap(
      existingReservation.user_id,
      nextDate,
      nextStartTime,
      nextEndTime,
      existingReservation.id,
    )
  }
  const existingEquipmentIds = await getReservationEquipmentIds(existingReservation.id)
  if (isScheduleChange && existingEquipmentIds.length > 0) {
    await assertEquipmentSelectionAllowed({
      roomId: table.room_id,
      equipmentIds: existingEquipmentIds,
      date: nextDate,
      startTime: nextStartTime,
      endTime: nextEndTime,
      ignoreReservationId: existingReservation.id,
    })
  }
  const status = nextStatus == null ? existingReservation.status : String(nextStatus) as ReservationRow['status']
  let rows: ReservationRow[]
  try {
    rows = await sql`
      UPDATE reservations
      SET date = ${nextDate}, start_time = ${nextStartTime}, end_time = ${nextEndTime}, surface = ${nextSurface}, status = ${status}
      WHERE id = ${reservationId}
        AND (${session.role === 'admin'} OR user_id = ${session.id})
      RETURNING ${sql.unsafe(RESERVATION_COLUMNS)}
    ` as ReservationRow[]
  } catch (error) {
    if (isConflictError(error)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }

  if (!rows[0]) serviceError('Reservation not found', 404)
  return mapReservation(rows[0])
}

export async function activateReservationByTable(
  tableId: string,
  userId: string,
  side?: 'inf',
): Promise<Reservation> {
  // Anchor "today" in the club's local timezone so near-midnight requests on
  // DST transition days resolve to the correct calendar date.
  const today = getCurrentClubDate()

  const table = await getTable(tableId)
  if (!table) {
    serviceError('Table not found', 404)
  }
  const requiresBottomSurface = side === 'inf'
  let pendingRows: ReservationRow[]
  try {
    pendingRows = await sql`
      SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
      FROM reservations
      WHERE table_id = ${tableId}
        AND date = ${today}
        AND user_id = ${userId}
        AND status = 'pending'
        AND (${requiresBottomSurface} = false OR surface = 'bottom')
      LIMIT 1
    ` as ReservationRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  if (!pendingRows[0]) {
    let activeRows: ReservationRow[]
    try {
      activeRows = await sql`
        SELECT ${sql.unsafe(RESERVATION_COLUMNS)}
        FROM reservations
        WHERE table_id = ${tableId}
          AND date = ${today}
          AND user_id = ${userId}
          AND status = 'active'
          AND (${requiresBottomSurface} = false OR surface = 'bottom')
        LIMIT 1
      ` as ReservationRow[]
    } catch {
      serviceError('Internal server error', 500)
    }

    if (activeRows[0]) {
      serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
    }

    serviceError(ERROR_CODES.CHECK_IN_NO_RESERVATION, 404)
  }

  const reservation = pendingRows[0]

  if (!reservation.end_time) {
    serviceError('Invalid reservation data', 500)
  }

  const nowUtc = await getDatabaseNow()
  const reservationStart = zonedDateTimeToUtc(reservation.date, normalizeTime(reservation.start_time))
  const reservationEnd = zonedDateTimeToUtc(reservation.date, normalizeTime(reservation.end_time))

  if (reservationEnd <= reservationStart) {
    serviceError('Invalid reservation data', 500)
  }

  // Allow check-in starting CHECK_IN_EARLY_MINUTES before the slot begins,
  // up to CHECK_IN_LATE_MINUTES after start (capped at reservation end).
  const windowStart = new Date(reservationStart.getTime() - CHECK_IN_EARLY_MINUTES * 60 * 1000)
  const windowEnd = getPendingCheckInDeadline(reservation)

  if (nowUtc < windowStart) {
    serviceError(ERROR_CODES.CHECK_IN_TOO_EARLY, 400)
  }
  if (nowUtc > windowEnd) {
    serviceError(ERROR_CODES.CHECK_IN_TOO_LATE, 400)
  }

  let updatedRows: ReservationRow[]
  try {
    updatedRows = await sql`
      UPDATE reservations
      SET status = 'active', activated_at = ${nowUtc.toISOString()}
      WHERE id = ${reservation.id} AND status = 'pending'
      RETURNING ${sql.unsafe(RESERVATION_COLUMNS)}
    ` as ReservationRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  if (!updatedRows[0]) {
    serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
  }

  return mapReservation(updatedRows[0])
}
