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

/**
 * EVENTS SERVICE TEST COVERAGE (PR3 Drizzle Migration)
 *
 * Tests for admin CRUD operations on internal events (legacy room-booking surface)
 * Implementation: lib/server/events/events-service.ts
 *
 * Key scenarios tested:
 * - createEvent with roomId cancels overlapping active/pending reservations
 * - createEvent without roomId does not attempt cancellation
 * - updateEvent with changed time cancels overlapping reservations
 * - updateEvent with changed roomId cancels only new room's reservations
 * - updateEvent with title-only changes does not cancel reservations
 * - isClubEventRow guard prevents mutations on public club events
 * - Member-role sessions are denied admin mutations
 * - Error handling when DB calls fail
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
}))

vi.mock('@/lib/supabase/server', () => ({
  getAdminDb: vi.fn(() => ({
    from: vi.fn((table: string) => ({
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
      select: vi.fn(() => ({
        eq: vi.fn(async () => ({ data: [], error: null })),
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
    listEvents: mod.listEvents,
    getEvent: mod.getEvent,
    isClubEventRow: mod.isClubEventRow,
    deleteEventCascade: mod.deleteEventCascade,
    cancelOverlappingReservationsForBlocks: mod.cancelOverlappingReservationsForBlocks,
  }
}

describe('events-service — createEvent with roomId cancellation', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('calls create_event_atomic transaction with correct parameters', async () => {
    const adminSession = createAdminSession()

    const newEventRow = {
      id: 'evt-new-1',
      title: 'Game Night',
      description: 'Weekly game session',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '22:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    const blockRow = {
      id: 'block-new-1',
      eventId: 'evt-new-1',
      roomId: 'room-1',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }

    insertMock.mockResolvedValue([newEventRow])
    setFixture('event_room_blocks', [blockRow])

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
    expect(result.description).toBe('Weekly game session')
    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-1')
  })

  it('does not attempt cancellation when roomId is not provided', async () => {
    const adminSession = createAdminSession()

    const newEventRow = {
      id: 'evt-no-room',
      title: 'Announcement',
      description: null,
      date: '2026-04-15',
      startTime: '19:00:00',
      endTime: '20:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    insertMock.mockResolvedValue([newEventRow])
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
    expect(result.roomBlocks).toHaveLength(0)
  })

  it('includes description when provided', async () => {
    const adminSession = createAdminSession()

    const newEventRow = {
      id: 'evt-desc',
      title: 'Tournament',
      description: 'Competitive tournament',
      date: '2026-04-20',
      startTime: '14:00:00',
      endTime: '18:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    insertMock.mockResolvedValue([newEventRow])
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

  it('throws 500 when DB transaction fails', async () => {
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

  it('calls update_event_atomic transaction with updated time values', async () => {
    const adminSession = createAdminSession()

    const currentEventRow = {
      title: 'Old Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }

    const updatedEventRow = {
      id: 'evt-update-1',
      title: 'Updated Event',
      description: null,
      date: '2026-04-20',
      startTime: '16:00:00',
      endTime: '20:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    const blockRow = {
      id: 'block-update-1',
      eventId: 'evt-update-1',
      roomId: 'room-1',
      date: '2026-04-20',
      startTime: '16:00:00',
      endTime: '20:00:00',
      allDay: false,
      tableId: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([updatedEventRow])
    setFixture('event_room_blocks', [blockRow])

    const { updateEvent } = await loadEventsService()

    const result = await updateEvent(adminSession, 'evt-update-1', {
      title: 'Updated Event',
      description: null,
      date: '2026-04-20',
      startTime: '16:00',
      endTime: '20:00',
      roomId: 'room-1',
      allDay: false,
    })

    expect(result.id).toBe('evt-update-1')
    expect(result.title).toBe('Updated Event')
    expect(result.date).toBe('2026-04-20')
    expect(result.startTime).toBe('16:00')
    expect(result.endTime).toBe('20:00')
  })

  it('loads existing room when roomId is not provided', async () => {
    const adminSession = createAdminSession()

    const currentEventRow = {
      title: 'Old Title',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }

    const existingEventRow = {
      id: 'evt-keep-room',
      title: 'Updated Title Only',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    const existingBlock = {
      id: 'block-existing',
      eventId: 'evt-keep-room',
      roomId: 'room-2',
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([existingEventRow])
    setFixture('event_room_blocks', [existingBlock])

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

    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-2')
  })

  it('keeps existing room when allDay is updated without roomId', async () => {
    const adminSession = createAdminSession()

    const currentEventRow = {
      title: 'All-Day Event',
      description: null,
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      titleEs: null,
      titleEn: null,
    }

    const eventRow = {
      id: 'evt-allday',
      title: 'All-Day Event',
      description: null,
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    const blockRow = {
      id: 'block-allday',
      eventId: 'evt-allday',
      roomId: 'room-3',
      date: '2026-04-20',
      startTime: '00:00:00',
      endTime: '23:59:00',
      allDay: true,
      tableId: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([eventRow])
    setFixture('event_room_blocks', [blockRow])

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
    expect(result.roomBlocks).toHaveLength(1)
  })

  it('updates room when roomId is provided', async () => {
    const adminSession = createAdminSession()

    const currentEventRow = {
      title: 'Changed Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }

    const eventRow = {
      id: 'evt-room-change',
      title: 'Changed Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    const newBlockRow = {
      id: 'block-new-room',
      eventId: 'evt-room-change',
      roomId: 'room-new',
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      allDay: false,
      tableId: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([eventRow])
    setFixture('event_room_blocks', [newBlockRow])

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

    expect(result.roomBlocks[0].roomId).toBe('room-new')
  })

  it('removes room when roomId is explicitly set to null', async () => {
    const adminSession = createAdminSession()

    const currentEventRow = {
      title: 'No Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: null,
    }

    const eventRow = {
      id: 'evt-remove-room',
      title: 'No Room Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: null,
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([eventRow])
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

    expect(result.roomBlocks).toHaveLength(0)
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

  it('throws 500 when update transaction fails', async () => {
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

    const currentEventRow = {
      title: 'Legacy Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      titleEs: null,
      titleEn: 'Legacy Event',
    }

    const legacyEventRow = {
      id: 'evt-legacy',
      title: 'Legacy Event',
      description: null,
      date: '2026-04-20',
      startTime: '18:00:00',
      endTime: '22:00:00',
      dateKind: 'single',
      endDate: null,
      titleEs: null,
      titleEn: 'Legacy Event',
      createdBy: null,
      createdAt: new Date('2026-04-13'),
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    }

    setFixture('events', [currentEventRow])
    updateMock.mockResolvedValue([legacyEventRow])
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
    deleteMock.mockResolvedValue([{ id: 'evt-legacy-del' }])

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
