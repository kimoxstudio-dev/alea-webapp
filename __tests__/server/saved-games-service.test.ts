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
 * - `createSavedGameForSession`: SELECT pg_advisory_xact_lock(...), then WITH
 *   input AS (SELECT 4 values), conflict AS (SELECT 1 FROM
 *   event_room_blocks ... CROSS JOIN input), ins AS (INSERT INTO saved_games
 *   SELECT ... FROM input WHERE NOT EXISTS (SELECT 1 FROM conflict)
 *   RETURNING *) SELECT ... FROM ins sg LEFT JOIN tables/rooms — batched via
 *   sql.transaction([lock, checkAndInsert]) (security-review fix, #301, for
 *   the joined roomName/tableName; advisory-lock + conflict re-check added
 *   #334 code-review to close a race with cancelActiveSavedGamesForRoomBlock
 *   in club-events-service.ts)
 * - `renewSavedGameForSession`: SELECT saved_games by id (1 value), then the
 *   same lock + three-CTE (input/conflict/ins, 5 values, includes
 *   renewed_from_id) shape as create — not a plain VALUES insert
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

    // create + renew saved game's advisory-lock statement (#334 code-review
    // fix): SELECT pg_advisory_xact_lock(hashtext($1)) — the first statement
    // of its `sql.transaction([lock, checkAndInsert])`, coordinating with
    // cancelActiveSavedGamesForRoomBlock's own lock on the same table.
    sqlMock.addHandler({
      name: 'SELECT pg_advisory_xact_lock (create + renew saved game, #334)',
      verb: 'select',
      match: (stmt) => stmt.text.includes('pg_advisory_xact_lock'),
      respond: () => [{ pg_advisory_xact_lock: null }],
    })

    // createSavedGameForSession: WITH input AS (SELECT $1,$2,$3,$4), conflict
    // AS (SELECT 1 FROM event_room_blocks ... CROSS JOIN input WHERE ...),
    // ins AS (INSERT INTO saved_games (...) SELECT ... FROM input WHERE NOT
    // EXISTS (SELECT 1 FROM conflict) RETURNING *) SELECT ... FROM ins sg
    // LEFT JOIN tables/rooms — CTE-wrapped insert (security-review fix,
    // #301; conflict re-check under the advisory lock added #334
    // code-review), anchored as verb='insert'/table='saved_games' by the
    // sql-mock's multi-CTE support (picks the first data-modifying CTE, here
    // `ins`, over the leading `input`/`conflict` SELECT CTEs). 4 bound
    // values: table_id, user_id, start_date, end_date — each interpolated
    // exactly once via the `input` CTE.
    sqlMock.addHandler({
      name: 'INSERT saved game (create, with lock-guarded conflict re-check)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 4,
      respond: (stmt) => {
        if (createInsertError) throw createInsertError
        const [tableId, userId, startDate, endDate] = stmt.values.map(String)
        // Simulates the `WHERE NOT EXISTS (SELECT 1 FROM conflict)` guard:
        // an event block conflicting with this table/date-range — found
        // freshly under the advisory lock, independent of whatever
        // assertTableAndEventAvailability's earlier precheck saw — skips the
        // insert (0 rows), same as that precheck's own SAVED_GAME_EVENT_CONFLICT.
        //
        // Code-review finding (MEDIUM 3): only simulate the guard when the
        // statement actually carries it — otherwise deleting the real
        // `conflict`/`WHERE NOT EXISTS` CTE from production code would leave
        // this handler still computing the conflict itself and this test
        // would stay green despite the guard being gone.
        const hasConflictGuard = stmt.text.includes('event_room_blocks') && stmt.text.includes('not exists')
        const table = tablesState.get(tableId)
        const conflict =
          hasConflictGuard &&
          blocksState.some(
            (block) =>
              block.room_id === table?.room_id &&
              block.date >= startDate &&
              block.date <= endDate &&
              (block.table_id == null || block.table_id === tableId),
          )
        if (conflict) return []
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

    // renewSavedGameForSession: WITH input AS (SELECT $1,$2,$3,$4,$5),
    // conflict AS (...), current_check AS (...), ins AS (INSERT INTO
    // saved_games (...) SELECT ... FROM input WHERE NOT EXISTS (SELECT 1
    // FROM conflict) AND EXISTS (SELECT 1 FROM current_check) RETURNING *)
    // SELECT ..., (SELECT NOT EXISTS(...) FROM current_check) AS was_inactive
    // FROM (SELECT 1) AS one LEFT JOIN ins sg ON true LEFT JOIN tables/rooms
    // — the `(SELECT 1) AS one LEFT JOIN ins` shape (#334 code-review, second
    // finding: renew never rechecked the source row's status under the lock)
    // means this always returns exactly one row, with every `sg.*` column
    // null when the `ins` guard skipped the insert — never `[]`. 5 bound
    // values: table_id, user_id, start_date, end_date, renewed_from_id —
    // each interpolated exactly once via the `input` CTE.
    sqlMock.addHandler({
      name: 'INSERT saved game (renew, with lock-guarded conflict + status re-check)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 5,
      respond: (stmt) => {
        if (renewInsertError) throw renewInsertError
        const [tableId, userId, startDate, endDate, renewedFromId] = stmt.values.map((v) => (v == null ? null : String(v)))
        // Same guard simulation as the create handler above (code-review
        // finding: the renew guard previously had zero behavioural
        // coverage) — only report a conflict when the statement actually
        // carries the re-check, and compute it from live state rather than
        // unconditionally.
        // Anchored to the guard's own text (not a loose `includes('not
        // exists')`), because this statement's final SELECT also carries a
        // second, unrelated `NOT EXISTS` (the `was_inactive` projection
        // below) — a substring-only match here would still report the guard
        // present after someone deleted `AND EXISTS (SELECT 1 FROM
        // current_check)` from the `ins` WHERE clause, since `NOT EXISTS
        // (SELECT 1 FROM conflict)` alone still contains `not exists`
        // (coordinator review finding, HIGH 2).
        const hasConflictGuard =
          stmt.text.includes('event_room_blocks') && stmt.text.includes('not exists (select 1 from conflict)')
        const table = tablesState.get(tableId!)
        const conflict =
          hasConflictGuard &&
          blocksState.some(
            (block) =>
              block.room_id === table?.room_id &&
              block.date >= startDate! &&
              block.date <= endDate! &&
              (block.table_id == null || block.table_id === tableId),
          )
        // #334 code-review finding (renewal race with source-row
        // cancellation): the `current_check` CTE re-reads the source row's
        // live status under the lock and the insert is gated on it still
        // being 'active'. Only simulate the guard when the statement
        // actually carries it — same discipline as the conflict guard above
        // — so reverting the fix in production leaves this handler
        // computing nothing and the regression test below fails.
        //
        // Anchored to the guard's own clause, not a loose
        // `includes('current_check')` — that substring also matches the CTE
        // definition and the `was_inactive` projection, both of which stay
        // in the statement even if someone deletes only `AND EXISTS (SELECT
        // 1 FROM current_check)` from the `ins` WHERE clause. A loose match
        // would keep this handler correctly rejecting the insert while the
        // real production guard was gone — the regression test would stay
        // green for the wrong reason (coordinator review finding, HIGH 1).
        const hasCurrentCheckGuard = stmt.text.includes('and exists (select 1 from current_check)')
        const sourceRow = renewedFromId ? savedGamesState.find((item) => item.id === renewedFromId) : undefined
        const sourceInactive = hasCurrentCheckGuard && sourceRow?.status !== 'active'
        if (conflict || sourceInactive) {
          return [{
            id: null, table_id: null, user_id: null, start_date: null, end_date: null,
            status: null, attendance_count: null, renewed_from_id: null, created_at: null, updated_at: null,
            table_name: null, room_name: null, was_inactive: sourceInactive,
          }]
        }
        const row = makeSavedGame({
          id: `sg-${savedGamesState.length + 1}`,
          table_id: tableId!,
          user_id: userId!,
          start_date: startDate!,
          end_date: endDate!,
          renewed_from_id: renewedFromId,
        })
        savedGamesState.push(row)
        return [{ ...withJoinedNames(row), was_inactive: false }]
      },
    })

    // recordSavedGameAttendance: WITH ins AS (INSERT INTO
    // saved_game_attendances (saved_game_id, play_reservation_id,
    // attended_on) VALUES (...) RETURNING saved_game_id) UPDATE saved_games
    // SET attendance_count = attendance_count + 1, updated_at = now() WHERE
    // id = (SELECT saved_game_id FROM ins) — a single combined CTE (#301
    // round-3 fix, see saved-games-service.ts). The mock's CTE support
    // anchors this as verb='insert'/table='saved_game_attendances' (the verb
    // *inside* the WITH parens), so this one handler must model BOTH
    // effects: the attendance insert AND the attendance_count increment,
    // since the real UPDATE only ever runs as part of this same statement
    // (there is no separate UPDATE statement in production to intercept).
    // On a duplicate/idempotent retry (23505 on the INSERT), the increment
    // must NOT happen — mirrors real Postgres: the UPDATE only executes
    // after the INSERT (inside the same CTE) succeeds.
    sqlMock.addHandler({
      name: 'INSERT saved game attendance + increment attendance_count',
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
        const savedGame = savedGamesState.find((item) => item.id === savedGameId)
        if (savedGame) savedGame.attendance_count += 1
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

    // Code-review finding (HIGH): structural proof the lock and the
    // check+insert actually travel together as one sql.transaction([...])
    // call — without this, someone could revert createSavedGameForSession
    // back to two sequential `await sql` calls (fully reopening the #334
    // race) and this test would stay green, since the handlers above match
    // on statement shape regardless of how they were dispatched.
    expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
    const batched = sqlMock.transaction.mock.calls[0]?.[0]
    expect(Array.isArray(batched)).toBe(true)
    expect(batched).toHaveLength(2)
    // Order matters (LOW 3 code-review finding): batch length alone doesn't
    // prove the lock runs first — [checkAndInsert, lock] would also have
    // length 2 and would reopen the race silently. sqlMock.sql dispatches
    // eagerly at tagged-template call time, so its two most recent calls at
    // this point are exactly this transaction's own [lock, insert], in order.
    const dispatchOrder = sqlMock.sql.mock.calls.slice(-2).map((call) => String(call[0]))
    expect(dispatchOrder[0]).toContain('pg_advisory_xact_lock')
    expect(dispatchOrder[1]).not.toContain('pg_advisory_xact_lock')
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

  it('rejects with SAVED_GAME_EVENT_CONFLICT/409 when an event block appears between the precheck and the lock-guarded insert (#334 code-review — race with cancelActiveSavedGamesForRoomBlock)', async () => {
    // Simulates cancelActiveSavedGamesForRoomBlock's UPDATE winning the
    // per-table advisory lock race and committing an event-block-driven
    // cancellation right after assertTableAndEventAvailability's precheck
    // ran clean, but before createSavedGameForSession's own insert (which
    // re-checks the same event_room_blocks condition under the lock, inside
    // the same statement as the insert) executes. The precheck's SELECT
    // handler returns a clean room, then pushes the block as a side effect
    // — visible only to the later re-check embedded in the INSERT's `conflict`
    // CTE, not to the precheck itself.
    sqlMock.prependHandler({
      name: 'SELECT event_room_blocks in range (race: block lands after precheck)',
      verb: 'select',
      match: (stmt) => stmt.table === 'event_room_blocks' && stmt.values.length === 3,
      respond: (stmt) => {
        const [roomId, startDate, endDate] = stmt.values.map(String)
        const before = blocksState
          .filter((block) => block.room_id === roomId && block.date >= startDate && block.date <= endDate)
          .map((block) => ({ id: block.id, table_id: block.table_id }))
        blocksState.push({ id: 'block-race', room_id: 'room-1', table_id: null, date: '2026-06-20' })
        return before
      },
    })

    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-07-20',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_EVENT_CONFLICT', statusCode: 409 })

    // Structural proof (HIGH finding, same as the happy-path test above):
    // the lock and the re-check+insert still travelled together as one
    // batched sql.transaction() call even on this rejection path.
    expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
    const batched = sqlMock.transaction.mock.calls[0]?.[0]
    expect(Array.isArray(batched)).toBe(true)
    expect(batched).toHaveLength(2)
    // Order matters (LOW 3 code-review finding) — see the happy-path test's
    // comment above for why batch length alone doesn't prove ordering.
    const dispatchOrder = sqlMock.sql.mock.calls.slice(-2).map((call) => String(call[0]))
    expect(dispatchOrder[0]).toContain('pg_advisory_xact_lock')
    expect(dispatchOrder[1]).not.toContain('pg_advisory_xact_lock')
  })

  it('deterministically surfaces the availability error on create when both checks would fail (#301 round-3 fix)', async () => {
    // Sequential-await regression test: assertTableAndEventAvailability and
    // assertNoBottomReservationConflict used to run via Promise.all, so when
    // both would reject, which error won the race was nondeterministic. The
    // fix awaits availability first, then the conflict check — so the
    // availability error (SAVED_GAME_EVENT_CONFLICT) must always win when
    // both conditions are present, and the reservation-conflict handler must
    // never even be reached.
    blocksState.push({ id: 'event-1', room_id: 'room-1', table_id: null, date: '2026-07-01' })
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

  it('maps a check-constraint violation (23514) on saved_games_max_duration to SAVED_GAME_MAX_DURATION/400 without leaking error.message (#301 round-4 fix)', async () => {
    createInsertError = neonDbError('23514', 'new row for relation "saved_games" violates check constraint "saved_games_max_duration"', 'saved_games_max_duration')
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_MAX_DURATION', statusCode: 400 })
  })

  it('maps a check-constraint violation (23514) on saved_games_valid_dates to SAVED_GAME_INVALID_RANGE/400 without leaking error.message (#301 round-4 fix)', async () => {
    createInsertError = neonDbError('23514', 'new row for relation "saved_games" violates check constraint "saved_games_valid_dates"', 'saved_games_valid_dates')
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'SAVED_GAME_INVALID_RANGE', statusCode: 400 })
  })

  it('maps a check-constraint violation (23514) on an unrecognized constraint name to a generic 500, never leaking error.message (#301 round-4 fix)', async () => {
    createInsertError = neonDbError('23514', 'new row violates check constraint "some_future_constraint"', 'some_future_constraint')
    const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(
      createSavedGameForSession(member, {
        tableId: 'double',
        startDate: '2026-06-20',
        endDate: '2026-09-19',
      }),
    ).rejects.toMatchObject({ message: 'Internal server error', statusCode: 500 })
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

    // #334 code-review (MEDIUM 2): renewSavedGameForSession now takes the
    // same lock-guarded treatment as createSavedGameForSession — structural
    // proof the lock and the re-check+insert travelled together as one
    // batched sql.transaction() call.
    expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
    const batched = sqlMock.transaction.mock.calls[0]?.[0]
    expect(Array.isArray(batched)).toBe(true)
    expect(batched).toHaveLength(2)
    // Order matters (LOW 3 code-review finding): the lock must be dispatched
    // before the guarded insert, or the guard runs unlocked and the race it
    // exists to close reopens silently. sqlMock.sql records dispatch order
    // (it dispatches eagerly at tagged-template call time), so the two most
    // recent calls at this point are exactly this transaction's [lock, insert].
    const dispatchOrder = sqlMock.sql.mock.calls.slice(-2).map((call) => String(call[0]))
    expect(dispatchOrder[0]).toContain('pg_advisory_xact_lock')
    expect(dispatchOrder[1]).not.toContain('pg_advisory_xact_lock')
  })

  it('rejects with SAVED_GAME_EVENT_CONFLICT/409 on renewal when an event block appears between the precheck and the lock-guarded insert (#334 code-review — race with cancelActiveSavedGamesForRoomBlock, MEDIUM finding)', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )

    // Same race simulation as createSavedGameForSession's analogous test
    // above: the precheck sees a clean room, then pushes a conflicting block
    // as a side effect — visible only to the later re-check embedded in the
    // renew insert's `conflict` CTE, not to the precheck itself.
    sqlMock.prependHandler({
      name: 'SELECT event_room_blocks in range (race: block lands after renew precheck)',
      verb: 'select',
      match: (stmt) => stmt.table === 'event_room_blocks' && stmt.values.length === 3,
      respond: (stmt) => {
        const [roomId, startDate, endDate] = stmt.values.map(String)
        const before = blocksState
          .filter((block) => block.room_id === roomId && block.date >= startDate && block.date <= endDate)
          .map((block) => ({ id: block.id, table_id: block.table_id }))
        blocksState.push({ id: 'block-race', room_id: 'room-1', table_id: null, date: '2026-07-01' })
        return before
      },
    })

    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_EVENT_CONFLICT',
      statusCode: 409,
    })

    expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
    const batched = sqlMock.transaction.mock.calls[0]?.[0]
    expect(Array.isArray(batched)).toBe(true)
    expect(batched).toHaveLength(2)
    const dispatchOrder = sqlMock.sql.mock.calls.slice(-2).map((call) => String(call[0]))
    expect(dispatchOrder[0]).toContain('pg_advisory_xact_lock')
    expect(dispatchOrder[1]).not.toContain('pg_advisory_xact_lock')
  })

  it('rejects with SAVED_GAME_NOT_ACTIVE/409 on renewal when the source row is cancelled between the precheck and the lock-guarded insert (#334 code-review — race with cancelActiveSavedGamesForRoomBlock)', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )

    // Same race shape as the event-block test above, but on the source
    // row's own status: `renewSavedGameForSession`'s precheck reads it as
    // 'active' and passes that snapshot through to `current`, then a
    // concurrent `cancelActiveSavedGamesForRoomBlock` flips the live row to
    // 'cancelled' before the lock-guarded insert's `current_check` CTE
    // re-reads it. The precheck's stale `current.status` must never be what
    // decides the insert — only the value read after the lock counts.
    sqlMock.prependHandler({
      name: 'SELECT saved game by id (race: cancelled after renew precheck)',
      verb: 'select',
      match: (stmt) => stmt.table === 'saved_games' && stmt.values.length === 1 && whereConditionCount(stmt) === 1,
      respond: (stmt) => {
        const row = savedGamesState.find((item) => item.id === String(stmt.values[0]))
        if (!row) return []
        const snapshot = { ...row }
        row.status = 'cancelled'
        return [snapshot]
      },
    })

    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_NOT_ACTIVE',
      statusCode: 409,
    })

    // No renewal row was inserted — only the original (now cancelled) row exists.
    expect(savedGamesState).toHaveLength(1)
    expect(savedGamesState[0]?.status).toBe('cancelled')

    // Structural proof the lock and the check+insert still travel together
    // as one sql.transaction([...]) call, same guard as the tests above.
    expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
    const batched = sqlMock.transaction.mock.calls[0]?.[0]
    expect(Array.isArray(batched)).toBe(true)
    expect(batched).toHaveLength(2)
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

  it('deterministically surfaces the availability error on renew when both checks would fail (#301 round-3 fix)', async () => {
    // Same sequential-await regression as the create test above, applied to
    // renewSavedGameForSession's own availability/conflict pair. Next period
    // is 2026-07-01..2026-09-30 (see the renewal tests below) — seed both an
    // event block and a bottom-reservation conflict inside that range so the
    // availability error must be the one that wins deterministically.
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-04-01',
        end_date: '2026-06-30',
      }),
    )
    blocksState.push({ id: 'event-1', room_id: 'room-1', table_id: null, date: '2026-07-15' })
    reservationConflictsState.push({
      id: 'res-1',
      table_id: 'double',
      status: 'active',
      surface: 'bottom',
      date: '2026-07-15',
    })
    const { renewSavedGameForSession } = await import('@/lib/server/saved-games-service')
    await expect(renewSavedGameForSession(member, 'sg-1')).rejects.toMatchObject({
      message: 'SAVED_GAME_EVENT_CONFLICT',
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
    // Regression coverage (#301 round-3 fix): the combined
    // `WITH ins AS (INSERT ...) UPDATE saved_games SET attendance_count =
    // attendance_count + 1 ...` CTE must increment attendance_count exactly
    // once for the real (first) attendance, and the second call — which
    // hits the 23505 idempotency guard on the INSERT — must be a true
    // no-op that never reaches the UPDATE, so attendance_count does not
    // double-increment on a duplicate/retry.
    expect(savedGamesState[0]!.attendance_count).toBe(1)
  })

  it('increments attendance_count by exactly 1 on a brand-new attendance record', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
        attendance_count: 3,
      }),
    )
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    await recordSavedGameAttendance({
      id: 'r-9',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-20',
      start_time: '18:00',
      end_time: '20:00',
      surface: 'top' as const,
      status: 'active' as const,
      activated_at: '',
      created_at: '',
    })
    expect(attendancesState).toEqual([
      { saved_game_id: 'sg-1', play_reservation_id: 'r-9', attended_on: '2026-06-20' },
    ])
    expect(savedGamesState[0]!.attendance_count).toBe(4)
  })

  it('does not double-increment attendance_count on a simulated 23505 unique-violation retry', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    // Pre-seed the attendance row directly (bypassing the service) so the
    // very first call already hits the mock's 23505 duplicate-key branch —
    // isolates the idempotency path from the "second call of two" shape of
    // the test above, so this test fails if the no-op guard is ever removed
    // or the UPDATE is hoisted outside the INSERT's success path.
    attendancesState.push({ saved_game_id: 'sg-1', play_reservation_id: 'r-dup', attended_on: '2026-06-19' })
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    await recordSavedGameAttendance({
      id: 'r-dup',
      table_id: 'double',
      user_id: 'user-1',
      date: '2026-06-19',
      start_time: '18:00',
      end_time: '20:00',
      surface: 'top' as const,
      status: 'active' as const,
      activated_at: '',
      created_at: '',
    })
    expect(attendancesState).toHaveLength(1)
    expect(savedGamesState[0]!.attendance_count).toBe(0)
  })

  it('treats a 23505 scoped to the attendance constraint as the expected idempotent conflict, even without pre-existing state (#301 round-4 fix)', async () => {
    // Forces the INSERT handler itself to throw a 23505 explicitly scoped to
    // saved_game_attendances_play_reservation_id_key, independent of the
    // `attendancesState` duplicate-detection branch already covered above —
    // isolates isAttendanceConflict()'s constraint-name check itself.
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    attendanceInsertError = neonDbError('23505', 'duplicate key', 'saved_game_attendances_play_reservation_id_key')
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    await expect(
      recordSavedGameAttendance({
        id: 'r-scoped',
        table_id: 'double',
        user_id: 'user-1',
        date: '2026-06-19',
        start_time: '18:00',
        end_time: '20:00',
        surface: 'top' as const,
        status: 'active' as const,
        activated_at: '',
        created_at: '',
      }),
    ).resolves.toBeUndefined()
  })

  it('does NOT swallow a 23505 on an unrelated constraint as the attendance conflict — propagates as a 500 (#301 round-4 fix, key regression)', async () => {
    savedGamesState.push(
      makeSavedGame({
        id: 'sg-1',
        table_id: 'double',
        user_id: 'user-1',
        start_date: '2026-06-01',
        end_date: '2026-08-31',
      }),
    )
    // Same SQLSTATE (23505) but a different constraint name — before the
    // #301 round-4 fix, `error.code === '23505'` alone would have swallowed
    // this as the expected idempotent conflict and silently returned.
    attendanceInsertError = neonDbError('23505', 'unrelated unique violation', 'some_other_unique_constraint')
    const { recordSavedGameAttendance } = await import('@/lib/server/saved-games-service')
    await expect(
      recordSavedGameAttendance({
        id: 'r-unrelated',
        table_id: 'double',
        user_id: 'user-1',
        date: '2026-06-19',
        start_time: '18:00',
        end_time: '20:00',
        surface: 'top' as const,
        status: 'active' as const,
        activated_at: '',
        created_at: '',
      }),
    ).rejects.toMatchObject({ message: 'Internal server error', statusCode: 500 })
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
