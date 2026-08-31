// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@/lib/server/auth'
import { createSqlMock, neonDbError, whereConditionCount } from '../helpers/sql-mock'

/**
 * SAVED GAMES SERVICE TEST COVERAGE — raw SQL (Neon) migration (#301)
 *
 * `lib/server/saved-games-service.ts` was migrated from the Supabase client
 * to the tagged-template `sql` client (`lib/db/client.ts`), following the
 * same pattern already used for #300/#303/#304/#305. This file replaces the
 * old Supabase mocks with the shared Neon `sql` mock helper
 * (`__tests__/helpers/sql-mock.ts`).
 *
 * Query shapes exercised here (see saved-games-service.ts):
 * - `assertTableAndEventAvailability`: SELECT tables by id (1 value),
 *   SELECT event_room_blocks by room_id/date range (3 values)
 * - `assertNoBottomReservationConflict` (security-review fix, #301): SELECT
 *   id FROM reservations WHERE table_id = $1 AND status IN ('pending',
 *   'active') AND (surface IS NULL OR surface = 'bottom') AND date >= $2 AND
 *   date <= $3 LIMIT 1 — 3 bound values, status/surface are literals
 * - `listSavedGamesForSession`: SELECT ... FROM saved_games sg LEFT JOIN
 *   tables/rooms WHERE (isAdmin OR sg.user_id = $2) — 2 bound values
 * - `createSavedGameForSession`: WITH ins AS (INSERT INTO saved_games (4
 *   values) RETURNING *) SELECT ... FROM ins sg LEFT JOIN tables/rooms —
 *   CTE-wrapped insert (security-review fix, #301) so the response includes
 *   real roomName/tableName instead of null
 * - `renewSavedGameForSession`: SELECT saved_games by id (1 value), then
 *   WITH ins AS (INSERT INTO saved_games (5 values, includes
 *   renewed_from_id) RETURNING *) SELECT ... FROM ins sg LEFT JOIN
 *   tables/rooms — same CTE-wrapped shape as create
 * - `recordSavedGameAttendance`: SELECT active saved_games by
 *   table_id/user_id/date range (4 bound values, 5 WHERE conditions —
 *   `status = 'active'` is a literal, not bound), then INSERT INTO
 *   saved_game_attendances (3 values)
 */

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

vi.mock('@/lib/club-time', async () => {
  const actual = await vi.importActual<typeof import('@/lib/club-time')>('@/lib/club-time')
  return { ...actual, getCurrentClubDate: () => '2026-06-19' }
})

type TableRow = { id: string; room_id: string; type: string; name: string }
type RoomRow = { id: string; name: string }
type BlockRow = { id: string; room_id: string; table_id: string | null; date: string }
type SavedGameRow = {
  id: string
  table_id: string
  user_id: string
  start_date: string
  end_date: string
  status: string
  attendance_count: number
  renewed_from_id: string | null
  created_at: string
  updated_at: string
}
type AttendanceRow = { saved_game_id: string; play_reservation_id: string; attended_on: string }
type ReservationConflictRow = { id: string; table_id: string; status: string; surface: string | null; date: string }

const tablesState = new Map<string, TableRow>()
const roomsState = new Map<string, RoomRow>()
const blocksState: BlockRow[] = []
const savedGamesState: SavedGameRow[] = []
const attendancesState: AttendanceRow[] = []
const reservationConflictsState: ReservationConflictRow[] = []

/** Looks up the table/room names for a saved-games row, mirroring the LEFT
 * JOIN tables/rooms the production `SAVED_GAME_JOINED_COLUMNS` re-select
 * performs on the `ins` CTE for create/renew. */
function withJoinedNames(row: SavedGameRow) {
  const table = tablesState.get(row.table_id)
  const room = table ? roomsState.get(table.room_id) : undefined
  return { ...row, table_name: table?.name ?? null, room_name: room?.name ?? null }
}

let createInsertError: Error | null = null
let renewInsertError: Error | null = null
let attendanceInsertError: Error | null = null
// Regression-test knob: simulates the WHERE (isAdmin OR user_id = ...) filter
// being accidentally bypassed at the query layer, so the mock returns mixed
// rows across users regardless of session — exercises assertMemberRowsScoped()
// itself, independent of the query filter working correctly.
let bypassMemberFilterInMock = false

function seedState() {
  tablesState.clear()
  tablesState.set('double', { id: 'double', room_id: 'room-1', type: 'removable_top', name: 'Mesa doble' })
  tablesState.set('regular', { id: 'regular', room_id: 'room-1', type: 'large', name: 'Mesa normal' })

  roomsState.clear()
  roomsState.set('room-1', { id: 'room-1', name: 'Sala' })

  blocksState.length = 0
  savedGamesState.length = 0
  attendancesState.length = 0
  reservationConflictsState.length = 0
  createInsertError = null
  renewInsertError = null
  attendanceInsertError = null
  bypassMemberFilterInMock = false
}

function makeSavedGame(overrides: Partial<SavedGameRow> & Pick<SavedGameRow, 'id' | 'table_id' | 'user_id' | 'start_date' | 'end_date'>): SavedGameRow {
  return {
    status: 'active',
    attendance_count: 0,
    renewed_from_id: null,
    created_at: '2026-06-19T10:00:00Z',
    updated_at: '2026-06-19T10:00:00Z',
    ...overrides,
  }
}

const member: SessionUser = { id: 'user-1', role: 'member' }

describe('saved games service', () => {
  beforeEach(() => {
    sqlMock.reset()
    seedState()

    // SELECT id, room_id, type FROM tables WHERE id = $1 LIMIT 1
    sqlMock.addHandler({
      name: 'SELECT table by id',
      verb: 'select',
      match: (stmt) => stmt.table === 'tables' && stmt.values.length === 1,
      respond: (stmt) => {
        const table = tablesState.get(String(stmt.values[0]))
        return table ? [{ id: table.id, room_id: table.room_id, type: table.type }] : []
      },
    })

    // SELECT id, table_id FROM event_room_blocks WHERE room_id = $1 AND date >= $2 AND date <= $3
    sqlMock.addHandler({
      name: 'SELECT event_room_blocks in range',
      verb: 'select',
      match: (stmt) => stmt.table === 'event_room_blocks' && stmt.values.length === 3,
      respond: (stmt) => {
        const [roomId, startDate, endDate] = stmt.values.map(String)
        return blocksState
          .filter((block) => block.room_id === roomId && block.date >= startDate && block.date <= endDate)
          .map((block) => ({ id: block.id, table_id: block.table_id }))
      },
    })

    // assertNoBottomReservationConflict: SELECT id FROM reservations WHERE
    // table_id = $1 AND status IN ('pending','active') AND (surface IS NULL
    // OR surface = 'bottom') AND date >= $2 AND date <= $3 LIMIT 1 — 3 bound
    // values (status list and surface literal are not bound params).
    // Defaults to no conflict ([]) so existing happy-path tests need no
    // setup changes.
    sqlMock.addHandler({
      name: 'SELECT bottom reservation conflict',
      verb: 'select',
      match: (stmt) => stmt.table === 'reservations' && stmt.values.length === 3,
      respond: (stmt) => {
        const [tableId, startDate, endDate] = stmt.values.map(String)
        const conflict = reservationConflictsState.find(
          (row) =>
            row.table_id === tableId &&
            (row.status === 'pending' || row.status === 'active') &&
            (row.surface == null || row.surface === 'bottom') &&
            row.date >= startDate &&
            row.date <= endDate,
        )
        return conflict ? [{ id: conflict.id }] : []
      },
    })

    // listSavedGamesForSession: SELECT ... FROM saved_games sg LEFT JOIN
    // tables/rooms WHERE (isAdmin OR sg.user_id = $2) ORDER BY sg.start_date ASC
    sqlMock.addHandler({
      name: 'SELECT joined saved games list',
      verb: 'select',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 2 && stmt.orderBy === 'sg.start_date asc',
      respond: (stmt) => {
        const [isAdmin, userId] = stmt.values
        return savedGamesState
          .filter((row) => bypassMemberFilterInMock || Boolean(isAdmin) || row.user_id === String(userId))
          .slice()
          .sort((a, b) => a.start_date.localeCompare(b.start_date))
          .map((row) => {
            const table = tablesState.get(row.table_id)
            const room = table ? roomsState.get(table.room_id) : undefined
            return {
              ...row,
              table_name: table?.name ?? null,
              room_name: room?.name ?? null,
            }
          })
      },
    })

    // renewSavedGameForSession's fetch-by-id: SELECT <cols> FROM saved_games
    // WHERE id = $1 LIMIT 1
    sqlMock.addHandler({
      name: 'SELECT saved game by id',
      verb: 'select',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 1 && whereConditionCount(stmt) === 1,
      respond: (stmt) => {
        const row = savedGamesState.find((item) => item.id === String(stmt.values[0]))
        return row ? [row] : []
      },
    })

    // recordSavedGameAttendance's active-saved-game lookup: 4 bound values
    // (table_id, user_id, start_date<=, end_date>=) but 5 WHERE conditions
    // since `status = 'active'` is a literal, not a bound param.
    sqlMock.addHandler({
      name: 'SELECT active saved game for attendance',
      verb: 'select',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 4 && whereConditionCount(stmt) === 5,
      respond: (stmt) => {
        const [tableId, userId, date1, date2] = stmt.values.map(String)
        const row = savedGamesState.find(
          (item) =>
            item.table_id === tableId &&
            item.user_id === userId &&
            item.status === 'active' &&
            item.start_date <= date1 &&
            item.end_date >= date2,
        )
        return row ? [{ id: row.id }] : []
      },
    })

    // createSavedGameForSession: WITH ins AS (INSERT INTO saved_games
    // (table_id, user_id, start_date, end_date) VALUES (...) RETURNING *)
    // SELECT ... FROM ins sg LEFT JOIN tables/rooms — CTE-wrapped insert
    // (security-review fix, #301), still anchored as verb='insert'/
    // table='saved_games' by the sql-mock's CTE support. 4 bound values.
    sqlMock.addHandler({
      name: 'INSERT saved game (create)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 4,
      respond: (stmt) => {
        if (createInsertError) throw createInsertError
        const [tableId, userId, startDate, endDate] = stmt.values.map(String)
        const row = makeSavedGame({
          id: `sg-${savedGamesState.length + 1}`,
          table_id: tableId,
          user_id: userId,
          start_date: startDate,
          end_date: endDate,
        })
        savedGamesState.push(row)
        return [withJoinedNames(row)]
      },
    })

    // renewSavedGameForSession: WITH ins AS (INSERT INTO saved_games
    // (table_id, user_id, start_date, end_date, renewed_from_id) VALUES
    // (...) RETURNING *) SELECT ... FROM ins sg LEFT JOIN tables/rooms —
    // same CTE-wrapped shape as create. 5 bound values.
    sqlMock.addHandler({
      name: 'INSERT saved game (renew)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 5,
      respond: (stmt) => {
        if (renewInsertError) throw renewInsertError
        const [tableId, userId, startDate, endDate, renewedFromId] = stmt.values.map((v) => (v == null ? null : String(v)))
        const row = makeSavedGame({
          id: `sg-${savedGamesState.length + 1}`,
          table_id: tableId!,
          user_id: userId!,
          start_date: startDate!,
          end_date: endDate!,
          renewed_from_id: renewedFromId,
        })
        savedGamesState.push(row)
        return [withJoinedNames(row)]
      },
    })

    // recordSavedGameAttendance: INSERT INTO saved_game_attendances
    // (saved_game_id, play_reservation_id, attended_on) VALUES (...)
    sqlMock.addHandler({
      name: 'INSERT saved game attendance',
      verb: 'insert',
      match: (stmt) => stmt.table === 'saved_game_attendances',
      respond: (stmt) => {
        if (attendanceInsertError) throw attendanceInsertError
        const [savedGameId, playReservationId, attendedOn] = stmt.values.map(String)
        if (attendancesState.some((item) => item.play_reservation_id === playReservationId)) {
          throw neonDbError('23505', 'duplicate attendance', 'saved_game_attendances_play_reservation_id_key')
        }
        const row = { saved_game_id: savedGameId, play_reservation_id: playReservationId, attended_on: attendedOn }
        attendancesState.push(row)
        return []
      },
    })
  })

  it('creates a day-based Saved Game on a removable-top table', async () => {
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
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
      // Security-review fix (#301): the CTE-wrapped INSERT re-selects joined
      // table/room names, so the create response no longer has null names.
      roomName: 'Sala',
      tableName: 'Mesa doble',
    })
  })

  it('rejects create with a 409 when an active bottom reservation overlaps the requested range', async () => {
    reservationConflictsState.push({
      id: 'res-1',
      table_id: 'double',
      status: 'active',
      surface: 'bottom',
      date: '2026-07-01',
    })
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_BOTTOM_RESERVATION_CONFLICT', statusCode: 409 })
  })

  it('rejects create with a 409 when a pending bottom reservation overlaps the requested range', async () => {
    reservationConflictsState.push({
      id: 'res-2',
      table_id: 'double',
      status: 'pending',
      surface: null,
      date: '2026-08-15',
    })
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_BOTTOM_RESERVATION_CONFLICT', statusCode: 409 })
  })

  it('allows create when a bottom reservation exists but outside the requested date range', async () => {
    reservationConflictsState.push({
      id: 'res-3',
      table_id: 'double',
      status: 'active',
      surface: 'bottom',
      date: '2026-01-01',
    })
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).resolves.toMatchObject({ tableId: 'double' })
  })

  it('rejects regular tables and durations over three months', async () => {
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
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
    blocksState.push({ id: 'event-1', room_id: 'room-1', table_id: null, date: '2026-07-01' })
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-07-20',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_EVENT_CONFLICT', statusCode: 409 })
  })

  it('maps an exclusion-constraint conflict (23P01) on create to SAVED_GAME_CONFLICT/409', async () => {
    createInsertError = neonDbError('23P01', 'exclusion violation', 'saved_games_no_active_overlap')
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_CONFLICT', statusCode: 409 })
  })

  it('maps a check-constraint violation (23514) on create to 400', async () => {
    createInsertError = neonDbError('23514', 'check constraint violated')
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'check constraint violated', statusCode: 400 })
  })

  it('allows renewal only during the final fifteen days and creates the next period', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
        attendance_count: 2,
      }),
    )
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    const renewed = await renewSavedGameForSession(member, 'sg-1')
    expect(renewed).toMatchObject({
      startDate: '2026-07-01',
      endDate: '2026-09-30',
      renewedFromId: 'sg-1',
      // Security-review fix (#301): the CTE-wrapped INSERT re-selects joined
      // table/room names, so the renew response no longer has null names.
      roomName: 'Sala',
      tableName: 'Mesa doble',
    })
  })

  it('rejects renewal with a 409 when a bottom reservation overlaps the next period', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )
    // Next period is 2026-07-01..2026-09-30 (see the happy-path renewal test
    // above) — put the conflicting bottom reservation inside that range.
    reservationConflictsState.push({
      id: 'res-1',
      table_id: 'double',
      status: 'active',
      surface: 'bottom',
      date: '2026-07-15',
    })
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_BOTTOM_RESERVATION_CONFLICT',
      statusCode: 409,
    })
  })

  it('rejects renewal before the final fifteen days', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_RENEWAL_NOT_OPEN',
    })
  })

  it('rejects renewal by a non-owner non-admin session with 403', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'other-user',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'Forbidden',
      statusCode: 403,
    })
  })

  it('maps a unique-violation on renewed_from_id (23505) to SAVED_GAME_ALREADY_RENEWED/409', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )
    renewInsertError = neonDbError('23505', 'unique violation', 'saved_games_renewed_from_id_key')
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_ALREADY_RENEWED',
      statusCode: 409,
    })
  })

  it('maps an exclusion-constraint conflict (23P01) on renew to SAVED_GAME_CONFLICT/409', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )
    renewInsertError = neonDbError('23P01', 'exclusion violation', 'saved_games_no_active_overlap')
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_CONFLICT',
      statusCode: 409,
    })
  })

  it('derives completed status for expired games without mutating during a list read', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-03-01',
        end_date: '2026-06-18',
        attendance_count: 3,
      }),
    )
    const { listSavedGamesForSession } = await import('@/lib/server/saved-games-service')

    await expect(listSavedGamesForSession(member)).resolves.toEqual([
      expect.objectContaining({ id: 'sg-1', status: 'completed', canRenew: false }),
    ])
    expect(savedGamesState[0]!.status).toBe('active')
  })

  it('records QR attendance only for the user top reservation and remains idempotent', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    const reservation = {
      id: 'r-1',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      start_time: '18:00',
      end_time: '20:00',
      surface: 'top' as const,
      status: 'active' as const,
      activated_at: '',
      created_at: '',
    }
    await recordSavedGameAttendance(reservation)
    await recordSavedGameAttendance(reservation)
    expect(attendancesState).toEqual([
      { saved_game_id: 'sg-1', play_reservation_id: 'r-1', attended_on: '2026-06-19' },
    ])
  })

  it('does not record attendance for a non-top or non-active reservation', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    await recordSavedGameAttendance({
      id: 'r-2',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      start_time: '18:00',
      end_time: '20:00',
      surface: 'bottom' as const,
      status: 'active' as const,
      activated_at: '',
      created_at: '',
    })
    expect(attendancesState).toEqual([])
  })

  it('member session cannot access foreign saved games (isolation via assertMemberRowsScoped)', async () => {
    const { listSavedGamesForSession } = await import('@/lib/server/saved-games-service')
    const memberSession: SessionUser = { id: 'user-1', role: 'member' }
    const adminSession: SessionUser = { id: 'admin-1', role: 'admin' }

    savedGamesState.push(
      makeSavedGame({ id: 'sg-1', table_id: 'double', user_id: 'user-1', start_date: '2026-06-01', end_date: '2026-08-31', attendance_count: 1 }),
      makeSavedGame({ id: 'sg-2', table_id: 'regular', user_id: 'user-2', start_date: '2026-07-01', end_date: '2026-09-30' }),
    )

    const memberResult = await listSavedGamesForSession(memberSession)
    expect(memberResult).toHaveLength(1)
    expect(memberResult[0]!.userId).toBe('user-1')
    expect(memberResult[0]!.id).toBe('sg-1')
    expect(memberResult.some((sg) => sg.id === 'sg-2')).toBe(false)

    const adminResult = await listSavedGamesForSession(adminSession)
    expect(adminResult.some((sg) => sg.id === 'sg-1')).toBe(true)
    expect(adminResult.some((sg) => sg.id === 'sg-2')).toBe(true)
  })

  it('rejects with a 500 when the query layer leaks a foreign row past the user_id filter (assertMemberRowsScoped regression)', async () => {
    const { listSavedGamesForSession } = await import('@/lib/server/saved-games-service')
    savedGamesState.push(
      makeSavedGame({ id: 'sg-1', table_id: 'double', user_id: 'user-1', start_date: '2026-06-01', end_date: '2026-08-31' }),
      makeSavedGame({ id: 'sg-foreign', table_id: 'regular', user_id: 'user-999', start_date: '2026-07-01', end_date: '2026-09-30' }),
    )

    // Simulate the `sg.user_id = $2` filter being accidentally bypassed at
    // the query layer, so the mock returns mixed rows across users — this
    // proves assertMemberRowsScoped() itself catches the leak, not just the
    // (working) query filter.
    bypassMemberFilterInMock = true

    await expect(listSavedGamesForSession(member)).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
      message: 'Data isolation violation: member read returned foreign rows',
    })
  })
})
