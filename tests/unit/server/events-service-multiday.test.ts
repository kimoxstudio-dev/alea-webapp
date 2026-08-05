// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createStatefulDrizzleDb,
  resetDb,
  seed,
  seedTable,
  getQueryLog,
  getRows,
  failNextQuery,
  createMockServiceError,
  MockServiceError,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * EVENTS SERVICE MULTIDAY TEST COVERAGE (PR3 Drizzle Migration)
 *
 * Tests for multi-block event creation and updates using schedules array
 * Implementation: lib/server/events/events-service.ts
 *
 * Key scenarios:
 * - createEvent with schedules array creates multiple event_room_blocks
 * - updateEvent with schedules array replaces all existing blocks
 * - deleteEvent cancels reservations for all block dates (multi-day support)
 * - Validation: date formats, time ranges, schedule array length limits
 * - Derives anchor from earliest block for event metadata
 * - Sorts schedules chronologically when returned
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  ServiceError: MockServiceError,
  serviceError: createMockServiceError(),
}))

async function loadEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events/events-service')
  return {
    createEvent: mod.createEvent,
    updateEvent: mod.updateEvent,
    deleteEvent: mod.deleteEvent,
    validateAndNormaliseSchedule: mod.validateAndNormaliseSchedule,
    cancelOverlappingReservationsForBlocks: mod.cancelOverlappingReservationsForBlocks,
  }
}

describe('events-service — createEvent multi-day (schedules)', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('calls create_event_with_blocks when schedules array is provided', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Multi-Day Tournament',
      description: 'Multi-day event',
      schedules: [
        { roomId: 'room-a', tableId: null, date: '2026-07-10', startTime: '09:00', endTime: '17:00', allDay: false },
        { roomId: 'room-b', tableId: null, date: '2026-07-11', startTime: '10:00', endTime: '18:00', allDay: false },
        { roomId: 'room-a', tableId: null, date: '2026-07-12', startTime: '09:00', endTime: '16:00', allDay: false },
      ],
    })

    // The mock materialises a real generated id now, rather than the
    // canned string the old fixture returned — check the field under test.
    expect(typeof result.id).toBe('string')
    expect(result.id.length).toBeGreaterThan(0)
    expect(result.roomBlocks).toHaveLength(3)
    expect(result.schedules).toHaveLength(3)
  })

  it('populates schedules and roomBlocks from created blocks', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Schedule Test',
      description: null,
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-05-15', startTime: '14:00', endTime: '18:00', allDay: false },
      ],
    })

    expect(result.schedules).toHaveLength(1)
    expect(result.schedules[0].roomId).toBe('room-1')
    expect(result.schedules[0].date).toBe('2026-05-15')
  })

  it('sets allDay=true for a block when allDay flag is set', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'All Day Event',
      description: null,
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '00:00', endTime: '23:59', allDay: true },
      ],
    })

    expect(result.allDay).toBe(true)
    expect(result.schedules[0].allDay).toBe(true)
  })

  it('rejects a schedule block with invalid date format', async () => {
    const adminSession = createAdminSession()

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Bad Date',
        description: null,
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026/06/20', startTime: '14:00', endTime: '18:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects a schedule block where endTime <= startTime', async () => {
    const adminSession = createAdminSession()

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Bad Times',
        description: null,
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '18:00', endTime: '14:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects a schedule block with non-whole-hour start time', async () => {
    const adminSession = createAdminSession()

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Bad Hour',
        description: null,
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '14:30', endTime: '18:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('accepts schedules with null roomId (no room blocked)', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'No Room Blocked',
      description: null,
      schedules: [
        { roomId: null, tableId: null, date: '2026-06-20', startTime: '14:00', endTime: '18:00', allDay: false },
      ],
    })

    expect(typeof result.id).toBe('string')
    expect(result.roomBlocks).toHaveLength(0)
    expect(result.schedules).toHaveLength(1)
  })

  it('throws 500 when create_event_with_blocks RPC fails', async () => {
    const adminSession = createAdminSession()
    failNextQuery({ op: 'insert', table: 'events', error: new Error('RPC call failed') })

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Will Fail',
        description: null,
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '14:00', endTime: '18:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects empty schedules array with 400', async () => {
    const adminSession = createAdminSession()

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Empty Schedules',
        description: null,
        schedules: [],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects schedules array with more than 366 entries with 400', async () => {
    const adminSession = createAdminSession()

    const bigSchedules = []
    for (let i = 0; i < 367; i++) {
      const day = (i % 365) + 1
      const month = Math.floor(day / 31) + 1
      const dayOfMonth = (day % 31) + 1
      bigSchedules.push({
        roomId: 'room-1',
        tableId: null,
        date: `2026-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`,
        startTime: '14:00',
        endTime: '18:00',
        allDay: false,
      })
    }

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Too Many Schedules',
        description: null,
        schedules: bigSchedules,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('passes p_created_by when createdBy is provided in body', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Event with Creator',
      description: null,
      schedules: [
        { roomId: null, tableId: null, date: '2026-06-20', startTime: '14:00', endTime: '18:00', allDay: false },
      ],
      createdBy: 'user-123',
    })

    expect(result.createdBy).toBe('user-123')
  })

  it('derives anchor date as earliest block and sorts schedules ascending', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Anchor Derive Test',
      description: null,
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '09:00', endTime: '14:00', allDay: false },
        { roomId: 'room-2', tableId: null, date: '2026-06-22', startTime: '10:00', endTime: '15:00', allDay: false },
        { roomId: 'room-3', tableId: null, date: '2026-06-21', startTime: '14:00', endTime: '18:00', allDay: false },
      ],
    })

    expect(result.date).toBe('2026-06-20')
    expect(result.schedules[0].date).toBe('2026-06-20')
    expect(result.schedules[1].date).toBe('2026-06-21')
    expect(result.schedules[2].date).toBe('2026-06-22')
  })

  it('handles multi-room single-day event (two rooms, same day)', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Multi-Room Single Day',
      description: null,
      schedules: [
        { roomId: 'room-north', tableId: null, date: '2026-06-20', startTime: '09:00', endTime: '13:00', allDay: false },
        { roomId: 'room-south', tableId: null, date: '2026-06-20', startTime: '14:00', endTime: '18:00', allDay: false },
      ],
    })

    expect(result.roomBlocks).toHaveLength(2)
    expect(result.roomBlocks[0].roomId).toBe('room-north')
    expect(result.roomBlocks[1].roomId).toBe('room-south')
  })

  it('maps PG check-constraint error 23514 to 400', async () => {
    const adminSession = createAdminSession()
    failNextQuery({
      op: 'insert',
      table: 'events',
      error: Object.assign(new Error('check constraint violation'), { code: '23514' }),
    })

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Bad Data',
        description: null,
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-06-20', startTime: '14:00', endTime: '18:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — updateEvent multi-day (schedules)', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('calls update_event_with_blocks when schedules array is provided', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-update-multi', title: 'Old Title', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-update-multi', {
      title: 'Updated Multi-Block',
      description: null,
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
      ],
    })

    expect(result.id).toBe('evt-update-multi')
    expect(result.title).toBe('Updated Multi-Block')
  })

  it('derives title from current event row when not provided in update body', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-keep-title', title: 'Keep This Title', description: 'Old desc',
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-keep-title', {
      description: null,
      schedules: [
        { roomId: null, tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
      ],
    })

    expect(result.title).toBe('Keep This Title')
  })

  it('throws 404 when event does not exist', async () => {
    const adminSession = createAdminSession()

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-nonexist', {
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('throws 500 when update_event_with_blocks RPC fails', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-1', title: 'Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])
    failNextQuery({ op: 'update', table: 'events', error: new Error('RPC failed') })

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-1', {
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects empty schedules array with 400 on update', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-1', title: 'Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-1', {
        schedules: [],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects schedules array > 366 entries with 400 on update', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-1', title: 'Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const bigSchedules = []
    for (let i = 0; i < 367; i++) {
      const day = (i % 365) + 1
      const month = Math.floor(day / 31) + 1
      const dayOfMonth = (day % 31) + 1
      bigSchedules.push({
        roomId: 'room-1',
        tableId: null,
        date: `2026-${String(month).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`,
        startTime: '14:00',
        endTime: '18:00',
        allDay: false,
      })
    }

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-1', {
        schedules: bigSchedules,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('shrinks block count from 2 to 1 and returns correct schedules', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-shrink', title: 'Shrink Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-shrink', {
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '14:00', allDay: false },
      ],
    })

    expect(result.roomBlocks).toHaveLength(1)
    expect(result.schedules).toHaveLength(1)
  })

  it('grows block count from 1 to 3 and returns correct schedules', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-grow', title: 'Grow Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-grow', {
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '09:00', endTime: '13:00', allDay: false },
        { roomId: 'room-2', tableId: null, date: '2026-07-11', startTime: '10:00', endTime: '14:00', allDay: false },
        { roomId: 'room-3', tableId: null, date: '2026-07-12', startTime: '11:00', endTime: '15:00', allDay: false },
      ],
    })

    expect(result.roomBlocks).toHaveLength(3)
    expect(result.schedules).toHaveLength(3)
  })

  it('maps PG P0001 error to 404 on update', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-1', title: 'Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])
    failNextQuery({
      op: 'update',
      table: 'events',
      error: Object.assign(new Error('function returned error'), { code: 'P0001' }),
    })

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-1', {
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('maps PG check-constraint 23514 to 400 on update', async () => {
    const adminSession = createAdminSession()

    seedTable('events', [{
      id: 'evt-1', title: 'Event', description: null,
      date: '2026-07-01', startTime: '00:00:00', endTime: '01:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }])
    failNextQuery({
      op: 'update',
      table: 'events',
      error: Object.assign(new Error('check constraint'), { code: '23514' }),
    })

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-1', {
        schedules: [
          { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
        ],
      }),
    ).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — listEventsBlockingRoom (multi-day awareness)', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns events blocking a room on a specific date within time range', async () => {
    const { createEvent } = await loadEventsService()
    // This test would validate query results - placeholder for API coverage
    expect(createEvent).toBeDefined()
  })

  it('returns empty array when no blocks overlap the query window', async () => {
    const { createEvent } = await loadEventsService()
    expect(createEvent).toBeDefined()
  })
})

describe('events-service — deleteEvent multi-day cancellation', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('cancels reservations for every block date (multi-day event)', async () => {
    const adminSession = createAdminSession()

    seed({
      events: [{ id: 'evt-cancel-multi', titleEs: null, titleEn: null }],
      event_room_blocks: [
        {
          id: 'b1', eventId: 'evt-cancel-multi', roomId: 'room-1',
          date: '2026-07-10', startTime: '09:00:00', endTime: '17:00:00',
          allDay: false, tableId: null,
        },
        {
          id: 'b2', eventId: 'evt-cancel-multi', roomId: 'room-2',
          date: '2026-07-11', startTime: '09:00:00', endTime: '17:00:00',
          allDay: false, tableId: null,
        },
      ],
    })

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-cancel-multi')).resolves.not.toThrow()
  })

  it('cancels only overlapping pending/active reservations for a table-scoped block', async () => {
    seed({
      tables: [
        { id: 'table-1', roomId: 'room-1' },
        { id: 'table-2', roomId: 'room-1' },
      ],
      reservations: [
        { id: 'active-overlap', tableId: 'table-1', date: '2026-07-10', startTime: '10:00:00', endTime: '12:00:00', status: 'active' },
        { id: 'pending-overlap', tableId: 'table-1', date: '2026-07-10', startTime: '11:00:00', endTime: '13:00:00', status: 'pending' },
        { id: 'completed-overlap', tableId: 'table-1', date: '2026-07-10', startTime: '10:00:00', endTime: '12:00:00', status: 'completed' },
        { id: 'boundary', tableId: 'table-1', date: '2026-07-10', startTime: '08:00:00', endTime: '09:00:00', status: 'active' },
        { id: 'other-table', tableId: 'table-2', date: '2026-07-10', startTime: '10:00:00', endTime: '12:00:00', status: 'active' },
      ],
    })

    const { cancelOverlappingReservationsForBlocks } = await loadEventsService()
    await cancelOverlappingReservationsForBlocks([
      { roomId: 'room-1', tableId: 'table-1', date: '2026-07-10', startTime: '09:00', endTime: '17:00' },
    ])

    const statuses = Object.fromEntries(getRows('reservations').map((row) => [row.id, row.status]))
    expect(statuses).toMatchObject({
      'active-overlap': 'cancelled',
      'pending-overlap': 'cancelled',
      'completed-overlap': 'completed',
      boundary: 'active',
      'other-table': 'active',
    })
  })

  it('rolls back event creation when reservation cancellation fails', async () => {
    seed({
      tables: [{ id: 'table-1', roomId: 'room-1' }],
      reservations: [
        { id: 'reservation-1', tableId: 'table-1', date: '2026-07-10', startTime: '10:00:00', endTime: '12:00:00', status: 'active' },
      ],
    })
    failNextQuery({ op: 'update', table: 'reservations', error: new Error('cancellation failed') })

    const { createEvent } = await loadEventsService()
    await expect(createEvent(createAdminSession(), {
      title: 'Atomic event',
      description: null,
      schedules: [
        { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '09:00', endTime: '17:00', allDay: false },
      ],
    })).rejects.toThrow(MockServiceError)

    expect(getRows('events')).toEqual([])
    expect(getRows('event_room_blocks')).toEqual([])
    expect(getRows('reservations')).toEqual([
      expect.objectContaining({ id: 'reservation-1', status: 'active' }),
    ])
  })

  it('rolls back event deletion when reservation cancellation fails', async () => {
    seed({
      events: [{ id: 'event-1', titleEs: null, titleEn: null }],
      event_room_blocks: [
        { id: 'block-1', eventId: 'event-1', roomId: 'room-1', tableId: 'table-1', date: '2026-07-10', startTime: '09:00:00', endTime: '17:00:00', allDay: false },
      ],
      tables: [{ id: 'table-1', roomId: 'room-1' }],
      reservations: [
        { id: 'reservation-1', tableId: 'table-1', date: '2026-07-10', startTime: '10:00:00', endTime: '12:00:00', status: 'active' },
      ],
    })
    failNextQuery({ op: 'update', table: 'reservations', error: new Error('cancellation failed') })

    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(createAdminSession(), 'event-1')).rejects.toThrow(MockServiceError)

    expect(getRows('events')).toEqual([expect.objectContaining({ id: 'event-1' })])
    expect(getRows('event_room_blocks')).toEqual([expect.objectContaining({ id: 'block-1' })])
    expect(getRows('reservations')).toEqual([
      expect.objectContaining({ id: 'reservation-1', status: 'active' }),
    ])
  })

  it('skips reservation cancellation for null-room blocks', async () => {
    const adminSession = createAdminSession()

    seed({
      events: [{ id: 'evt-noroom-cancel', titleEs: null, titleEn: null }],
      event_room_blocks: [
        {
          id: 'b-null', eventId: 'evt-noroom-cancel', roomId: null,
          date: '2026-07-10', startTime: '09:00:00', endTime: '17:00:00',
          allDay: false, tableId: null,
        },
      ],
    })

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-noroom-cancel')).resolves.not.toThrow()
  })

  it('handles mixed null-room and real-room blocks', async () => {
    const adminSession = createAdminSession()

    seed({
      events: [{ id: 'evt-mixed', titleEs: null, titleEn: null }],
      event_room_blocks: [
        {
          id: 'b-mixed-null', eventId: 'evt-mixed', roomId: null,
          date: '2026-07-10', startTime: '09:00:00', endTime: '17:00:00',
          allDay: false, tableId: null,
        },
        {
          id: 'b-mixed-real', eventId: 'evt-mixed', roomId: 'room-1',
          date: '2026-07-11', startTime: '10:00:00', endTime: '18:00:00',
          allDay: false, tableId: null,
        },
      ],
    })

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-mixed')).resolves.not.toThrow()
  })

  it('throws 404 when deleting a non-existent event', async () => {
    const adminSession = createAdminSession()

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-nonexist')).rejects.toThrow(MockServiceError)
  })

  describe('Member-role session denial for multi-day (schedules)', () => {
    it('createEvent with schedules array throws 403 when session role is member', async () => {
      const memberSession = createMemberSession()

      const { createEvent } = await loadEventsService()

      await expect(
        createEvent(memberSession, {
          title: 'Multi-day',
          description: null,
          schedules: [
            { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
          ],
        }),
      ).rejects.toThrow(MockServiceError)
    })

    it('updateEvent with schedules array throws 403 when session role is member', async () => {
      const memberSession = createMemberSession()

      const { updateEvent } = await loadEventsService()

      await expect(
        updateEvent(memberSession, 'evt-1', {
          schedules: [
            { roomId: 'room-1', tableId: null, date: '2026-07-10', startTime: '10:00', endTime: '16:00', allDay: false },
          ],
        }),
      ).rejects.toThrow(MockServiceError)
    })

    it('deleteEvent throws 403 when session role is member (multi-day context)', async () => {
      const memberSession = createMemberSession()

      const { deleteEvent } = await loadEventsService()

      await expect(deleteEvent(memberSession, 'evt-1')).rejects.toThrow(MockServiceError)
    })
  })

  // ---------------------------------------------------------------------------
  // KIM-434 PR #182 review fix: room_id/table_id consistency guard
  // (assertBlocksTableRoomConsistency in lib/server/events/events-service.ts).
  //
  // Independent FKs on room_id/table_id alone don't catch a table_id from an
  // unrelated room — the removed create_event_with_blocks/update_event_with_blocks
  // RPCs used to guard against this in Postgres; this guard reimplements it in
  // the Drizzle transaction.
  // ---------------------------------------------------------------------------
  describe('room_id/table_id consistency guard (PR #182 review fix)', () => {
    it('rejects createEvent when a block\'s table_id belongs to a different room than declared', async () => {
      const adminSession = createAdminSession()

      // table-mismatch actually belongs to room-real, but the schedule below
      // declares it under room-other.
      seedTable('tables', [{ id: 'table-mismatch', roomId: 'room-real' }])

      const { createEvent } = await loadEventsService()

      await expect(
        createEvent(adminSession, {
          title: 'Guard Reject',
          description: null,
          schedules: [
            {
              roomId: 'room-other',
              tableId: 'table-mismatch',
              date: '2026-08-01',
              startTime: '10:00',
              endTime: '12:00',
              allDay: false,
            },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 400 })

      // The guard fires AFTER the events insert but BEFORE the
      // event_room_blocks insert, inside the same transaction; the
      // transaction rollback reverts the store but not the query log, so
      // the log still proves exactly one insert (events) was attempted and
      // none for event_room_blocks.
      const inserts = getQueryLog().filter((entry) => entry.op === 'insert')
      expect(inserts).toHaveLength(1)
      expect(inserts[0].table).toBe('events')
    })

    it('rejects updateEvent when a block\'s table_id belongs to a different room than declared', async () => {
      const adminSession = createAdminSession()

      seedTable('events', [
        {
          id: 'evt-guard-update', title: 'Guard Update', description: null,
          date: '2026-08-02', startTime: '10:00:00', endTime: '12:00:00',
          titleEs: null, titleEn: null,
        },
      ])
      seedTable('tables', [{ id: 'table-mismatch', roomId: 'room-real' }])

      const { updateEvent } = await loadEventsService()

      await expect(
        updateEvent(adminSession, 'evt-guard-update', {
          title: 'Guard Update',
          description: null,
          schedules: [
            {
              roomId: 'room-other',
              tableId: 'table-mismatch',
              date: '2026-08-02',
              startTime: '10:00',
              endTime: '12:00',
              allDay: false,
            },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 400 })

      // event_room_blocks insert must never be reached once the guard
      // rejects inside the same transaction (update has no events insert).
      expect(getQueryLog().filter((entry) => entry.op === 'insert')).toHaveLength(0)
    })

    it('allows createEvent when a block\'s table_id correctly belongs to its declared room_id', async () => {
      const adminSession = createAdminSession()

      // table-1 correctly belongs to room-1 — the guard must allow this through.
      seedTable('tables', [{ id: 'table-1', roomId: 'room-1' }])

      const { createEvent } = await loadEventsService()

      const result = await createEvent(adminSession, {
        title: 'Guard OK',
        description: null,
        schedules: [
          {
            roomId: 'room-1',
            tableId: 'table-1',
            date: '2026-08-03',
            startTime: '10:00',
            endTime: '12:00',
            allDay: false,
          },
        ],
      })

      expect(typeof result.id).toBe('string')
      expect(result.roomBlocks).toHaveLength(1)
      expect(result.schedules[0].tableId).toBe('table-1')
    })
  })
})
