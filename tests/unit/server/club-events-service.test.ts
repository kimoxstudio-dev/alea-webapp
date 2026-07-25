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
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * CLUB EVENTS SERVICE TEST COVERAGE (OIR-203) — PR3 Drizzle Migration
 *
 * Tests for admin CRUD operations on public club events
 * Implementation: lib/server/events/club-events-service.ts
 *
 * This test file is being migrated from Supabase mocks to Drizzle mocks
 * using the dispatching mock helper. The first test proves the helper works.
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

      // Set up the mock to return the newly inserted event
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

      // Mock the insert to return the new row
      insertMock.mockResolvedValue([newEventRow])

      // Mock the event room blocks query to return empty (no blocks)
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

      // Verify the result matches what we expect
      expect(result.id).toBe('evt-created-1')
      expect(result.titleEs).toBe('Gastronómica Viernes')
      expect(result.titleEn).toBe('Friday Gastro')
      expect(result.status).toBe('upcoming')
      expect(result.blocksRooms).toBe(false)
      expect(result.roomBlocks.length).toBe(0)
    })
  })
})
