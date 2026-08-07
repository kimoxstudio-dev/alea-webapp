import type { AvailableEquipment, Equipment, Reservation, TableSurface } from '@/lib/types'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { SessionUser } from '@/lib/server/auth'
import { getCurrentClubDate, isValidDateOnlyString, zonedDateTimeToUtc } from '@/lib/club-time'
import { getDatabaseNow } from '@/lib/server/database-time'
import { serviceError } from '@/lib/server/service-error'
import { assertMemberRowsScoped } from '@/lib/server/data-scoping'
import { createSupabaseServerAdminClient, createSupabaseServerClient } from '@/lib/supabase/server'
import type { Tables, TablesInsert, TablesUpdate } from '@/lib/supabase/types'
import { normalizeTime } from '@/lib/server/availability'
import {
  CHECK_IN_LATE_MINUTES,
  getPendingCheckInDeadline,
  isPendingReservationExpired,
} from '@/lib/server/pending-reservation-expiry'

type ReservationRow = Tables<'reservations'>
type TableRow = Tables<'tables'>
type EquipmentRow = Tables<'equipment'>
type ReservationEquipmentRow = Tables<'reservation_equipment'>
type PostgrestErrorLike = { code?: string }
type TablesLookupClient = {
  select: (columns?: string) => {
    eq: (column: 'id', value: string) => {
      maybeSingle: () => Promise<{ data: TableRow | null; error: unknown }>
    }
  }
}
type AdminReservationsQuery = {
  eq: (column: 'id' | 'table_id' | 'date' | 'status', value: string) => AdminReservationsQuery
  neq: (column: 'id', value: string) => AdminReservationsQuery
  in: (column: 'status', values: string[]) => AdminReservationsQuery
  lt: (column: 'start_time', value: string) => AdminReservationsQuery
  gt: (column: 'end_time', value: string) => AdminReservationsQuery
  order: (column: string, options?: { ascending: boolean }) => AdminReservationsQuery
  range: (from: number, to: number) => Promise<{ data: Array<{ id: string }> | null; error: unknown }>
  limit: (count: number) => Promise<{ data: Array<{ id: string }> | null; error: unknown }>
  maybeSingle: () => Promise<{ data: ReservationRow | null; error: unknown }>
  then: Promise<{ data: ReservationRow[] | null; error: unknown }>['then']
}
type AdminReservationsTableClient = {
  select: (columns: string) => AdminReservationsQuery
}
type SessionReservationsQuery = {
  eq: (column: 'user_id' | 'table_id' | 'date', value: string) => SessionReservationsQuery
  order: (column: string, options: { ascending: boolean }) => SessionReservationsQuery
  then: Promise<{ data: ReservationRow[] | null; error: unknown }>['then']
}
type UserSlotOverlapQuery = {
  eq: (column: 'user_id' | 'date', value: string) => UserSlotOverlapQuery
  neq: (column: 'id', value: string) => UserSlotOverlapQuery
  in: (column: 'status', values: string[]) => UserSlotOverlapQuery
  lt: (column: 'start_time' | 'end_time', value: string) => UserSlotOverlapQuery
  gt: (column: 'start_time' | 'end_time', value: string) => UserSlotOverlapQuery
  then: Promise<{ data: ReservationRow[] | null; error: unknown }>['then']
}
type UserSlotOverlapTableClient = {
  select: (columns: string) => UserSlotOverlapQuery
}
type SessionReservationsTableClient = {
  select: (columns: string) => SessionReservationsQuery
  insert: (values: TablesInsert<'reservations'>) => {
    select: (columns: string) => {
      single: () => Promise<{ data: ReservationRow | null; error: PostgrestErrorLike | null }>
    }
  }
  update: (values: TablesUpdate<'reservations'>) => {
    eq: (column: 'id', value: string) => {
      select: (columns: string) => {
        single: () => Promise<{ data: ReservationRow | null; error: PostgrestErrorLike | null }>
      }
    }
  }
}

type EnrichedReservationRow = ReservationRow & {
  profiles?: { member_number: string } | null
  tables?: { name: string; rooms?: { name: string } | null } | null
  reservation_equipment?: Array<ReservationEquipmentRow & { equipment: EquipmentRow | null }> | null
}

type EnrichedReservationsQuery = {
  eq: (column: 'user_id' | 'table_id' | 'date', value: string) => EnrichedReservationsQuery
  order: (column: string, options: { ascending: boolean }) => EnrichedReservationsQuery
  then: Promise<{ data: EnrichedReservationRow[] | null; error: unknown }>['then']
}
type EnrichedReservationsTableClient = {
  select: (columns: string) => EnrichedReservationsQuery
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
const RESERVATION_ENRICHED_COLUMNS = 'id, table_id, user_id, date, start_time, end_time, status, surface, activated_at, created_at, profiles(member_number), tables(name, rooms(name)), reservation_equipment(equipment(id, name, description, created_at))'

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

function mapEnrichedReservation(row: EnrichedReservationRow): Reservation {
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
    memberNumber: row.profiles?.member_number ?? null,
    roomName: row.tables?.rooms?.name ?? null,
    tableName: row.tables?.name ?? null,
    equipment: (row.reservation_equipment ?? [])
      .map((item) => item.equipment)
      .filter((item): item is EquipmentRow => item !== null)
      .map(toEquipment),
  }
}

async function getTable(tableId: string) {
  const supabase = await createSupabaseServerClient()
  const tables = supabase.from('tables') as unknown as TablesLookupClient
  const { data, error } = await tables
    .select('id, type, room_id')
    .eq('id', tableId)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return data as TableRow | null
}

async function hasEventBlockConflict(input: {
  roomId: string
  tableId: string
  date: string
  startTime: string
  endTime: string
}) {
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('event_room_blocks')
    .select('id, table_id')
    .eq('room_id', input.roomId)
    .eq('date', input.date)
    .lt('start_time', input.endTime)
    .gt('end_time', input.startTime)

  if (error) {
    serviceError('Internal server error', 500)
  }

  // OIR-208: a block with a table_id only conflicts with that single table;
  // NULL (the pre-OIR-208 default) conflicts with every table of the room.
  return ((data ?? []) as Array<{ id: string; table_id: string | null }>).some(
    (block) => block.table_id == null || block.table_id === input.tableId,
  )
}

async function hasSavedGameBottomConflict(input: {
  tableId: string
  date: string
  surface?: TableSurface
}) {
  if (input.surface !== 'bottom') return false
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('saved_games')
    .select('id')
    .eq('table_id', input.tableId)
    .eq('status', 'active')
    .lte('start_date', input.date)
    .gte('end_date', input.date)
    .limit(1)

  if (error) serviceError('Internal server error', 500)
  return Boolean(data?.length)
}

async function getReservationForAccess(reservationId: string) {
  const admin = createSupabaseServerAdminClient()
  const reservations = admin.from('reservations') as unknown as AdminReservationsTableClient
  const { data, error } = await reservations
    .select(RESERVATION_COLUMNS)
    .eq('id', reservationId)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return data as ReservationRow | null
}

async function listActiveReservationsForConflict(input: {
  tableId: string
  date: string
  ignoreReservationId?: string
}) {
  const admin = createSupabaseServerAdminClient()
  const query = (admin.from('reservations') as unknown as AdminReservationsTableClient)
    .select(RESERVATION_COLUMNS)
    .eq('table_id', input.tableId)
    .eq('date', input.date)
    .in('status', ['active', 'pending'])

  const result = input.ignoreReservationId
    ? await query.neq('id', input.ignoreReservationId)
    : await query
  const { data, error } = result

  if (error) {
    serviceError('Internal server error', 500)
  }

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow(admin)
  return (data ?? []).filter((row) => {
    if (row.status === 'pending' && row.activated_at === null) {
      return !isPendingReservationExpired(row, nowUtc)
    }
    return true // Keep active reservations
  }) as ReservationRow[]
}

async function expireStalePendingReservations(tableId: string, date: string) {
  const admin = createSupabaseServerAdminClient()
  const nowUtc = await getDatabaseNow(admin)
  const { data, error } = await admin
    .from('reservations')
    .select(RESERVATION_COLUMNS)
    .eq('status', 'pending')
    .eq('table_id', tableId)
    .eq('date', date)
    .is('activated_at', null)

  if (error) {
    console.error('expireStalePendingReservations failed (non-fatal):', error)
    return
  }

  const expiredIds = (data ?? [])
    .filter((row) => isPendingReservationExpired(row, nowUtc))
    .map((row) => row.id)

  for (const id of expiredIds) {
    const { error: updateError } = await admin
      .from('reservations')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .eq('status', 'pending')
      .is('activated_at', null)

    if (updateError) {
      console.error('expireStalePendingReservations failed (non-fatal):', updateError)
    }
  }
}

async function listOverlappingReservationIds(input: {
  date: string
  startTime: string
  endTime: string
  ignoreReservationId?: string
}) {
  const admin = createSupabaseServerAdminClient()
  const pageSize = 1000
  const reservationIds: string[] = []
  let from = 0

  // Capture DB time once before the pagination loop to avoid one RPC per page.
  const nowUtc = await getDatabaseNow(admin)

  // Get full rows to enable lazy evaluation filtering
  while (true) {
    let query = (admin.from('reservations') as unknown as AdminReservationsTableClient)
      .select(RESERVATION_COLUMNS)
      .eq('date', input.date)
      .in('status', ['pending', 'active'])
      .lt('start_time', input.endTime)
      .gt('end_time', input.startTime)

    if (input.ignoreReservationId) {
      query = query.neq('id', input.ignoreReservationId)
    }

    const { data, error } = await query.order('id', { ascending: true }).range(from, from + pageSize - 1)

    if (error) {
      serviceError('Internal server error', 500)
    }

    const rows = (data ?? []) as ReservationRow[]

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
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('room_default_equipment')
    .select('equipment(id, name, description, created_at)')
    .eq('room_id', roomId)

  if (error) {
    serviceError('Internal server error', 500)
  }

  return ((data ?? []) as Array<{ equipment: EquipmentRow | null }>)
    .map((row) => row.equipment)
    .filter((row): row is EquipmentRow => row !== null)
}

async function listAllEquipment() {
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('equipment')
    .select('id, name, description, created_at')
    .order('name', { ascending: true })

  if (error) {
    serviceError('Internal server error', 500)
  }

  return (data ?? []) as EquipmentRow[]
}

async function listEquipmentLockedToOtherRooms(roomId: string): Promise<Set<string>> {
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('room_default_equipment')
    .select('equipment_id, room_id')

  if (error) {
    serviceError('Internal server error', 500)
  }

  const lockedToOther = new Set<string>()
  for (const row of (data ?? []) as Array<{ equipment_id: string; room_id: string }>) {
    if (row.room_id !== roomId) {
      lockedToOther.add(row.equipment_id)
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

  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('reservation_equipment')
    .select('equipment_id')
    .in('reservation_id', overlappingReservationIds)
    .in('equipment_id', input.equipmentIds)

  if (error) {
    serviceError('Internal server error', 500)
  }

  return new Set((data ?? []).map((row) => row.equipment_id))
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
  const admin = createSupabaseServerAdminClient()
  const { error: deleteError } = await admin
    .from('reservation_equipment')
    .delete()
    .eq('reservation_id', reservationId)

  if (deleteError) {
    serviceError('Internal server error', 500)
  }

  if (equipmentIds.length === 0) {
    return
  }

  const inserts: TablesInsert<'reservation_equipment'>[] = equipmentIds.map((equipment_id) => ({
    reservation_id: reservationId,
    equipment_id,
  }))
  const { error: insertError } = await admin
    .from('reservation_equipment')
    .insert(inserts)

  if (insertError) {
    serviceError('Internal server error', 500)
  }
}

async function getReservationEquipmentIds(reservationId: string) {
  const admin = createSupabaseServerAdminClient()
  const { data, error } = await admin
    .from('reservation_equipment')
    .select('equipment_id')
    .eq('reservation_id', reservationId)

  if (error) {
    serviceError('Internal server error', 500)
  }

  return (data ?? []).map((row) => row.equipment_id)
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

function isConflictError(error: PostgrestErrorLike | null | undefined) {
  return error?.code === '23P01'
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
  // Admin client required: RLS is removed in Phase 2. Member isolation is
  // enforced by deriving effectiveUserId from session.id for non-admin callers
  // (see line below), ensuring members can only query their own reservations.
  const supabase = createSupabaseServerAdminClient()
  const effectiveUserId = input.session.role === 'admin' ? input.userId ?? undefined : input.session.id
  const effectiveDate = input.date != null && input.date !== '' ? parseDate(input.date) : undefined

  let query = (supabase.from('reservations') as unknown as EnrichedReservationsTableClient)
    .select(RESERVATION_ENRICHED_COLUMNS)
    .order('date', { ascending: true })
    .order('start_time', { ascending: true })

  if (effectiveUserId) {
    query = query.eq('user_id', effectiveUserId)
  }
  if (input.tableId) {
    query = query.eq('table_id', input.tableId)
  }
  if (effectiveDate) {
    query = query.eq('date', effectiveDate)
  }

  const { data, error } = await query

  if (error) {
    serviceError('Internal server error', 500)
  }

  // Defense-in-depth: verify the query filter held before mapping rows out.
  const rawRows = assertMemberRowsScoped(
    (data ?? []) as EnrichedReservationRow[],
    input.session,
  )

  const isAdmin = input.session.role === 'admin'
  const nowUtc = await getDatabaseNow(supabase)

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
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  ignoreReservationId?: string,
) {
  let query = (supabase.from('reservations') as unknown as UserSlotOverlapTableClient)
    .select(RESERVATION_COLUMNS)
    .eq('user_id', userId)
    .eq('date', date)
    .in('status', ['pending', 'active'])
    .lt('start_time', endTime)
    .gt('end_time', startTime)

  if (ignoreReservationId) {
    query = query.neq('id', ignoreReservationId)
  }

  const { data, error } = await query

  if (error) {
    serviceError('Internal server error', 500)
  }

  // Lazy evaluation: filter out expired pending reservations
  const nowUtc = await getDatabaseNow()
  const activeReservations = (data ?? []).filter((row) => {
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

  const supabase = await createSupabaseServerClient()

  await expireStalePendingReservations(tableId, date)
  await checkUserSlotOverlap(session.id, date, startTime, endTime, supabase)

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
  const insertPayload: TablesInsert<'reservations'> = {
    table_id: tableId,
    user_id: session.id,
    date,
    start_time: startTime,
    end_time: endTime,
    surface: surface ?? null,
  }
  const reservations = supabase.from('reservations') as unknown as SessionReservationsTableClient
  const { data, error } = await reservations
    .insert(insertPayload)
    .select(RESERVATION_COLUMNS)
    .single()

  if (error || !data) {
    if (isConflictError(error)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }

  try {
    await saveReservationEquipment(data.id, equipmentIds)
  } catch {
    // Compensating delete: remove the just-created reservation to avoid a ghost
    // row with no equipment association. Ignore errors from the delete itself —
    // the original equipment error is what the caller needs to act on.
    const adminForRollback = createSupabaseServerAdminClient()
    await adminForRollback.from('reservations').delete().eq('id', data.id)
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

  const supabase = await createSupabaseServerClient()
  if (needsUserOverlapCheck) {
    await checkUserSlotOverlap(
      existingReservation.user_id,
      nextDate,
      nextStartTime,
      nextEndTime,
      supabase,
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
  const updatePayload: TablesUpdate<'reservations'> = {
    date: nextDate,
    start_time: nextStartTime,
    end_time: nextEndTime,
    surface: nextSurface,
    status: nextStatus == null ? existingReservation.status : String(nextStatus) as ReservationRow['status'],
  }
  const reservations = supabase.from('reservations') as unknown as SessionReservationsTableClient
  const { data, error } = await reservations
    .update(updatePayload)
    .eq('id', reservationId)
    .select(RESERVATION_COLUMNS)
    .single()

  if (error || !data) {
    if (isConflictError(error)) {
      throwSlotTaken()
    }
    serviceError('Internal server error', 500)
  }

  return mapReservation(data as ReservationRow)
}

type ActivationAdminQuery = {
  eq: (column: 'table_id' | 'date' | 'status' | 'user_id' | 'surface' | 'id', value: string) => ActivationAdminQuery
  or: (filter: string) => ActivationAdminQuery
  maybeSingle: () => Promise<{ data: ReservationRow | null; error: unknown }>
  select: (columns?: string) => ActivationAdminQuery
  update: (values: TablesUpdate<'reservations'>) => ActivationAdminQuery
  single: () => Promise<{ data: ReservationRow | null; error: PostgrestErrorLike | null }>
  then: Promise<{ data: ReservationRow | null; error: PostgrestErrorLike | null }>['then']
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
  const admin = createSupabaseServerAdminClient()

  let pendingQuery = (admin.from('reservations') as unknown as { select: (c: string) => ActivationAdminQuery })
    .select(RESERVATION_COLUMNS)
    .eq('table_id', tableId)
    .eq('date', today)
    .eq('user_id', userId)
    .eq('status', 'pending')

  if (side === 'inf') {
    pendingQuery = pendingQuery.eq('surface', 'bottom')
  }

  const { data: pendingData, error: pendingError } = await pendingQuery.maybeSingle()

  if (pendingError) {
    serviceError('Internal server error', 500)
  }

  if (!pendingData) {
    let activeQuery = (admin.from('reservations') as unknown as { select: (c: string) => ActivationAdminQuery })
      .select(RESERVATION_COLUMNS)
      .eq('table_id', tableId)
      .eq('date', today)
      .eq('user_id', userId)
      .eq('status', 'active')

    if (side === 'inf') {
      activeQuery = activeQuery.eq('surface', 'bottom')
    }

    const { data: activeData, error: activeError } = await activeQuery.maybeSingle()

    if (activeError) {
      serviceError('Internal server error', 500)
    }

    if (activeData) {
      serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
    }

    serviceError(ERROR_CODES.CHECK_IN_NO_RESERVATION, 404)
  }

  const reservation = pendingData as ReservationRow

  if (!reservation.end_time) {
    serviceError('Invalid reservation data', 500)
  }

  const nowUtc = await getDatabaseNow(admin)
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

  const { data: updated, error: updateError } = await admin
    .from('reservations')
    .update({ status: 'active', activated_at: nowUtc.toISOString() })
    .eq('id', reservation.id)
    .eq('status', 'pending')
    .select(RESERVATION_COLUMNS)
    .single()

  // PGRST116: PostgREST returns this code when .single() matches zero rows.
  // Here it means the reservation was already activated by a concurrent request
  // (TOCTOU race) between our read and this UPDATE. Return 409, not 500.
  if ((updateError as PostgrestErrorLike | null)?.code === 'PGRST116') {
    serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
  }
  if (updateError) {
    serviceError('Internal server error', 500)
  }
  if (!updated) {
    serviceError(ERROR_CODES.CHECK_IN_ALREADY_ACTIVE, 409)
  }

  return mapReservation(updated as ReservationRow)
}
