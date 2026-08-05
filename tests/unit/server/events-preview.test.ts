// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockServiceError,
  createStatefulDrizzleDb,
  getQueryLog,
  MockServiceError,
  resetDb,
  seed,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  ServiceError: MockServiceError,
  serviceError: createMockServiceError(),
}))

function table(id: string, roomId: string) {
  return { id, roomId }
}

function reservation(overrides: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    tableId: 'table-1',
    userId: crypto.randomUUID(),
    date: '2026-08-01',
    startTime: '10:00:00',
    endTime: '12:00:00',
    status: 'active',
    surface: null,
    activatedAt: null,
    createdAt: new Date(),
    ...overrides,
  }
}

async function preview(schedules: unknown[]) {
  const { previewEventConflicts } = await import('@/lib/server/events/events-service')
  return previewEventConflicts({ schedules })
}

describe('events-service — previewEventConflicts', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('returns no conflicts without querying when every schedule has no room', async () => {
    await expect(preview([
      { date: '2026-07-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
      { date: '2026-07-11', startTime: '14:00', endTime: '16:00', roomId: null, allDay: false },
    ])).resolves.toEqual({ total: 0, blocks: [] })

    expect(getQueryLog()).toEqual([])
  })

  it('returns zero when a room has tables but no overlapping reservations', async () => {
    seed({ tables: [table('table-1', 'room-A')] })

    await expect(preview([
      { date: '2026-08-01', startTime: '10:00', endTime: '12:00', roomId: 'room-A', allDay: false },
    ])).resolves.toEqual({
      total: 0,
      blocks: [{ date: '2026-08-01', roomId: 'room-A', count: 0 }],
    })
  })

  it('counts active and pending overlaps per block using Neon state', async () => {
    seed({
      tables: [table('table-1', 'room-B'), table('table-2', 'room-B')],
      reservations: [
        reservation({ id: 'r1', tableId: 'table-1', date: '2026-09-01', status: 'active' }),
        reservation({ id: 'r2', tableId: 'table-1', date: '2026-09-01', status: 'pending' }),
        reservation({ id: 'r3', tableId: 'table-2', date: '2026-09-01', status: 'active' }),
        reservation({ id: 'r4', tableId: 'table-1', date: '2026-09-02', status: 'active' }),
        reservation({ id: 'r5', tableId: 'table-2', date: '2026-09-02', status: 'pending' }),
        reservation({ id: 'ignored', tableId: 'table-2', date: '2026-09-02', status: 'cancelled' }),
      ],
    })

    await expect(preview([
      { date: '2026-09-01', startTime: '10:00', endTime: '14:00', roomId: 'room-B', allDay: false },
      { date: '2026-09-02', startTime: '10:00', endTime: '14:00', roomId: 'room-B', allDay: false },
    ])).resolves.toEqual({
      total: 5,
      blocks: [
        { date: '2026-09-01', roomId: 'room-B', count: 3 },
        { date: '2026-09-02', roomId: 'room-B', count: 2 },
      ],
    })
  })

  it('batches the table lookup for multiple blocks', async () => {
    seed({ tables: [table('table-1', 'room-C')] })

    await preview([
      { date: '2026-10-01', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
      { date: '2026-10-02', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
      { date: '2026-10-03', startTime: '10:00', endTime: '12:00', roomId: 'room-C', allDay: false },
    ])

    expect(getQueryLog().filter((entry) => entry.op === 'select' && entry.table === 'tables')).toHaveLength(1)
  })

  it('returns no conflicts for an empty schedules array', async () => {
    await expect(preview([])).resolves.toEqual({ total: 0, blocks: [] })
  })

  it('rejects more than 366 schedules', async () => {
    const schedules = Array.from({ length: 367 }, (_, i) => ({
      date: new Date(2026, 0, 1 + (i % 365)).toISOString().slice(0, 10),
      startTime: '10:00',
      endTime: '12:00',
      roomId: 'room-1',
      allDay: false,
    }))

    await expect(preview(schedules)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('does not count a reservation ending exactly when the block starts', async () => {
    seed({
      tables: [table('table-1', 'room-D')],
      reservations: [reservation({ tableId: 'table-1', date: '2026-11-01', startTime: '12:00:00', endTime: '14:00:00' })],
    })

    await expect(preview([
      { date: '2026-11-01', startTime: '14:00', endTime: '18:00', roomId: 'room-D', allDay: false },
    ])).resolves.toEqual({
      total: 0,
      blocks: [{ date: '2026-11-01', roomId: 'room-D', count: 0 }],
    })
  })

  it('counts genuine overlaps', async () => {
    seed({
      tables: [table('table-1', 'room-E')],
      reservations: [
        reservation({ id: 'r1', tableId: 'table-1', date: '2026-11-02', startTime: '13:00:00', endTime: '15:00:00' }),
        reservation({ id: 'r2', tableId: 'table-1', date: '2026-11-02', startTime: '17:00:00', endTime: '19:00:00', status: 'pending' }),
      ],
    })

    await expect(preview([
      { date: '2026-11-02', startTime: '14:00', endTime: '18:00', roomId: 'room-E', allDay: false },
    ])).resolves.toEqual({
      total: 2,
      blocks: [{ date: '2026-11-02', roomId: 'room-E', count: 2 }],
    })
  })

  it('includes a zero-count block when a room has no tables', async () => {
    await expect(preview([
      { date: '2026-12-01', startTime: '10:00', endTime: '12:00', roomId: 'room-empty', allDay: false },
    ])).resolves.toEqual({
      total: 0,
      blocks: [{ date: '2026-12-01', roomId: 'room-empty', count: 0 }],
    })
  })

  it('rejects invalid dates', async () => {
    await expect(preview([
      { date: 'not-a-date', startTime: '10:00', endTime: '12:00', roomId: 'room-1', allDay: false },
    ])).rejects.toMatchObject({ statusCode: 400 })
  })

  it('rejects schedules whose end is not after their start', async () => {
    await expect(preview([
      { date: '2026-07-10', startTime: '18:00', endTime: '10:00', roomId: 'room-1', allDay: false },
    ])).rejects.toMatchObject({ statusCode: 400 })
  })

  it('skips null-room blocks while counting real-room blocks', async () => {
    seed({
      tables: [table('table-1', 'room-F')],
      reservations: Array.from({ length: 4 }, (_, i) => reservation({
        id: `r${i}`,
        tableId: 'table-1',
        date: '2026-08-11',
      })),
    })

    await expect(preview([
      { date: '2026-08-10', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
      { date: '2026-08-11', startTime: '10:00', endTime: '12:00', roomId: 'room-F', allDay: false },
      { date: '2026-08-12', startTime: '10:00', endTime: '12:00', roomId: null, allDay: false },
    ])).resolves.toEqual({
      total: 4,
      blocks: [{ date: '2026-08-11', roomId: 'room-F', count: 4 }],
    })
  })

  it('scopes table-level blocks to that table instead of the whole room', async () => {
    seed({
      tables: [table('table-Y1', 'room-Y'), table('table-Y2', 'room-Y')],
      reservations: [
        reservation({ id: 'target', tableId: 'table-Y1', date: '2027-01-01' }),
        reservation({ id: 'other', tableId: 'table-Y2', date: '2027-01-01' }),
      ],
    })

    await expect(preview([
      {
        date: '2027-01-01',
        startTime: '10:00',
        endTime: '12:00',
        roomId: 'room-Y',
        tableId: 'table-Y1',
        allDay: false,
      },
    ])).resolves.toEqual({
      total: 1,
      blocks: [{ date: '2027-01-01', roomId: 'room-Y', count: 1 }],
    })
  })
})
