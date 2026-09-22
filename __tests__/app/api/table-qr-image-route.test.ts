// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const requireAdminMock = vi.fn()
const getPrivateImageMock = vi.fn()
const TABLE_ID = '123e4567-e89b-12d3-a456-426614174000'

vi.mock('@/lib/server/auth', () => ({ requireAdmin: requireAdminMock }))
vi.mock('@/lib/server/private-blob', () => ({ getPrivateImage: getPrivateImageMock }))

const admin = { session: { id: 'admin-1', role: 'admin' as const }, applyCookies: (response: NextResponse) => response }

describe('GET /api/tables/[id]/qr/image', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAdminMock.mockResolvedValue(admin)
  })

  it('requires the existing admin audience before serving the fixed QR pathname', async () => {
    getPrivateImageMock.mockResolvedValue(new NextResponse('image'))
    const { GET } = await import('@/app/api/tables/[id]/qr/image/route')
    const response = await GET(new NextRequest(`http://localhost/api/tables/${TABLE_ID}/qr/image`), {
      params: Promise.resolve({ id: TABLE_ID }),
    })

    expect(response.status).toBe(200)
    expect(getPrivateImageMock).toHaveBeenCalledWith(
      `table-qr-codes/${TABLE_ID}.png`,
      'private, no-cache',
      undefined,
      false,
    )
  })

  it('returns the auth response before reading the QR Blob', async () => {
    requireAdminMock.mockResolvedValue(NextResponse.json({ message: 'Forbidden' }, { status: 403 }))
    const { GET } = await import('@/app/api/tables/[id]/qr/image/route')
    const response = await GET(new NextRequest(`http://localhost/api/tables/${TABLE_ID}/qr/image`), {
      params: Promise.resolve({ id: TABLE_ID }),
    })

    expect(response.status).toBe(403)
    expect(getPrivateImageMock).not.toHaveBeenCalled()
  })
})
