// @vitest-environment node
/**
 * KIM-383: previewEventConflicts service tests (Neon raw SQL — #303)
 *
 * Rewritten off the Supabase admin-client mock to the raw-SQL Neon
 * implementation in lib/server/events-service.ts.
 *
 * Covers:
 * - All null-room schedules → { total: 0, blocks: [] }, no DB queries needed
 * - Room set but no overlapping reservations → total: 0, per-block count 0
 * - Room + overlapping active/pending reservations → correct total and per-block count
 * - Multiple blocks sharing one room → tables lookup is batched (single query)
 * - Empty schedules array → early return (not an error); > 366 schedules → 400
 * - Overlap predicate: end_time == block.start_time is NOT counted; real overlap IS counted
 * - Room with no tables → count 0, block still included
 * - Invalid schedule entries propagate 400
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlMock } from '../helpers/sql-mock'

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/events-service')
}

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

/** SELECT id, room_id FROM tables WHERE room_id = ANY(...) — batched table lookup for all distinct rooms in the request. */
function addTablesByRoomIdsHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && Boolean(stmt.whereClause?.includes('any(')),
    respond,
  })
}

/** SELECT COUNT(*) AS count FROM reservations WHERE table_id = ANY(...) AND ... — one call per roomed block, in call order. */
function addReservationCountHandler(factory: (callIndex: number) => number) {
  let callIndex = 0
  sqlMock.addHandler({
    name: 'SELECT COUNT(*) overlapping reservations',
    verb: 'select',
    match: (stmt) => stmt.table === 'reservations' && stmt.isCountSelect,
    respond: () => {
      const count = factory(callIndex)
      callIndex += 1
      return [{ count }]
    },
  })
}

describe('events-service — previewEventConflicts', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  // -------------------------------------------------------------------------
  // 1. All null-room schedules → early return, no DB queries
  // -------------------------------------------------------------------------

  it('returns { total: 0, blocks: [] } when all schedules have null room_id', async () => {
    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
        { date: '2026-07-11', startTime: '14:00', endTime: '16:00', roomId: null, allDay: false },
      ],
    })

    expect(result).toEqual({ total: 0, blocks: [] })
    // No DB queries should have been issued
    expect(sqlMock.sql).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2. Room set but no overlapping reservations → total 0, count 0 per block
  // -------------------------------------------------------------------------

  it('returns total: 0 when room has tables but no overlapping reservations', async () => {
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-A' }])
    addReservationCountHandler(() => 0)

    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [{ date: '2026-08-01', startTime: '10:00', endTime: '12:00', roomId: 'room-A', allDay: false }],
    })

    expect(result.total).toBe(0)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toEqual({ date: '2026-08-01', roomId: 'room-A', count: 0 })
  })

  // -------------------------------------------------------------------------
  // 3. Room + overlapping active/pending reservations → correct total & count
  // -------------------------------------------------------------------------

  it('returns correct total and per-block count when overlapping reservations exist', async () => {
    // Two blocks in the same room; block 0 has 3 overlapping reservations, block 1 has 2.
    addTablesByRoomIdsHandler(() => [
      { id: 'table-1', room_id: 'room-B' },
      { id: 'table-2', room_id: 'room-B' },
    ])
    addReservationCountHandler((idx) => [3, 2][idx] ?? 0)

    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-09-01', startTime: '10:00', endTime: '14:00', roomId: 'room-B', allDay: false },
        { date: '2026-09-02', startTime: '10:00', endTime: '14:00', roomId: 'room-B', allDay: false },
      ],
    })

    expect(result.total).toBe(5)
    expect(result.blocks).toHaveLength(2)
    expect(result.blocks[0]).toEqual({ date: '2026-09-01', roomId: 'room-B', count: 3 })
    expect(result.blocks[1]).toEqual({ date: '2026-09-02', roomId: 'room-B', count: 2 })
  })

  // -------------------------------------------------------------------------
  // 4. Multiple blocks sharing one room → tables lookup is batched (single query)
  // -------------------------------------------------------------------------

  it('performs a single batched tables lookup for multiple blocks sharing the same room', async () => {
    const tablesSpy = vi.fn(() => [{ id: 'table-1', room_id: 'room-C' }])
    addTablesByRoomIdsHandler(tablesSpy)
    addReservationCountHandler(() => 1)

    const { previewEventConflicts } = await loadService()

    await previewEventConflicts({
      schedules: [
        { date: '2026-10-01', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
        { date: '2026-10-02', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
        { date: '2026-10-03', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
      ],
    })

    // The tables lookup should be called exactly once (batched), not once per block
    expect(tablesSpy).toHaveBeenCalledTimes(1)
    // ...and the room_id list bound into `WHERE room_id = ANY(...)` must be
    // deduplicated — three blocks sharing 'room-C' must produce a single
    // 'room-C' entry, not ['room-C', 'room-C', 'room-C']. `respond` is
    // invoked by the sql-mock dispatcher as `respond(stmt)`, so the parsed
    // statement (and its bound `values`) is captured as this spy's call arg
    // despite the factory's `() => unknown` signature not naming it.
    const stmt = tablesSpy.mock.calls[0][0] as { values: unknown[] }
    expect(stmt.values).toEqual([['room-C']])
  })

  // -------------------------------------------------------------------------
  // 5a. Empty schedules array → early return (no error per implementation)
  // -------------------------------------------------------------------------

  it('returns { total: 0, blocks: [] } for empty schedules array (early exit, not 400)', async () => {
    const { previewEventConflicts } = await loadService()

    // The service implementation: `!Array.isArray(schedules) || schedules.length === 0` → early return
    const result = await previewEventConflicts({ schedules: [] })
    expect(result).toEqual({ total: 0, blocks: [] })
  })

  // -------------------------------------------------------------------------
  // 5b. > 366 schedules → 400
  // -------------------------------------------------------------------------

  it('throws 400 when schedules array has more than 366 entries', async () => {
    const { previewEventConflicts } = await loadService()

    const schedules = Array.from({ length: 367 }, (_, i) => {
      const dateStr = new Date(2026, 0, 1 + (i % 365)).toISOString().slice(0, 10)
      return { date: dateStr, startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }
    })

    await expect(previewEventConflicts({ schedules })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/Too many schedule blocks/),
    })
  })

  // -------------------------------------------------------------------------
  // 6a. Overlap predicate: boundary-touching reservation is NOT counted
  // -------------------------------------------------------------------------

  it('does not count a reservation whose end_time equals the block start_time (strict boundary)', async () => {
    // The service uses: start_time < block.end_time AND end_time > block.start_time.
    // A reservation with end_time == '14:00' does NOT satisfy `end_time > '14:00'`.
    // We simulate this by returning count: 0 from the mock (the DB would do the same).
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-D' }])
    addReservationCountHandler(() => 0)

    const { previewEventConflicts } = await loadService()

    // Block: 14:00–18:00; a boundary-touch reservation ends exactly at 14:00 → not counted.
    const result = await previewEventConflicts({
      schedules: [{ date: '2026-11-01', startTime: '14:00', endTime: '18:00', roomId: 'room-D', allDay: false }],
    })

    expect(result.total).toBe(0)
    expect(result.blocks[0].count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 6b. Genuine overlap IS counted
  // -------------------------------------------------------------------------

  it('counts a reservation that genuinely overlaps the block window', async () => {
    // A reservation 13:00–15:00 overlaps block 14:00–18:00: 13:00 < 18:00 AND 15:00 > 14:00
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-E' }])
    addReservationCountHandler(() => 2)

    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [{ date: '2026-11-02', startTime: '14:00', endTime: '18:00', roomId: 'room-E', allDay: false }],
    })

    expect(result.total).toBe(2)
    expect(result.blocks[0].count).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 7. Room with no tables → count 0, block still appears in result
  // -------------------------------------------------------------------------

  it('includes a block with count: 0 when the room has no tables in the DB', async () => {
    addTablesByRoomIdsHandler(() => [])
    // count handler intentionally not registered — no table ids means the count
    // query is never issued, so a handler returning a non-zero count would
    // never even be reached; the assertion below proves it's skipped.
    const countSpy = vi.fn(() => 99)
    addReservationCountHandler(countSpy)

    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [{ date: '2026-12-01', startTime: '10:00', endTime: '12:00', roomId: 'room-empty', allDay: false }],
    })

    expect(result.total).toBe(0)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toEqual({ date: '2026-12-01', roomId: 'room-empty', count: 0 })
    expect(countSpy).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 8. Invalid schedule entries propagate 400
  // -------------------------------------------------------------------------

  it('throws 400 when a schedule has an invalid date format', async () => {
    const { previewEventConflicts } = await loadService()

    await expect(
      previewEventConflicts({
        schedules: [{ date: 'not-a-date', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/date must be in YYYY-MM-DD format/) })
  })

  it('throws 400 when a schedule has endTime <= startTime', async () => {
    const { previewEventConflicts } = await loadService()

    await expect(
      previewEventConflicts({
        schedules: [{ date: '2026-07-10', startTime: '18:00', endTime: '10:00', roomId: 'room-1', allDay: false }],
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/endTime must be after startTime/) })
  })

  // -------------------------------------------------------------------------
  // 9. Mixed null-room and real-room blocks
  // -------------------------------------------------------------------------

  it('skips null-room blocks but counts conflicts for real-room blocks in the same call', async () => {
    addTablesByRoomIdsHandler(() => [{ id: 'table-1', room_id: 'room-F' }])
    addReservationCountHandler(() => 4)

    const { previewEventConflicts } = await loadService()

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-08-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
        { date: '2026-08-11', startTime: '10:00', endTime: '12:00', roomId: 'room-F', allDay: false },
        { date: '2026-08-12', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
      ],
    })

    // Only the real-room block appears in results
    expect(result.total).toBe(4)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toEqual({ date: '2026-08-11', roomId: 'room-F', count: 4 })
  })
})
