// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NeonDbError } from '@neondatabase/serverless'
import type { ServiceError } from '@/lib/server/service-error'
import {
  createSqlMock,
  whereColumnHasOperator,
  whereConditionCount,
  whereHasColumn,
} from '../helpers/sql-mock'

/**
 * Raw-SQL Neon port test suite for rooms-service (#302).
 *
 * Mocks the tagged-template `sql` export from `lib/db/client.ts` via the
 * shared verb-anchored SQL mock helper (#332) — see `sql-mock.ts` for why a
 * loose substring-dispatch mock is unsafe. `getDatabaseNow` is mocked at the
 * module level (matching `reservations-service.test.ts` /
 * `rooms-service.ts` calling it as an already-imported helper, not via the
 * `sql` mock's `now()` handler), and `regenerateQrCodes` (still
 * Supabase-based, out of scope for #302) is mocked as a spy only.
 */

const sqlMock = createSqlMock()
const getDatabaseNowMock = vi.fn(async () => new Date('2025-01-01T09:00:00.000Z'))
const regenerateQrCodesMock = vi.fn()

vi.mock('@/lib/db/client', () => ({
  sql: sqlMock.sql,
}))

vi.mock('@/lib/server/database-time', () => ({
  getDatabaseNow: getDatabaseNowMock,
}))

vi.mock('@/lib/server/tables-service', () => ({
  regenerateQrCodes: regenerateQrCodesMock,
}))

async function loadRoomsService() {
  vi.resetModules()
  return import('@/lib/server/rooms-service')
}

function makeRoomRow(overrides?: Partial<{ id: string; name: string; table_count: number; description: string | null }>) {
  return {
    id: '1',
    name: 'Sala Mirkwood',
    table_count: 8,
    description: 'Sala principal',
    ...overrides,
  }
}

function makeTableRow(overrides?: Partial<{
  id: string
  room_id: string
  name: string
  type: 'small' | 'large' | 'removable_top'
  qr_code: string | null
  qr_code_inf: string | null
  pos_x: number | null
  pos_y: number | null
}>) {
  return {
    id: 't1',
    room_id: '1',
    name: 'Mesa 1',
    type: 'small' as const,
    qr_code: null,
    qr_code_inf: null,
    pos_x: null,
    pos_y: null,
    ...overrides,
  }
}

function makeReservationRow(overrides?: Partial<{
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
}>) {
  return {
    id: 'r1',
    table_id: 't1',
    date: '2025-01-01',
    start_time: '10:00:00',
    end_time: '12:00:00',
    status: 'active',
    surface: null,
    user_id: '2',
    activated_at: '2025-01-01T00:00:00.000Z',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeEventBlockRow(overrides?: Partial<{
  id: string
  event_id: string
  room_id: string
  table_id: string | null
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}>) {
  return {
    id: 'b1',
    event_id: 'ev1',
    room_id: '1',
    table_id: null,
    date: '2025-01-01',
    start_time: '14:00:00',
    end_time: '16:00:00',
    all_day: false,
    ...overrides,
  }
}

describe('rooms-service (Neon raw SQL)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
    getDatabaseNowMock.mockReset()
    getDatabaseNowMock.mockResolvedValue(new Date('2025-01-01T09:00:00.000Z'))
    regenerateQrCodesMock.mockReset()
    regenerateQrCodesMock.mockResolvedValue({ qr_code: 'QR', qr_code_inf: null })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('listAllRooms', () => {
    it('maps rows to Room shape on success', async () => {
      sqlMock.addHandler({
        name: 'SELECT rooms ordered by created_at',
        verb: 'select',
        match: (stmt) => stmt.table === 'rooms' && stmt.whereClause === null,
        respond: () => [makeRoomRow(), makeRoomRow({ id: '2', name: 'Sala Rivendell', table_count: 4, description: null })],
      })

      const { listAllRooms } = await loadRoomsService()
      const rooms = await listAllRooms()

      expect(rooms).toEqual([
        { id: '1', name: 'Sala Mirkwood', tableCount: 8, description: 'Sala principal' },
        { id: '2', name: 'Sala Rivendell', tableCount: 4, description: undefined },
      ])
    })

    it('maps a DB error to a 500 ServiceError', async () => {
      sqlMock.addHandler({
        name: 'SELECT rooms — failing',
        verb: 'select',
        match: (stmt) => stmt.table === 'rooms' && stmt.whereClause === null,
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { listAllRooms } = await loadRoomsService()
      await expect(listAllRooms()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })
  })

  describe('createRoomEntry', () => {
    beforeEach(() => {
      sqlMock.addHandler({
        name: 'INSERT rooms',
        verb: 'insert',
        match: (stmt) => stmt.table === 'rooms',
        respond: (stmt) => [
          makeRoomRow({
            name: stmt.values[0] as string,
            table_count: stmt.values[1] as number,
            description: stmt.values[2] as string | null,
          }),
        ],
      })
    })

    it('throws 400 when name is missing', async () => {
      const { createRoomEntry } = await loadRoomsService()
      await expect(createRoomEntry({ tableCount: 1 })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 400 })
    })

    it('throws 400 when name is empty/whitespace', async () => {
      const { createRoomEntry } = await loadRoomsService()
      await expect(createRoomEntry({ name: '   ', tableCount: 1 })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 400 })
    })

    it.each([
      { label: 'negative', tableCount: -1 },
      { label: 'non-integer', tableCount: 1.5 },
      { label: 'non-numeric', tableCount: 'abc' },
    ])('throws 400 when tableCount is $label', async ({ tableCount }) => {
      const { createRoomEntry } = await loadRoomsService()
      await expect(createRoomEntry({ name: 'Sala X', tableCount })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 400 })
    })

    it('inserts and returns the mapped room on success', async () => {
      const { createRoomEntry } = await loadRoomsService()
      const result = await createRoomEntry({ name: 'Sala Mirkwood', tableCount: 8, description: 'Sala principal' })

      expect(result).toEqual({ id: '1', name: 'Sala Mirkwood', tableCount: 8, description: 'Sala principal' })
    })

    it('maps a DB error to a 500 ServiceError', async () => {
      sqlMock.clearHandlers()
      sqlMock.addHandler({
        name: 'INSERT rooms — failing',
        verb: 'insert',
        match: (stmt) => stmt.table === 'rooms',
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { createRoomEntry } = await loadRoomsService()
      await expect(createRoomEntry({ name: 'Sala X', tableCount: 1 })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('returns 500 when insert returns no row', async () => {
      sqlMock.clearHandlers()
      sqlMock.addHandler({
        name: 'INSERT rooms — empty result',
        verb: 'insert',
        match: (stmt) => stmt.table === 'rooms',
        respond: () => [],
      })

      const { createRoomEntry } = await loadRoomsService()
      await expect(createRoomEntry({ name: 'Sala X', tableCount: 1 })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })
  })

  describe('updateRoom', () => {
    it('throws 400 when tableCount is not a non-negative integer', async () => {
      const { updateRoom } = await loadRoomsService()

      let caught: ServiceError | undefined
      try {
        await updateRoom('1', { tableCount: -1 })
      } catch (err) {
        caught = err as ServiceError
      }

      expect(caught).toBeDefined()
      expect(caught?.name).toBe('ServiceError')
      expect(caught?.statusCode).toBe(400)
      expect(caught?.message).toMatch(/tableCount/i)
    })

    it('returns 404 when no row matches the id', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — not found',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })

      const { updateRoom } = await loadRoomsService()
      await expect(updateRoom('missing', { name: 'X' })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 404 })
    })

    it('maps a DB error to a 500 ServiceError', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — failing',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { updateRoom } = await loadRoomsService()
      await expect(updateRoom('1', { name: 'X' })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('updates only the name when only name is provided', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — name only',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [makeRoomRow({ name: 'Sala Renamed' })],
      })

      const { updateRoom } = await loadRoomsService()
      const result = await updateRoom('1', { name: 'Sala Renamed' })
      expect(result.name).toBe('Sala Renamed')
    })

    it('updates only the description when only description is provided', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — description only',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [makeRoomRow({ description: 'New description' })],
      })

      const { updateRoom } = await loadRoomsService()
      const result = await updateRoom('1', { description: 'New description' })
      expect(result.description).toBe('New description')
    })

    it('updates only tableCount when only tableCount is provided', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — tableCount only',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [makeRoomRow({ table_count: 5 })],
      })

      const { updateRoom } = await loadRoomsService()
      const result = await updateRoom('1', { tableCount: 5 })
      expect(result.tableCount).toBe(5)
    })

    it('updates a combination of name, description, and tableCount', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — combined',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [makeRoomRow({ name: 'Sala Combo', description: 'Combo desc', table_count: 3 })],
      })

      const { updateRoom } = await loadRoomsService()
      const result = await updateRoom('1', { name: 'Sala Combo', description: 'Combo desc', tableCount: 3 })
      expect(result).toEqual({ id: '1', name: 'Sala Combo', tableCount: 3, description: 'Combo desc' })
    })

    it('treats tableCount null/empty string as not provided (no 400)', async () => {
      sqlMock.addHandler({
        name: 'UPDATE rooms — null/empty tableCount',
        verb: 'update',
        match: (stmt) => stmt.table === 'rooms' && whereHasColumn(stmt, 'id'),
        respond: () => [makeRoomRow()],
      })

      const { updateRoom } = await loadRoomsService()
      await expect(updateRoom('1', { tableCount: null })).resolves.not.toThrow()
      await expect(updateRoom('1', { tableCount: '' })).resolves.not.toThrow()
    })
  })

  describe('listRoomTables', () => {
    it('delegates to the tables SELECT and maps rows', async () => {
      sqlMock.addHandler({
        name: 'SELECT tables by room_id',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'room_id', '=') && whereConditionCount(stmt) === 1,
        respond: () => [makeTableRow({ id: 't1', name: 'Mesa 1' }), makeTableRow({ id: 't2', name: 'Mesa 2', type: 'large' })],
      })

      const { listRoomTables } = await loadRoomsService()
      const tables = await listRoomTables('1')

      expect(tables).toHaveLength(2)
      expect(tables[0]).toMatchObject({ id: 't1', roomId: '1', name: 'Mesa 1', type: 'small' })
      expect(tables[1]).toMatchObject({ id: 't2', name: 'Mesa 2', type: 'large' })
    })

    it('returns an empty array when the room has no tables', async () => {
      sqlMock.addHandler({
        name: 'SELECT tables by room_id — empty',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'room_id', '=') && whereConditionCount(stmt) === 1,
        respond: () => [],
      })

      const { listRoomTables } = await loadRoomsService()
      const tables = await listRoomTables('empty-room')
      expect(tables).toEqual([])
    })
  })

  describe('getRoomTablesAvailability', () => {
    function addTablesHandler(rows: ReturnType<typeof makeTableRow>[]) {
      sqlMock.addHandler({
        name: 'SELECT tables by room_id',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'room_id', '=') && whereConditionCount(stmt) === 1,
        respond: () => rows,
      })
    }

    function addReservationsHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'SELECT reservations for tables/date',
        verb: 'select',
        match: (stmt) =>
          stmt.table === 'reservations' &&
          whereColumnHasOperator(stmt, 'date', '=') &&
          whereHasColumn(stmt, 'table_id'),
        respond,
      })
    }

    function addEventBlocksHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks for room/date',
        verb: 'select',
        match: (stmt) =>
          stmt.table === 'event_room_blocks' &&
          whereColumnHasOperator(stmt, 'room_id', '=') &&
          whereColumnHasOperator(stmt, 'date', '='),
        respond,
      })
    }

    function addSavedGamesHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'SELECT saved_games active/table-scoped',
        verb: 'select',
        match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
        respond,
      })
    }

    function addEventsHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'SELECT events by id',
        verb: 'select',
        match: (stmt) => stmt.table === 'events' && whereHasColumn(stmt, 'id'),
        respond,
      })
    }

    it('returns {} early without querying reservations when the room has no tables', async () => {
      addTablesHandler([])
      // No reservations/event_room_blocks/saved_games handlers registered —
      // if the implementation queried them despite having no tables, the
      // mock would throw "no handler matched", failing this test loudly.

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('empty-room', '2025-01-01')

      expect(result).toEqual({})
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('maps a reservations DB error to a 500 ServiceError', async () => {
      addTablesHandler([makeTableRow({ id: 't1' })])
      addReservationsHandler(() => {
        throw new Error('connection reset')
      })
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => [])

      const { getRoomTablesAvailability } = await loadRoomsService()
      await expect(getRoomTablesAvailability('1', '2025-01-01')).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('maps an event_room_blocks DB error to a 500 ServiceError', async () => {
      addTablesHandler([makeTableRow({ id: 't1' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => {
        throw new Error('connection reset')
      })
      addSavedGamesHandler(() => [])

      const { getRoomTablesAvailability } = await loadRoomsService()
      await expect(getRoomTablesAvailability('1', '2025-01-01')).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('maps a saved_games DB error to a 500 ServiceError', async () => {
      addTablesHandler([makeTableRow({ id: 't1' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => {
        throw new Error('connection reset')
      })

      const { getRoomTablesAvailability } = await loadRoomsService()
      await expect(getRoomTablesAvailability('1', '2025-01-01')).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('filters out expired pending reservations without activated_at', async () => {
      addTablesHandler([makeTableRow({ id: 't1', type: 'small' })])
      addReservationsHandler(() => [
        makeReservationRow({
          id: 'pending-expired',
          table_id: 't1',
          status: 'pending',
          activated_at: null,
          start_time: '06:00:00',
          end_time: '07:00:00',
        }),
      ])
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => [])
      // now (09:00 UTC) is past the pending check-in deadline for a 06:00-07:00 slot
      getDatabaseNowMock.mockResolvedValue(new Date('2025-01-01T09:00:00.000Z'))

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      // The expired pending reservation must NOT block the slot.
      const slot = result.t1?.slots.find((s) => s.startTime === '06:00')
      expect(slot?.available).toBe(true)
    })

    it('keeps a pending reservation with activated_at set even past the deadline', async () => {
      addTablesHandler([makeTableRow({ id: 't1', type: 'small' })])
      addReservationsHandler(() => [
        makeReservationRow({
          id: 'pending-activated',
          table_id: 't1',
          status: 'pending',
          activated_at: '2025-01-01T05:00:00.000Z',
          start_time: '06:00:00',
          end_time: '07:00:00',
        }),
      ])
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => [])
      getDatabaseNowMock.mockResolvedValue(new Date('2025-01-01T09:00:00.000Z'))

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      const slot = result.t1?.slots.find((s) => s.startTime === '06:00')
      expect(slot?.available).toBe(false)
    })

    it('a null table_id event block blocks every table in the room', async () => {
      addTablesHandler([makeTableRow({ id: 't1' }), makeTableRow({ id: 't2' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [makeEventBlockRow({ table_id: null, start_time: '14:00:00', end_time: '15:00:00' })])
      addSavedGamesHandler(() => [])
      addEventsHandler(() => [{ id: 'ev1', title: 'Tournament' }])

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      expect(result.t1?.slots.find((s) => s.startTime === '14:00')?.available).toBe(false)
      expect(result.t2?.slots.find((s) => s.startTime === '14:00')?.available).toBe(false)
    })

    it('a specific table_id event block only blocks that table', async () => {
      addTablesHandler([makeTableRow({ id: 't1' }), makeTableRow({ id: 't2' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [makeEventBlockRow({ table_id: 't1', start_time: '14:00:00', end_time: '15:00:00' })])
      addSavedGamesHandler(() => [])
      addEventsHandler(() => [{ id: 'ev1', title: 'Tournament' }])

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      expect(result.t1?.slots.find((s) => s.startTime === '14:00')?.available).toBe(false)
      expect(result.t2?.slots.find((s) => s.startTime === '14:00')?.available).toBe(true)
    })

    it('looks up event titles when eventIds are present', async () => {
      addTablesHandler([makeTableRow({ id: 't1' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [makeEventBlockRow({ table_id: null, event_id: 'ev1', start_time: '14:00:00', end_time: '15:00:00' })])
      addSavedGamesHandler(() => [])
      const eventsHandlerSpy = vi.fn(() => [{ id: 'ev1', title: 'Tournament Night' }])
      addEventsHandler(eventsHandlerSpy)

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      expect(eventsHandlerSpy).toHaveBeenCalledTimes(1)
      expect(result.t1?.slots.find((s) => s.startTime === '14:00')?.label).toBe('Tournament Night')
    })

    it('skips the events lookup entirely when there are no event blocks', async () => {
      addTablesHandler([makeTableRow({ id: 't1' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => [])
      // No events handler registered — if the implementation queried events
      // despite an empty eventIds list, the mock throws "no handler matched".

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      expect(result.t1?.slots.every((s) => s.available)).toBe(true)
    })

    it('marks the bottom surface blocked by an active saved game for a removable_top table', async () => {
      addTablesHandler([makeTableRow({ id: 't1', type: 'removable_top' })])
      addReservationsHandler(() => [])
      addEventBlocksHandler(() => [])
      addSavedGamesHandler(() => [{ table_id: 't1' }])

      const { getRoomTablesAvailability } = await loadRoomsService()
      const result = await getRoomTablesAvailability('1', '2025-01-01')

      expect(result.t1?.bottom?.every((s) => !s.available)).toBe(true)
    })
  })

  describe('createTableEntry', () => {
    it('throws 400 when name is missing', async () => {
      const { createTableEntry } = await loadRoomsService()
      await expect(createTableEntry('1', { type: 'small' })).rejects.toMatchObject({ name: 'ServiceError', statusCode: 400 })
    })

    it('throws 400 when type is invalid', async () => {
      const { createTableEntry } = await loadRoomsService()
      await expect(createTableEntry('1', { name: 'Mesa X', type: 'invalid_type' })).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
      })
    })

    it.each(['small', 'large', 'removable_top'] as const)('accepts valid type %s', async (type) => {
      sqlMock.addHandler({
        name: 'INSERT tables',
        verb: 'insert',
        match: (stmt) => stmt.table === 'tables',
        respond: (stmt) => [
          makeTableRow({
            room_id: stmt.values[0] as string,
            name: stmt.values[1] as string,
            type: stmt.values[2] as typeof type,
          }),
        ],
      })

      const { createTableEntry } = await loadRoomsService()
      const result = await createTableEntry('1', { name: 'Mesa X', type })
      expect(result.type).toBe(type)
    })

    it('maps a foreign-key violation (23503) to a 400 "Invalid room ID" error', async () => {
      sqlMock.addHandler({
        name: 'INSERT tables — FK violation',
        verb: 'insert',
        match: (stmt) => stmt.table === 'tables',
        respond: () => {
          const err = new NeonDbError('insert or update on table "tables" violates foreign key constraint')
          ;(err as unknown as { code: string }).code = '23503'
          throw err
        },
      })

      const { createTableEntry } = await loadRoomsService()
      await expect(createTableEntry('nonexistent-room', { name: 'Mesa X', type: 'small' })).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 400,
        message: 'Invalid room ID',
      })
    })

    it('maps a non-FK DB error to a 500 ServiceError', async () => {
      sqlMock.addHandler({
        name: 'INSERT tables — generic failure',
        verb: 'insert',
        match: (stmt) => stmt.table === 'tables',
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { createTableEntry } = await loadRoomsService()
      await expect(createTableEntry('1', { name: 'Mesa X', type: 'small' })).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 500,
      })
    })

    it('triggers a fire-and-forget regenerateQrCodes call on success when NEXT_PUBLIC_APP_URL is set', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://test.example.com')
      sqlMock.addHandler({
        name: 'INSERT tables',
        verb: 'insert',
        match: (stmt) => stmt.table === 'tables',
        respond: () => [makeTableRow({ id: 't1' })],
      })

      const { createTableEntry } = await loadRoomsService()
      const result = await createTableEntry('1', { name: 'Mesa 1', type: 'small' })

      expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
      expect(regenerateQrCodesMock).toHaveBeenCalledWith('t1')
    })

    it('does not call regenerateQrCodes when NEXT_PUBLIC_APP_URL is unset', async () => {
      vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
      sqlMock.addHandler({
        name: 'INSERT tables',
        verb: 'insert',
        match: (stmt) => stmt.table === 'tables',
        respond: () => [makeTableRow({ id: 't1' })],
      })

      const { createTableEntry } = await loadRoomsService()
      await createTableEntry('1', { name: 'Mesa 1', type: 'small' })

      expect(regenerateQrCodesMock).not.toHaveBeenCalled()
    })
  })
})
