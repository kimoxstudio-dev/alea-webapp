// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createDrizzleQueryBuilderWithDispatching,
  resetFixtures,
  setFixture,
  createMockServiceError,
  MockServiceError,
  insertMock,
  updateMock,
  deleteMock,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
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
  }
}

describe('events-service — createEvent with roomId cancellation', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('calls create_event_atomic RPC with correct parameters', async () => {
    const adminSession = createAdminSession()

    insertMock.mockResolvedValue([{
      id: 'evt-new-1',
      title: 'Game Night',
      description: 'Weekly game session',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '22:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [{
      id: 'block-new-1',
      eventId: 'evt-new-1',
      roomId: 'room-1',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }])
    setFixture('tables', [])

    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Game Night',
      description: 'Weekly game session',
      date: '2026-04-15',
      startTime: '18:00',
      endTime: '22:00',
      roomId: 'room-1',
      allDay: false,
    })

    expect(result.id).toBe('evt-new-1')
    expect(result.title).toBe('Game Night')
  })

  it('does not attempt cancellation when roomId is not provided', async () => {
    const adminSession = createAdminSession()

    insertMock.mockResolvedValue([{
      id: 'evt-no-room',
      title: 'Announcement',
      description: null,
      date: '2026-04-15',
      startTime: '19:00:00',
      endTime: '20:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [])

    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Announcement',
      description: null,
      date: '2026-04-15',
      startTime: '19:00',
      endTime: '20:00',
      roomId: null,
      allDay: false,
    })

    expect(result.id).toBe('evt-no-room')
    expect(result.roomBlocks.length).toBe(0)
  })

  it('includes description when provided', async () => {
    const adminSession = createAdminSession()

    insertMock.mockResolvedValue([{
      id: 'evt-desc',
      title: 'Tournament',
      description: 'Competitive tournament',
      date: '2026-04-20',
      startTime: '14:00:00',
      endTime: '18:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [])

    const { createEvent } = await loadEventsService()

    const result = await createEvent(adminSession, {
      title: 'Tournament',
      description: 'Competitive tournament',
      date: '2026-04-20',
      startTime: '14:00',
      endTime: '18:00',
      roomId: null,
      allDay: false,
    })

    expect(result.description).toBe('Competitive tournament')
  })

  it('throws 500 when RPC fails', async () => {
    const adminSession = createAdminSession()

    insertMock.mockRejectedValue(new Error('Connection failed'))

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(adminSession, {
        title: 'Game Night',
        description: null,
        date: '2026-04-15',
        startTime: '18:00',
        endTime: '22:00',
        roomId: 'room-1',
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — updateEvent with cancellation', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('calls update_event_atomic RPC with updated time values', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Old Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-update-1',
      title: 'Updated Event',
      description: null,
      date: '2026-04-20',
      startTime: '16:00:00',
      endTime: '20:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-update-1', {
      title: 'Updated Event',
      description: null,
      date: '2026-04-20',
      startTime: '16:00',
      endTime: '20:00',
      roomId: null,
      allDay: false,
    })

    expect(result.id).toBe('evt-update-1')
    expect(result.title).toBe('Updated Event')
  })

  it('loads existing room when roomId is not provided', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Old Title',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-keep-room',
      title: 'Updated Title Only',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [{
      id: 'block-existing',
      eventId: 'evt-keep-room',
      roomId: 'room-2',
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-keep-room', {
      title: 'Updated Title Only',
      description: null,
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
      roomId: null,
      allDay: false,
    })

    expect(result.roomBlocks.length).toBeGreaterThan(0)
  })

  it('keeps existing room when allDay is updated without roomId', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'All-Day Event',
      description: null,
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-allday',
      title: 'All-Day Event',
      description: null,
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [{
      id: 'block-allday',
      eventId: 'evt-allday',
      roomId: 'room-3',
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      allDay: true,
      tableId: null,
    }])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-allday', {
      title: 'All-Day Event',
      description: null,
      date: '2026-04-20',
      startTime: '00:00',
      endTime: '23:59',
      roomId: null,
      allDay: true,
    })

    expect(result.allDay).toBe(true)
  })

  it('updates room when roomId is provided', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Changed Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-room-change',
      title: 'Changed Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [{
      id: 'block-new-room',
      eventId: 'evt-room-change',
      roomId: 'room-new',
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }])
    setFixture('tables', [])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-room-change', {
      title: 'Changed Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
      roomId: 'room-new',
      allDay: false,
    })

    expect(result.id).toBe('evt-room-change')
  })

  it('removes room when roomId is explicitly set to null', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'No Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-remove-room',
      title: 'No Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-remove-room', {
      title: 'No Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
      roomId: null,
      allDay: false,
    })

    expect(result.roomBlocks.length).toBe(0)
  })

  it('throws 500 when event not found', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [])

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-nonexistent', {
        title: 'Title',
        description: null,
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: null,
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('throws 500 when RPC fails', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])
    updateMock.mockRejectedValue(new Error('DB error'))

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-update-1', {
        title: 'Title',
        description: null,
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: null,
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('rejects non-hour event start times', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }])

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-update-1', {
        title: 'Title',
        description: null,
        date: '2026-04-20',
        startTime: '18:30',
        endTime: '22:00',
        roomId: null,
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })
})

describe('events-service — isClubEventRow guard (Finding 3)', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('updateEvent rejects club event rows (both title_es and title_en set)', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Club Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: 'Evento de Club',
      titleEn: 'Club Event',
    }])

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(adminSession, 'evt-club', {
        title: 'Updated',
        description: null,
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: null,
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('deleteEvent rejects club event rows (both title_es and title_en set)', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      id: 'evt-club-del',
      titleEs: 'Evento de Club',
      titleEn: 'Club Event',
    }])

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-club-del')).rejects.toThrow(MockServiceError)
  })

  it('updateEvent allows legacy rows (only one of title_es or title_en)', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      title: 'Legacy Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: 'Legacy Event',
    }])
    updateMock.mockResolvedValue([{
      id: 'evt-legacy',
      title: 'Legacy Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      createdAt: new Date('2026-04-13'),
    }])
    setFixture('event_room_blocks', [])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-legacy', {
      title: 'Updated Legacy',
      description: null,
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
      roomId: null,
      allDay: false,
    })

    expect(result.id).toBe('evt-legacy')
  })

  it('deleteEvent allows legacy rows (only one of title_es or title_en)', async () => {
    const adminSession = createAdminSession()

    setFixture('events', [{
      id: 'evt-legacy-del',
      titleEs: null,
      titleEn: 'Legacy Event',
    }])
    setFixture('event_room_blocks', [])
    deleteMock.mockResolvedValue([])

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(adminSession, 'evt-legacy-del')).resolves.not.toThrow()
  })
})

describe('events-service — Member-role session denial (requireAdminSession)', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('createEvent throws 403 when session role is member', async () => {
    const memberSession = createMemberSession()

    const { createEvent } = await loadEventsService()

    await expect(
      createEvent(memberSession, {
        title: 'Game Night',
        description: null,
        date: '2026-04-15',
        startTime: '18:00',
        endTime: '22:00',
        roomId: 'room-1',
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('updateEvent throws 403 when session role is member', async () => {
    const memberSession = createMemberSession()

    const { updateEvent } = await loadEventsService()

    await expect(
      updateEvent(memberSession, 'evt-1', {
        title: 'Updated',
        description: null,
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: null,
        allDay: false,
      }),
    ).rejects.toThrow(MockServiceError)
  })

  it('deleteEvent throws 403 when session role is member', async () => {
    const memberSession = createMemberSession()

    const { deleteEvent } = await loadEventsService()

    await expect(deleteEvent(memberSession, 'evt-1')).rejects.toThrow(MockServiceError)
  })
})
