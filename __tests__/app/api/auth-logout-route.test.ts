// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const logoutMock = vi.fn()
const enforceMutationSecurityMock = vi.fn()
const enforceRateLimitMock = vi.fn()

vi.mock('@/lib/server/auth-service', () => ({
  logout: logoutMock,
}))

vi.mock('@/lib/server/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/security')>()
  return {
    ...actual,
    enforceMutationSecurity: enforceMutationSecurityMock,
    enforceRateLimit: enforceRateLimitMock,
    RATE_LIMIT_POLICIES: {
      authLogout: { bucket: 'auth-logout', limit: 5, windowMs: 60_000 },
    },
  }
})

function createJsonRequest(options?: { origin?: string }) {
  const origin = options?.origin ?? 'http://localhost:3000'
  return new NextRequest('http://localhost:3000/api/auth/logout', {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin,
      'x-forwarded-for': '10.0.0.1',
      'x-real-ip': '127.0.0.1',
      'x-csrf-token': 'test-csrf-token',
      cookie: 'alea-csrf-token=test-csrf-token',
      'content-type': 'application/json',
    },
  })
}

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    enforceMutationSecurityMock.mockReturnValue(null)
    enforceRateLimitMock.mockResolvedValue(null)
    logoutMock.mockResolvedValue({ success: true })
  })

  it('accepts logout requests and returns success', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(createJsonRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
  })

  it('rejects logout requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')
    enforceMutationSecurityMock.mockReturnValueOnce(
      NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }),
    )

    const response = await POST(
      createJsonRequest({
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('maps logout service failures to a 500 response', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')
    const { ServiceError } = await import('@/lib/server/service-error')
    logoutMock.mockRejectedValueOnce(new ServiceError('Internal server error', 500))

    const response = await POST(createJsonRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 500 })
  })
})
