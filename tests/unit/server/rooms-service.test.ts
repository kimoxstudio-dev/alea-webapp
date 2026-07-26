// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceError } from '@/lib/server/shared/service-error'
import {
  createDrizzleQueryBuilder,
  selectMock,
  insertMock,
  updateMock,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

// ── Legacy Supabase mocks for tables not yet migrated ─────────────────────────
const listReservationsMock = vi.fn()
const listEventBlocksMock = vi.fn()
const listSavedGamesMock = vi.fn()
const listEventsMock = vi.fn()
const regenerateQrCodesMock = vi.fn()

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
  getAdminDb: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'reservations') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: vi.fn(() => ({
                in: vi.fn(() => listReservationsMock()),
              })),
            })),
          })),
        }
      }
      if (table === 'event_room_blocks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => listEventBlocksMock()),
            })),
          })),
        }
      }
      if (table === 'saved_games') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              lte: vi.fn(() => ({
                gte: vi.fn(() => ({
                  in: vi.fn(() => listSavedGamesMock()),
                })),
              })),
            })),
          })),
        }
      }
      if (table === 'events') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(() => listEventsMock()),
          })),
        }
      }
      return { select: vi.fn(() => ({})) }
    }),
    rpc: vi.fn(async (fn: string) => 
      fn === 'get_database_time'
        ? { data: '2025-01-01T09:00:00.000Z', error: null }
        : { data: null, error: null }
    ),
  })),
}))

vi.mock('@/lib/server/tables/tables-service', () => ({
  regenerateQrCodes: regenerateQrCodesMock,
}))

async function loadRoomsModules() {
  vi.resetModules()
  return import('@/lib/server/rooms/rooms-service')
}

describe('updateRoom', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // Setup Drizzle mocks for rooms table
    selectMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood',
        tableCount: 8,
        description: 'Sala principal',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    updateMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood Updated',
        tableCount: 8,
        description: 'Sala principal',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
  })

  it('succeeds when tableCount is a valid non-negative integer', async () => {
    updateMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood',
        tableCount: 5,
        description: 'Sala principal',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const updated = await updateRoom(adminSession, '1', { tableCount: 5 })

    expect(updated).not.toBeNull()
    expect(updated?.tableCount).toBe(5)
  })

  it('throws ServiceError with status 400 when tableCount is not a non-negative integer', async () => {
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    let caught: ServiceError | undefined
    try {
      await updateRoom(adminSession, '1', { tableCount: -1 })
    } catch (err) {
      caught = err as ServiceError
    }

    expect(caught).toBeDefined()
    expect(caught?.name).toBe('ServiceError')
    expect(caught?.statusCode).toBe(400)
    expect(caught?.message).toMatch(/tableCount/i)
  })

  it('succeeds when tableCount is not provided (using seed room id "1")', async () => {
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const updated = await updateRoom(adminSession, '1', { name: 'Sala Mirkwood Updated' })

    expect(updated).not.toBeNull()
    expect(updated?.name).toBe('Sala Mirkwood Updated')
  })

  it('skips table_count update when tableCount is null', async () => {
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    // null is treated as "not provided" — should not reset table_count to 0
    await expect(updateRoom(adminSession, '1', { tableCount: null })).resolves.not.toThrow()
  })

  it('skips table_count update when tableCount is empty string', async () => {
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    // empty string is treated as "not provided" — should not reset table_count to 0
    await expect(updateRoom(adminSession, '1', { tableCount: '' })).resolves.not.toThrow()
  })

  it('preserves existing description when description is null', async () => {
    updateMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood',
        tableCount: 8,
        description: 'Sala principal',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const updated = await updateRoom(adminSession, '1', { description: null })

    expect(updated.description).not.toBe('null')
  })

  it('preserves existing description when description is undefined', async () => {
    updateMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood',
        tableCount: 8,
        description: 'Sala principal',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const updated = await updateRoom(adminSession, '1', { description: undefined })

    expect(updated.description).not.toBe('null')
  })

  it('sets description to the new string when a value is provided', async () => {
    updateMock.mockResolvedValue([
      {
        id: '1',
        name: 'Sala Mirkwood',
        tableCount: 8,
        description: 'New description',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    const { updateRoom } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const updated = await updateRoom(adminSession, '1', { description: 'New description' })

    expect(updated.description).toBe('New description')
  })
})

describe('createTableEntry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // Setup Drizzle mocks for tables table
    insertMock.mockResolvedValue([
      {
        id: 't1',
        roomId: '1',
        name: 'Mesa 1',
        type: 'small',
        qrCode: '',
        qrCodeInf: null,
        posX: null,
        posY: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    regenerateQrCodesMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps a foreign-key violation (23503) to a 400 ServiceError', async () => {
    // Mock the insert to throw a 23503 error
    const fkError = new Error('Foreign key violation') as any
    fkError.code = '23503'
    insertMock.mockRejectedValue(fkError)
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    await expect(createTableEntry(adminSession, 'nonexistent-room', { name: 'Mesa X', type: 'small' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('returns the created table on success', async () => {
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const result = await createTableEntry(adminSession, '1', { name: 'Mesa 1', type: 'small' })

    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
  })

  it('throws 400 when table name is empty', async () => {
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    await expect(createTableEntry(adminSession, '1', { name: '', type: 'small' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('throws 400 when table type is invalid', async () => {
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    await expect(createTableEntry(adminSession, '1', { name: 'Mesa X', type: 'invalid_type' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('resolves immediately even if QR generation fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://test.example.com')
    regenerateQrCodesMock.mockRejectedValue(new Error('QR generation failed'))
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    // Should not throw even though regenerateQrCodes rejects
    const result = await createTableEntry(adminSession, '1', { name: 'Mesa 1', type: 'small' })
    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
  })

  it('does not await QR generation (fire-and-forget)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://test.example.com')
    let qrResolve: (() => void) | null = null
    const qrPromise = new Promise<void>((resolve) => {
      qrResolve = resolve
    })
    regenerateQrCodesMock.mockReturnValue(qrPromise)
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    // Call createTableEntry
    const resultPromise = createTableEntry(adminSession, '1', { name: 'Mesa 1', type: 'small' })

    // createTableEntry should resolve immediately without waiting for QR generation
    const result = await resultPromise
    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })

    // Now resolve the QR generation to clean up
    qrResolve?.()
    await qrPromise
  })

  it('skips QR generation when NEXT_PUBLIC_APP_URL is absent', async () => {
    // Task 6: when NEXT_PUBLIC_APP_URL is empty/unset, regenerateQrCodes must NOT be called
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const { createTableEntry } = await loadRoomsModules()
    const adminSession = createAdminSession()

    const result = await createTableEntry(adminSession, '1', { name: 'Mesa 1', type: 'small' })

    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
    expect(regenerateQrCodesMock).not.toHaveBeenCalled()
  })
})

describe('getRoomTablesAvailability', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // Setup Drizzle mocks for tables table
    selectMock.mockResolvedValue([
      {
        id: 't3',
        roomId: '1',
        name: 'Mesa 3',
        type: 'removable_top',
        qrCode: 'QR-3',
        posX: 1,
        posY: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ])
    listReservationsMock.mockResolvedValue({
      data: [
        {
          id: 'r2',
          table_id: 't3',
          date: '2025-01-01',
          start_time: '10:00:00',
          end_time: '12:00:00',
          status: 'active',
          surface: 'top',
          user_id: '2',
          activated_at: null,
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    })
    listEventBlocksMock.mockResolvedValue({ data: [], error: null })
    listSavedGamesMock.mockResolvedValue({ data: [], error: null })
    listEventsMock.mockResolvedValue({ data: [], error: null })
  })

  it('builds availability from Supabase rows', async () => {
    const { getRoomTablesAvailability } = await loadRoomsModules()

    const availability = await getRoomTablesAvailability('1', '2025-01-01')

    expect(availability.t3?.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
  })
})

describe('Member-role session denial for requireAdminSession', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('createRoomEntry throws 403 when session role is member', async () => {
    const { createRoomEntry } = await loadRoomsModules()
    const memberSession = createMemberSession()

    await expect(createRoomEntry(memberSession, { name: 'New Room', tableCount: 5 })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })

  it('updateRoom throws 403 when session role is member', async () => {
    const { updateRoom } = await loadRoomsModules()
    const memberSession = createMemberSession()

    await expect(updateRoom(memberSession, '1', { name: 'Updated Room' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })

  it('createTableEntry throws 403 when session role is member', async () => {
    const { createTableEntry } = await loadRoomsModules()
    const memberSession = createMemberSession()

    await expect(createTableEntry(memberSession, '1', { name: 'Mesa X', type: 'small' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })
})
