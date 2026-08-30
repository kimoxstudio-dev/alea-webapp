// @vitest-environment node
/**
 * KIM-383: Multi-day event service tests (Neon raw SQL — #303)
 *
 * Tests for createEvent / updateEvent using the multi-block (schedules) path.
 * Rewritten off the `create_event_with_blocks` / `update_event_with_blocks`
 * Supabase RPC mocks to the raw-SQL Neon implementation — those RPCs no
 * longer exist; the same behavior is now plain sequential `sql` statements
 * (see lib/server/events-service.ts's top-of-file comment).
 *
 * Verifies:
 * - createEvent with schedules array inserts the event row + one
 *   event_room_blocks row per roomed block, and cancels overlapping
 *   reservations per block
 * - createEvent with multiple schedules builds correct blocks/anchor
 * - updateEvent with schedules array replaces blocks (delete-then-insert)
 * - Validation: each schedule entry must have a valid date
 * - Validation: time boundaries enforced per-block (whole-hour, end > start)
 * - schedules array is populated on the returned AdminEvent
 * - listEventsBlockingRoom still works for multi-day events (per-block queries)
 * - deleteEvent cancels reservations for every block date, not just the anchor date
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqlMock,
  hasExactSelectColumns,
  neonDbError,
  whereColumnHasOperator,
  whereConditionCount,
  whereHasColumn,
} from '../helpers/sql-mock'

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/events-service')
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

function makeEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title: 'Multi-Day Event',
    description: null,
    date: '2026-07-10',
    start_time: '18:00:00',
    end_time: '22:00:00',
    created_by: null,
    created_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

function makeBlockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'block-1',
    event_id: 'evt-1',
    room_id: 'room-1',
    date: '2026-07-10',
    start_time: '18:00:00',
    end_time: '22:00:00',
    all_day: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

/** INSERT INTO events (title, description, date, start_time, end_time, created_by) — multi-block create (6 bound values). */
function addMultiBlockEventInsertHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'INSERT events (multi-block, 6 values incl. created_by)',
    verb: 'insert',
    match: (stmt) => stmt.table === 'events' && stmt.returning && stmt.values.length === 6,
    respond: (stmt) => respond(stmt.values),
  })
}

/** INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day) RETURNING ... */
function addRoomBlockInsertHandler(respond: (values: unknown[]) => unknown) {
  let callIndex = -1
  sqlMock.addHandler({
    name: 'INSERT event_room_blocks',
    verb: 'insert',
    match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
    respond: (stmt) => {
      callIndex += 1
      return respond(stmt.values)
    },
  })
  return () => callIndex
}

/** SELECT id FROM tables WHERE room_id = $1 (single room, cancellation preflight) */
function addTablesBySingleRoomHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT tables by single room_id',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'tables' &&
      whereColumnHasOperator(stmt, 'room_id', '=') &&
      !stmt.whereClause?.includes('any('),
    respond,
  })
}

/** UPDATE reservations SET status='cancelled' WHERE table_id = ANY(...) AND ... */
function addReservationsCancelHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE reservations cancel overlapping',
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
    respond,
  })
}

/** SELECT title, description, date, start_time, end_time, title_es, title_en FROM events WHERE id=$1 LIMIT 1 (updateEvent's currentRows fetch) */
function addCurrentEventHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT current event row for update',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'events' &&
      hasExactSelectColumns(stmt, 'title, description, date, start_time, end_time, title_es, title_en'),
    respond,
  })
}

/** UPDATE events SET title=,description=,date=,start_time=,end_time= WHERE id=... RETURNING ... (multi-block update) */
function addMultiBlockEventUpdateHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE events (multi-block)',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'events' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1,
    respond: (stmt) => respond(stmt.values),
  })
}

/** DELETE FROM event_room_blocks WHERE event_id=$1 */
function addBlocksDeleteHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'DELETE event_room_blocks WHERE event_id',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_room_blocks',
    respond,
  })
}

/** SELECT id, title_es, title_en FROM events WHERE id=$1 LIMIT 1 (deleteEvent's club-row guard) */
function addDeleteGuardHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT id, title_es, title_en FROM events (deleteEvent guard)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, 'id, title_es, title_en'),
    respond,
  })
}

/** SELECT room_id, date, start_time, end_time FROM event_room_blocks WHERE event_id=$1 (deleteEventCascade's blocks fetch) */
function addCascadeBlocksFetchHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT room_id, date, start_time, end_time FROM event_room_blocks (cascade)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'event_room_blocks' &&
      hasExactSelectColumns(stmt, 'room_id, date, start_time, end_time'),
    respond,
  })
}

/** SELECT id, room_id FROM tables WHERE room_id = ANY(...) (deleteEventCascade's batched table lookup) */
function addTablesByRoomIdsHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && Boolean(stmt.whereClause?.includes('any(')),
    respond,
  })
}

/** DELETE FROM events WHERE id=$1 (deleteEventCascade's final step) */
function addEventsDeleteHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'DELETE events WHERE id',
    verb: 'delete',
    match: (stmt) => stmt.table === 'events',
    respond,
  })
}

/** SELECT event_id FROM event_room_blocks WHERE room_id=... AND date=... AND start_time<... AND end_time>... (listEventsBlockingRoom) */
function addBlockingRoomEventIdsHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT event_id FROM event_room_blocks (listEventsBlockingRoom)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, 'event_id'),
    respond,
  })
}

/** SELECT id, title, description, date, start_time, end_time, created_by, created_at FROM events WHERE id = ANY(...) (listEventsBlockingRoom) */
function addEventsByIdsHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT events WHERE id = ANY(...)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'events' &&
      Boolean(stmt.whereClause?.includes('any(')) &&
      hasExactSelectColumns(stmt, 'id, title, description, date, start_time, end_time, created_by, created_at'),
    respond,
  })
}

// ---------------------------------------------------------------------------
// createEvent — multi-block path
// ---------------------------------------------------------------------------

describe('events-service — createEvent multi-day (schedules)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('inserts the event row and one event_room_blocks row per block when schedules array is provided', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow()])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ id: `block-${values[1]}`, date: values[2], start_time: values[3], end_time: values[4] }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Multi-Day Event',
      schedules: [
        { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
        { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
      ],
    })

    expect(result.schedules).toHaveLength(2)
    expect(result.schedules[0].date).toBe('2026-07-10')
    expect(result.schedules[1].date).toBe('2026-07-11')
    expect(sqlMock.sql).toHaveBeenCalled()
  })

  it('populates schedules and roomBlocks from the inserted block rows', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow()])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Multi-Day Event',
      schedules: [
        { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
        { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
      ],
    })

    expect(result.roomBlocks).toHaveLength(2)
    expect(result.schedules).toHaveLength(2)
    // Anchor date = earliest block
    expect(result.date).toBe('2026-07-10')
  })

  it('sets allDay=true for a block when allDay flag is set', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow({ date: '2026-07-10', start_time: '00:00:00', end_time: '23:59:00' })])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string, all_day: values[5] as boolean }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'All Day Event',
      schedules: [{ date: '2026-07-10', roomId: 'room-1', allDay: true, startTime: '', endTime: '' }],
    })

    expect(result.allDay).toBe(true)
    expect(result.schedules[0].allDay).toBe(true)
  })

  it('rejects a schedule block with invalid date format', async () => {
    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Bad Date Event',
        schedules: [{ date: 'not-a-date', startTime: '18:00', endTime: '22:00', roomId: null, allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/date must be in YYYY-MM-DD format/) })

    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('rejects a schedule block where endTime <= startTime', async () => {
    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Bad Time Event',
        schedules: [{ date: '2026-07-10', startTime: '22:00', endTime: '18:00', roomId: null, allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/endTime must be after startTime/) })

    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('rejects a schedule block with non-whole-hour start time', async () => {
    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Bad Time Event',
        schedules: [{ date: '2026-07-10', startTime: '18:30', endTime: '22:00', roomId: null, allDay: false }],
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/startTime must be on a whole-hour boundary/),
    })

    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('accepts schedules with null roomId (no room blocked) — returns synthetic schedule entry', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow()])
    const blockInsertSpy = vi.fn(() => [])
    addRoomBlockInsertHandler(blockInsertSpy)
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'No Room Event',
      schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: null, allDay: false }],
    })

    // No real room blocks (null-room blocks are not stored as room blocks)
    expect(blockInsertSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
    expect(result.roomBlocks).toHaveLength(0)
    // Service synthesises ONE schedule entry from the event anchor when no room blocks exist
    expect(result.schedules).toHaveLength(1)
    expect(result.schedules[0].roomId).toBeNull()
    expect(result.schedules[0].date).toBe('2026-07-10')
    expect(result.schedules[0].startTime).toBe('18:00')
    expect(result.schedules[0].endTime).toBe('22:00')
  })

  it('throws 500 when the events insert fails', async () => {
    addMultiBlockEventInsertHandler(() => {
      throw new Error('DB error')
    })

    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Failing Event',
        schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 500 })
  })

  it('rejects empty schedules array with 400', async () => {
    const { createEvent } = await loadService()

    await expect(createEvent({ title: 'Empty Schedules', schedules: [] })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/At least one schedule is required/),
    })
    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('rejects schedules array with more than 366 entries with 400', async () => {
    const { createEvent } = await loadService()

    const schedules = Array.from({ length: 367 }, (_, i) => {
      const dateStr = new Date(2026, 0, 1 + (i % 365)).toISOString().slice(0, 10)
      return { date: dateStr, startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }
    })

    await expect(createEvent({ title: 'Too Many Blocks', schedules })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Too many schedule blocks/),
    })
    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('passes createdBy through to the inserted event row when provided in body', async () => {
    addMultiBlockEventInsertHandler((values) => [makeEventRow({ created_by: values[5] })])
    addRoomBlockInsertHandler(() => [makeBlockRow()])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Creator Event',
      createdBy: 'user-abc',
      schedules: [{ date: '2026-09-01', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }],
    })

    expect(result.createdBy).toBe('user-abc')
  })

  it('derives anchor date as earliest block and sorts schedules ascending when blocks are submitted out of order', async () => {
    addMultiBlockEventInsertHandler((values) => [makeEventRow({ date: values[2], start_time: values[3], end_time: values[4] })])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ id: `b-${values[2]}`, date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Out Of Order',
      schedules: [
        { date: '2026-08-03', startTime: '14:00', endTime: '16:00', roomId: 'room-1', allDay: false },
        { date: '2026-08-01', startTime: '09:00', endTime: '11:00', roomId: 'room-1', allDay: false },
        { date: '2026-08-02', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false },
      ],
    })

    // Anchor date is the earliest block
    expect(result.date).toBe('2026-08-01')
    // schedules sorted ascending by date
    expect(result.schedules).toHaveLength(3)
    expect(result.schedules[0].date).toBe('2026-08-01')
    expect(result.schedules[1].date).toBe('2026-08-02')
    expect(result.schedules[2].date).toBe('2026-08-03')
  })

  it('handles multi-room single-day event (two rooms, same day)', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow({ date: '2026-10-01', start_time: '10:00:00', end_time: '14:00:00' })])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ id: `b-${values[1]}`, room_id: values[1] as string, date: '2026-10-01', start_time: '10:00:00', end_time: '14:00:00' }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Multi-Room Single Day',
      schedules: [
        { date: '2026-10-01', startTime: '10:00', endTime: '14:00', roomId: 'room-A', allDay: false },
        { date: '2026-10-01', startTime: '10:00', endTime: '14:00', roomId: 'room-B', allDay: false },
      ],
    })

    expect(result.roomBlocks).toHaveLength(2)
    expect(result.schedules).toHaveLength(2)
    expect(result.date).toBe('2026-10-01')
    const roomIds = result.roomBlocks.map((b) => b.roomId)
    expect(roomIds).toContain('room-A')
    expect(roomIds).toContain('room-B')
  })

  it('maps a PG check-constraint error (23514) from the events insert to 400', async () => {
    addMultiBlockEventInsertHandler(() => {
      throw neonDbError('23514', 'check constraint violated')
    })

    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Constraint Fail',
        schedules: [{ date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('preserves a roomless block (roomId: null) as a non-persisted schedule entry instead of dropping it (#303 code-review post-PR round, Finding 1)', async () => {
    addMultiBlockEventInsertHandler(() => [makeEventRow({ date: '2026-07-10', start_time: '10:00:00', end_time: '12:00:00' })])
    const blockInsertSpy = vi.fn((values: unknown[]) => [
      makeBlockRow({
        id: 'block-roomed-1',
        room_id: values[1] as string,
        date: values[2] as string,
        start_time: values[3] as string,
        end_time: values[4] as string,
      }),
    ])
    addRoomBlockInsertHandler(blockInsertSpy)
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Mixed Roomless Event',
      schedules: [
        { date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
        { date: '2026-07-11', startTime: '14:00', endTime: '16:00', roomId: 'room-1', allDay: false },
      ],
    })

    // Only the room-assigned block issues an INSERT — event_room_blocks.room_id
    // is NOT NULL, so a roomless block can never become a persisted row.
    expect(blockInsertSpy).toHaveBeenCalledTimes(1)
    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-1')

    // The roomless block must still appear in schedules — as a synthetic,
    // non-persisted entry (id: undefined, roomId: null) — not be silently
    // dropped from the response entirely.
    expect(result.schedules).toHaveLength(2)
    const roomlessEntry = result.schedules.find((s) => s.roomId === null)
    expect(roomlessEntry).toBeDefined()
    expect(roomlessEntry!.id).toBeUndefined()
    expect(roomlessEntry!.date).toBe('2026-07-10')
    expect(roomlessEntry!.startTime).toBe('10:00')
    expect(roomlessEntry!.endTime).toBe('12:00')

    const roomedEntry = result.schedules.find((s) => s.roomId === 'room-1')
    expect(roomedEntry).toBeDefined()
    expect(roomedEntry!.date).toBe('2026-07-11')
  })

  // -------------------------------------------------------------------------
  // Compensating rollback (#303 code-review Finding 2) — createEvent path.
  //
  // These loops are NOT wrapped in a single sql.transaction() (see
  // lib/server/events-service.ts's rollbackPartialMultiBlockWrite doc
  // comment): each iteration branches on the previous query's runtime
  // result, which Neon's HTTP driver's batched transaction() can't express.
  // If a later block's INSERT fails, rollbackPartialMultiBlockWrite must:
  // - delete every event_room_blocks row inserted so far in this call
  // - reactivate every reservation cancelled so far in this call
  // - (createEvent only) delete the now-orphaned event row
  // -------------------------------------------------------------------------
  describe('compensating rollback on partial multi-block write failure', () => {
    it('rolls back inserted blocks, reactivated reservations, and the orphaned event row when a later block INSERT fails', async () => {
      addMultiBlockEventInsertHandler(() => [makeEventRow({ id: 'evt-rollback-1' })])

      let insertCallIndex = 0
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (fails on 2nd block)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
        respond: (stmt) => {
          insertCallIndex += 1
          if (insertCallIndex === 2) {
            throw new Error('connection reset mid-insert')
          }
          return [
            makeBlockRow({
              id: 'block-1',
              date: stmt.values[2] as string,
              start_time: stmt.values[3] as string,
              end_time: stmt.values[4] as string,
            }),
          ]
        },
      })

      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-1' }],
      })

      const rollbackBlocksDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: rollbackBlocksDeleteSpy,
      })

      const rollbackReactivateSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'UPDATE reservations SET active WHERE id = ANY(...) (rollback)',
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id'),
        respond: rollbackReactivateSpy,
      })

      const rollbackEventDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (rollback, createEvent)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: rollbackEventDeleteSpy,
      })

      const { createEvent } = await loadService()

      await expect(
        createEvent({
          title: 'Rollback Event',
          schedules: [
            { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
            { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      // Rollback deletes exactly the one block inserted before the failure.
      expect(rollbackBlocksDeleteSpy).toHaveBeenCalledTimes(1)
      expect(rollbackBlocksDeleteSpy.mock.calls[0][0].values).toEqual([['block-1']])

      // Rollback reactivates exactly the one reservation cancelled before the failure.
      expect(rollbackReactivateSpy).toHaveBeenCalledTimes(1)
      expect(rollbackReactivateSpy.mock.calls[0][0].values).toEqual([['res-1']])

      // createEvent's rollback also deletes the now-orphaned event row.
      expect(rollbackEventDeleteSpy).toHaveBeenCalledTimes(1)
      expect(rollbackEventDeleteSpy.mock.calls[0][0].values).toEqual(['evt-rollback-1'])
    })

    it('does not attempt any rollback deletes/reactivations when every block insert succeeds', async () => {
      addMultiBlockEventInsertHandler(() => [makeEventRow({ id: 'evt-ok-1' })])
      addRoomBlockInsertHandler((values) => [
        makeBlockRow({ id: `block-${values[2]}`, date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string }),
      ])
      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-1' }],
      })

      const rollbackBlocksDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: rollbackBlocksDeleteSpy,
      })
      const rollbackEventDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (rollback, createEvent)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: rollbackEventDeleteSpy,
      })

      const { createEvent } = await loadService()

      await createEvent({
        title: 'No Rollback Needed',
        schedules: [
          { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
          { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
        ],
      })

      expect(rollbackBlocksDeleteSpy).not.toHaveBeenCalled()
      expect(rollbackEventDeleteSpy).not.toHaveBeenCalled()
    })

    it('restores a cancelled reservation to its own original status (pending), not hardcoded active (#303 code-review post-PR round, Finding 5)', async () => {
      addMultiBlockEventInsertHandler(() => [makeEventRow({ id: 'evt-rollback-status-1' })])

      let insertCallIndex = 0
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (fails on 2nd block)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
        respond: (stmt) => {
          insertCallIndex += 1
          if (insertCallIndex === 2) throw new Error('connection reset mid-insert')
          return [makeBlockRow({ id: 'block-1', date: stmt.values[2] as string, start_time: stmt.values[3] as string, end_time: stmt.values[4] as string })]
        },
      })

      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      // The cancellation RETURNING now includes each reservation's
      // pre-cancellation status — this one was originally 'pending'.
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id, status)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-pending-1', status: 'pending' }],
      })

      // The SET value ('active'/'pending') is a literal, not a bound param —
      // distinguish the two rollback branches by that literal text, not by
      // WHERE shape (both share the same id = ANY(...) AND status = 'cancelled' WHERE).
      const restoreToPendingSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: "UPDATE reservations SET status = 'pending' (rollback)",
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id') &&
          stmt.text.includes("status = 'pending'"),
        respond: (stmt) => restoreToPendingSpy(stmt.values),
      })
      const restoreToActiveSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: "UPDATE reservations SET status = 'active' (rollback)",
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id') &&
          stmt.text.includes("status = 'active'"),
        respond: (stmt) => restoreToActiveSpy(stmt.values),
      })
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (rollback, createEvent)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: () => [],
      })

      const { createEvent } = await loadService()

      await expect(
        createEvent({
          title: 'Rollback Status Event',
          schedules: [
            { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
            { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(restoreToPendingSpy).toHaveBeenCalledTimes(1)
      expect(restoreToPendingSpy.mock.calls[0][0]).toEqual([['res-pending-1']])
      expect(restoreToActiveSpy).not.toHaveBeenCalled()
    })

    it('restores a cancelled reservation to active when that was its own original status (#303 code-review post-PR round, Finding 5)', async () => {
      addMultiBlockEventInsertHandler(() => [makeEventRow({ id: 'evt-rollback-status-2' })])

      let insertCallIndex = 0
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (fails on 2nd block)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
        respond: (stmt) => {
          insertCallIndex += 1
          if (insertCallIndex === 2) throw new Error('connection reset mid-insert')
          return [makeBlockRow({ id: 'block-1', date: stmt.values[2] as string, start_time: stmt.values[3] as string, end_time: stmt.values[4] as string })]
        },
      })

      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id, status)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-active-1', status: 'active' }],
      })

      const restoreToPendingSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: "UPDATE reservations SET status = 'pending' (rollback)",
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id') &&
          stmt.text.includes("status = 'pending'"),
        respond: (stmt) => restoreToPendingSpy(stmt.values),
      })
      const restoreToActiveSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: "UPDATE reservations SET status = 'active' (rollback)",
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id') &&
          stmt.text.includes("status = 'active'"),
        respond: (stmt) => restoreToActiveSpy(stmt.values),
      })
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (rollback, createEvent)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: () => [],
      })

      const { createEvent } = await loadService()

      await expect(
        createEvent({
          title: 'Rollback Status Event 2',
          schedules: [
            { date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false },
            { date: '2026-07-11', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(restoreToActiveSpy).toHaveBeenCalledTimes(1)
      expect(restoreToActiveSpy.mock.calls[0][0]).toEqual([['res-active-1']])
      expect(restoreToPendingSpy).not.toHaveBeenCalled()
    })
  })
})

// ---------------------------------------------------------------------------
// updateEvent — multi-block path
// ---------------------------------------------------------------------------

describe('events-service — updateEvent multi-day (schedules)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('replaces blocks (delete-then-insert) when schedules array is provided', async () => {
    addCurrentEventHandler(() => [
      { title: 'Old Title', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => [makeEventRow({ title: 'Updated Multi-Day' })])
    const deleteSpy = vi.fn(() => [])
    addBlocksDeleteHandler(deleteSpy)
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-1', {
      title: 'Updated Multi-Day',
      schedules: [
        { date: '2026-08-01', startTime: '09:00', endTime: '13:00', roomId: 'room-1', allDay: false },
        { date: '2026-08-02', startTime: '14:00', endTime: '18:00', roomId: 'room-1', allDay: false },
      ],
    })

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(result.schedules).toHaveLength(2)
  })

  it('derives title from current event row when not provided in update body', async () => {
    addCurrentEventHandler(() => [
      { title: 'Existing Title', description: 'Existing desc', date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler((values) => [makeEventRow({ title: values[0] })])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler(() => [makeBlockRow()])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-1', {
      schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false }],
    })

    expect(result.title).toBe('Existing Title')
  })

  it('throws 404 when event does not exist', async () => {
    addCurrentEventHandler(() => [])

    const { updateEvent } = await loadService()

    await expect(
      updateEvent('nonexistent', {
        schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 500 when the events update fails', async () => {
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => {
      throw new Error('DB error')
    })

    const { updateEvent } = await loadService()

    await expect(
      updateEvent('evt-1', {
        schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '22:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 500 })
  })

  it('rejects empty schedules array with 400 on update', async () => {
    addCurrentEventHandler(() => [
      { title: 'Existing', description: null, date: '2026-07-10', start_time: '10:00:00', end_time: '12:00:00', title_es: null, title_en: null },
    ])

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-1', { schedules: [] })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/At least one schedule is required/),
    })
  })

  it('rejects schedules array > 366 entries with 400 on update', async () => {
    addCurrentEventHandler(() => [
      { title: 'Existing', description: null, date: '2026-07-10', start_time: '10:00:00', end_time: '12:00:00', title_es: null, title_en: null },
    ])

    const { updateEvent } = await loadService()

    const schedules = Array.from({ length: 367 }, (_, i) => {
      const dateStr = new Date(2026, 0, 1 + (i % 365)).toISOString().slice(0, 10)
      return { date: dateStr, startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }
    })

    await expect(updateEvent('evt-1', { schedules })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Too many schedule blocks/),
    })
  })

  it('shrinks block count from 2 to 1 and returns correct schedules', async () => {
    addCurrentEventHandler(() => [
      { title: 'Event', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => [makeEventRow({ date: '2026-08-01', start_time: '09:00:00', end_time: '13:00:00' })])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler((values) => [
      makeBlockRow({ id: 'b1', date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string }),
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-1', {
      schedules: [{ date: '2026-08-01', startTime: '09:00', endTime: '13:00', roomId: 'room-1', allDay: false }],
    })

    expect(result.schedules).toHaveLength(1)
    expect(result.schedules[0].date).toBe('2026-08-01')
  })

  it('grows block count from 1 to 3 and returns correct schedules', async () => {
    addCurrentEventHandler(() => [
      { title: 'Growing Event', description: null, date: '2026-09-01', start_time: '10:00:00', end_time: '14:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => [makeEventRow({ date: '2026-09-01', start_time: '10:00:00', end_time: '14:00:00' })])
    addBlocksDeleteHandler(() => [])
    let n = 0
    addRoomBlockInsertHandler((values) => {
      n += 1
      return [makeBlockRow({ id: `b${n}`, date: values[2] as string, start_time: values[3] as string, end_time: values[4] as string })]
    })
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-1', {
      schedules: [
        { date: '2026-09-01', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
        { date: '2026-09-02', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
        { date: '2026-09-03', startTime: '10:00', endTime: '14:00', roomId: 'room-1', allDay: false },
      ],
    })

    expect(result.schedules).toHaveLength(3)
    expect(result.schedules[0].date).toBe('2026-09-01')
    expect(result.schedules[1].date).toBe('2026-09-02')
    expect(result.schedules[2].date).toBe('2026-09-03')
  })

  it('maps a distinct non-check-constraint NeonDbError from the update to the generic 500 (error-mapping coverage on the update path too)', async () => {
    // Adapted from the pre-Neon-migration test "maps PG P0001 error to 404 on
    // update": that scenario relied on `update_event_atomic`'s custom
    // `RAISE EXCEPTION ... P0001` for an event that disappeared between the
    // existence check and the RPC call — a race the RPC itself detected.
    // The Neon port has no equivalent later existence check (there is no
    // second, RPC-internal existence check to race against — updateEvent's
    // single upfront `currentRows` SELECT is the only such check, already
    // covered by the "throws 404 when event does not exist" test above), and
    // mapEventWriteError has no code that maps to 404 — only 23514/22P02/
    // 23502 map to 400, everything else (including an arbitrary NeonDbError
    // code) maps to 500. This test instead documents that behavior directly:
    // a NeonDbError whose code isn't one of the three 400-mapped codes still
    // falls through to the generic 500, not a mis-mapped 4xx.
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-07-10', start_time: '10:00:00', end_time: '12:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => {
      throw neonDbError('40001', 'serialization_failure')
    })

    const { updateEvent } = await loadService()

    await expect(
      updateEvent('evt-1', {
        schedules: [{ date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 500 })
  })

  it('maps PG check-constraint 23514 to 400 on update', async () => {
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-07-10', start_time: '10:00:00', end_time: '12:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => {
      throw neonDbError('23514', 'check constraint violated')
    })

    const { updateEvent } = await loadService()

    await expect(
      updateEvent('evt-1', {
        schedules: [{ date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('preserves a roomless block (roomId: null) as a non-persisted schedule entry, even though the unconditional DELETE already wiped all prior blocks (#303 code-review post-PR round, Finding 2)', async () => {
    addCurrentEventHandler(() => [
      { title: 'Existing', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addMultiBlockEventUpdateHandler(() => [makeEventRow({ id: 'evt-1' })])
    // The pre-loop DELETE wipes every pre-existing block for this event,
    // unconditionally, before the loop below even looks at the roomless
    // entry — this is what makes Finding 2 worse than Finding 1: a skip
    // here isn't just missing from the response, it's permanently lost.
    const replaceDeleteSpy = vi.fn(() => [])
    addBlocksDeleteHandler(replaceDeleteSpy)

    const blockInsertSpy = vi.fn((values: unknown[]) => [
      makeBlockRow({
        id: 'block-roomed-1',
        room_id: values[1] as string,
        date: values[2] as string,
        start_time: values[3] as string,
        end_time: values[4] as string,
      }),
    ])
    addRoomBlockInsertHandler(blockInsertSpy)
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-1', {
      schedules: [
        { date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
        { date: '2026-07-11', startTime: '14:00', endTime: '16:00', roomId: 'room-1', allDay: false },
      ],
    })

    // The pre-loop wipe did happen (proving this scenario really exercises
    // the "worse than createEvent" ordering)...
    expect(replaceDeleteSpy).toHaveBeenCalledTimes(1)

    // ...only the room-assigned block issues an INSERT...
    expect(blockInsertSpy).toHaveBeenCalledTimes(1)
    expect(result.roomBlocks).toHaveLength(1)

    // ...and the roomless block is NOT silently dropped: it still appears in
    // schedules as a synthetic, non-persisted entry.
    expect(result.schedules).toHaveLength(2)
    const roomlessEntry = result.schedules.find((s) => s.roomId === null)
    expect(roomlessEntry).toBeDefined()
    expect(roomlessEntry!.id).toBeUndefined()
    expect(roomlessEntry!.date).toBe('2026-07-10')
    expect(roomlessEntry!.startTime).toBe('10:00')
    expect(roomlessEntry!.endTime).toBe('12:00')
  })

  // -------------------------------------------------------------------------
  // Compensating rollback (#303 code-review Finding 2) — updateEvent path.
  //
  // Unlike createEvent's rollback, the event row here pre-existed the call
  // and must NOT be deleted on failure — only the blocks/reservations this
  // specific call touched are rolled back (see rollbackPartialMultiBlockWrite
  // callers in lib/server/events-service.ts).
  // -------------------------------------------------------------------------
  describe('compensating rollback on partial multi-block write failure', () => {
    it('rolls back inserted blocks and reactivated reservations, but does NOT delete the pre-existing event row', async () => {
      addCurrentEventHandler(() => [
        { title: 'Existing', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
      ])
      addMultiBlockEventUpdateHandler(() => [makeEventRow({ id: 'evt-1' })])

      // The "replace" step deletes ALL existing blocks for this event first —
      // distinct from the rollback's targeted id=ANY(...) delete below (its
      // WHERE clause is `event_id = $1`, which never satisfies the
      // word-boundary-anchored `whereHasColumn(stmt, 'id')` check the
      // rollback handler uses).
      const replaceDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE event_id (replace step)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'event_id'),
        respond: replaceDeleteSpy,
      })

      let insertCallIndex = 0
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (fails on 2nd block)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
        respond: (stmt) => {
          insertCallIndex += 1
          if (insertCallIndex === 2) {
            throw new Error('connection reset mid-insert')
          }
          return [
            makeBlockRow({
              id: 'block-1',
              date: stmt.values[2] as string,
              start_time: stmt.values[3] as string,
              end_time: stmt.values[4] as string,
            }),
          ]
        },
      })

      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-1' }],
      })

      const rollbackBlocksDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: rollbackBlocksDeleteSpy,
      })

      const rollbackReactivateSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'UPDATE reservations SET active WHERE id = ANY(...) (rollback)',
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id'),
        respond: rollbackReactivateSpy,
      })

      const eventsDeleteSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (must NOT be called by updateEvent rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: eventsDeleteSpy,
      })
      // revertEventFieldsOnFailure also fires on this failure path (round 4)
      // — asserted directly by the dedicated test below; present here only
      // so this pre-existing test's mock doesn't throw an unhandled-query
      // error for it.
      sqlMock.addHandler({
        name: 'UPDATE events (revert fields, no RETURNING)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events' && !stmt.returning,
        respond: () => [],
      })

      const { updateEvent } = await loadService()

      await expect(
        updateEvent('evt-1', {
          schedules: [
            { date: '2026-08-01', startTime: '09:00', endTime: '13:00', roomId: 'room-1', allDay: false },
            { date: '2026-08-02', startTime: '14:00', endTime: '18:00', roomId: 'room-1', allDay: false },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      // Rollback deletes exactly the one block inserted before the failure.
      expect(rollbackBlocksDeleteSpy).toHaveBeenCalledTimes(1)
      expect(rollbackBlocksDeleteSpy.mock.calls[0][0].values).toEqual([['block-1']])

      // Rollback reactivates exactly the one reservation cancelled before the failure.
      expect(rollbackReactivateSpy).toHaveBeenCalledTimes(1)
      expect(rollbackReactivateSpy.mock.calls[0][0].values).toEqual([['res-1']])

      // updateEvent's rollback does NOT delete the event row — it pre-existed this call.
      expect(eventsDeleteSpy).not.toHaveBeenCalled()
    })

    it('also restores the pre-existing blocks the unconditional DELETE wiped, and reverts the event-row field mutation, when a later block insert fails (#303 code-review round 4)', async () => {
      const originalRow = { title: 'Existing', description: 'Existing desc', date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null }
      addCurrentEventHandler(() => [originalRow])
      addMultiBlockEventUpdateHandler(() => [makeEventRow({ id: 'evt-1', title: 'Updated Multi-Day' })])

      // The unconditional "replace" DELETE now captures (via RETURNING) the
      // block(s) it wipes, so they can be restored if a later block's INSERT
      // fails mid-loop.
      const preExistingBlock = {
        id: 'block-pre-1',
        event_id: 'evt-1',
        room_id: 'room-1',
        date: '2026-07-10',
        start_time: '18:00:00',
        end_time: '22:00:00',
        all_day: false,
      }
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE event_id (replace step, RETURNING)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'event_id'),
        respond: () => [preExistingBlock],
      })

      let insertCallIndex = 0
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (fails on 2nd block)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
        respond: (stmt) => {
          insertCallIndex += 1
          if (insertCallIndex === 2) {
            throw new Error('connection reset mid-insert')
          }
          return [
            makeBlockRow({
              id: 'block-new-1',
              date: stmt.values[2] as string,
              start_time: stmt.values[3] as string,
              end_time: stmt.values[4] as string,
            }),
          ]
        },
      })

      addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (RETURNING id)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [{ id: 'res-1' }],
      })
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })
      sqlMock.addHandler({
        name: 'UPDATE reservations SET active WHERE id = ANY(...) (rollback)',
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'reservations' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'table_id'),
        respond: () => [],
      })

      // restoreDeletedBlocksOnUpdateFailure's reinsert: has an explicit `id`
      // column and NO RETURNING clause — distinct from the block-insert
      // handler above (which requires RETURNING).
      const restoreInsertSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (restore, no RETURNING)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
        respond: (stmt) => restoreInsertSpy(stmt.values),
      })

      // revertEventFieldsOnFailure's UPDATE: same columns as the multi-block
      // UPDATE events RETURNING statement, but with NO RETURNING clause.
      const revertFieldsSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'UPDATE events (revert fields, no RETURNING)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events' && !stmt.returning,
        respond: (stmt) => revertFieldsSpy(stmt.values),
      })

      const { updateEvent } = await loadService()

      await expect(
        updateEvent('evt-1', {
          schedules: [
            { date: '2026-08-01', startTime: '09:00', endTime: '13:00', roomId: 'room-1', allDay: false },
            { date: '2026-08-02', startTime: '14:00', endTime: '18:00', roomId: 'room-1', allDay: false },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      // The pre-existing block wiped by the unconditional DELETE is reinserted verbatim.
      expect(restoreInsertSpy).toHaveBeenCalledTimes(1)
      expect(restoreInsertSpy).toHaveBeenCalledWith([
        preExistingBlock.id,
        preExistingBlock.event_id,
        preExistingBlock.room_id,
        preExistingBlock.date,
        preExistingBlock.start_time,
        preExistingBlock.end_time,
        preExistingBlock.all_day,
      ])

      // The event row's field mutation is reverted back to its pre-update values.
      expect(revertFieldsSpy).toHaveBeenCalledTimes(1)
      expect(revertFieldsSpy).toHaveBeenCalledWith([
        originalRow.title,
        originalRow.description,
        originalRow.date,
        originalRow.start_time,
        originalRow.end_time,
        'evt-1',
      ])
    })

    it('reverts the event-row field mutation when the unconditional block DELETE itself fails (#303 code-review round 4 audit)', async () => {
      const originalRow = { title: 'Existing', description: null, date: '2026-07-10', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null }
      addCurrentEventHandler(() => [originalRow])
      addMultiBlockEventUpdateHandler(() => [makeEventRow({ id: 'evt-1', title: 'Updated Multi-Day' })])

      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE event_id (replace step, fails)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'event_id'),
        respond: () => {
          throw new Error('connection reset on delete')
        },
      })

      const revertFieldsSpy = vi.fn(() => [])
      sqlMock.addHandler({
        name: 'UPDATE events (revert fields, no RETURNING)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events' && !stmt.returning,
        respond: (stmt) => revertFieldsSpy(stmt.values),
      })

      const { updateEvent } = await loadService()

      await expect(
        updateEvent('evt-1', {
          schedules: [{ date: '2026-08-01', startTime: '09:00', endTime: '13:00', roomId: 'room-1', allDay: false }],
        }),
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(revertFieldsSpy).toHaveBeenCalledTimes(1)
      expect(revertFieldsSpy).toHaveBeenCalledWith([
        originalRow.title,
        originalRow.description,
        originalRow.date,
        originalRow.start_time,
        originalRow.end_time,
        'evt-1',
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// listEventsBlockingRoom — availability check still works for multi-day blocks
// ---------------------------------------------------------------------------

describe('events-service — listEventsBlockingRoom (multi-day awareness)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('returns events blocking a room on a specific date within time range', async () => {
    addBlockingRoomEventIdsHandler(() => [{ event_id: 'evt-multi' }])
    addEventsByIdsHandler(() => [
      makeEventRow({ id: 'evt-multi', title: 'Multi-Day Blocker', date: '2026-08-01', start_time: '10:00:00', end_time: '18:00:00' }),
    ])

    const { listEventsBlockingRoom } = await loadService()

    const results = await listEventsBlockingRoom('room-1', '2026-08-01', '11:00', '14:00')

    expect(results).toHaveLength(1)
    expect(results[0].title).toBe('Multi-Day Blocker')
    // listEventsBlockingRoom calls toAdminEvent(row, []) — no room blocks joined.
    // The service synthesises ONE schedule entry from the event anchor in that case.
    expect(results[0].schedules).toHaveLength(1)
    expect(results[0].schedules[0].roomId).toBeNull()
    expect(results[0].schedules[0].date).toBe('2026-08-01')
  })

  it('returns empty array when no blocks overlap the query window', async () => {
    addBlockingRoomEventIdsHandler(() => [])
    const eventsSpy = vi.fn(() => [])
    addEventsByIdsHandler(eventsSpy)

    const { listEventsBlockingRoom } = await loadService()

    const results = await listEventsBlockingRoom('room-1', '2026-09-15', '08:00', '10:00')

    expect(results).toHaveLength(0)
    // Short-circuits before querying events when there are no matching blocks
    expect(eventsSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// deleteEvent — multi-day cancellation
// ---------------------------------------------------------------------------

describe('events-service — deleteEvent multi-day cancellation', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('cancels reservations for every block date (multi-day event)', async () => {
    addDeleteGuardHandler(() => [{ id: 'evt-multi', title_es: null, title_en: null }])
    addCascadeBlocksFetchHandler(() => [
      { room_id: 'room-1', date: '2026-08-01', start_time: '10:00:00', end_time: '14:00:00' },
      { room_id: 'room-1', date: '2026-08-02', start_time: '10:00:00', end_time: '14:00:00' },
      { room_id: 'room-1', date: '2026-08-03', start_time: '10:00:00', end_time: '14:00:00' },
    ])
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-1' }])
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)
    addEventsDeleteHandler(() => [])

    const { deleteEvent } = await loadService()

    await deleteEvent('evt-multi')

    // update called once per block (3 blocks, each with a real room)
    expect(cancelSpy).toHaveBeenCalledTimes(3)
  })

  it('skips reservation cancellation for null-room blocks', async () => {
    addDeleteGuardHandler(() => [{ id: 'evt-null', title_es: null, title_en: null }])
    addCascadeBlocksFetchHandler(() => [
      { room_id: null, date: '2026-09-01', start_time: '10:00:00', end_time: '12:00:00' },
    ])
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)
    addEventsDeleteHandler(() => [])

    const { deleteEvent } = await loadService()

    await deleteEvent('evt-null')

    // No reservations should be cancelled — null-room blocks have no tableIds,
    // and (per the cascade's distinctRoomIds.filter(Boolean)) the tables
    // lookup itself is skipped entirely.
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('handles mixed null-room and real-room blocks — cancels only for real-room blocks', async () => {
    addDeleteGuardHandler(() => [{ id: 'evt-mixed', title_es: null, title_en: null }])
    addCascadeBlocksFetchHandler(() => [
      { room_id: null, date: '2026-10-01', start_time: '10:00:00', end_time: '12:00:00' },
      { room_id: 'room-1', date: '2026-10-02', start_time: '10:00:00', end_time: '12:00:00' },
      { room_id: null, date: '2026-10-03', start_time: '10:00:00', end_time: '12:00:00' },
    ])
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-1' }])
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)
    addEventsDeleteHandler(() => [])

    const { deleteEvent } = await loadService()

    await deleteEvent('evt-mixed')

    // Only the one real-room block (2026-10-02) triggers a reservation update
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('throws 404 when deleting a non-existent event', async () => {
    addDeleteGuardHandler(() => [])

    const { deleteEvent } = await loadService()

    await expect(deleteEvent('nonexistent')).rejects.toMatchObject({ statusCode: 404 })
  })
})
