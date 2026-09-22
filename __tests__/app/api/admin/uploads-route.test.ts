// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const requireAdminMock = vi.fn()
const uploadLandingMediaImageMock = vi.fn()
const enforceMutationSecurityMock = vi.fn()
const enforceRateLimitMock = vi.fn()

vi.mock('@/lib/server/auth', () => ({ requireAdmin: requireAdminMock }))
vi.mock('@/lib/server/uploads-service', () => ({ uploadLandingMediaImage: uploadLandingMediaImageMock }))
vi.mock('@/lib/server/security', () => ({
  enforceMutationSecurity: enforceMutationSecurityMock,
  enforceRateLimit: enforceRateLimitMock,
  RATE_LIMIT_POLICIES: { adminMutation: {} },
}))

const admin = { session: { id: 'admin-1', role: 'admin' as const }, applyCookies: (response: NextResponse) => response }

describe('POST /api/admin/uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enforceMutationSecurityMock.mockReturnValue(null)
    enforceRateLimitMock.mockResolvedValue(null)
    requireAdminMock.mockResolvedValue(admin)
  })

  it('returns the scoped media route instead of a private Blob URL', async () => {
    uploadLandingMediaImageMock.mockResolvedValue({
      pathname: 'landing-media/events/123e4567-e89b-12d3-a456-426614174000.png',
    })
    const form = new FormData()
    form.set('folder', 'events')
    form.set('file', new File([new Uint8Array([1])], 'image.png', { type: 'image/png' }))
    const { POST } = await import('@/app/api/admin/uploads/route')

    const response = await POST(new NextRequest('https://alea.example/api/admin/uploads', { method: 'POST', body: form }))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({
      url: '/api/media/events/123e4567-e89b-12d3-a456-426614174000.png',
    })
  })
})
