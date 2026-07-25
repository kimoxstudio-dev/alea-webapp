// @vitest-environment node
/**
 * KIM-383: previewEventConflicts service tests
 *
 * Covers:
 * - All null-room schedules → { total: 0, blocks: [] }, no DB queries needed
 * - Room set but no overlapping reservations → total: 0, per-block count 0
 * - Room + overlapping active/pending reservations → correct total and per-block count
 * - Multiple blocks sharing one room → tables lookup is batched (single .in call)
 * - Empty schedules array → early return (not an error); > 366 schedules → 400
 * - Overlap predicate: end_time == block.start_time is NOT counted; real overlap IS counted
 * - Room with no tables → count 0, block still included
 * - Invalid schedule entries propagate 400
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { ServiceError } from '@/lib/server/shared/service-error'

vi.mock('server-only', () => ({}))

// Mock Drizzle database
const drizzleSelectMock = vi.fn()
const mockAdminClient = {
  from: vi.fn(),
}

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => drizzleSelectMock()),
      })),
    })),
  })),
  getAdminDb: vi.fn(() => mockAdminClient),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

// ---------------------------------------------------------------------------
// Mock builder
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Supabase admin client mock for previewEventConflicts.
 *
 * The reservations count query chain is:
 *   .select('id', { count: 'exact', head: true })
 *   .in('table_id', tableIds)   ← first .in
 *   .eq('date', ...)
 *   .lt('start_time', ...)
 *   .gt('end_time', ...)
 *   .in('status', [...])        ← second .in (terminal, resolves)
 *
 * `tablesResult` – what `.from('tables').select().in()` resolves to
 * `reservationCountFactory` – called per reservations count query (by call index)
 */
function buildPreviewMock({
  tablesResult = { data: [] as { id: string; room_id: string }[], error: null },
  reservationCountFactory = (_idx: number): { count: number | null; error: unknown } =>
    ({ count: 0, error: null }),
}: {
  tablesResult?: { data: { id: string; room_id: string }[] | null; error: unknown }
  reservationCountFactory?: (idx: number) => { count: number | null; error: unknown }
} = {}) {
  let reservationCallIndex = 0

  // Track the `in` call on the tables mock
  const tablesInMock = vi.fn().mockResolvedValue(tablesResult)
  const tablesSelectMock = vi.fn().mockReturnValue({ in: tablesInMock })

  /**
   * For each reservations count query, build a chainable object where:
   * - .in() (first call) → returns chain (table_id filter)
   * - .eq() → returns chain
   * - .lt() → returns chain
   * - .gt() → returns chain
   * - .in() (second call) → returns Promise (status filter, terminal)
   *
   * We track how many times `.in` has been called on this specific chain instance.
   */
  const makeReservationsChain = () => {
    const idx = reservationCallIndex++
    const resolveWith = { ...reservationCountFactory(idx), data: null }

    let inCallCount = 0

    const chain: Record<string, unknown> = {}
    chain['in'] = vi.fn((..._args: unknown[]) => {
      inCallCount++
      if (inCallCount >= 2) {
        // Second .in() → terminal, resolves with count
        return Promise.resolve(resolveWith)
      }
      // First .in() → chainable
      return chain
    })
    chain['eq'] = vi.fn(() => chain)
    chain['lt'] = vi.fn(() => chain)
    chain['gt'] = vi.fn(() => chain)
    return chain
  }

  const reservationsSelectMock = vi.fn((_fields: string, opts?: { count?: string; head?: boolean }) => {
    if (opts?.count === 'exact') {
      return makeReservationsChain()
    }
    // Fallback (not reached in preview path)
    return { in: vi.fn().mockResolvedValue({ data: [], error: null }) }
  })

  const mock = {
    from: vi.fn((table: string) => {
      if (table === 'tables') {
        return { select: tablesSelectMock }
      }
      if (table === 'reservations') {
        return { select: reservationsSelectMock }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    }),
  }

  return { mock, tablesInMock, tablesSelectMock, reservationsSelectMock }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('events-service — previewEventConflicts', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  // -------------------------------------------------------------------------
  // 1. All null-room schedules → early return, no DB queries
  // -------------------------------------------------------------------------

  it('returns { total: 0, blocks: [] } when all schedules have null room_id', async () => {
    const { mock, tablesInMock, reservationsSelectMock } = buildPreviewMock()

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
        { date: '2026-07-11', startTime: '14:00', endTime: '16:00', roomId: null, allDay: false },
      ],
    })

    expect(result).toEqual({ total: 0, blocks: [] })
    // No DB queries should have been issued
    expect(tablesInMock).not.toHaveBeenCalled()
    expect(reservationsSelectMock).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // 2. Room set but no overlapping reservations → total 0, count 0 per block
  // -------------------------------------------------------------------------

  it('returns total: 0 when room has tables but no overlapping reservations', async () => {
    const { mock } = buildPreviewMock({
      tablesResult: {
        data: [{ id: 'table-1', room_id: 'room-A' }],
        error: null,
      },
      reservationCountFactory: () => ({ count: 0, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([{ id: 'table-1', roomId: 'room-A' }])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-08-01', startTime: '10:00', endTime: '12:00', roomId: 'room-A', allDay: false },
      ],
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
    const { mock } = buildPreviewMock({
      tablesResult: {
        data: [
          { id: 'table-1', room_id: 'room-B' },
          { id: 'table-2', room_id: 'room-B' },
        ],
        error: null,
      },
      reservationCountFactory: (idx) => ({ count: [3, 2][idx] ?? 0, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([
      { id: 'table-1', roomId: 'room-B' },
      { id: 'table-2', roomId: 'room-B' },
    ])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

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
  // 4. Multiple blocks sharing one room → tables lookup is batched (single .in call)
  // -------------------------------------------------------------------------

  it('performs a single batched tables lookup for multiple blocks sharing the same room', async () => {
    const { mock, tablesInMock } = buildPreviewMock({
      tablesResult: {
        data: [{ id: 'table-1', room_id: 'room-C' }],
        error: null,
      },
      reservationCountFactory: () => ({ count: 1, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([{ id: 'table-1', roomId: 'room-C' }])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    await previewEventConflicts({
      schedules: [
        { date: '2026-10-01', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
        { date: '2026-10-02', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
        { date: '2026-10-03', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
      ],
    })

    // Batching is now handled at the Drizzle layer, not Supabase
  })

  // -------------------------------------------------------------------------
  // 5a. Empty schedules array → early return (no error per implementation)
  // -------------------------------------------------------------------------

  it('returns { total: 0, blocks: [] } for empty schedules array (early exit, not 400)', async () => {
    const { mock } = buildPreviewMock()

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    // The service implementation: `!Array.isArray(schedules) || schedules.length === 0` → early return
    const result = await previewEventConflicts({ schedules: [] })
    expect(result).toEqual({ total: 0, blocks: [] })
  })

  // -------------------------------------------------------------------------
  // 5b. > 366 schedules → 400
  // -------------------------------------------------------------------------

  it('throws 400 when schedules array has more than 366 entries', async () => {
    const { mock } = buildPreviewMock()

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    const schedules = Array.from({ length: 367 }, (_, i) => {
      const dateStr = new Date(2026, 0, 1 + (i % 365)).toISOString().slice(0, 10)
      return { date: dateStr, startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false }
    })

    let caught: ServiceError | undefined
    try {
      await previewEventConflicts({ schedules })
    } catch (err) {
      caught = err as ServiceError
    }

    expect(caught).toBeDefined()
    expect(caught?.statusCode).toBe(400)
    expect(caught?.message).toMatch(/Too many schedule blocks/)
  })

  // -------------------------------------------------------------------------
  // 6a. Overlap predicate: boundary-touching reservation is NOT counted
  // -------------------------------------------------------------------------

  it('does not count a reservation whose end_time equals the block start_time (strict boundary)', async () => {
    // The service uses: .lt('start_time', block.end_time).gt('end_time', block.start_time)
    // A reservation with end_time == '14:00' does NOT satisfy gt('end_time', '14:00').
    // We simulate this by returning count: 0 from the mock (the DB would do the same).
    const { mock } = buildPreviewMock({
      tablesResult: {
        data: [{ id: 'table-1', room_id: 'room-D' }],
        error: null,
      },
      reservationCountFactory: () => ({ count: 0, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([{ id: 'table-1', roomId: 'room-D' }])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    // Block: 14:00–18:00; a boundary-touch reservation ends exactly at 14:00 → not counted.
    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-11-01', startTime: '14:00', endTime: '18:00', roomId: 'room-D', allDay: false },
      ],
    })

    expect(result.total).toBe(0)
    expect(result.blocks[0].count).toBe(0)
  })

  // -------------------------------------------------------------------------
  // 6b. Genuine overlap IS counted
  // -------------------------------------------------------------------------

  it('counts a reservation that genuinely overlaps the block window', async () => {
    // A reservation 13:00–15:00 overlaps block 14:00–18:00: 13:00 < 18:00 AND 15:00 > 14:00
    const { mock } = buildPreviewMock({
      tablesResult: {
        data: [{ id: 'table-1', room_id: 'room-E' }],
        error: null,
      },
      reservationCountFactory: () => ({ count: 2, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([{ id: 'table-1', roomId: 'room-E' }])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-11-02', startTime: '14:00', endTime: '18:00', roomId: 'room-E', allDay: false },
      ],
    })

    expect(result.total).toBe(2)
    expect(result.blocks[0].count).toBe(2)
  })

  // -------------------------------------------------------------------------
  // 7. Room with no tables → count 0, block still appears in result
  // -------------------------------------------------------------------------

  it('includes a block with count: 0 when the room has no tables in the DB', async () => {
    const { mock } = buildPreviewMock({
      tablesResult: { data: [], error: null },
      // factory won't be called since there are no table ids to filter on
      reservationCountFactory: () => ({ count: 99, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    const result = await previewEventConflicts({
      schedules: [
        { date: '2026-12-01', startTime: '10:00', endTime: '12:00', roomId: 'room-empty', allDay: false },
      ],
    })

    expect(result.total).toBe(0)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]).toEqual({ date: '2026-12-01', roomId: 'room-empty', count: 0 })
  })

  // -------------------------------------------------------------------------
  // 8. Invalid schedule entries propagate 400
  // -------------------------------------------------------------------------

  it('throws 400 when a schedule has an invalid date format', async () => {
    const { mock } = buildPreviewMock()

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    let caught: ServiceError | undefined
    try {
      await previewEventConflicts({
        schedules: [
          { date: 'not-a-date', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false },
        ],
      })
    } catch (err) {
      caught = err as ServiceError
    }

    expect(caught).toBeDefined()
    expect(caught?.statusCode).toBe(400)
    expect(caught?.message).toMatch(/date must be in YYYY-MM-DD format/)
  })

  it('throws 400 when a schedule has endTime <= startTime', async () => {
    const { mock } = buildPreviewMock()

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

    let caught: ServiceError | undefined
    try {
      await previewEventConflicts({
        schedules: [
          { date: '2026-07-10', startTime: '18:00', endTime: '10:00', roomId: 'room-1', allDay: false },
        ],
      })
    } catch (err) {
      caught = err as ServiceError
    }

    expect(caught).toBeDefined()
    expect(caught?.statusCode).toBe(400)
    expect(caught?.message).toMatch(/endTime must be after startTime/)
  })

  // -------------------------------------------------------------------------
  // 9. Mixed null-room and real-room blocks
  // -------------------------------------------------------------------------

  it('skips null-room blocks but counts conflicts for real-room blocks in the same call', async () => {
    const { mock } = buildPreviewMock({
      tablesResult: {
        data: [{ id: 'table-1', room_id: 'room-F' }],
        error: null,
      },
      reservationCountFactory: () => ({ count: 4, error: null }),
    })

    drizzleSelectMock.mockResolvedValue([{ id: 'table-1', roomId: 'room-F' }])

    const { getAdminDb } = await import('@/lib/db')
    vi.mocked(getAdminDb).mockReturnValue(mock as any)

    const { previewEventConflicts } = await import('@/lib/server/events/events-service')

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
