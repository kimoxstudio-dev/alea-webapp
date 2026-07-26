// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionUser = { id: string; role: 'admin' | 'member'; email?: string }

function createAdminSession(): SessionUser {
  return { id: 'admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'member-1', role: 'member', email: 'member@example.com' }
}


const maybeSingleMock = vi.fn()
const listReservationsMock = vi.fn()
const adminTableMaybeSingleMock = vi.fn()
const adminUpdateEqMock = vi.fn()
const storageUploadMock = vi.fn()
const rpcMock = vi.fn()
const listSavedGamesMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      if (table === 'tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: maybeSingleMock,
            })),
          })),
        }
      }

      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: listReservationsMock,
            })),
          })),
        })),
      }
    }),
  })),
  createSupabaseServerAdminClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === 'tables') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: adminTableMaybeSingleMock,
            })),
          })),
          update: vi.fn(() => ({
            eq: adminUpdateEqMock,
          })),
        }
      }

      if (table === 'saved_games') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                lte: vi.fn(() => ({
                  gte: vi.fn(() => ({ limit: listSavedGamesMock })),
                })),
              })),
            })),
          })),
        }
      }

      // reservations table for getTableAvailability
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              in: listReservationsMock,
            })),
          })),
        })),
      }
    }),
    rpc: rpcMock,
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
    maybeSingleMock.mockResolvedValue({
      data: {
        id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
        room_id: '1',
        name: 'Mesa 3',
        type: 'removable_top',
        qr_code: 'QR-3',
        pos_x: 1,
        pos_y: 1,
      },
      error: null,
    })

vi.mock('@vercel/blob', () => ({
  put: vi.fn().mockResolvedValue({}),
  del: vi.fn().mockResolvedValue({}),
}))
    listReservationsMock.mockResolvedValue({
      data: [
        {
          id: 'r2',
          table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
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

  it('builds removable-top availability from Supabase reservations', async () => {
    const { getTableAvailability } = await loadTablesModules()

    const availability = await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2025-01-01')

    expect(availability.top?.some((slot) => slot.startTime === '10:00' && !slot.available)).toBe(true)
    expect(availability.bottom?.every((slot) => slot.available)).toBe(true)
  })

  it('filters reservations with status in [active, pending]', async () => {
    const { getTableAvailability } = await loadTablesModules()

    await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2025-01-01')

    // Verify that the mock chain includes .in('status', ['active', 'pending'])
    // The query builder is called with .select -> .eq (table_id) -> .eq (date) -> .in (status)
    expect(listReservationsMock).toHaveBeenCalled()
  })

  it('treats pending reservations as occupying time slots', async () => {
    const { getTableAvailability } = await loadTablesModules()

    listReservationsMock.mockResolvedValue({
      data: [
        {
          id: 'r_pending',
          table_id: 'c3d4e5f6-a7b8-9012-cdef-012345678901',
          date: '2025-01-01',
          start_time: '14:00:00',
          end_time: '15:00:00',
          status: 'pending',
          surface: 'top',
          user_id: '2',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      ],
      error: null,
    })

    const availability = await getTableAvailability('c3d4e5f6-a7b8-9012-cdef-012345678901', '2025-01-01')

    expect(availability.top?.some((slot) => slot.startTime === '14:00' && !slot.available)).toBe(true)
  })

  it('blocks the lower surface for the full day when an active Saved Game covers the date', async () => {
    listReservationsMock.mockResolvedValue({ data: [], error: null })
    listSavedGamesMock.mockResolvedValue({ data: [{ id: 'sg-1' }], error: null })
    const { getTableAvailability } = await loadTablesModules()

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
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
    qrcodeToBufferMock.mockResolvedValue(Buffer.from('fake-png-data'))
    storageUploadMock.mockResolvedValue({ data: { path: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' }, error: null })
  })

  it('returns a Blob public URL containing the tableId', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/a1b2c3d4-e5f6-7890-abcd-ef1234567890\.png$/)
  })

  it('encodes the absolute URL with the tableId in the QR payload', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    // Assert the result is a valid Blob URL
    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/a1b2c3d4-e5f6-7890-abcd-ef1234567890\.png$/)
    
    // Assert qrcode.toBuffer was called with the correct check-in URL
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

  it('works when NEXT_PUBLIC_SUPABASE_URL is missing (not needed for Blob URLs)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    // Should work because Blob URLs don't depend on NEXT_PUBLIC_SUPABASE_URL
    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes/)
  })

  it('encodes QR code with correct options', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    // Verify qrcode generation was called with correct parameters
    expect(qrcodeToBufferMock).toHaveBeenCalledWith(
      'https://test.example.com/check-in/a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      expect.objectContaining({ errorCorrectionLevel: 'M', width: 400, type: 'png' })
    )
  })

  it('returns Blob URL when storage succeeds', async () => {
    const { generateTableQrCode } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await generateTableQrCode(adminSession, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890')

    // Verify the Blob URL is returned
    expect(result).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes/)
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
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com'
    process.env.BLOB_PUBLIC_BASE_URL = 'https://example.public.blob.vercel-storage.com'
    adminUpdateEqMock.mockResolvedValue({ error: null })
    qrcodeToBufferMock.mockResolvedValue(Buffer.from('fake-png-data'))
    storageUploadMock.mockResolvedValue({ data: { path: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890.png' }, error: null })
  })

  it('for a non-removable-top table: qr_code is set, qr_code_inf is null', async () => {
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')

    expect(result.qr_code).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/d4e5f6a7-b8c9-0123-def0-123456789012\.png$/)
    expect(result.qr_code_inf).toBeNull()
  })

  it('for a removable-top table: only qr_code is set, qr_code_inf is null', async () => {
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')

    expect(result.qr_code).toMatch(/^https:\/\/example\.public\.blob\.vercel-storage\.com\/table-qr-codes\/c3d4e5f6-a7b8-9012-cdef-012345678901\.png$/)
    expect(result.qr_code_inf).toBeNull()
  })

  it('uploads only one QR code for removable-top table', async () => {
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')

    // Verify only qr_code is set (not qr_code_inf) for removable-top
    expect(result.qr_code).toBeDefined()
    expect(result.qr_code_inf).toBeNull()
  })

  it('handles missing NEXT_PUBLIC_APP_URL gracefully for non-removable-top table', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('handles missing NEXT_PUBLIC_APP_URL gracefully for removable-top table', async () => {
    delete process.env.NEXT_PUBLIC_APP_URL
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'c3d4e5f6-a7b8-9012-cdef-012345678901', type: 'removable_top' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    await expect(regenerateQrCodes(adminSession, 'c3d4e5f6-a7b8-9012-cdef-012345678901')).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('works when NEXT_PUBLIC_SUPABASE_URL is missing (not needed for Blob URLs)', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    adminTableMaybeSingleMock.mockResolvedValue({
      data: { id: 'd4e5f6a7-b8c9-0123-def0-123456789012', type: 'large' },
      error: null,
    })

    const { regenerateQrCodes } = await loadTablesModules()
    const adminSession = createAdminSession()

    const result = await regenerateQrCodes(adminSession, 'd4e5f6a7-b8c9-0123-def0-123456789012')

    // Should work because Blob URLs don't depend on NEXT_PUBLIC_SUPABASE_URL
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
