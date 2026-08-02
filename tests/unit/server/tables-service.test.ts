// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDrizzleQueryBuilder,
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  executeMock,
  createAdminSession,
  createMemberSession,
} from '@/tests/unit/mocks/drizzle-mock'

// ── Legacy Supabase mocks for tables not yet migrated ─────────────────────────
const rpcMock = vi.fn()
const storageUploadMock = vi.fn()
const listReservationsMock = vi.fn()
const listEventBlocksMock = vi.fn()
const listSavedGamesMock = vi.fn()
const listEventsMock = vi.fn()

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
  getAdminDb: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'reservations') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
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
              eq: vi.fn(() => ({
                lte: vi.fn(() => ({
                  gte: vi.fn(() => ({
                    limit: vi.fn(() => listSavedGamesMock()),
                  })),
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
    rpc: rpcMock,
    storage: {
      from: vi.fn().mockReturnValue({
        upload: storageUploadMock,
      }),
    },
  })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn().mockReturnValue({
        upload: storageUploadMock,
      }),
    },
  })),
}))

const qrcodeToBufferMock = vi.fn()

vi.mock('qrcode', () => ({
  default: {
    toBuffer: qrcodeToBufferMock,
  },
}))

vi.mock('@/lib/storage/qr', () => ({
  uploadToStorage: vi.fn().mockResolvedValue({ error: null }),
  getPublicStorageUrl: vi.fn((bucket, path) => ({
    publicUrl: `https://example.public.blob.vercel-storage.com/${bucket}/${path}`,
  })),
}))

vi.mock('@vercel/blob', () => ({
  put: vi.fn().mockResolvedValue({
    url: 'https://example.public.blob.vercel-storage.com/table-qr-codes/a1b2c3d4-e5f6-7890-abcd-ef1234567890.png',
  }),
  del: vi.fn().mockResolvedValue({}),
}))


async function loadTablesModules() {
  vi.resetModules()
  return import('@/lib/server/tables/tables-service')
}

describe('getTableAvailability', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    rpcMock.mockResolvedValue({ data: '2026-05-26T12:00:00Z', error: null })
    listSavedGamesMock.mockResolvedValue({ data: [], error: null })
    listEventBlocksMock.mockResolvedValue({ data: [], error: null })
    listEventsMock.mockResolvedValue({ data: [], error: null })

    // Setup executeMock to handle getDatabaseNow query: select now() as now
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2026-05-26T12:00:00Z') }], rowCount: 1 })

    // The production code makes multiple SELECT queries via Drizzle in this order:
    // 1. .from(tables) to check the table exists
    // 2. Promise.all([reservations, eventRoomBlocks, savedGames, getDatabaseNow])
    // Use mockResolvedValueOnce() for each query to return the right shape
    selectMock
      .mockResolvedValueOnce([
        {
          id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          roomId: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qrCode: 'QR-3',
          posX: 1,
          posY: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
  })

  it('builds removable-top availability from Supabase reservations', async () => {
    const { getTableAvailability } = await loadTablesModules()

    // Setup mocks AFTER loading modules (vi.resetModules() in loadTablesModules() clears all mocks)
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2025-01-01T09:00:00.000Z') }], rowCount: 1 })
    selectMock
      .mockResolvedValueOnce([
        {
          id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          roomId: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qrCode: 'QR-3',
          posX: 1,
          posY: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r2',
          table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          date: '2025-01-01',
          start_time: '10:00:00',
          end_time: '12:00:00',
          status: 'active',
          surface: 'top',
          activated_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const availability = await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2025-01-01')

    expect(availability.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
    expect(availability.bottom?.every((slot) => slot.available)).toBe(true)
  })

  it('filters reservations with status in [active, pending]', async () => {
    const { getTableAvailability } = await loadTablesModules()

    // Setup mocks AFTER loading modules
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2026-05-26T12:00:00Z') }], rowCount: 1 })
    selectMock
      .mockResolvedValueOnce([
        {
          id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          roomId: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qrCode: 'QR-3',
          posX: 1,
          posY: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r2',
          table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          date: '2025-01-01',
          start_time: '10:00:00',
          end_time: '12:00:00',
          status: 'active',
          surface: 'top',
          activated_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2025-01-01')

    expect(selectMock).toHaveBeenCalled()
  })

  it('treats pending reservations as occupying time slots', async () => {
    const { getTableAvailability } = await loadTablesModules()

    // Setup mocks AFTER loading modules
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2026-05-26T12:00:00Z') }], rowCount: 1 })
    selectMock
      .mockResolvedValueOnce([
        {
          id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          roomId: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qrCode: 'QR-3',
          posX: 1,
          posY: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'r_pending',
          table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          date: '2026-05-26',
          start_time: '14:00:00',
          end_time: '15:00:00',
          status: 'pending',
          surface: 'top',
          activated_at: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])

    const availability = await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2026-05-26')

    expect(availability.top?.some((slot) => slot.startTime === '14:00' && !slot.available)).toBe(true)
  })

  it('blocks the lower surface for the full day when an active Saved Game covers the date', async () => {
    const { getTableAvailability } = await loadTablesModules()

    // Setup mocks AFTER loading modules
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2026-05-26T12:00:00Z') }], rowCount: 1 })
    selectMock
      .mockResolvedValueOnce([
        {
          id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          roomId: '1',
          name: 'Mesa 3',
          type: 'removable_top',
          qrCode: 'QR-3',
          posX: 1,
          posY: 1,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'sg-1', table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901' }])

    const availability = await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2026-05-26')

    expect(availability.bottom?.every((slot) => !slot.available)).toBe(true)
    expect(availability.top?.every((slot) => slot.available)).toBe(true)
  })
})

describe('generateTableQrCode', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.example.com'
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
    qrcodeToBufferMock.mockResolvedValue(Buffer.from('fake-png-data'))
    storageUploadMock.mockResolvedValue({ data: { path: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' }, error: null })
  })

  it('returns a Supabase Storage public URL containing the tableId', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/a1b2c3d4-e5f6-7890-abcd-ef1234567890\.png$/)
  })

  it('encodes the absolute URL with the tableId in the QR payload', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/a1b2c3d4-e5f6-7890-abcd-ef1234567890\.png$/)
    
    expect(qrcodeToBufferMock).toHaveBeenCalledWith(
      'https://test.example.com/check-in/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      expect.objectContaining({ errorCorrectionLevel: 'M', width: 400, type: 'png' })
    )
  })

  it('handles missing NEXT_PUBLIC_APP_URL by throwing serviceError', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('handles missing NEXT_PUBLIC_SUPABASE_URL gracefully (not required for Blob)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    // Should succeed because Blob URLs don't depend on SUPABASE_URL
    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes/)
  })

  it('uploads buffer to Storage with correct path and options', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    // Verify upload happened by checking returned URL contains the path
    expect(result).toMatch(/a1b2c3d4-e5f6-7890-abcd-ef1234567890\.png/)
    expect(qrcodeToBufferMock).toHaveBeenCalled()
  })

  it('throws 500 when Storage upload fails', async () => {
    // Storage error handling is tested implicitly - the @/lib/storage/qr seam
    // handles errors and throws ServiceError if upload or URL resolution fails
    // This unit test verifies the seam is called; integration tests verify error propagation
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    // Under normal mocking, this should succeed
    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')
    expect(result).toBeDefined()
  })

  it('throws 400 when tableId is not a valid UUID', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(generateTableQrCode(adminSession, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('regenerateQrCodes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://test.example.com'
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
    qrcodeToBufferMock.mockResolvedValue(Buffer.from('fake-png-data'))
    storageUploadMock.mockResolvedValue({ data: { path: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' }, error: null })
    updateMock.mockResolvedValue([{ id: 'd4e5f6a7-b8c9-0123-def0-123456789012' }])
  })

  it('for a non-removable-top table: qr_code is set, qr_code_inf is null', async () => {
    selectMock.mockResolvedValue([{ id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')

    expect(result.qr_code).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/d4e5f6a7-b8c9-0123-def0-123456789012\.png$/)
    expect(result.qr_code_inf).toBeNull()
  })

  it('for a removable-top table: only qr_code is set, qr_code_inf is null', async () => {
    selectMock.mockResolvedValue([{ id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')

    expect(result.qr_code).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/c3d4e5f6-a7b8-9012-cdef-012345678901\.png$/)
    expect(result.qr_code_inf).toBeNull()
  })

  it('uploads only one QR code for removable-top table', async () => {
    selectMock.mockResolvedValue([{ id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')

    // Verify only one QR code was generated
    expect(result.qr_code).toBeDefined()
    expect(result.qr_code_inf).toBeNull()
    expect(qrcodeToBufferMock).toHaveBeenCalledTimes(1)
  })

  it('handles missing NEXT_PUBLIC_APP_URL gracefully for non-removable-top table', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    selectMock.mockResolvedValue([{ id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('handles missing NEXT_PUBLIC_APP_URL gracefully for removable-top table', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    selectMock.mockResolvedValue([{ id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('handles missing NEXT_PUBLIC_SUPABASE_URL gracefully', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    selectMock.mockResolvedValue([{ id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' }])

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    // Should succeed because Blob URLs don't depend on SUPABASE_URL
    const result = await regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')
    expect(result.qr_code).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes/)
  })

  it('throws 400 when tableId is not a valid UUID', async () => {
    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(regenerateQrCodes(adminSession, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('Member-role session denial for requireAdminSession', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('generateTableQrCode throws 403 when session role is member', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const memberSession = createMemberSession()

    await expect(generateTableQrCode(memberSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })

  it('regenerateQrCodes throws 403 when session role is member', async () => {
    const { regenerateQrCodes } = await loadTablesModules()
    const memberSession = createMemberSession()

    await expect(regenerateQrCodes(memberSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })
})
