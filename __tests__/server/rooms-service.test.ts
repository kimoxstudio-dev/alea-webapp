// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceError } from '@/lib/server/service-error'

vi.mock('@/lib/server/database-time', () => ({
  getDatabaseNow: vi.fn(async () => new Date('2025-01-01T09:00:00.000Z')),
}))

const maybeSingleMock = vi.fn()
const listRoomsMock = vi.fn()
const listTablesMock = vi.fn()
const listReservationsMock = vi.fn()
const updateMock = vi.fn()
const regenerateQrCodesMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      if (table === 'rooms') {
        return {
          select: vi.fn(() => ({
            order: listRoomsMock,
            maybeSingle: maybeSingleMock,
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: maybeSingleMock,
            })),
          })),
          update: updateMock,
        }
      }

      if (table === 'tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: listTablesMock,
            })),
          })),
        }
      }

      if (table === 'event_room_blocks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(async () => ({
                data: [],
                error: null,
              })),
            })),
          })),
        }
      }

      if (table === 'events') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(async () => ({
              data: [],
              error: null,
            })),
          })),
        }
      }

      if (table === 'saved_games') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              lte: vi.fn(() => ({
                gte: vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) })),
              })),
            })),
          })),
        }
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(() => ({
              in: listReservationsMock,
            })),
          })),
        })),
      }
    }),
  })),
  createSupabaseServerAdminClient: vi.fn(() => ({
    rpc: vi.fn(async (fn: string) => fn === 'get_database_time'
      ? { data: '2025-01-01T09:00:00.000Z', error: null }
      : { data: null, error: null }),
    from: vi.fn((table: string) => {
      if (table === 'rooms') {
        return {
          select: vi.fn(() => ({
            order: listRoomsMock,
            maybeSingle: maybeSingleMock,
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: maybeSingleMock,
            })),
          })),
          update: updateMock,
        }
      }

      if (table === 'tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: listTablesMock,
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: maybeSingleMock,
            })),
          })),
        }
      }

      if (table === 'event_room_blocks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(async () => ({
                data: [],
                error: null,
              })),
            })),
          })),
        }
      }

      if (table === 'events') {
        return {
          select: vi.fn(() => ({
            in: vi.fn(async () => ({
              data: [],
              error: null,
            })),
          })),
        }
      }

      if (table === 'saved_games') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              lte: vi.fn(() => ({
                gte: vi.fn(() => ({ in: vi.fn(async () => ({ data: [], error: null })) })),
              })),
            })),
          })),
        }
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(() => ({
              in: listReservationsMock,
            })),
          })),
        })),
      }
    }),
  })),
}))

vi.mock('@/lib/server/tables-service', () => ({
  regenerateQrCodes: regenerateQrCodesMock,
}))

async function loadRoomsModules() {
  vi.resetModules()

  const service = await import('@/lib/server/rooms-service')

  return { ...service }
}

describe('updateRoom', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listRoomsMock.mockResolvedValue({
      data: [
        { id: '1', name: 'Sala Mirkwood', table_count: 8, description: 'Sala principal' },
      ],
      error: null,
    })
    listTablesMock.mockResolvedValue({
      data: [
        {
          id: 't1',
          room_id: '1',
          name: 'Mesa 1',
          type: 'large',
          qr_code: 'QR-1',
          pos_x: 0,
          pos_y: 0,
        },
      ],
      error: null,
    })
    listReservationsMock.mockResolvedValue({
      data: [
        {
          id: 'r1',
          table_id: 't1',
          date: '2025-01-01',
          start_time: '10:00:00',
          end_time: '12:00:00',
          status: 'active',
          surface: null,
          user_id: '2',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    })
    maybeSingleMock.mockResolvedValue({
      data: { id: '1', name: 'Sala Mirkwood Updated', table_count: 8, description: 'Sala principal' },
      error: null,
    })
    updateMock.mockReturnValue({
      eq: vi.fn(() => ({
        select: vi.fn(() => ({
          maybeSingle: maybeSingleMock,
        })),
      })),
    })
  })

  it('succeeds when tableCount is a valid non-negative integer', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: '1', name: 'Sala Mirkwood', table_count: 5, description: 'Sala principal' },
      error: null,
    })
    const { updateRoom } = await loadRoomsModules()

    const updated = await updateRoom('1', { tableCount: 5 })

    expect(updated).not.toBeNull()
    expect(updated?.tableCount).toBe(5)
  })

  it('throws ServiceError with status 400 when tableCount is not a non-negative integer', async () => {
    const { updateRoom } = await loadRoomsModules()

    let caught: ServiceError | undefined
    try {
      await updateRoom('1', { tableCount: -1 })
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

    const updated = await updateRoom('1', { name: 'Sala Mirkwood Updated' })

    expect(updated).not.toBeNull()
    expect(updated?.name).toBe('Sala Mirkwood Updated')
  })

  it('skips table_count update when tableCount is null', async () => {
    const { updateRoom } = await loadRoomsModules()

    // null is treated as "not provided" — should not reset table_count to 0
    await expect(updateRoom('1', { tableCount: null })).resolves.not.toThrow()
    expect(updateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ table_count: expect.anything() })
    )
  })

  it('skips table_count update when tableCount is empty string', async () => {
    const { updateRoom } = await loadRoomsModules()

    // empty string is treated as "not provided" — should not reset table_count to 0
    await expect(updateRoom('1', { tableCount: '' })).resolves.not.toThrow()
    expect(updateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ table_count: expect.anything() })
    )
  })

  it('preserves existing description when description is null', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: '1', name: 'Sala Mirkwood', table_count: 8, description: 'Sala principal' },
      error: null,
    })
    const { updateRoom } = await loadRoomsModules()

    const updated = await updateRoom('1', { description: null })

    expect(updated.description).not.toBe('null')
  })

  it('preserves existing description when description is undefined', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: '1', name: 'Sala Mirkwood', table_count: 8, description: 'Sala principal' },
      error: null,
    })
    const { updateRoom } = await loadRoomsModules()

    const updated = await updateRoom('1', { description: undefined })

    expect(updated.description).not.toBe('null')
  })

  it('sets description to the new string when a value is provided', async () => {
    maybeSingleMock.mockResolvedValue({
      data: { id: '1', name: 'Sala Mirkwood', table_count: 8, description: 'New description' },
      error: null,
    })
    const { updateRoom } = await loadRoomsModules()

    const updated = await updateRoom('1', { description: 'New description' })

    expect(updated.description).toBe('New description')
  })
})

describe('createTableEntry', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    maybeSingleMock.mockResolvedValue({
      data: { id: 't1', room_id: '1', name: 'Mesa 1', type: 'small', qr_code: null, pos_x: null, pos_y: null },
      error: null,
    })
    regenerateQrCodesMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps a foreign-key violation (23503) to a 400 ServiceError', async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: { code: '23503', message: 'FK violation' } })
    const { createTableEntry } = await loadRoomsModules()

    await expect(createTableEntry('nonexistent-room', { name: 'Mesa X', type: 'small' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('returns the created table on success', async () => {
    const { createTableEntry } = await loadRoomsModules()

    const result = await createTableEntry('1', { name: 'Mesa 1', type: 'small' })

    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
  })

  it('throws 400 when table name is empty', async () => {
    const { createTableEntry } = await loadRoomsModules()

    await expect(createTableEntry('1', { name: '', type: 'small' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('throws 400 when table type is invalid', async () => {
    const { createTableEntry } = await loadRoomsModules()

    await expect(createTableEntry('1', { name: 'Mesa X', type: 'invalid_type' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('resolves immediately even if QR generation fails', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://test.example.com')
    regenerateQrCodesMock.mockRejectedValue(new Error('QR generation failed'))
    const { createTableEntry } = await loadRoomsModules()

    // Should not throw even though regenerateQrCodes rejects
    const result = await createTableEntry('1', { name: 'Mesa 1', type: 'small' })
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

    // Call createTableEntry
    const resultPromise = createTableEntry('1', { name: 'Mesa 1', type: 'small' })

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

    const result = await createTableEntry('1', { name: 'Mesa 1', type: 'small' })

    expect(result).toMatchObject({ name: 'Mesa 1', type: 'small' })
    expect(regenerateQrCodesMock).not.toHaveBeenCalled()
  })
})

describe('getRoomTablesAvailability', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    listTablesMock.mockResolvedValue({
      data: [
        {
          id: 't3',
          room_id: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qr_code: 'QR-3',
          pos_x: 1,
          pos_y: 1,
        },
      ],
      error: null,
    })
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
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    })
  })

  it('builds availability from Supabase rows', async () => {
    const { getRoomTablesAvailability } = await loadRoomsModules()

    const availability = await getRoomTablesAvailability('1', '2025-01-01')

    expect(availability.t3?.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
  })
})
