// @vitest-environment node
import type { SessionUser } from '@/lib/server/auth/auth'
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import {
  createStatefulDrizzleDb,
  resetDb as resetDrizzleDb,
  seed as seedDrizzleDb,
  getRows,
  executeMock,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('@/lib/server/games/saved-games-service', () => ({ recordSavedGameAttendance: vi.fn() }))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
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

function createDatabaseTimeRpc() {
  return vi.fn(async (fn: string) => {
    if (fn === 'get_database_time') {
      return { data: new Date(Date.now()).toISOString(), error: null }
    }
    return { data: null, error: null }
  })
}

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

function buildSelectChain<T>(rows: T[], hydrate?: (row: T) => T) {
  let current = [...rows]

  return {
    eq(column: string, value: string) {
      current = current.filter((row) => String((row as Record<string, unknown>)[column]) === value)
      return this
    },
    neq(column: string, value: string) {
      current = current.filter((row) => String((row as Record<string, unknown>)[column]) !== value)
      return this
    },
    in(column: string, values: string[]) {
      current = current.filter((row) => values.includes(String((row as Record<string, unknown>)[column])))
      return this
    },
    order(column: string, { ascending }: { ascending: boolean }) {
      current = [...current].sort((left, right) => {
        const a = String((left as Record<string, unknown>)[column] ?? '')
        const b = String((right as Record<string, unknown>)[column] ?? '')
        return ascending ? a.localeCompare(b) : b.localeCompare(a)
      })
      return this
    },
    or(condition: string) {
      // OR filtering is handled by the actual Supabase client; mock just returns this for chaining
      return this
    },
    lt(column: string, value: string) {
      current = current.filter((row) => {
        let cellValue = String((row as Record<string, unknown>)[column] ?? '')
        // Normalize time values for comparison (HH:MM:SS -> HH:MM)
        if (cellValue.match(/^\d{2}:\d{2}:\d{2}$/)) {
          cellValue = cellValue.slice(0, 5)
        }
        return cellValue < value
      })
      return this
    },
    gt(column: string, value: string) {
      current = current.filter((row) => {
        let cellValue = String((row as Record<string, unknown>)[column] ?? '')
        // Normalize time values for comparison (HH:MM:SS -> HH:MM)
        if (cellValue.match(/^\d{2}:\d{2}:\d{2}$/)) {
          cellValue = cellValue.slice(0, 5)
        }
        return cellValue > value
      })
      return this
    },
    limit(count: number) {
      return Promise.resolve({
        data: current.slice(0, count).map((row) => hydrate ? hydrate(row) : ({ ...row })),
        error: null,
      })
    },
    range(from: number, to: number) {
      return Promise.resolve({
        data: current.slice(from, to + 1).map((row) => hydrate ? hydrate(row) : ({ ...row })),
        error: null,
      })
    },
    then<TResult1 = { data: T[]; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: T[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve({
        data: current.map((row) => hydrate ? hydrate(row) : ({ ...row })),
        error: null,
      }).then(onfulfilled, onrejected)
    },
    maybeSingle() {
      return Promise.resolve({ data: current[0] ? (hydrate ? hydrate(current[0]) : { ...current[0] }) : null, error: null })
    },
    single() {
      return Promise.resolve({ data: current[0] ? (hydrate ? hydrate(current[0]) : { ...current[0] }) : null, error: null })
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      if (table === 'tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn((column: string, value: string) => ({
              maybeSingle: vi.fn(async () => ({
                data: column === 'id' ? (tablesState.get(value) ?? null) : null,
                error: null,
              })),
            })),
          })),
        }
      }

      if (table === 'reservations') {
        return {
          select: vi.fn(() => buildSelectChain(reservationsState, cloneReservation)),
          insert: vi.fn((payload: Record<string, string | null>) => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                const row = makeReservation({
                  id: `r${reservationsState.length + 1}`,
                  table_id: String(payload.table_id),
                  user_id: String(payload.user_id),
                  date: String(payload.date),
                  start_time: `${String(payload.start_time)}:00`,
                  end_time: `${String(payload.end_time)}:00`,
                  surface: payload.surface as ReservationRow['surface'],
                  created_at: '2026-04-04T12:00:00.000Z',
                })
                reservationsState.push(row)
                return { data: cloneReservation(row), error: null }
              }),
            })),
          })),
          update: vi.fn((payload: Record<string, string | null>) => ({
            eq: vi.fn((column: string, value: string) => ({
              select: vi.fn(() => ({
                single: vi.fn(async () => {
                  const row = reservationsState.find((reservation) => String((reservation as Record<string, unknown>)[column]) === value)
                  if (!row) {
                    return { data: null, error: null }
                  }

                  Object.assign(row, payload)
                  if (payload.start_time) row.start_time = `${payload.start_time}:00`
                  if (payload.end_time) row.end_time = `${payload.end_time}:00`
                  return { data: cloneReservation(row), error: null }
                }),
              })),
            })),
          })),
        }
      }

      throw new Error(`Unexpected table ${table}`)
    }),
  })),
  createSupabaseServerAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'event_room_blocks') {
        return {
          select: vi.fn(() => buildSelectChain(eventRoomBlocksState)),
        }
      }

      if (table === 'room_default_equipment') {
        return {
          select: vi.fn(() => buildSelectChain(roomDefaultEquipmentState)),
        }
      }

      if (table === 'reservation_equipment') {
        return {
          select: vi.fn(() => buildSelectChain(reservationEquipmentState)),
          insert: vi.fn(async (payload: ReservationEquipmentRow | ReservationEquipmentRow[]) => {
            const rows = Array.isArray(payload) ? payload : [payload]
            reservationEquipmentState.push(...rows.map((row) => ({ ...row })))
            return { error: null }
          }),
          delete: vi.fn(() => ({
            eq: vi.fn(async (_column: string, value: string) => {
              for (let index = reservationEquipmentState.length - 1; index >= 0; index -= 1) {
                if (reservationEquipmentState[index]!.reservation_id === value) {
                  reservationEquipmentState.splice(index, 1)
                }
              }
              return { error: null }
            }),
          })),
        }
      }

      if (table !== 'reservations') {
        throw new Error(`Unexpected admin table ${table}`)
      }

      return {
        select: vi.fn(() => buildSelectChain(reservationsState, cloneReservation)),
        update: vi.fn((payload: Record<string, unknown>) => {
          // Support chained .eq() calls: update().eq(col, val).eq(col2, val2).select().single()
          // The first .eq() identifies the row (by 'id'); subsequent .eq() calls act as
          // TOCTOU conditions — the row is only updated if ALL conditions match.
          const filters: Array<[string, string]> = []
          const chain = {
            eq: vi.fn((column: string, value: string) => {
              filters.push([column, value])
              return chain
            }),
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                const row = reservationsState.find((r) =>
                  filters.every(([col, val]) => String((r as Record<string, unknown>)[col]) === val)
                )
                if (!row) {
                  return { data: null, error: null }
                }
                Object.assign(row, payload)
                return { data: cloneReservation(row), error: null }
              }),
            })),
          }
          return chain
        }),
      }
    }),
    rpc: createDatabaseTimeRpc(),
  })),
}))

async function loadReservationModules() {
  vi.resetModules()
  const service = await import('@/lib/server/reservations/reservations-service')
  return { ...service }
}


describe('reservations service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    resetDrizzleDb()
    seedState()

    // Mock database time queries to return current time
    executeMock.mockImplementation((sql: unknown) => {
      const sqlStr = (sql && typeof sql === 'object' && 'queryChunks' in sql)
        ? String((sql as any).queryChunks)
        : String(sql)
      if (sqlStr.includes('select now()') || sqlStr.includes('select') || sqlStr.includes('now')) {
        return Promise.resolve({ rows: [{ now: new Date() }], rowCount: 1 })
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    })

    // Seed tables in Drizzle mock so getTable() calls in reservations-service work
    seedDrizzleDb({
      tables: [
        { id: 't1', roomId: 'room-1', name: 'Mesa 1', type: 'large' },
        { id: 't2', roomId: 'room-1', name: 'Mesa 2', type: 'small' },
        { id: 't3', roomId: 'room-1', name: 'Mesa 3', type: 'removable_top' },
      ],
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
      // Also seed in Drizzle mock, preserving any existing reservations
      const existingReservations = getRows('reservations')
      seedDrizzleDb({
        reservations: [
          ...existingReservations,
          {
            id: row.id,
            tableId: row.table_id,
            userId: row.user_id,
            date: row.date,
            startTime: row.start_time,
            endTime: row.end_time,
            status: row.status,
            surface: row.surface,
            activatedAt: row.activated_at ? new Date(row.activated_at) : null,
            createdAt: new Date(row.created_at),
          },
        ],
      })
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
      // Task 3: when the active-reservation query errors, the service should throw 500.
      // The pendingQuery maybeSingle returns null (no row, no error) → service moves on to activeQuery.
      // The activeQuery maybeSingle returns an error → service should throw 500.
      // We use vi.doMock here and restore the original mock factory at the end of the test
      // to prevent contamination of subsequent tests.
      vi.resetModules()

      // Track how many times maybeSingle has been called across all chains in this test
      let maybeSingleCallCount = 0

      vi.doMock('@/lib/supabase/server', () => ({
        createSupabaseServerClient: vi.fn(async () => ({
          from: vi.fn((table: string) => {
            if (table === 'tables') {
              return {
                select: vi.fn(() => ({
                  eq: vi.fn((column: string, value: string) => ({
                    maybeSingle: vi.fn(async () => ({
                      data: column === 'id' ? (tablesState.get(value) ?? null) : null,
                      error: null,
                    })),
                  })),
                })),
              }
            }
            return { select: vi.fn(() => buildSelectChain(reservationsState)) }
          }),
        })),
        createSupabaseServerAdminClient: vi.fn(() => {
          function makeChain(): {
            eq: (col: string, val: string) => ReturnType<typeof makeChain>
            maybeSingle: () => Promise<{ data: null; error: { message: string } | null }>
            select: (cols?: string) => ReturnType<typeof makeChain>
            update: (payload: unknown) => ReturnType<typeof makeChain>
            single: () => Promise<{ data: null; error: null }>
          } {
            return {
              eq: vi.fn(() => makeChain()),
              select: vi.fn(() => makeChain()),
              update: vi.fn(() => makeChain()),
              single: vi.fn(async () => ({ data: null, error: null })),
              maybeSingle: vi.fn(async () => {
                maybeSingleCallCount++
                if (maybeSingleCallCount === 1) {
                  // First call: pendingQuery — no pending reservation found
                  return { data: null, error: null }
                }
                // Second call: activeQuery — simulate DB error
                return { data: null, error: { message: 'db error' } }
              }),
            }
          }

          return {
            from: vi.fn(() => makeChain()),
            rpc: vi.fn(),
          }
        }),
      }))

      const { activateReservationByTable: activate } = await import('@/lib/server/reservations/reservations-service')

      await expect(activate('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 500,
      })

      // Restore the original mock factory so subsequent tests are not contaminated
      vi.resetModules()
      vi.doMock('@/lib/supabase/server', () => ({
        createSupabaseServerClient: vi.fn(async () => ({
          from: vi.fn((table: string) => {
            if (table === 'tables') {
              return {
                select: vi.fn(() => ({
                  eq: vi.fn((column: string, value: string) => ({
                    maybeSingle: vi.fn(async () => ({
                      data: column === 'id' ? (tablesState.get(value) ?? null) : null,
                      error: null,
                    })),
                  })),
                })),
              }
            }
            if (table === 'reservations') {
              return {
                select: vi.fn(() => buildSelectChain(reservationsState)),
                insert: vi.fn((payload: Record<string, string | null>) => ({
                  select: vi.fn(() => ({
                    single: vi.fn(async () => {
                      const row = makeReservation({
                        id: `r${reservationsState.length + 1}`,
                        table_id: String(payload.table_id),
                        user_id: String(payload.user_id),
                        date: String(payload.date),
                        start_time: `${String(payload.start_time)}:00`,
                        end_time: `${String(payload.end_time)}:00`,
                        surface: payload.surface as ReservationRow['surface'],
                        created_at: '2026-04-04T12:00:00.000Z',
                      })
                      reservationsState.push(row)
                      return { data: cloneReservation(row), error: null }
                    }),
                  })),
                })),
                update: vi.fn((payload: Record<string, string | null>) => ({
                  eq: vi.fn((column: string, value: string) => ({
                    select: vi.fn(() => ({
                      single: vi.fn(async () => {
                        const row = reservationsState.find((reservation) => String((reservation as Record<string, unknown>)[column]) === value)
                        if (!row) {
                          return { data: null, error: null }
                        }
                        Object.assign(row, payload)
                        if (payload.start_time) row.start_time = `${payload.start_time}:00`
                        if (payload.end_time) row.end_time = `${payload.end_time}:00`
                        return { data: cloneReservation(row), error: null }
                      }),
                    })),
                  })),
                })),
              }
            }
            throw new Error(`Unexpected table ${table}`)
          }),
        })),
        createSupabaseServerAdminClient: vi.fn(() => ({
          from: vi.fn((table: string) => {
            if (table !== 'reservations') {
              throw new Error(`Unexpected admin table ${table}`)
            }
            return {
              select: vi.fn(() => buildSelectChain(reservationsState)),
              update: vi.fn((payload: Record<string, unknown>) => {
                const filters: Array<[string, string]> = []
                const chain = {
                  eq: vi.fn((column: string, value: string) => {
                    filters.push([column, value])
                    return chain
                  }),
                  select: vi.fn(() => ({
                    single: vi.fn(async () => {
                      const row = reservationsState.find((r) =>
                        filters.every(([col, val]) => String((r as Record<string, unknown>)[col]) === val)
                      )
                      if (!row) {
                        return { data: null, error: null }
                      }
                      Object.assign(row, payload)
                      return { data: cloneReservation(row), error: null }
                    }),
                  })),
                }
                return chain
              }),
            }
          }),
          rpc: vi.fn(),
        })),
      }))
    })

    it('invalid CLUB_TIMEZONE propagates as a RangeError', async () => {
      // Task 4: CLUB_TIMEZONE='Invalid/Zone' → RangeError propagates (no fallback)
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

    it('UPDATE returning PGRST116 resolves to 409 CHECK_IN_ALREADY_ACTIVE (TOCTOU race)', async () => {
      // Simulates the TOCTOU race: pendingQuery finds the row, but by the time the UPDATE
      // executes the row is gone (already activated by a concurrent request).
      // PostgREST returns PGRST116 when .single() matches zero rows.
      // We override createSupabaseServerAdminClient for this one invocation via mockReturnValueOnce.
      const { createSupabaseServerAdminClient } = await import('@/lib/supabase/server')
      const adminMock = vi.mocked(createSupabaseServerAdminClient)

      const pendingRow = makeReservation({
        id: 'rTOCTOU',
        table_id: 't3',
        user_id: '2',
        date: FIXED_DATE,
        status: 'pending',
        surface: 'top',
        start_time: makeStartTime(10),
      })

      // Build a select chain that returns the pending row for pendingQuery
      function buildSingleRowSelectChain(row: ReservationRow) {
        const self: {
          eq: (col: string, val: string) => typeof self
          maybeSingle: () => Promise<{ data: ReservationRow; error: null }>
        } = {
          eq: vi.fn(() => self),
          maybeSingle: vi.fn(async () => ({ data: { ...row }, error: null })),
        }
        return self
      }

      // Build an update chain whose single() returns PGRST116
      function buildPGRST116UpdateChain() {
        const self: {
          eq: (col: string, val: string) => typeof self
          select: (cols?: string) => typeof self
          single: () => Promise<{ data: null; error: { code: string; message: string } }>
        } = {
          eq: vi.fn(() => self),
          select: vi.fn(() => self),
          single: vi.fn(async () => ({
            data: null,
            error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
          })),
        }
        return self
      }

      let fromCallCount = 0
      adminMock.mockReturnValueOnce({
        from: vi.fn((table: string) => {
          if (table !== 'reservations') throw new Error(`Unexpected admin table ${table}`)
          fromCallCount++
          if (fromCallCount === 1) {
            // pendingQuery: .select(cols).eq().eq().eq().eq().eq().maybeSingle()
            return { select: vi.fn(() => buildSingleRowSelectChain(pendingRow)) }
          }
          // updateChain: .update().eq().eq().select().single() → PGRST116
          return { update: vi.fn(() => buildPGRST116UpdateChain()) }
        }),
        rpc: createDatabaseTimeRpc(),
      } as unknown as ReturnType<typeof createSupabaseServerAdminClient>)

      const { activateReservationByTable } = await loadReservationModules()

      await expect(activateReservationByTable('t3', '2', undefined)).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 409,
        message: expect.stringContaining('CHECK_IN_ALREADY_ACTIVE'),
      })
    })

    it('sequential double-call returns 409 CHECK_IN_ALREADY_ACTIVE on second call', async () => {
      // First call activates the reservation (pending → active).
      // Second call finds no pending row but finds an active row → 409 CHECK_IN_ALREADY_ACTIVE.
      const { createSupabaseServerAdminClient } = await import('@/lib/supabase/server')
      const adminMock = vi.mocked(createSupabaseServerAdminClient)
      adminMock.mockImplementation(() => ({
        from: vi.fn((table: string) => {
          if (table === 'event_room_blocks') {
            return {
              select: vi.fn(() => buildSelectChain(eventRoomBlocksState)),
            }
          }

          if (table !== 'reservations') {
            throw new Error(`Unexpected admin table ${table}`)
          }

          return {
            select: vi.fn(() => buildSelectChain(reservationsState)),
            update: vi.fn((payload: Record<string, unknown>) => {
              const filters: Array<[string, string]> = []
              const chain = {
                eq: vi.fn((column: string, value: string) => {
                  filters.push([column, value])
                  return chain
                }),
                select: vi.fn(() => ({
                  single: vi.fn(async () => {
                    const row = reservationsState.find((reservation) =>
                      filters.every(([column, value]) => String((reservation as Record<string, unknown>)[column]) === value)
                    )
                    if (!row) {
                      return { data: null, error: null }
                    }
                    Object.assign(row, payload)
                    return { data: cloneReservation(row), error: null }
                  }),
                })),
              }
              return chain
            }),
          }
        }),
        rpc: createDatabaseTimeRpc(),
      }) as unknown as ReturnType<typeof createSupabaseServerAdminClient>)

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
