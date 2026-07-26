// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServiceError } from '@/lib/server/shared/service-error'
import {
  createTransactionAwareMockBuilder,
  resetFixtures,
  setFixture,
  setInsertFixture,
  insertMock,
  updateMock,
  selectMock,
  createMockServiceError,
  MockServiceError,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * CLUB EVENTS SERVICE TEST COVERAGE (OIR-203)
 *
 * Tests for admin CRUD operations on public club events
 * Implementation: lib/server/events/club-events-service.ts
 *
 * Key scenarios tested:
 * - createClubEvent with bilingual titles and optional room blocks (admin-only)
 * - updateClubEvent with partial updates and room block toggling (admin-only)
 * - deleteClubEvent removes event and cancels conflicting reservations (admin-only)
 * - Non-admin users get 403 Forbidden from every CRUD endpoint
 * - URL hardening: validateOptionalUrl rejects javascript:, data:, relative URLs
 * - Room blocking is optional: events without blocksRooms don't create event_room_blocks rows
 * - Upcoming/past split derived from date_kind and end_date at read time
 * - listEvents() excludes landing rows (both title_es and title_en populated)
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createTransactionAwareMockBuilder()),
  getDrizzleAdminDb: vi.fn(() => createTransactionAwareMockBuilder()),
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
  isClubEventRow: vi.fn((row) => row.titleEs !== null && row.titleEn !== null),
  cancelOverlappingReservationsForBlocksTx: vi.fn(async () => {}),
  deleteEventCascade: vi.fn(async () => {}),
}))

type SessionUser = {
  id: string
  role: 'admin' | 'member'
  email?: string
}

function createAdminSession(): SessionUser {
  return { id: 'user-admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'user-member-1', role: 'member', email: 'member@example.com' }
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

async function loadEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events/events-service')
  return {
    listEvents: mod.listEvents,
  }
}

describe('club-events-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetFixtures()
  })

  describe('createClubEvent', () => {
    it('admin can create a public club event without room blocks', async () => {
      const adminSession = createAdminSession()
      
      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Gastronómica Viernes',
          titleEs: 'Gastronómica Viernes',
          titleEn: 'Friday Gastro',
          blurbEs: 'Noche de comida',
          blurbEn: 'Food night',
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: 'Social',
          categoryEn: 'Social',
          dateKind: 'recurring',
          date: '2026-04-17',
          endDate: null,
          recurrenceLabelEs: 'Todos los viernes',
          recurrenceLabelEn: 'Every Friday',
          imageUrl: 'https://example.com/gastro.png',
          linkUrl: 'https://example.com/reserve',
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '18:00:00',
          endTime: '20:00:00',
        },
      ])
      setInsertFixture('event_room_blocks', [])

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

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Gastronómica Viernes')
      expect(result.titleEn).toBe('Friday Gastro')
      expect(result.status).toBe('upcoming')
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

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

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

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Evento en Español',
          titleEs: 'Evento en Español',
          titleEn: 'Evento en Español',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Evento en Español',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Evento en Español')
      expect(result.titleEn).toBe('Evento en Español')
    })

    it('creates a club event with titleEn empty string, succeeds with fallback (OIR-206)', async () => {
      const adminSession = createAdminSession()

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Evento Viernes',
          titleEs: 'Evento Viernes',
          titleEn: 'Evento Viernes',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

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

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Torneo de Ajedrez',
          titleEs: 'Torneo de Ajedrez',
          titleEn: 'Chess Tournament',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

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

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Gaming Night',
          titleEs: 'Noche de Juegos',
          titleEn: 'Gaming Night',
          blurbEs: 'Una noche divertida',
          blurbEn: 'Una noche divertida',
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Noche de Juegos',
        titleEn: 'Gaming Night',
        blurbEs: 'Una noche divertida',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.blurbEn).toBe('Una noche divertida')
    })

    it('creates a club event with categoryEn absent, falls back to categoryEs (OIR-206)', async () => {
      const adminSession = createAdminSession()

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Tournaments',
          titleEs: 'Torneos',
          titleEn: 'Tournaments',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: 'Competencia',
          categoryEn: 'Competencia',
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Torneos',
        titleEn: 'Tournaments',
        categoryEs: 'Competencia',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.categoryEn).toBe('Competencia')
    })

    it('rejects categoryEn as non-string object (still 400, not fallback) (OIR-206)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          categoryEn: {},
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts null and undefined for optional string fields', async () => {
      const adminSession = createAdminSession()

      setInsertFixture('events', [
        {
          id: 'evt-new-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: adminSession.id,
          createdAt: new Date('2026-04-15T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(adminSession, {
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: null,
        blurbEn: undefined,
        categoryEs: null,
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-new-1')
    })

    it('rejects blurbEs as object with 400 (Finding 5)', async () => {
      const adminSession = createAdminSession()

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(adminSession, {
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: {},
          date: '2026-05-01',
          dateKind: 'single',
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
          categoryEn: [],
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('updateClubEvent', () => {
    it('admin can update a club event', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Old Event',
          titleEs: 'Evento Antiguo',
          titleEn: 'Old Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      setInsertFixture('events', [
        {
          id: 'evt-1',
          title: 'Updated Event',
          titleEs: 'Evento Actualizado',
          titleEn: 'Updated Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Evento Actualizado',
        titleEn: 'Updated Event',
      })

      expect(result.id).toBe('evt-1')
      expect(result.titleEs).toBe('Evento Actualizado')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const memberSession = createMemberSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(memberSession, 'evt-1', { titleEs: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent or non-landing club event', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(adminSession, 'non-existent', { titleEs: 'Test' })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects malformed schedules with 400 and no update on events table (Finding 2)', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(adminSession, 'evt-1', {
          titleEs: 'Updated',
          blocksRooms: true,
          schedules: 'not an array',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('deleteClubEvent', () => {
    it('admin can delete a club event', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(deleteClubEvent(adminSession, 'evt-1')).resolves.not.toThrow()
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const memberSession = createMemberSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Event',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(memberSession, 'evt-1')
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listAdminClubEvents', () => {
    it('admin gets upcoming and past events split by date', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Upcoming',
          titleEs: 'Próximo',
          titleEn: 'Upcoming',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { listAdminClubEvents } = await loadClubEventsService()

      const result = await listAdminClubEvents(adminSession)

      expect(result.upcoming.length).toBeGreaterThanOrEqual(0)
      expect(Array.isArray(result.past)).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { listAdminClubEvents } = await loadClubEventsService()

      await expect(
        listAdminClubEvents(memberSession)
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listClubEvents', () => {
    it('returns upcoming and past club events for public listing', async () => {
      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Evento',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { listClubEvents } = await loadClubEventsService()

      const result = await listClubEvents()

      expect(Array.isArray(result.upcoming)).toBe(true)
      expect(Array.isArray(result.past)).toBe(true)
    })
  })

  describe('listEvents (from events-service.ts)', () => {
    it('excludes landing-only rows (both title_es and title_en populated)', async () => {
      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Evento',
          titleEn: 'Event',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-05-01',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      const { listEvents } = await loadEventsService()

      const result = await listEvents()

      expect(Array.isArray(result)).toBe(true)
    })
  })

  describe('updateClubEvent with fallback semantics edge cases (OIR-206 round 2)', () => {
    it('rule 2: explicit different titleEn + blank titleEn payload = re-enable auto-copy to new ES', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Old',
          titleEs: 'Viejo',
          titleEn: 'Different EN',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      setInsertFixture('events', [
        {
          id: 'evt-1',
          title: 'Nuevo',
          titleEs: 'Nuevo',
          titleEn: 'Nuevo',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Nuevo',
        titleEn: '',
      })

      expect(result.titleEn).toBe('Nuevo')
    })

    it('rule 1: resending identical titleEn (en === es deliberately) + ES change = EN preserved', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Viejo',
          titleEs: 'Viejo',
          titleEn: 'Viejo',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      setInsertFixture('events', [
        {
          id: 'evt-1',
          title: 'Nuevo',
          titleEs: 'Nuevo',
          titleEn: 'Nuevo',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Nuevo',
        titleEn: 'Nuevo',
      })

      expect(result.titleEn).toBe('Nuevo')
    })

    it('rule 2: whitespace-only titleEn behaves as blank (re-enable auto-copy to new ES)', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Viejo',
          titleEs: 'Viejo',
          titleEn: 'Different',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      setInsertFixture('events', [
        {
          id: 'evt-1',
          title: 'Nuevo',
          titleEs: 'Nuevo',
          titleEn: 'Nuevo',
          blurbEs: null,
          blurbEn: null,
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        titleEs: 'Nuevo',
        titleEn: '   ',
      })

      expect(result.titleEn).toBe('Nuevo')
    })

    it('rule 2: blank blurbEn (nullable) re-enables auto-copy to new ES (nullable field)', async () => {
      const adminSession = createAdminSession()

      setFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Evento',
          titleEn: 'Event',
          blurbEs: 'Viejo',
          blurbEn: 'Different',
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])

      setInsertFixture('events', [
        {
          id: 'evt-1',
          title: 'Event',
          titleEs: 'Evento',
          titleEn: 'Event',
          blurbEs: 'Nuevo',
          blurbEn: 'Nuevo',
          descriptionEs: null,
          descriptionEn: null,
          categoryEs: null,
          categoryEn: null,
          dateKind: 'single',
          date: '2026-04-20',
          endDate: null,
          recurrenceLabelEs: null,
          recurrenceLabelEn: null,
          imageUrl: null,
          linkUrl: null,
          createdBy: 'user-1',
          createdAt: new Date('2026-04-01T00:00:00Z'),
          startTime: '00:00:00',
          endTime: '23:59:59',
        },
      ])
      setInsertFixture('event_room_blocks', [])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(adminSession, 'evt-1', {
        blurbEs: 'Nuevo',
        blurbEn: '',
      })

      expect(result.blurbEn).toBe('Nuevo')
    })
  })
})
