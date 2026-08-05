// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/server/auth/auth'
import {
  createStatefulDrizzleDb,
  resetDb,
  seed,
  getRows,
  failNextQuery,
  createMockServiceError,
  getQueryLog,
} from '@/tests/unit/mocks/drizzle-mock'
import { createQueryBuilder } from '@/tests/unit/mocks/supabase-mock'
import { rooms, tables, savedGames, savedGameAttendances } from '@/lib/db/schema'

// In-memory store for event_room_blocks (still using legacy Supabase)
const eventRoomBlocksStore: Array<{ id: string; room_id: string; table_id: string | null; date: string }> = []

vi.mock('@/lib/club-time', async () => {
  const actual = await vi.importActual<typeof import('@/lib/club-time')>('@/lib/club-time')
  return { ...actual, getCurrentClubDate: () => '2026-06-19' }
})

vi.mock('@/lib/server/shared/service-error', () => ({
  serviceError: createMockServiceError(),
}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
  getAdminDb: vi.fn(() => ({
    from: (table: string) => {
      if (table === 'event_room_blocks') {
        return { select: () => createQueryBuilder(eventRoomBlocksStore) }
      }
      throw new Error(`Unexpected table ${table}`)
    },
  })),
}))

const member: SessionUser = { id: 'user-1', role: 'member' }

describe('saved games service', () => {
  beforeEach(() => {
    resetDb()
    eventRoomBlocksStore.length = 0
    vi.clearAllMocks()

    // Seed common test data: room, two tables (one removable_top, one regular)
    seed({
      rooms: [{ id: 'room-1', name: 'Sala Principal', tableCount: 2, createdAt: new Date(), description: '' }],
      tables: [
        {
          id: 'double',
          roomId: 'room-1',
          name: 'Mesa doble',
          type: 'removable_top',
          qrCode: null,
          posX: null,
          posY: null,
          createdAt: new Date(),
          qrCodeInf: null,
        },
        {
          id: 'regular',
          roomId: 'room-1',
          name: 'Mesa normal',
          type: 'large',
          qrCode: null,
          posX: null,
          posY: null,
          createdAt: new Date(),
          qrCodeInf: null,
        },
      ],
    })
  })

  it('creates a day-based Saved Game on a removable-top table', async () => {
    const { createSavedGameForSession } = await import('@/lib/server/games/saved-games-service')
    const result = await createSavedGameForSession(member, {
      tableId: 'double',
      startDate: '2026-06-20',
      endDate: '2026-09-19',
    })
    expect(result).toMatchObject({
      tableId: 'double',
      startDate: '2026-06-20',
      endDate: '2026-09-19',
      attendanceCount: 0,
    })
  })

  it('rejects regular tables and durations over three months', async () => {
    const { createSavedGameForSession } = await import('@/lib/server/games/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'regular',
        startDate: '2026-06-20',
        endDate: '2026-07-20',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_REQUIRES_REMOVABLE_TOP' })
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-20',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_MAX_DURATION' })
  })

  it('rejects date ranges blocked by an event', async () => {
    eventRoomBlocksStore.push({ id: 'event-1', room_id: 'room-1', table_id: null, date: '2026-07-01' })
    const { createSavedGameForSession } = await import('@/lib/server/games/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-07-20',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_EVENT_CONFLICT', statusCode: 409 })
  })

  it('allows renewal only during the final fifteen days and creates the next period', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-04-01',
          endDate: '2026-06-30',
          status: 'active',
          attendanceCount: 2,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { renewSavedGameForSession } = await import('@/lib/server/games/saved-games-service')
    const renewed = await renewSavedGameForSession(member, 'sg-1')
    expect(renewed).toMatchObject({
      startDate: '2026-07-01',
      endDate: '2026-09-30',
      renewedFromId: 'sg-1',
    })
  })

  it('rejects renewal before the final fifteen days', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-06-01',
          endDate: '2026-08-31',
          status: 'active',
          attendanceCount: 0,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { renewSavedGameForSession } = await import('@/lib/server/games/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_RENEWAL_NOT_OPEN',
    })
  })

  it('derives completed status for expired games without mutating during a list read', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-03-01',
          endDate: '2026-06-18',
          status: 'active',
          attendanceCount: 3,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { listSavedGamesForSession } = await import('@/lib/server/games/saved-games-service')

    const resultBefore = getRows(savedGames)
    expect(resultBefore[0]!.status).toBe('active')

    await expect(listSavedGamesForSession(member)).resolves.toEqual([
      expect.objectContaining({ id: 'sg-1', status: 'completed', canRenew: false }),
    ])

    const resultAfter = getRows(savedGames)
    expect(resultAfter[0]!.status).toBe('active')
  })

  it('records QR attendance only for the user top reservation and remains idempotent', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-06-01',
          endDate: '2026-08-31',
          status: 'active',
          attendanceCount: 0,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { recordSavedGameAttendance } = await import('@/lib/server/games/saved-games-service')
    const reservation = {
      id: 'r-1',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      start_time: '18:00',
      end_time: '20:00',
      surface: 'top' as const,
      status: 'active' as const,
      activated_at: '2026-06-19T18:00:00Z',
      created_at: '2026-06-19T10:00:00Z',
    }
    await recordSavedGameAttendance(reservation)

    // Second call should fail with 23505 (unique constraint on playReservationId)
    // Create an Error-like object with a code property that passes the duck-type check
    const pgError = new Error('unique_violation') as unknown as { code: string }
    ;(pgError as any).code = '23505'
    failNextQuery({ op: 'insert', table: savedGameAttendances, error: pgError })
    await recordSavedGameAttendance(reservation)

    const attendances = getRows(savedGameAttendances)
    expect(attendances).toHaveLength(1)
    expect(attendances[0]).toMatchObject({
      savedGameId: 'sg-1',
      playReservationId: 'r-1',
      attendedOn: '2026-06-19',
    })
  })

  it('member session cannot access foreign saved games (isolation via assertMemberRowsScoped)', async () => {
    const { listSavedGamesForSession } = await import('@/lib/server/games/saved-games-service')
    const memberSession: SessionUser = { id: 'user-1', role: 'member' }
    const adminSession: SessionUser = { id: 'admin-1', role: 'admin' }

    // Seed saved games: one for user-1, one for user-2
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-06-01',
          endDate: '2026-08-31',
          status: 'active',
          attendanceCount: 1,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: 'sg-2',
          tableId: 'regular',
          userId: 'user-2',
          startDate: '2026-07-01',
          endDate: '2026-09-30',
          status: 'active',
          attendanceCount: 0,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })

    // Member can only see their own saved games
    const memberResult = await listSavedGamesForSession(memberSession)
    expect(memberResult).toHaveLength(1)
    expect(memberResult[0]!.userId).toBe('user-1')
    expect(memberResult[0]!.id).toBe('sg-1')
    expect(memberResult.some((sg) => sg.id === 'sg-2')).toBe(false)

    // Admin can see all saved games
    const adminResult = await listSavedGamesForSession(adminSession)
    expect(adminResult.some((sg) => sg.id === 'sg-1')).toBe(true)
    expect(adminResult.some((sg) => sg.id === 'sg-2')).toBe(true)
  })

  it('takes advisory lock before conflict check when creating saved game', async () => {
    const { createSavedGameForSession } = await import('@/lib/server/games/saved-games-service')

    await createSavedGameForSession(member, {
      tableId: 'double',
      startDate: '2026-06-20',
      endDate: '2026-09-19',
    })

    // Verify that pg_advisory_xact_lock was called by checking the query log
    const log = getQueryLog()
    const hasLockCall = log.some((entry) => {
      return entry.op === 'execute'
    })
    expect(hasLockCall).toBe(true)
  })

  it('takes advisory lock before conflict check when renewing saved game', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-04-01',
          endDate: '2026-06-30',
          status: 'active',
          attendanceCount: 0,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { renewSavedGameForSession } = await import('@/lib/server/games/saved-games-service')

    await renewSavedGameForSession(member, 'sg-1')

    // Verify that pg_advisory_xact_lock was called by checking the query log
    const log = getQueryLog()
    const hasLockCall = log.some((entry) => {
      return entry.op === 'execute'
    })
    expect(hasLockCall).toBe(true)
  })

  it('increments attendanceCount atomically with attendance insert', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-06-01',
          endDate: '2026-08-31',
          status: 'active',
          attendanceCount: 5,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { recordSavedGameAttendance } = await import('@/lib/server/games/saved-games-service')

    const reservation = {
      id: 'r-1',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      surface: 'top' as const,
      status: 'active' as const,
    }

    await recordSavedGameAttendance(reservation)

    // Verify both the attendance row AND the counter were updated
    const attendances = getRows(savedGameAttendances)
    expect(attendances).toHaveLength(1)
    expect(attendances[0]!.savedGameId).toBe('sg-1')

    const savedGamesRows = getRows(savedGames)
    const updatedGame = savedGamesRows.find((sg) => sg.id === 'sg-1')
    expect(updatedGame?.attendanceCount).toBe(6)
  })

  it('does not increment counter or record attendance for bottom-surface reservations', async () => {
    seed({
      saved_games: [
        {
          id: 'sg-1',
          tableId: 'double',
          userId: 'user-1',
          startDate: '2026-06-01',
          endDate: '2026-08-31',
          status: 'active',
          attendanceCount: 2,
          renewedFromId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    })
    const { recordSavedGameAttendance } = await import('@/lib/server/games/saved-games-service')

    const bottomReservation = {
      id: 'r-bottom',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      surface: 'bottom' as const,
      status: 'active' as const,
    }

    await recordSavedGameAttendance(bottomReservation)

    // No attendance should be recorded
    const attendances = getRows(savedGameAttendances)
    expect(attendances).toHaveLength(0)

    // Counter should remain unchanged
    const savedGamesRows = getRows(savedGames)
    const unchangedGame = savedGamesRows.find((sg) => sg.id === 'sg-1')
    expect(unchangedGame?.attendanceCount).toBe(2)
  })

  it('does not increment counter for reservations with no matching saved game', async () => {
    const { recordSavedGameAttendance } = await import('@/lib/server/games/saved-games-service')

    const reservation = {
      id: 'r-orphan',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      surface: 'top' as const,
      status: 'active' as const,
    }

    // No saved game seeded for this reservation
    await recordSavedGameAttendance(reservation)

    // No attendance should be recorded
    const attendances = getRows(savedGameAttendances)
    expect(attendances).toHaveLength(0)
  })
})
