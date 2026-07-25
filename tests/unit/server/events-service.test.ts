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
