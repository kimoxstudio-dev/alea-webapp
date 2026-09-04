// @vitest-environment node
import type { SessionUser } from '@/lib/server/auth'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { createSqlMock, whereColumnHasOperator, whereConditionCount } from '../helpers/sql-mock'

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

vi.mock('@/lib/server/saved-games-service', () => ({ recordSavedGameAttendance: vi.fn() }))
vi.mock('@/lib/server/database-time', () => ({
  getDatabaseNow: vi.fn(async () => new Date()),
}))

type ReservationRow = {
  id: string
  table_id: string
  user_id: string
  date: string
  start_time: string
  end_time: string
  status: 'active' | 'cancelled' | 'completed' | 'pending' | 'no_show'
  surface: 'top' | 'bottom' | null
  activated_at: string | null
  created_at: string
  // enriched join fields populated by the mock
  profiles?: { member_number: string } | null
  tables?: { name: string; rooms?: { name: string } | null } | null
  reservation_equipment?: Array<{ reservation_id: string; equipment_id: string; equipment: EquipmentRow | null }> | null
}

type EquipmentRow = {
  id: string
  name: string
  description: string | null
  created_at: string
}

type ReservationEquipmentRow = {
  reservation_id: string
  equipment_id: string
  equipment?: EquipmentRow | null
}

type RoomDefaultEquipmentRow = {
  room_id: string
  equipment_id: string
  equipment?: EquipmentRow | null
}

type TableRow = {
  id: string
  room_id: string
  name: string
  type: 'small' | 'large' | 'removable_top'
  qr_code: string | null
  pos_x: number | null
  pos_y: number | null
}

type RoomRow = {
  id: string
  name: string
}

type EventRoomBlockRow = {
  id: string
  event_id: string
  room_id: string
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}

const adminSession: SessionUser = {
  id: '1',
  role: 'admin',
}

const memberSession: SessionUser = {
  id: '2',
  role: 'member',
}

const reservationsState: ReservationRow[] = []
const equipmentState = new Map<string, EquipmentRow>()
const reservationEquipmentState: ReservationEquipmentRow[] = []
const roomDefaultEquipmentState: RoomDefaultEquipmentRow[] = []
const tablesState = new Map<string, TableRow>()
const profilesMap = new Map<string, { member_number: string }>()
const roomsMap = new Map<string, RoomRow>()
const eventRoomBlocksState: EventRoomBlockRow[] = []
let activationActiveLookupError = false
let activationUpdateReturnsNoRow = false

function makeReservation(overrides?: Partial<ReservationRow>): ReservationRow {
  return {
    id: 'r1',
    table_id: 't1',
    user_id: '2',
    date: '2026-12-31',
    start_time: '16:00:00',
    end_time: '18:00:00',
    status: 'active',
    surface: null,
    activated_at: null,
    created_at: '2026-12-31T10:00:00.000Z',
    ...overrides,
  }
}

function cloneReservation(row: ReservationRow) {
  return {
    ...row,
    reservation_equipment: reservationEquipmentState
      .filter((item) => item.reservation_id === row.id)
      .map((item) => ({
        reservation_id: item.reservation_id,
        equipment_id: item.equipment_id,
        equipment: equipmentState.get(item.equipment_id) ?? null,
      })),
  }
}

function seedState() {
  equipmentState.clear()
  equipmentState.set('eq-1', {
    id: 'eq-1',
    name: 'Projector',
    description: 'Ceiling projector',
    created_at: '2026-04-01T10:00:00.000Z',
  })
  equipmentState.set('eq-2', {
    id: 'eq-2',
    name: 'Speaker Kit',
    description: 'Portable speakers',
    created_at: '2026-04-01T10:00:00.000Z',
  })

  profilesMap.clear()
  profilesMap.set('2', { member_number: 'M-00000002' })

  roomsMap.clear()
  roomsMap.set('room-1', { id: 'room-1', name: 'Sala Mirkwood' })

  tablesState.clear()
  tablesState.set('t1', {
    id: 't1',
    room_id: 'room-1',
    name: 'Mesa 1',
    type: 'large',
    qr_code: 'QR-1',
    pos_x: 0,
    pos_y: 0,
  })
  tablesState.set('t2', {
    id: 't2',
    room_id: 'room-1',
    name: 'Mesa 2',
    type: 'small',
    qr_code: 'QR-2',
    pos_x: 1,
    pos_y: 0,
  })
  tablesState.set('t3', {
    id: 't3',
    room_id: 'room-1',
    name: 'Mesa 3',
    type: 'removable_top',
    qr_code: 'QR-3',
    pos_x: 1,
    pos_y: 0,
  })

  reservationsState.length = 0
  reservationEquipmentState.length = 0
  roomDefaultEquipmentState.length = 0
  eventRoomBlocksState.length = 0

  roomDefaultEquipmentState.push(
    { room_id: 'room-1', equipment_id: 'eq-1', equipment: equipmentState.get('eq-1') ?? null },
    { room_id: 'room-1', equipment_id: 'eq-2', equipment: equipmentState.get('eq-2') ?? null },
  )

  const r1base = makeReservation()
  const t1 = tablesState.get(r1base.table_id)!
  reservationsState.push({
    ...r1base,
    profiles: profilesMap.get(r1base.user_id) ?? null,
    tables: t1 ? { name: t1.name, rooms: roomsMap.get(t1.room_id) ?? null } : null,
  })
  reservationEquipmentState.push({ reservation_id: 'r1', equipment_id: 'eq-1', equipment: equipmentState.get('eq-1') ?? null })

  const r2base = makeReservation({
    id: 'r2',
    table_id: 't3',
    start_time: '10:00:00',
    end_time: '12:00:00',
    surface: 'top',
  })
  const t3 = tablesState.get(r2base.table_id)!
  reservationsState.push({
    ...r2base,
    profiles: profilesMap.get(r2base.user_id) ?? null,
    tables: t3 ? { name: t3.name, rooms: roomsMap.get(t3.room_id) ?? null } : null,
  })
}

async function loadReservationModules() {
  vi.resetModules()
  const service = await import('@/lib/server/reservations-service')
  return { ...service }
}


describe('reservations service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    sqlMock.reset()
    activationActiveLookupError = false
    activationUpdateReturnsNoRow = false
    seedState()
    sqlMock.addHandler({
      name: 'SELECT table by id',
      verb: 'select',
      match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'id', '=') && whereConditionCount(stmt) === 1,
      respond: (stmt) => {
        const table = tablesState.get(String(stmt.values[0]))
        return table ? [table] : []
      },
    })
    sqlMock.addHandler({
      name: 'SELECT pending or active reservation for activation',
      verb: 'select',
      match: (stmt) => stmt.table === 'reservations' && stmt.text.endsWith('limit 1') && stmt.values.length === 4,
      respond: (stmt) => {
        const [tableId, date, userId, requiresBottom] = stmt.values
        const isActiveLookup = stmt.text.includes("status = 'active'")
        if (isActiveLookup && activationActiveLookupError) throw new Error('db error')
        const status = isActiveLookup ? 'active' : 'pending'
        return reservationsState.filter((row) =>
          row.table_id === String(tableId) &&
          row.date === String(date) &&
          row.user_id === String(userId) &&
          row.status === status &&
          (!requiresBottom || row.surface === 'bottom'),
        ).slice(0, 1).map(cloneReservation)
      },
    })
    sqlMock.addHandler({
      name: 'UPDATE pending reservation during activation',
      verb: 'update',
      match: (stmt) => stmt.table === 'reservations' && stmt.returning && stmt.whereClause?.includes("status = 'pending'") === true,
      respond: (stmt) => {
        const [activatedAt, reservationId] = stmt.values
        const row = reservationsState.find((reservation) => reservation.id === String(reservationId) && reservation.status === 'pending')
        if (!row || activationUpdateReturnsNoRow) return []
        row.status = 'active'
        row.activated_at = String(activatedAt)
        return [cloneReservation(row)]
      },
    })
  })

  describe('activateReservationByTable', () => {
    // Fixed timestamp: 2025-06-15T14:00:00Z (14:00 UTC)
    const FIXED_DATE = '2025-06-15'
    const FIXED_TIME = new Date('2025-06-15T14:00:00Z')

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(FIXED_TIME)
    })

    afterEach(() => {
      vi.useRealTimers()
      vi.unstubAllEnvs()
    })

    function seedPendingReservation(overrides?: Partial<ReservationRow>) {
      const row: ReservationRow = makeReservation({
        id: 'rA',
        table_id: 't3',
        user_id: '2',
        date: FIXED_DATE,
        status: 'pending',
        surface: 'top',
        ...overrides,
      })
      reservationsState.push(row)
      return row
    }

    function makeStartTime(offsetMinutes: number): string {
      const nowUtc = new Date()
      const clubTz = process.env.CLUB_TIMEZONE ?? 'Europe/Madrid'
      
      let madridParts: Record<string, number>
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: clubTz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        }).formatToParts(nowUtc)
        madridParts = Object.fromEntries(
          parts.filter((p: any) => p.type !== 'literal').map((p: any) => [p.type, parseInt(p.value, 10)])
        )
      } catch {
        // Fallback to UTC if timezone is invalid
        madridParts = {
          year: nowUtc.getUTCFullYear(),
          month: nowUtc.getUTCMonth() + 1,
          day: nowUtc.getUTCDate(),
          hour: nowUtc.getUTCHours(),
          minute: nowUtc.getUTCMinutes(),
          second: nowUtc.getUTCSeconds(),
        }
      }
      
      // Create a date in "timezone local time space" (treating parts as UTC for comparison)
      const madridTime = new Date(
        madridParts.year!,
        madridParts.month! - 1,
        madridParts.day!,
        madridParts.hour!,
        madridParts.minute!,
        madridParts.second!,
      )
      madridTime.setMinutes(madridTime.getMinutes() - offsetMinutes)
      const hh = String(madridTime.getHours()).padStart(2, '0')
      const mm = String(madridTime.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}:00`
    }

    function makeEndTime(startTimeStr: string, durationMinutes: number): string {
      const [hh, mm] = startTimeStr.split(':')
      const nowUtc = new Date()
      const clubTz = process.env.CLUB_TIMEZONE ?? 'Europe/Madrid'
      
      let madridParts: Record<string, number>
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: clubTz,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour12: false,
        }).formatToParts(nowUtc)
        madridParts = Object.fromEntries(
          parts.filter((p: any) => p.type !== 'literal').map((p: any) => [p.type, parseInt(p.value, 10)])
        )
      } catch {
        // Fallback to UTC if timezone is invalid
        madridParts = {
          year: nowUtc.getUTCFullYear(),
          month: nowUtc.getUTCMonth() + 1,
          day: nowUtc.getUTCDate(),
        }
      }
      
      const date = new Date(
        madridParts.year!,
        madridParts.month! - 1,
        madridParts.day!,
        parseInt(hh!, 10),
        parseInt(mm!, 10),
        0,
        0,
      )
      date.setTime(date.getTime() + durationMinutes * 60 * 1000)
      const endHh = String(date.getHours()).padStart(2, '0')
      const endMm = String(date.getMinutes()).padStart(2, '0')
      return `${endHh}:${endMm}:00`
    }

    it('throws CHECK_IN_TOO_EARLY when called before start_time', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      seedPendingReservation({ start_time: makeStartTime(-30) })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_EARLY'),
      })
    })

    it('boundary: called exactly 5 minutes before start_time (early window opens) succeeds', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 14:05:00 (5 min in future)
      // This is exactly at [start - 5min, end_time], so check-in should succeed
      const startTime = makeStartTime(-5)
      seedPendingReservation({ start_time: startTime })

      const result = await activateReservationByTable('t3', '2', undefined)

      expect(result.status).toBe('active')
    })

    it('boundary: called 6 minutes before start_time throws CHECK_IN_TOO_EARLY', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 14:06:00 (6 min in future)
      // This is before the early window [start - 5min], so check-in should fail
      seedPendingReservation({ start_time: makeStartTime(-6) })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_EARLY'),
      })
    })

    it('throws CHECK_IN_TOO_LATE when called after end_time', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      const startTime = makeStartTime(25)
      seedPendingReservation({ start_time: startTime, end_time: makeEndTime(startTime, 20) })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_LATE'),
      })
    })

    it('throws CHECK_IN_ALREADY_ACTIVE when reservation is already active', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      reservationsState.push(makeReservation({
        id: 'rActive',
        table_id: 't3',
        user_id: '2',
        date: FIXED_DATE,
        status: 'active',
        surface: 'top',
        start_time: makeStartTime(10),
      }))

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 409,
        message: expect.stringContaining('CHECK_IN_ALREADY_ACTIVE'),
      })
    })

    it('throws CHECK_IN_NO_RESERVATION when no pending reservation exists', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 404,
        message: expect.stringContaining('CHECK_IN_NO_RESERVATION'),
      })
    })

    it('with side=inf: matches reservation with surface bottom', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      seedPendingReservation({ surface: 'bottom', start_time: makeStartTime(10) })

      const result = await activateReservationByTable('t3', '2', 'inf')

      expect(result).toMatchObject({ tableId: 't3', userId: '2', status: 'active' })
    })

    it('with side=inf on a non-removable-top table: throws CHECK_IN_NO_RESERVATION', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      reservationsState.push(makeReservation({
        id: 'rNonTop',
        table_id: 't1',
        user_id: '2',
        date: FIXED_DATE,
        status: 'pending',
        surface: null,
        start_time: makeStartTime(10),
      }))

      await expect(activateReservationByTable('t1', '2', 'inf')).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 404,
        message: expect.stringContaining('CHECK_IN_NO_RESERVATION'),
      })
    })

    it('boundary: called exactly at start_time succeeds', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      seedPendingReservation({ start_time: makeStartTime(0) })

      const result = await activateReservationByTable('t3', '2', undefined)

      expect(result.status).toBe('active')
    })

    it('boundary: called at start_time + 30 min succeeds', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 13:30:00 (30 min in past)
      // Within 60-min window: should succeed
      seedPendingReservation({ start_time: makeStartTime(30) })

      const result = await activateReservationByTable('t3', '2', undefined)

      expect(result.status).toBe('active')
    })

    it('boundary: called at start_time + 60 min succeeds when reservation longer', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 13:00:00 (60 min in past)
      // Exactly at 60-min boundary, end_time is 14:30:00 (extends past boundary)
      // windowEnd = min(start + 60min, end) = min(14:00:00, 14:30:00) = 14:00:00
      // now === windowEnd → should succeed (not strictly greater)
      const startTime = makeStartTime(60)
      const endTime = makeEndTime(startTime, 90)
      seedPendingReservation({ start_time: startTime, end_time: endTime })

      const result = await activateReservationByTable('t3', '2', undefined)

      expect(result.status).toBe('active')
    })

    it('boundary: called at start_time + 61 min throws CHECK_IN_TOO_LATE', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 12:59:00 (61 min in past)
      // Beyond 60-min window: should fail
      seedPendingReservation({ start_time: makeStartTime(61) })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_LATE'),
      })
    })

    it('boundary: end_time before 60-min mark caps window at end_time', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, start_time is 13:30:00 (30 min in past)
      // end_time is 13:40:00 (20 min in past, before 60-min window closes)
      // windowEnd = min(start + 60min, end) = min(14:30:00, 13:40:00) = 13:40:00
      // now > windowEnd → should fail
      const startTime = makeStartTime(30)
      const endTime = makeEndTime(startTime, 10)
      seedPendingReservation({ start_time: startTime, end_time: endTime })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_LATE'),
      })
    })

    it('boundary: called exactly at end_time succeeds', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, set start_time so end_time is also 14:00:00
      // At end_time boundary, check-in should succeed (now === reservationEnd, not strictly greater)
      const startTime = makeStartTime(20)
      const endTime = makeEndTime(startTime, 20)
      seedPendingReservation({ start_time: startTime, end_time: endTime })

      const result = await activateReservationByTable('t3', '2', undefined)

      expect(result.status).toBe('active')
    })

    it('boundary: called just after end_time throws CHECK_IN_TOO_LATE', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      // now is 14:00:00, set end_time to 13:59:00 (1 minute before now)
      // This is after end_time, so check-in should fail
      const startTime = makeStartTime(21)
      const endTime = makeEndTime(startTime, 19)
      seedPendingReservation({ start_time: startTime, end_time: endTime })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: expect.stringContaining('CHECK_IN_TOO_LATE'),
      })
    })

    it('non-removable-top (large) table: activates with surface=null without surface filter', async () => {
      // Task 2: happy-path check-in on a non-removable-top table
      // t1 is type 'large' — isRemovableTop=false → no surface filter applied
      const { activateReservationByTable } = await loadReservationModules()

      reservationsState.push(makeReservation({
        id: 'rLarge',
        table_id: 't1',
        user_id: '2',
        date: FIXED_DATE,
        status: 'pending',
        surface: null,
        start_time: makeStartTime(10),
      }))

      const result = await activateReservationByTable('t1', '2', undefined)

      expect(result).toMatchObject({ tableId: 't1', userId: '2', status: 'active' })
    })

    it('activeQuery DB error returns 500', async () => {
      activationActiveLookupError = true
      const { activateReservationByTable } = await loadReservationModules()
      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 500,
      })
    })

    it('invalid CLUB_TIMEZONE propagates as a RangeError', async () => {
      // Task 4: CLUB_TIMEZONE='Invalid/Zone' → RangeError propagates (no fallback).
      // lib/club-time.ts reads NEXT_PUBLIC_CLUB_TIMEZONE first, and vitest.config.mts
      // pins that globally for the suite — both must be stubbed here, or the global
      // pin wins and this test exercises the pinned zone instead of the invalid one.
      vi.stubEnv('NEXT_PUBLIC_CLUB_TIMEZONE', 'Invalid/Zone')
      vi.stubEnv('CLUB_TIMEZONE', 'Invalid/Zone')
      const { activateReservationByTable } = await loadReservationModules()

      seedPendingReservation({ start_time: makeStartTime(10) })

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toThrow(RangeError)
    })

    it('getTable returning null throws 404 with Table not found', async () => {
      // Task 5: when the table does not exist in the DB, service throws 404
      const { activateReservationByTable } = await loadReservationModules()

      // Use a tableId that is not seeded in tablesState
      await expect(activateReservationByTable('t-nonexistent', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 404,
        message: expect.stringContaining('Table not found'),
      })
    })

    it('returns 409 when the conditional activation update loses a race', async () => {
      activationUpdateReturnsNoRow = true
      const { activateReservationByTable } = await loadReservationModules()
      seedPendingReservation({ start_time: makeStartTime(10) })
      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 409,
        message: expect.stringContaining('CHECK_IN_ALREADY_ACTIVE'),
      })
    })

    it('sequential double-call returns 409 CHECK_IN_ALREADY_ACTIVE on second call', async () => {
      const { activateReservationByTable } = await loadReservationModules()

      seedPendingReservation({ start_time: makeStartTime(10) })

      // First activation should succeed
      const firstResult = await activateReservationByTable('t3', '2', undefined)
      expect(firstResult).toMatchObject({ tableId: 't3', userId: '2', status: 'active' })

      // Second activation on the same table/user — reservation is now active, not pending
      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 409,
        message: expect.stringContaining('CHECK_IN_ALREADY_ACTIVE'),
      })
    })
  })


})
