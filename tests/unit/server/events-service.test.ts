// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createStatefulDrizzleDb,
  resetDb,
  seed,
  seedTable,
  getRows,
  getQueryLog,
  failNextQuery,
  executeMock,
  createMockServiceError,
  MockServiceError,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
  getAdminDb: vi.fn(() => ({
    from: vi.fn(() => ({
      update: vi.fn(() => ({
        in: vi.fn(() => ({
          eq: vi.fn(() => ({
            lt: vi.fn(() => ({
              gt: vi.fn(() => ({
                in: vi.fn(async () => ({ data: null, error: null })),
              })),
            })),
          })),
        })),
      })),
    })),
  })),
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
    isClubEventRow: mod.isClubEventRow,
    deleteEventCascade: mod.deleteEventCascade,
    cancelSavedGamesForBlockedRoom: mod.cancelSavedGamesForBlockedRoom,
  }
}

describe('events-service — createEvent with roomId cancellation', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('calls create_event_atomic with correct parameters', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()
    const result = await createEvent(adminSession, {
      title: 'Game Night', description: 'Weekly session',
      date: '2026-04-15', startTime: '18:00', endTime: '22:00',
      roomId: 'room-1', allDay: false,
    })
    // The mock now materialises a real row from .values(), so the id is a
    // genuinely generated uuid rather than a canned string — assert on the
    // fields the test actually cares about instead of a hardcoded id.
    expect(typeof result.id).toBe('string')
    expect(result.id.length).toBeGreaterThan(0)
    expect(result.title).toBe('Game Night')
    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-1')
  })

  it('does not attempt cancellation when roomId is not provided', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()
    const result = await createEvent(adminSession, {
      title: 'Announcement', description: null,
      date: '2026-04-15', startTime: '19:00', endTime: '20:00',
      roomId: null, allDay: false,
    })
    expect(result.roomBlocks.length).toBe(0)
  })

  it('includes description when provided', async () => {
    const adminSession = createAdminSession()
    const { createEvent } = await loadEventsService()
    const result = await createEvent(adminSession, {
      title: 'Tournament', description: 'Competitive',
      date: '2026-04-20', startTime: '14:00', endTime: '18:00',
      roomId: null, allDay: false,
    })
    expect(result.description).toBe('Competitive')
  })

  it('throws 500 when DB transaction fails', async () => {
    const adminSession = createAdminSession()
    failNextQuery({ op: 'insert', table: 'events', error: new Error('Failed') })
    const { createEvent } = await loadEventsService()
    await expect(createEvent(adminSession, {
      title: 'Game Night', description: null,
      date: '2026-04-15', startTime: '18:00', endTime: '22:00',
      roomId: 'room-1', allDay: false,
    })).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — updateEvent with cancellation', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('calls update_event_atomic with updated values', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-4', title: 'Old', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-4', {
      title: 'Updated', description: null,
      date: '2026-04-20', startTime: '16:00', endTime: '20:00',
      roomId: null, allDay: false,
    })
    expect(result.title).toBe('Updated')
  })

  it('loads existing room when roomId is not provided', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-5', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-5', {
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })
    expect(result.roomBlocks.length).toBe(0)
  })

  it('keeps existing room when allDay is updated', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-6', title: 'All-Day', description: null,
      date: '2026-04-20', startTime: '00:00:00', endTime: '23:59:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-6', {
      title: 'All-Day', description: null,
      date: '2026-04-20', startTime: '00:00', endTime: '23:59',
      roomId: null, allDay: true,
    })
    expect(result.allDay).toBe(true)
  })

  it('updates room when roomId is provided', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-7', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-7', {
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: 'room-new', allDay: false,
    })
    expect(result.id).toBe('evt-7')
    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-new')
  })

  it('removes room when roomId is explicitly set to null', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-8', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-8', {
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })
    expect(result.roomBlocks.length).toBe(0)
  })

  it('throws 404 when event not found', async () => {
    const adminSession = createAdminSession()
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-missing', {
      title: 'Title', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('throws 500 when update fails', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-9', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    failNextQuery({ op: 'update', table: 'events', error: new Error('DB error') })
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-9', {
      title: 'Title', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('rejects non-hour start times', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-10', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-10', {
      title: 'Title', description: null,
      date: '2026-04-20', startTime: '18:30', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — isClubEventRow guard', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('updateEvent rejects club event rows (both bilingual)', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-club', title: 'Club', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: 'Club', titleEn: 'Club',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-club', {
      title: 'Updated', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('deleteEvent rejects club event rows', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-club', titleEs: 'Club', titleEn: 'Club',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(adminSession, 'evt-club')).rejects.toThrow(MockServiceError)
  })

  it('updateEvent allows legacy rows (one bilingual)', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-legacy', title: 'Legacy', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: 'Legacy',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-legacy', {
      title: 'Updated Legacy', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })
    expect(result.id).toBe('evt-legacy')
  })

  it('deleteEvent allows legacy rows', async () => {
    const adminSession = createAdminSession()
    seedTable('events', [{
      id: 'evt-legacy-del', titleEs: null, titleEn: 'Legacy',
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    }])
    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(adminSession, 'evt-legacy-del')).resolves.not.toThrow()
  })
})

describe('events-service — Member-role denial', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('createEvent throws 403 for member', async () => {
    const memberSession = createMemberSession()
    const { createEvent } = await loadEventsService()
    await expect(createEvent(memberSession, {
      title: 'Game Night', description: null,
      date: '2026-04-15', startTime: '18:00', endTime: '22:00',
      roomId: 'room-1', allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('updateEvent throws 403 for member', async () => {
    const memberSession = createMemberSession()
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(memberSession, 'evt-1', {
      title: 'Updated', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('deleteEvent throws 403 for member', async () => {
    const memberSession = createMemberSession()
    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(memberSession, 'evt-1')).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — cancelSavedGamesForBlockedRoom cascade (KIM-434 PR #182 review fix)', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('cancels active saved_games on OTHER tables in the same room, not just the blocked table (room-scoped, not table-scoped)', async () => {
    // "room-1" has two tables. The block only names the room (the cascade
    // is deliberately room-scoped — see the doc comment above
    // cancelSavedGamesForBlockedRoom in events-service.ts), so an active
    // saved_games row on EITHER table must be a cancellation candidate.
    seed({
      tables: [
        { id: 'table-A', roomId: 'room-1' },
        { id: 'table-B', roomId: 'room-1' },
      ],
      // The one row that qualifies (status active, date within range) lives
      // on table-B — the table NOT explicitly named by the block.
      saved_games: [{
        id: 'sg-other-table', tableId: 'table-B', userId: 'u1', status: 'active',
        startDate: '2026-07-01', endDate: '2026-07-20',
      }],
    })

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const db = createStatefulDrizzleDb()

    const cancelledCount = await db.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-1', tableId: null, date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(1)
    expect(getRows('saved_games')[0].status).toBe('cancelled')

    // Advisory lock taken once per table in the room, in ascending id order
    // (hashtextextended(table_id, 0) — same key/order as the dropped
    // trigger), and all locks acquired before the cancellation update runs.
    expect(executeMock).toHaveBeenCalledTimes(2)
    expect(executeMock.mock.calls[0][0].queryChunks[1]).toBe('table-A')
    expect(executeMock.mock.calls[1][0].queryChunks[1]).toBe('table-B')

    // The query log is the shared, operation-agnostic record of call order
    // across both flavours of the mock — use it (rather than a legacy
    // *Mock.mock.invocationCallOrder, which the state-driven mock does not
    // populate) to assert both executes happened strictly before the update.
    const log = getQueryLog()
    const lastExecuteIndex = log.map((entry) => entry.op).lastIndexOf('execute')
    const updateIndex = log.findIndex((entry) => entry.op === 'update')
    expect(lastExecuteIndex).toBeGreaterThanOrEqual(0)
    expect(updateIndex).toBeGreaterThan(lastExecuteIndex)
  })

  it('cancels only the selected table when the event block is table-scoped', async () => {
    seed({
      tables: [
        { id: 'table-A', roomId: 'room-1' },
        { id: 'table-B', roomId: 'room-1' },
      ],
      saved_games: [
        {
          id: 'sg-blocked-table', tableId: 'table-A', userId: 'u1', status: 'active',
          startDate: '2026-07-01', endDate: '2026-07-20',
        },
        {
          id: 'sg-unrelated-table', tableId: 'table-B', userId: 'u2', status: 'active',
          startDate: '2026-07-01', endDate: '2026-07-20',
        },
      ],
    })

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const db = createStatefulDrizzleDb()

    const cancelledCount = await db.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{
        roomId: 'room-1',
        tableId: 'table-A',
        date: '2026-07-10',
      }]),
    )

    expect(cancelledCount).toBe(1)
    expect(getRows('saved_games')).toEqual([
      expect.objectContaining({ id: 'sg-blocked-table', status: 'cancelled' }),
      expect.objectContaining({ id: 'sg-unrelated-table', status: 'active' }),
    ])
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(executeMock.mock.calls[0][0].queryChunks[1]).toBe('table-A')
  })

  it('does not cancel anything when no active saved_games overlap the block', async () => {
    // Empty candidate set stands in for a DB-side WHERE clause that already
    // excluded a row for any of: a different room, a non-overlapping date
    // range, or a status other than 'active' (already 'cancelled'/etc.) —
    // in every case the SELECT the code trusts returns nothing, so no
    // update should ever be attempted.
    seed({ tables: [{ id: 'table-A', roomId: 'room-1' }], saved_games: [] })

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const db = createStatefulDrizzleDb()

    const cancelledCount = await db.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-1', tableId: null, date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(0)
    expect(getQueryLog().filter((entry) => entry.op === 'update')).toHaveLength(0)
    // The advisory lock loop still runs — it must serialize against
    // validate_saved_game's matching lock regardless of whether anything
    // ends up being cancelled.
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('takes no advisory locks and performs no update when the blocked room has no tables', async () => {
    seed({ tables: [] })

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const db = createStatefulDrizzleDb()

    const cancelledCount = await db.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-empty', tableId: null, date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(0)
    expect(executeMock).not.toHaveBeenCalled()
    expect(getQueryLog().filter((entry) => entry.op === 'update')).toHaveLength(0)
  })
})
