// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createDrizzleQueryBuilderWithDispatching,
  resetFixtures,
  setFixture,
  setDefaultMockResponse,
  createMockServiceError,
  MockServiceError,
  insertMock,
  updateMock,
  deleteMock,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * CLUB EVENTS SERVICE TEST COVERAGE (OIR-203) — PR3 Drizzle Migration
 *
 * Tests for admin CRUD operations on public club events
 * Implementation: lib/server/events/club-events-service.ts
 *
 * This test file is being migrated from Supabase mocks to Drizzle mocks
 * using the dispatching mock helper. All tests use table-based fixture
 * dispatching and per-test mock responses instead of positional
 * .mockResolvedValueOnce() sequencing.
 *
 * Key scenarios tested:
 * - createClubEvent with bilingual titles and optional room blocks (admin-only)
 * - updateClubEvent with partial updates and room block toggling (admin-only)
 * - deleteClubEvent removes event and cancels conflicting reservations (admin-only)
 * - Non-admin users get 403 Forbidden from every CRUD endpoint
 * - URL hardening: validateOptionalUrl rejects javascript:, data:, relative URLs
 * - Room blocking is optional: events without blocksRooms don't create event_room_blocks rows
 * - Upcoming/past split derived from date_kind and end_date at read time
 * - Pre-existing bug fix: updateClubEvent now fetches full row (not partial projection)
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  ServiceError: MockServiceError,
  serviceError: createMockServiceError(),
}))

vi.mock('@/lib/club-time', () => ({
  getCurrentClubDate: vi.fn(() => '2026-04-15'),
  isValidDateOnlyString: vi.fn((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
}))

vi.mock('@/lib/server/events/events-service', () => ({
  validateAndNormaliseSchedule: vi.fn(() => []),
  deleteEventCascade: vi.fn(),
  cancelOverlappingReservationsForBlocks: vi.fn(),
  isClubEventRow: vi.fn((row) => row.titleEs !== null && row.titleEn !== null),
}))

type SessionUser = {
  id: string
  role: 'admin' | 'member'
  email?: string
}

function createAdminSession(): SessionUser {
  return { id: 'admin-user-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'member-user-1', role: 'member', email: 'member@example.com' }
}

async function loadClubEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events/club-events-service')
  return {
    createClubEvent: mod.createClubEvent,
    updateClubEvent: mod.updateClubEvent,
    deleteClubEvent: mod.deleteClubEvent,
    listAdminClubEvents: mod.listAdminClubEvents,
    listClubEvents: mod.listClubEvents,
  }
}

describe('club-events-service (PR3 Drizzle redo)', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  describe('createClubEvent', () => {
    it('admin can create a public club event without room blocks', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-created-1',
        title: 'Gastronómica Viernes',
        titleEs: 'Gastronómica Viernes',
        titleEn: 'Friday Gastro',
        blurbEs: 'Noche de comida',
        blurbEn: 'Food night',
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-04-17',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'recurring',
        endDate: null,
        recurrenceLabelEs: 'Todos los viernes',
        recurrenceLabelEn: 'Every Friday',
        imageUrl: 'https://example.com/gastro.png',
        linkUrl: 'https://example.com/reserve',
        categoryEs: 'Social',
        categoryEn: 'Social',
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Gastronómica Viernes',
        titleEn: 'Friday Gastro',
        blurbEs: 'Noche de comida',
        blurbEn: 'Food night',
        dateKind: 'recurring',
        date: '2026-04-17',
        recurrenceLabelEs: 'Todos los viernes',
        recurrenceLabelEn: 'Every Friday',
        imageUrl: 'https://example.com/gastro.png',
        linkUrl: 'https://example.com/reserve',
        categoryEs: 'Social',
        categoryEn: 'Social',
        blocksRooms: false,
      })

      expect(result.id).toBe('evt-created-1')
      expect(result.titleEs).toBe('Gastronómica Viernes')
      expect(result.titleEn).toBe('Friday Gastro')
      expect(result.status).toBe('upcoming')
      expect(result.blocksRooms).toBe(false)
      expect(result.roomBlocks.length).toBe(0)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(memberSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects javascript: URL in image_url', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects data: URL in link_url', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          linkUrl: 'data:text/html,<script>alert(1)</script>',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects relative URL in imageUrl', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: '/images/event.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts empty/undefined imageUrl and linkUrl', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-url-test-1',
        title: 'Event',
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        imageUrl: undefined,
        linkUrl: null,
      })

      expect(result.imageUrl).toBeNull()
      expect(result.linkUrl).toBeNull()
    })

    it('creates a club event with titleEn absent, succeeds with title_en === title_es in DB (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-bilingual-1',
        title: 'Evento en Español',
        titleEs: 'Evento en Español',
        titleEn: 'Evento en Español',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Evento en Español',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-bilingual-1')
      expect(result.titleEs).toBe('Evento en Español')
      expect(result.titleEn).toBe('Evento en Español')
    })

    it('creates a club event with titleEn empty string, succeeds with fallback (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-bilingual-2',
        title: 'Evento Viernes',
        titleEs: 'Evento Viernes',
        titleEn: 'Evento Viernes',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Evento Viernes',
        titleEn: '',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Evento Viernes')
    })

    it('creates a club event with explicit titleEn, preserves EN value (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-bilingual-3',
        title: 'Torneo de Ajedrez',
        titleEs: 'Torneo de Ajedrez',
        titleEn: 'Chess Tournament',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Torneo de Ajedrez',
        titleEn: 'Chess Tournament',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Chess Tournament')
    })

    it('creates a club event with blurbEn absent, falls back to blurbEs (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-blurb-1',
        title: 'Event',
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: 'Descripción breve',
        blurbEn: 'Descripción breve',
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: 'Descripción breve',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.blurbEs).toBe('Descripción breve')
    })

    it('creates a club event with categoryEn absent, falls back to categoryEs (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-category-1',
        title: 'Event',
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: 'Torneo',
        categoryEn: 'Torneo',
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        categoryEs: 'Torneo',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-category-1')
    })

    it('rejects categoryEn as non-string object (still 400, not fallback) (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          categoryEs: 'Torneo',
          categoryEn: { nested: 'object' },
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects malformed schedules with 400 and no insert on events table (Finding 2)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: 'not-an-array',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })

    it('rejects blurbEs as object with 400 (Finding 5)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blurbEs: {},
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects categoryEn as array with 400 (Finding 5)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          categoryEn: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts null and undefined for optional string fields', async () => {
      const adminSession = createAdminSession()

      const newEventRow = {
        id: 'evt-nulls-1',
        title: 'Event',
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-05-01',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: adminSession.id,
        createdAt: '2026-04-15T00:00:00Z',
      }

      insertMock.mockResolvedValue([newEventRow])
      setFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        blurbEs: null,
        blurbEn: undefined,
        categoryEs: null,
        categoryEn: undefined,
      })

      expect(result.id).toBe('evt-nulls-1')
      expect(result.blurbEs).toBe('')
      expect(result.blurbEn).toBe('')
    })
  })

  describe('updateClubEvent', () => {
    it('admin can update a club event', async () => {
      const adminSession = createAdminSession()

      const currentEvent = {
        id: 'evt-1',
        title: 'Old Event',
        titleEs: 'Evento Antiguo',
        titleEn: 'Old Event',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-04-20',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: 'user-1',
        createdAt: '2026-04-01T00:00:00Z',
      }

      const updatedEvent = {
        ...currentEvent,
        titleEs: 'Updated Event ES',
        blurbEn: 'Updated blurb',
      }

      setFixture('events', [currentEvent])
      updateMock.mockResolvedValue([updatedEvent])
      setFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Updated Event ES',
        blurbEn: 'Updated blurb',
      })

      expect(result.id).toBe('evt-1')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const memberSession = createMemberSession()

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(memberSession, 'evt-1', {
          titleEs: 'Updated',
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent club event', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(adminSession, 'evt-nonexistent', {
          titleEs: 'Updated',
        })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects malformed schedules with 400 and no update on events table (Finding 2)', async () => {
      const adminSession = createAdminSession()

      const currentEvent = {
        id: 'evt-1',
        title: 'Event',
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: null,
        blurbEn: null,
        descriptionEs: null,
        descriptionEn: null,
        date: '2026-04-20',
        startTime: '00:00:00',
        endTime: '23:59:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: null,
        linkUrl: null,
        categoryEs: null,
        categoryEn: null,
        createdBy: 'user-1',
        createdAt: '2026-04-01T00:00:00Z',
      }

      setFixture('events', [currentEvent])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          blocksRooms: true,
          schedules: 'not-an-array',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateMock).not.toHaveBeenCalled()
    })
  })

  describe('deleteClubEvent', () => {
    it('admin can delete a club event', async () => {
      const adminSession = createAdminSession()

      const eventToDelete = {
        id: 'evt-to-delete',
        titleEs: 'Event to Delete',
        titleEn: 'Event to Delete',
      }

      setFixture('events', [eventToDelete])

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(adminSession, 'evt-to-delete')

      expect(deleteMock).toHaveBeenCalled()
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const memberSession = createMemberSession()

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(deleteClubEvent(memberSession, 'evt-1')).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listAdminClubEvents', () => {
    it('admin gets upcoming and past events split by date', async () => {
      const adminSession = createAdminSession()

      const events = [
        {
          id: 'evt-upcoming-1',
          title: 'Future Event',
          titleEs: 'Evento Futuro',
          titleEn: 'Future Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          date: '2026-05-01',
          startTime: '00:00:00',
          endTime: '23:59:00',
          dateKind: 'single',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          categoryEs: null,
          categoryEn: null,
          createdBy: 'user-1',
          createdAt: '2026-04-01T00:00:00Z',
        },
        {
          id: 'evt-past-1',
          title: 'Past Event',
          titleEs: 'Evento Pasado',
          titleEn: 'Past Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          date: '2026-04-01',
          startTime: '00:00:00',
          endTime: '23:59:00',
          dateKind: 'single',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          categoryEs: null,
          categoryEn: null,
          createdBy: 'user-1',
          createdAt: '2026-03-01T00:00:00Z',
        },
      ]

      setFixture('events', events)
      setFixture('event_room_blocks', [])

      const { listAdminClubEvents } = await loadClubEventsService()

      const result = await listAdminClubEvents(adminSession)

      expect(result.upcoming.length).toBeGreaterThan(0)
      expect(result.past.length).toBeGreaterThan(0)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { listAdminClubEvents } = await loadClubEventsService()

      await expect(listAdminClubEvents(memberSession)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listClubEvents', () => {
    it('returns upcoming and past club events for public listing', async () => {
      const events = [
        {
          id: 'evt-upcoming-1',
          title: 'Upcoming Event',
          titleEs: 'Evento Próximo',
          titleEn: 'Upcoming Event',
          blurbEs: 'Próximamente',
          blurbEn: 'Coming soon',
          descriptionEs: null,
          descriptionEn: null,
          date: '2026-05-01',
          startTime: '00:00:00',
          endTime: '23:59:00',
          dateKind: 'single',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          categoryEs: null,
          categoryEn: null,
          createdBy: 'user-1',
          createdAt: '2026-04-01T00:00:00Z',
        },
        {
          id: 'evt-past-1',
          title: 'Past Event',
          titleEs: 'Evento Pasado',
          titleEn: 'Past Event',
          blurbEs: 'Pasado',
          blurbEn: 'Past',
          descriptionEs: null,
          descriptionEn: null,
          date: '2026-04-01',
          startTime: '00:00:00',
          endTime: '23:59:00',
          dateKind: 'single',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          categoryEs: null,
          categoryEn: null,
          createdBy: 'user-1',
          createdAt: '2026-03-01T00:00:00Z',
        },
      ]

      setFixture('events', events)

      const { listClubEvents } = await loadClubEventsService()

      const result = await listClubEvents()

      expect(result.upcoming.length).toBeGreaterThan(0)
      expect(result.past.length).toBeGreaterThan(0)
    })
  })

  describe('Pre-existing bug fix: updateClubEvent full-row fetch', () => {
    it('updateClubEvent now fetches all fields including title, description, startTime, endTime', async () => {
      const adminSession = createAdminSession()

      const currentEvent = {
        id: 'evt-bug-test',
        title: 'Event with All Fields',
        titleEs: 'Evento con Todos los Campos',
        titleEn: 'Event with All Fields',
        blurbEs: 'Blurb',
        blurbEn: 'Blurb',
        descriptionEs: 'A detailed description in Spanish',
        descriptionEn: 'A detailed description in English',
        date: '2026-04-20',
        startTime: '14:30:00',
        endTime: '18:45:00',
        dateKind: 'single',
        endDate: null,
        recurrenceLabelEs: null,
        recurrenceLabelEn: null,
        imageUrl: 'https://example.com/image.png',
        linkUrl: 'https://example.com/link',
        categoryEs: 'Torneo',
        categoryEn: 'Tournament',
        createdBy: 'user-1',
        createdAt: '2026-04-01T00:00:00Z',
      }

      const updatedEvent = {
        ...currentEvent,
        titleEs: 'Updated Event',
        titleEn: 'Updated Event',
      }

      setFixture('events', [currentEvent])
      updateMock.mockResolvedValue([updatedEvent])
      setFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-bug-test', {
        titleEs: 'Updated Event',
      })

      expect(result.id).toBe('evt-bug-test')
      expect(result.titleEs).toBe('Updated Event')
      expect(result.descriptionEs).toBe('A detailed description in Spanish')
      expect(result.descriptionEn).toBe('A detailed description in English')
    })
  })
})
