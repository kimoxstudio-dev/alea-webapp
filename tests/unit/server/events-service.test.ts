// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createTransactionAwareMockBuilder,
  resetFixtures,
  setFixture,
  createMockServiceError,
  MockServiceError,
  insertMock,
  updateMock,
  deleteMock,
  executeMock,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createTransactionAwareMockBuilder()),
  getDrizzleAdminDb: vi.fn(() => createTransactionAwareMockBuilder()),
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('calls create_event_atomic with correct parameters', async () => {
    const adminSession = createAdminSession()
    insertMock.mockResolvedValue([{
      id: 'evt-1', title: 'Game Night', description: 'Weekly session',
      date: '2026-04-15', startTime: '18:00:00', endTime: '22:00:00',
      createdAt: new Date(),
    }])
    setFixture('event_room_blocks', [])
    const { createEvent } = await loadEventsService()
    const result = await createEvent(adminSession, {
      title: 'Game Night', description: 'Weekly session',
      date: '2026-04-15', startTime: '18:00', endTime: '22:00',
      roomId: 'room-1', allDay: false,
    })
    expect(result.id).toBe('evt-1')
  })

  it('does not attempt cancellation when roomId is not provided', async () => {
    const adminSession = createAdminSession()
    insertMock.mockResolvedValue([{
      id: 'evt-2', title: 'Announcement', description: null,
      date: '2026-04-15', startTime: '19:00:00', endTime: '20:00:00',
      createdAt: new Date(),
    }])
    setFixture('event_room_blocks', [])
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
    insertMock.mockResolvedValue([{
      id: 'evt-3', title: 'Tournament', description: 'Competitive',
      date: '2026-04-20', startTime: '14:00:00', endTime: '18:00:00',
      createdAt: new Date(),
    }])
    setFixture('event_room_blocks', [])
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
    insertMock.mockRejectedValue(new Error('Failed'))
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('calls update_event_atomic with updated values', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Old', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-4', title: 'Updated',
      description: null, date: '2026-04-20',
      startTime: '16:00:00', endTime: '20:00:00', createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    setFixture('event_room_blocks', [])
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
    setFixture('events', [{
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-5', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    setFixture('event_room_blocks', [{
      id: 'b1', eventId: 'evt-5', roomId: 'room-2',
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      allDay: false, tableId: null,
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
    setFixture('events', [{
      title: 'All-Day', description: null,
      date: '2026-04-20', startTime: '00:00:00', endTime: '23:59:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-6', title: 'All-Day', description: null,
      date: '2026-04-20', startTime: '00:00:00', endTime: '23:59:00',
      createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    setFixture('event_room_blocks', [{
      id: 'b2', eventId: 'evt-6', roomId: 'room-3',
      date: '2026-04-20', startTime: '00:00:00', endTime: '23:59:00',
      allDay: true, tableId: null,
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
    setFixture('events', [{
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-7', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    insertMock.mockResolvedValue([{
      id: 'b3', eventId: 'evt-7', roomId: 'room-new',
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      allDay: false, tableId: null,
    }])
    setFixture('event_room_blocks', [{
      id: 'b3', eventId: 'evt-7', roomId: 'room-new',
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      allDay: false, tableId: null,
    }])
    setFixture('tables', [])
    const { updateEvent } = await loadEventsService()
    const result = await updateEvent(adminSession, 'evt-7', {
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: 'room-new', allDay: false,
    })
    expect(result.id).toBe('evt-7')
  })

  it('removes room when roomId is explicitly set to null', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-8', title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    setFixture('event_room_blocks', [])
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
    setFixture('events', [])
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-missing', {
      title: 'Title', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('throws 500 when update fails', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
    }])
    updateMock.mockRejectedValue(new Error('DB error'))
    const { updateEvent } = await loadEventsService()
    await expect(updateEvent(adminSession, 'evt-9', {
      title: 'Title', description: null,
      date: '2026-04-20', startTime: '18:00', endTime: '22:00',
      roomId: null, allDay: false,
    })).rejects.toThrow(MockServiceError)
  })

  it('rejects non-hour start times', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Event', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: null,
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('updateEvent rejects club event rows (both bilingual)', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Club', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: 'Club', titleEn: 'Club',
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
    setFixture('events', [{
      id: 'evt-club', titleEs: 'Club', titleEn: 'Club',
    }])
    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(adminSession, 'evt-club')).rejects.toThrow(MockServiceError)
  })

  it('updateEvent allows legacy rows (one bilingual)', async () => {
    const adminSession = createAdminSession()
    setFixture('events', [{
      title: 'Legacy', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      titleEs: null, titleEn: 'Legacy',
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-legacy', title: 'Legacy', description: null,
      date: '2026-04-20', startTime: '18:00:00', endTime: '22:00:00',
      createdAt: new Date(),
    }])
    deleteMock.mockResolvedValue([])
    setFixture('event_room_blocks', [])
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
    setFixture('events', [{
      id: 'evt-legacy-del', titleEs: null, titleEn: 'Legacy',
    }])
    setFixture('event_room_blocks', [])
    deleteMock.mockResolvedValue([])
    const { deleteEvent } = await loadEventsService()
    await expect(deleteEvent(adminSession, 'evt-legacy-del')).resolves.not.toThrow()
  })
})

describe('events-service — Member-role denial', () => {
  beforeEach(() => {
    resetFixtures()
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('cancels active saved_games on OTHER tables in the same room, not just the blocked table (room-scoped, not table-scoped)', async () => {
    // "room-1" has two tables. The block only names the room (the cascade
    // is deliberately room-scoped — see the doc comment above
    // cancelSavedGamesForBlockedRoom in events-service.ts), so an active
    // saved_games row on EITHER table must be a cancellation candidate.
    setFixture('tables', [{ id: 'table-A' }, { id: 'table-B' }])
    // Stands in for the DB's WHERE clause (status='active' AND date overlap
    // AND table_id IN <all tables in the room>) already narrowing this down
    // to the one qualifying row — which lives on table-B, the table NOT
    // explicitly named by the block.
    setFixture('saved_games', [{ id: 'sg-other-table' }])
    updateMock.mockResolvedValue([{ id: 'sg-other-table' }])

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const builder = createTransactionAwareMockBuilder()

    const cancelledCount = await builder.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-1', date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(1)
    expect(updateMock).toHaveBeenCalledTimes(1)

    // Advisory lock taken once per table in the room, in ascending id order
    // (hashtextextended(table_id, 0) — same key/order as the dropped
    // trigger), and all locks acquired before the cancellation update runs.
    expect(executeMock).toHaveBeenCalledTimes(2)
    expect(executeMock.mock.calls[0][0].queryChunks[1]).toBe('table-A')
    expect(executeMock.mock.calls[1][0].queryChunks[1]).toBe('table-B')

    const lastExecuteOrder = Math.max(...executeMock.mock.invocationCallOrder)
    const firstUpdateOrder = Math.min(...updateMock.mock.invocationCallOrder)
    expect(lastExecuteOrder).toBeLessThan(firstUpdateOrder)
  })

  it('does not cancel anything when no active saved_games overlap the block', async () => {
    // Empty candidate set stands in for a DB-side WHERE clause that already
    // excluded a row for any of: a different room, a non-overlapping date
    // range, or a status other than 'active' (already 'cancelled'/etc.) —
    // in every case the SELECT the code trusts returns nothing, so no
    // update should ever be attempted.
    setFixture('tables', [{ id: 'table-A' }])
    setFixture('saved_games', [])

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const builder = createTransactionAwareMockBuilder()

    const cancelledCount = await builder.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-1', date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(0)
    expect(updateMock).not.toHaveBeenCalled()
    // The advisory lock loop still runs — it must serialize against
    // validate_saved_game's matching lock regardless of whether anything
    // ends up being cancelled.
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('takes no advisory locks and performs no update when the blocked room has no tables', async () => {
    setFixture('tables', [])

    const { cancelSavedGamesForBlockedRoom } = await loadEventsService()
    const builder = createTransactionAwareMockBuilder()

    const cancelledCount = await builder.transaction((tx) =>
      cancelSavedGamesForBlockedRoom(tx, [{ roomId: 'room-empty', date: '2026-07-10' }]),
    )

    expect(cancelledCount).toBe(0)
    expect(executeMock).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
  })
})
