// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqlMock,
  hasExactSelectColumns,
  whereColumnHasOperator,
  whereConditionCount,
  whereHasColumn,
} from '../helpers/sql-mock'

/**
 * EVENTS SERVICE TEST COVERAGE (Neon raw SQL — #303)
 *
 * Tests for reservation cancellation logic in createEvent()/updateEvent()'s
 * LEGACY single-block path (no `schedules` array), plus the isClubEventRow
 * guard on updateEvent/deleteEvent.
 *
 * Rewritten off Supabase-client/RPC mocks (`create_event_atomic` /
 * `update_event_atomic`) to the raw-SQL Neon implementation in
 * lib/server/events-service.ts (#303) — those RPCs no longer exist; the same
 * behavior is now plain sequential `sql` statements. Multi-block
 * (`schedules`) coverage lives in events-service-multiday.test.ts;
 * previewEventConflicts coverage lives in events-preview.test.ts.
 *
 * Key scenarios tested:
 * - createEvent with roomId inserts a room block and cancels overlapping
 *   active/pending reservations
 * - createEvent without roomId does not attempt cancellation
 * - updateEvent with changed time cancels overlapping reservations
 * - updateEvent with changed roomId cancels only new room's reservations
 * - updateEvent with title-only changes does not cancel reservations
 * - Error handling when the underlying SQL statements fail
 * - isClubEventRow guard: updateEvent/deleteEvent reject landing rows,
 *   allow legacy rows
 */

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/events-service')
}

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

/** INSERT INTO events (title, description, date, start_time, end_time) — legacy single-block create (5 bound values, no created_by column). RETURNING casts `date` back to text (#313) — pinned here so dropping that cast fails a test instead of only breaking at runtime. */
function addLegacyEventInsertHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'INSERT events (legacy single-block, 5 values)',
    verb: 'insert',
    match: (stmt) =>
      stmt.table === 'events' &&
      stmt.returning &&
      stmt.values.length === 5 &&
      stmt.text.includes('date::text as date'),
    respond: (stmt) => respond(stmt.values),
  })
}

/** INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day) RETURNING ... — RETURNING casts `date` back to text (#313), pinned via stmt.text. */
function addRoomBlockInsertHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'INSERT event_room_blocks',
    verb: 'insert',
    match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning && stmt.text.includes('date::text as date'),
    respond: (stmt) => respond(stmt.values),
  })
}

/** SELECT id FROM tables WHERE room_id = $1 (single room, not ANY — used by cancelOverlappingReservationsForRoom) */
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

/** UPDATE reservations SET status='cancelled' WHERE table_id = ANY(...) AND date=... AND start_time<... AND end_time>... AND status IN (...) */
function addReservationsCancelHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE reservations cancel overlapping',
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
    respond,
  })
}

/** SELECT title, description, date::text AS date, start_time, end_time, title_es, title_en FROM events WHERE id=$1 LIMIT 1 (updateEvent's currentRows fetch; #313 fix folded in — date is cast to text, see events-service.ts) */
function addCurrentEventHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT current event row for update',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'events' &&
      hasExactSelectColumns(stmt, 'title, description, date::text as date, start_time, end_time, title_es, title_en'),
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

/** UPDATE events SET title=,description=,date=,start_time=,end_time= WHERE id=... RETURNING ... (legacy single-block update). RETURNING casts `date` back to text (#313), pinned via stmt.text. */
function addLegacyEventUpdateHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE events (legacy single-block)',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'events' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1 &&
      stmt.text.includes('date::text as date'),
    respond: (stmt) => respond(stmt.values),
  })
}

/** SELECT room_id, all_day FROM event_room_blocks WHERE event_id=$1 LIMIT 1 (updateEvent's existingBlocks lookup) */
function addExistingBlocksHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT room_id, all_day FROM event_room_blocks (existingBlocks)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, 'room_id, all_day'),
    respond,
  })
}

/** DELETE FROM event_room_blocks WHERE event_id=$1 RETURNING ... — RETURNING casts `date` back to text (#313), pinned via stmt.text. */
function addBlocksDeleteHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'DELETE event_room_blocks WHERE event_id',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning && stmt.text.includes('date::text as date'),
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

/** SELECT room_id, date::text AS date, start_time, end_time FROM event_room_blocks WHERE event_id=$1 (deleteEventCascade's blocks fetch; #313 fix folded in — date is cast to text, see events-service.ts) */
function addCascadeBlocksFetchHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT room_id, date::text AS date, start_time, end_time FROM event_room_blocks (cascade)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'event_room_blocks' &&
      hasExactSelectColumns(stmt, 'room_id, date::text as date, start_time, end_time'),
    respond,
  })
}

const eventRow = {
  id: 'evt-1',
  title: 'Test Event',
  description: null,
  date: '2026-04-20',
  start_time: '18:00:00',
  end_time: '22:00:00',
  created_by: null,
  created_at: '2026-04-13T00:00:00Z',
}

describe('events-service — createEvent (legacy single-block) with roomId cancellation', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('inserts a room block and cancels overlapping reservations when roomId is provided', async () => {
    addLegacyEventInsertHandler(() => [eventRow])
    addRoomBlockInsertHandler(() => [
      {
        id: 'block-1',
        event_id: 'evt-1',
        room_id: 'room-1',
        date: '2026-04-20',
        start_time: '18:00:00',
        end_time: '22:00:00',
        all_day: false,
      },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }, { id: 'table-2' }])
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Test Event',
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
      roomId: 'room-1',
    })

    expect(result.id).toBe('evt-1')
    expect(result.title).toBe('Test Event')
    expect(result.roomBlocks).toHaveLength(1)
    expect(result.roomBlocks[0].roomId).toBe('room-1')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('does not attempt cancellation when roomId is not provided', async () => {
    addLegacyEventInsertHandler(() => [{ ...eventRow, title: 'No Room Event' }])
    const blockInsertSpy = vi.fn(() => [])
    addRoomBlockInsertHandler(blockInsertSpy)
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'No Room Event',
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
    })

    expect(result.id).toBe('evt-1')
    expect(result.roomBlocks).toHaveLength(0)
    expect(blockInsertSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('includes description when provided', async () => {
    addLegacyEventInsertHandler(([, description]) => [{ ...eventRow, description: description as string }])

    const { createEvent } = await loadService()

    const result = await createEvent({
      title: 'Event With Description',
      description: 'Test description',
      date: '2026-04-20',
      startTime: '18:00',
      endTime: '22:00',
    })

    expect(result.description).toBe('Test description')
  })

  it('throws 500 when the events insert fails', async () => {
    addLegacyEventInsertHandler(() => {
      throw new Error('connection reset')
    })

    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Test Event',
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: 'room-1',
      }),
    ).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
  })

  it('rejects non-hour event start times before querying', async () => {
    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Test Event',
        date: '2026-04-20',
        startTime: '18:30',
        endTime: '20:00',
        roomId: 'room-1',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'startTime must be on a whole-hour boundary' })

    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  it('rolls back (deletes) the just-inserted event row when the room-block insert fails (#303 code-review round 3, Finding 1)', async () => {
    // The event insert and the block insert are two separate statements
    // (non-transactional, same constraint documented at the top of
    // events-service.ts). A failure here must not leave an orphaned event
    // row with zero blocks — the legacy path reuses
    // rollbackPartialMultiBlockWrite(deleteEvent: true) as-is.
    addLegacyEventInsertHandler(() => [eventRow])
    addRoomBlockInsertHandler(() => {
      throw new Error('connection reset mid-insert')
    })

    const rollbackEventDeleteSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'DELETE events WHERE id (rollback, legacy createEvent)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'events',
      respond: rollbackEventDeleteSpy,
    })

    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Test Event',
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: 'room-1',
      }),
    ).rejects.toMatchObject({ statusCode: 500 })

    expect(rollbackEventDeleteSpy).toHaveBeenCalledTimes(1)
    expect(rollbackEventDeleteSpy.mock.calls[0][0].values).toEqual(['evt-1'])
  })

  it('rolls back the just-inserted event AND block rows when cancelOverlappingReservationsForRoom throws (#303 code-review round 5)', async () => {
    // This call was previously outside any try/catch — a failure here left
    // the just-committed event + block rows with no compensation. Now
    // wrapped: rollbackPartialMultiBlockWrite(deleteEvent: true) deletes the
    // inserted block explicitly (id = ANY([blockRow.id])) and the event row
    // (whose ON DELETE CASCADE would also remove the block, but the explicit
    // block delete still runs first per the helper's own order).
    addLegacyEventInsertHandler(() => [eventRow])
    addRoomBlockInsertHandler(() => [
      { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
    ])
    // cancelOverlappingReservationsForRoom's own internal try/catch turns
    // this into a real 500 ServiceError, which propagates out and triggers
    // createEvent's rollback.
    addTablesBySingleRoomHandler(() => {
      throw new Error('connection reset')
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
      name: 'DELETE events WHERE id (rollback, legacy createEvent)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'events',
      respond: rollbackEventDeleteSpy,
    })

    const { createEvent } = await loadService()

    await expect(
      createEvent({
        title: 'Test Event',
        date: '2026-04-20',
        startTime: '18:00',
        endTime: '22:00',
        roomId: 'room-1',
      }),
    ).rejects.toMatchObject({ statusCode: 500 })

    expect(rollbackBlocksDeleteSpy).toHaveBeenCalledTimes(1)
    expect(rollbackBlocksDeleteSpy.mock.calls[0][0].values).toEqual([['block-1']])

    expect(rollbackEventDeleteSpy).toHaveBeenCalledTimes(1)
    expect(rollbackEventDeleteSpy.mock.calls[0][0].values).toEqual(['evt-1'])
  })
})

describe('events-service — updateEvent (legacy single-block) with cancellation', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('updates event times and cancels overlapping reservations for the existing room', async () => {
    addCurrentEventHandler(() => [
      { title: 'Updated Event', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler(() => [
      { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', date: '2026-04-20', start_time: '16:00:00', end_time: '20:00:00', all_day: false },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })

    expect(result.id).toBe('evt-1')
    expect(result.startTime).toBe('16:00')
    expect(result.endTime).toBe('20:00')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
  })

  it('loads existing room when roomId is not provided', async () => {
    addCurrentEventHandler(() => [
      { title: 'Updated Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(() => [{ ...eventRow, title: 'Updated Title' }])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler(() => [
      { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-update-1', { title: 'Updated Title' })

    expect(result.id).toBe('evt-1')
    expect(result.roomBlocks[0].roomId).toBe('room-1')
  })

  it('keeps existing room when allDay is updated without roomId', async () => {
    addCurrentEventHandler(() => [
      { title: 'Updated Event', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(() => [{ ...eventRow, start_time: '00:00:00', end_time: '23:59:00' }])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler(() => [
      { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', date: '2026-04-20', start_time: '00:00:00', end_time: '23:59:00', all_day: true },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-update-1', { allDay: true })

    expect(result.allDay).toBe(true)
    expect(result.roomBlocks[0].roomId).toBe('room-1')
  })

  it('updates room when roomId is provided', async () => {
    addCurrentEventHandler(() => [
      { title: 'Updated Event', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(() => [eventRow])
    addBlocksDeleteHandler(() => [])
    addRoomBlockInsertHandler(() => [
      { id: 'block-2', event_id: 'evt-1', room_id: 'room-2', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-update-1', { roomId: 'room-2' })

    expect(result.id).toBe('evt-1')
    expect(result.roomBlocks[0].roomId).toBe('room-2')
  })

  it('removes room when roomId is explicitly set to null', async () => {
    addCurrentEventHandler(() => [
      { title: 'Updated Event', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(() => [eventRow])
    addBlocksDeleteHandler(() => [])
    const blockInsertSpy = vi.fn(() => [])
    addRoomBlockInsertHandler(blockInsertSpy)
    const cancelSpy = vi.fn(() => [])
    addReservationsCancelHandler(cancelSpy)

    const { updateEvent } = await loadService()

    const result = await updateEvent('evt-update-1', { roomId: null })

    expect(result.roomBlocks).toHaveLength(0)
    expect(blockInsertSpy).not.toHaveBeenCalled()
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('throws 404 when event does not exist', async () => {
    addCurrentEventHandler(() => [])

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-nonexistent', { title: 'Updated' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 500 when the events update fails', async () => {
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [])
    addLegacyEventUpdateHandler(() => {
      throw new Error('connection reset')
    })

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 500,
    })
  })

  it('throws 404 (not 500) when the events UPDATE...RETURNING affects 0 rows — event deleted between the read and the write (#303 code-review Finding 3)', async () => {
    // Distinct from "throws 404 when event does not exist" above (which
    // fails the upfront currentRows SELECT) and from "throws 500 when the
    // events update fails" above (which throws from the UPDATE itself).
    // Here the SELECT succeeds (event exists at read time) but the UPDATE
    // affects 0 rows — a real race, not an error — and must map to the same
    // 404 the multi-block path already returns for the equivalent race.
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [])
    addLegacyEventUpdateHandler(() => [])

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('restores the deleted block(s) when the replacement block insert fails (#303 code-review round 3, Finding 2)', async () => {
    // The legacy update path deletes the event's existing block(s) BEFORE
    // inserting the replacement — worse ordering than the multi-block path.
    // A failure inserting the new block must reinsert the exact row(s) the
    // DELETE...RETURNING just captured, so the event doesn't end up with
    // zero blocks.
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])

    const deletedBlockRow = {
      id: 'block-old-1',
      event_id: 'evt-update-1',
      room_id: 'room-1',
      date: '2026-04-20',
      start_time: '18:00:00',
      end_time: '22:00:00',
      all_day: false,
    }
    // DELETE FROM event_room_blocks WHERE event_id=$1 RETURNING ... — captures
    // the row(s) about to be restored on failure.
    addBlocksDeleteHandler(() => [deletedBlockRow])

    // The replacement insert (RETURNING present) fails.
    addRoomBlockInsertHandler(() => {
      throw new Error('connection reset mid-insert')
    })

    // The restore path re-inserts each captured row WITHOUT a RETURNING
    // clause — distinct from addRoomBlockInsertHandler above, which only
    // matches inserts that DO have RETURNING.
    const restoreInsertSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'INSERT event_room_blocks (restore, no RETURNING)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
      respond: (stmt) => restoreInsertSpy(stmt.values),
    })
    // revertEventFieldsOnFailure also fires on this failure path (round 4) —
    // asserted directly by the dedicated test below; present here only so
    // this pre-existing test's mock doesn't throw an unhandled-query error.
    sqlMock.addHandler({
      name: 'UPDATE events (revert fields, no RETURNING)',
      verb: 'update',
      match: (stmt) => stmt.table === 'events' && !stmt.returning,
      respond: () => [],
    })

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 500,
    })

    expect(restoreInsertSpy).toHaveBeenCalledTimes(1)
    expect(restoreInsertSpy).toHaveBeenCalledWith([
      deletedBlockRow.id,
      deletedBlockRow.event_id,
      deletedBlockRow.room_id,
      deletedBlockRow.date,
      deletedBlockRow.start_time,
      deletedBlockRow.end_time,
      deletedBlockRow.all_day,
    ])
  })

  it('does not attempt any block restore when the replacement insert succeeds', async () => {
    addCurrentEventHandler(() => [
      { title: 'Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null },
    ])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])
    addBlocksDeleteHandler(() => [
      { id: 'block-old-1', event_id: 'evt-update-1', room_id: 'room-1', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
    ])
    addRoomBlockInsertHandler(() => [
      { id: 'block-new-1', event_id: 'evt-update-1', room_id: 'room-1', date: '2026-04-20', start_time: '16:00:00', end_time: '20:00:00', all_day: false },
    ])
    addTablesBySingleRoomHandler(() => [{ id: 'table-1' }])
    addReservationsCancelHandler(() => [])

    const restoreInsertSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'INSERT event_room_blocks (restore, no RETURNING)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
      respond: (stmt) => restoreInsertSpy(stmt.values),
    })

    const { updateEvent } = await loadService()

    await updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })

    expect(restoreInsertSpy).not.toHaveBeenCalled()
  })

  it('reverts the event-row field mutation (in addition to restoring blocks) when the replacement block insert fails (#303 code-review round 4)', async () => {
    // The `UPDATE events SET title=...` above already committed new field
    // values before this INSERT ran and failed — revertEventFieldsOnFailure
    // must put them back, alongside restoreDeletedBlocksOnUpdateFailure
    // restoring the wiped block (already covered by the round-3 test above).
    const originalRow = { title: 'Original Title', description: 'Original desc', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null }
    addCurrentEventHandler(() => [originalRow])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])
    addBlocksDeleteHandler(() => [
      { id: 'block-old-1', event_id: 'evt-update-1', room_id: 'room-1', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
    ])
    addRoomBlockInsertHandler(() => {
      throw new Error('connection reset mid-insert')
    })
    // restoreDeletedBlocksOnUpdateFailure's reinsert (no RETURNING) — present
    // here so this test's own scenario resolves cleanly; asserted directly
    // by the round-3 test above.
    sqlMock.addHandler({
      name: 'INSERT event_room_blocks (restore, no RETURNING)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
      respond: () => [],
    })

    const revertFieldsSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'UPDATE events (revert fields, no RETURNING)',
      verb: 'update',
      match: (stmt) => stmt.table === 'events' && !stmt.returning,
      respond: (stmt) => revertFieldsSpy(stmt.values),
    })

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 500,
    })

    expect(revertFieldsSpy).toHaveBeenCalledTimes(1)
    expect(revertFieldsSpy).toHaveBeenCalledWith([
      originalRow.title,
      originalRow.description,
      originalRow.date,
      originalRow.start_time,
      originalRow.end_time,
      'evt-update-1',
    ])
  })

  it('reverts the event-row field mutation when the block DELETE itself fails, after the event fields already committed (#303 code-review round 4 audit)', async () => {
    const originalRow = { title: 'Original Title', description: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null }
    addCurrentEventHandler(() => [originalRow])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])
    sqlMock.addHandler({
      name: 'DELETE event_room_blocks WHERE event_id (fails)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'event_room_blocks',
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

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 500,
    })

    expect(revertFieldsSpy).toHaveBeenCalledTimes(1)
    expect(revertFieldsSpy).toHaveBeenCalledWith([
      originalRow.title,
      originalRow.description,
      originalRow.date,
      originalRow.start_time,
      originalRow.end_time,
      'evt-update-1',
    ])
  })

  it('undoes the event-field update, the just-inserted block, AND restores the pre-existing block(s) when cancelOverlappingReservationsForRoom throws (#303 code-review round 5)', async () => {
    // By the time this call runs, the event fields were updated, the old
    // block(s) deleted, and the new block inserted. A failure here must undo
    // all three: delete the newly-inserted block (rollbackPartialMultiBlockWrite,
    // deleteEvent: false — the event itself pre-existed this call), restore
    // the block(s) that existed before this call (restoreDeletedBlocksOnUpdateFailure),
    // and revert the event's field values (revertEventFieldsOnFailure).
    const originalRow = { title: 'Original Title', description: 'Original desc', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', title_es: null, title_en: null }
    addCurrentEventHandler(() => [originalRow])
    addExistingBlocksHandler(() => [{ room_id: 'room-1', all_day: false }])
    addLegacyEventUpdateHandler(([, , date, start_time, end_time]) => [
      { ...eventRow, date: date as string, start_time: start_time as string, end_time: end_time as string },
    ])

    const deletedBlockRow = {
      id: 'block-old-1',
      event_id: 'evt-update-1',
      room_id: 'room-1',
      date: '2026-04-20',
      start_time: '18:00:00',
      end_time: '22:00:00',
      all_day: false,
    }
    // Scoped explicitly to `event_id` (not the generic `addBlocksDeleteHandler`,
    // which matches any DELETE on this table regardless of WHERE clause) so it
    // never intercepts the rollback's `id = ANY(...)` delete registered below.
    sqlMock.addHandler({
      name: 'DELETE event_room_blocks WHERE event_id (replace step)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'event_id'),
      respond: () => [deletedBlockRow],
    })
    addRoomBlockInsertHandler(() => [
      { id: 'block-new-1', event_id: 'evt-update-1', room_id: 'room-1', date: '2026-04-20', start_time: '16:00:00', end_time: '20:00:00', all_day: false },
    ])
    // cancelOverlappingReservationsForRoom's own internal try/catch turns
    // this into a real 500 ServiceError, which propagates out and triggers
    // updateEvent's rollback.
    addTablesBySingleRoomHandler(() => {
      throw new Error('connection reset')
    })

    const rollbackBlocksDeleteSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback, new block)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id'),
      respond: rollbackBlocksDeleteSpy,
    })
    const eventsDeleteSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'DELETE events WHERE id (must NOT be called by updateEvent rollback)',
      verb: 'delete',
      match: (stmt) => stmt.table === 'events',
      respond: eventsDeleteSpy,
    })
    const restoreInsertSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'INSERT event_room_blocks (restore pre-existing, no RETURNING)',
      verb: 'insert',
      match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
      respond: (stmt) => restoreInsertSpy(stmt.values),
    })
    const revertFieldsSpy = vi.fn(() => [])
    sqlMock.addHandler({
      name: 'UPDATE events (revert fields, no RETURNING)',
      verb: 'update',
      match: (stmt) => stmt.table === 'events' && !stmt.returning,
      respond: (stmt) => revertFieldsSpy(stmt.values),
    })

    const { updateEvent } = await loadService()

    await expect(updateEvent('evt-update-1', { startTime: '16:00', endTime: '20:00' })).rejects.toMatchObject({
      statusCode: 500,
    })

    // The newly-inserted block from this call is deleted.
    expect(rollbackBlocksDeleteSpy).toHaveBeenCalledTimes(1)
    expect(rollbackBlocksDeleteSpy.mock.calls[0][0].values).toEqual([['block-new-1']])

    // The event row itself is NOT deleted — it pre-existed this call.
    expect(eventsDeleteSpy).not.toHaveBeenCalled()

    // The block that existed before this call is reinserted verbatim.
    expect(restoreInsertSpy).toHaveBeenCalledTimes(1)
    expect(restoreInsertSpy).toHaveBeenCalledWith([
      deletedBlockRow.id,
      deletedBlockRow.event_id,
      deletedBlockRow.room_id,
      deletedBlockRow.date,
      deletedBlockRow.start_time,
      deletedBlockRow.end_time,
      deletedBlockRow.all_day,
    ])

    // The event row's field mutation is reverted back to its pre-update values.
    expect(revertFieldsSpy).toHaveBeenCalledTimes(1)
    expect(revertFieldsSpy).toHaveBeenCalledWith([
      originalRow.title,
      originalRow.description,
      originalRow.date,
      originalRow.start_time,
      originalRow.end_time,
      'evt-update-1',
    ])
  })

  describe('isClubEventRow guard (Finding 3)', () => {
    it('updateEvent rejects club event rows (both title_es and title_en set)', async () => {
      addCurrentEventHandler(() => [
        {
          title: 'Club Event',
          description: null,
          date: '2026-04-20',
          start_time: '18:00:00',
          end_time: '22:00:00',
          title_es: 'Evento Club',
          title_en: 'Club Event',
        },
      ])

      const { updateEvent } = await loadService()

      await expect(updateEvent('evt-club-1', { title: 'Updated' })).rejects.toMatchObject({
        statusCode: 404,
        message: 'Event not found',
      })
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('deleteEvent rejects club event rows (both title_es and title_en set)', async () => {
      addDeleteGuardHandler(() => [{ id: 'evt-club-2', title_es: 'Otro Evento Club', title_en: 'Another Club Event' }])

      const { deleteEvent } = await loadService()

      await expect(deleteEvent('evt-club-2')).rejects.toMatchObject({
        statusCode: 404,
        message: 'Event not found',
      })
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('updateEvent allows legacy rows (only one of title_es or title_en)', async () => {
      addCurrentEventHandler(() => [
        {
          title: 'Legacy Event',
          description: null,
          date: '2026-04-20',
          start_time: '18:00:00',
          end_time: '22:00:00',
          title_es: 'Evento Legado',
          title_en: null,
        },
      ])
      addExistingBlocksHandler(() => [])
      addLegacyEventUpdateHandler(() => [{ ...eventRow, id: 'evt-legacy-1', title: 'Updated Legacy Event' }])
      addBlocksDeleteHandler(() => [])

      const { updateEvent } = await loadService()

      const result = await updateEvent('evt-legacy-1', { title: 'Updated Legacy Event' })
      expect(result.id).toBe('evt-legacy-1')
      expect(result.title).toBe('Updated Legacy Event')
    })

    it('deleteEvent allows legacy rows (only one of title_es or title_en)', async () => {
      addDeleteGuardHandler(() => [{ id: 'evt-legacy-2', title_es: null, title_en: 'Another Legacy' }])
      addCascadeBlocksFetchHandler(() => [])
      addEventsDeleteHandler(() => [])

      const { deleteEvent } = await loadService()

      await expect(deleteEvent('evt-legacy-2')).resolves.toBeUndefined()
    })
  })
})
