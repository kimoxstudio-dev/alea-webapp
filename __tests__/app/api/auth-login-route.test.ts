// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const enforceMutationSecurityMock = vi.fn()
const enforceRateLimitMock = vi.fn()

vi.mock('@/lib/server/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/security')>()
  return {
    ...actual,
    enforceMutationSecurity: enforceMutationSecurityMock,
    enforceRateLimit: enforceRateLimitMock,
    RATE_LIMIT_POLICIES: {
      authLogin: { bucket: 'auth-login', limit: 5, windowMs: 60_000 },
    },
  }
})

function createJsonRequest(options?: { origin?: string }) {
  const origin = options?.origin ?? 'http://localhost:3000'
  return new NextRequest('http://localhost:3000/api/auth/login', {
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

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    enforceMutationSecurityMock.mockReturnValue(null)
    enforceRateLimitMock.mockResolvedValue(null)
  })

  it('returns 410 Gone with disabled message', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    const response = await POST(createJsonRequest())

    expect(response.status).toBe(410)
    const json = await response.json()
    expect(json).toMatchObject({
      message: 'Password-based login is disabled. Sign in with your Clerk account instead.',
      statusCode: 410,
    })
  })

  it('invokes enforceMutationSecurity before returning 410', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    await POST(createJsonRequest())

    expect(enforceMutationSecurityMock).toHaveBeenCalledWith(expect.any(NextRequest))
  })

  it('invokes enforceRateLimit after mutation security check', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    await POST(createJsonRequest())

    expect(enforceRateLimitMock).toHaveBeenCalledWith(
      expect.any(NextRequest),
      expect.objectContaining({
        bucket: 'auth-login',
        limit: 5,
        windowMs: 60_000,
      }),
    )
  })

  it('returns security error before returning 410', async () => {
    enforceMutationSecurityMock.mockReturnValueOnce(
      NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }),
    )

    const { POST } = await import('@/app/api/auth/login/route')
    const response = await POST(createJsonRequest())

    expect(response.status).toBe(403)
  })

  it('returns rate-limit error before returning 410', async () => {
    enforceRateLimitMock.mockResolvedValueOnce(
      NextResponse.json({ message: 'Too many requests', statusCode: 429 }, { status: 429 }),
    )

    const { POST } = await import('@/app/api/auth/login/route')
    const response = await POST(createJsonRequest())

    expect(response.status).toBe(429)
  })

  it('rejects requests from different origin via security check', async () => {
    enforceMutationSecurityMock.mockReturnValueOnce(
      NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }),
    )

    const { POST } = await import('@/app/api/auth/login/route')
    const response = await POST(
      createJsonRequest({
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('does not perform any database writes or mutations', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    const response = await POST(createJsonRequest())

    // Stub endpoint should only return 410, no service layer calls
    expect(response.status).toBe(410)
    // Verify only security checks were called, no business logic
    expect(enforceMutationSecurityMock).toHaveBeenCalledOnce()
    expect(enforceRateLimitMock).toHaveBeenCalledOnce()
  })
})
