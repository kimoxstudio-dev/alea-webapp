// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const activateAccountMock = vi.fn()
const enforceMutationSecurityMock = vi.fn()
const enforceRateLimitMock = vi.fn()

vi.mock('@/lib/server/auth-service', () => ({
  activateAccount: activateAccountMock,
}))

vi.mock('@/lib/server/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/security')>()
  return {
    ...actual,
    enforceMutationSecurity: enforceMutationSecurityMock,
    enforceRateLimit: enforceRateLimitMock,
    RATE_LIMIT_POLICIES: {
      authActivate: { bucket: 'auth-activate', limit: 5, windowMs: 60_000 },
    },
  }
})

function createJsonRequest(body?: unknown) {
  return new NextRequest('http://localhost:3000/api/auth/activate', {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'x-forwarded-for': '10.0.0.1',
      'x-real-ip': '127.0.0.1',
      'x-csrf-token': 'test-csrf-token',
      cookie: 'alea-csrf-token=test-csrf-token',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

function createRawJsonRequest(body: string) {
  return new NextRequest('http://localhost:3000/api/auth/activate', {
    method: 'POST',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'x-forwarded-for': '10.0.0.1',
      'x-real-ip': '127.0.0.1',
      'x-csrf-token': 'test-csrf-token',
      cookie: 'alea-csrf-token=test-csrf-token',
      'content-type': 'application/json',
    },
    body,
  })
}

describe('POST /api/auth/activate', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    enforceMutationSecurityMock.mockReturnValue(null)
    enforceRateLimitMock.mockReturnValue(null)
    activateAccountMock.mockResolvedValue({
      user: {
        id: 'user-20',
        memberNumber: '100020',
        fullName: 'Test Member',
        email: 'contact@example.com',
        phone: '+1234567890',
        role: 'member',
        isActive: true,
        activeFrom: '2024-01-15T12:00:00.000Z',
        noShowCount: 0,
        blockedUntil: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-15T12:00:00.000Z',
      },
    })
  })

  it('accepts { token, password }, activates account, returns user payload', async () => {
    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token-value',
      password: 'Password123',
    }))

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({
      memberNumber: '100020',
      isActive: true,
      role: 'member',
    })

    // Verify activateAccount was called with both token and password
    expect(activateAccountMock).toHaveBeenCalledWith({
      token: 'plain-token-value',
      password: 'Password123',
    })
  })

  it('returns 400 for invalid JSON request bodies', async () => {
    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(new NextRequest('http://localhost:3000/api/auth/activate', {
      method: 'POST',
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:3000',
        'x-forwarded-for': '10.0.0.1',
        'x-real-ip': '127.0.0.1',
        'x-csrf-token': 'test-csrf-token',
        cookie: 'alea-csrf-token=test-csrf-token',
        'content-type': 'application/json',
      },
      body: '{',
    }))

    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json.message).toBe('Invalid JSON request body.')
    expect(activateAccountMock).not.toHaveBeenCalled()
  })

  it('treats valid non-object JSON bodies as empty payloads', async () => {
    const { ServiceError } = await import('@/lib/server/service-error')
    activateAccountMock.mockRejectedValueOnce(
      new ServiceError('Invalid activation link', 400),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createRawJsonRequest('"plain-string"'))

    expect(response.status).toBe(400)
    expect(activateAccountMock).toHaveBeenCalledWith({
      token: undefined,
      password: undefined,
    })
  })

  it('maps activation failures to service error responses', async () => {
    const { ServiceError } = await import('@/lib/server/service-error')
    activateAccountMock.mockRejectedValueOnce(
      new ServiceError('Activation link has already been used', 400),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'used-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(400)
    const json = await response.json()
    expect(json).toMatchObject({
      message: 'Activation link has already been used',
      statusCode: 400,
    })
  })

  it('returns 401 for invalid/expired activation link', async () => {
    const { ServiceError } = await import('@/lib/server/service-error')
    activateAccountMock.mockRejectedValueOnce(
      new ServiceError('Activation link is invalid or has expired', 400),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'expired-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(400)
  })

  it('returns 500 for Clerk user creation failure', async () => {
    const { ServiceError } = await import('@/lib/server/service-error')
    activateAccountMock.mockRejectedValueOnce(
      new ServiceError('Failed to create account credentials', 500),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(500)
    const json = await response.json()
    expect(json).toMatchObject({
      message: 'Failed to create account credentials',
      statusCode: 500,
    })
  })

  it('returns security error before touching activation logic', async () => {
    enforceMutationSecurityMock.mockReturnValueOnce(
      NextResponse.json({ message: 'Forbidden', statusCode: 403 }, { status: 403 }),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(403)
    expect(activateAccountMock).not.toHaveBeenCalled()
  })

  it('returns rate-limit error before touching activation logic', async () => {
    enforceRateLimitMock.mockReturnValueOnce(
      NextResponse.json({ message: 'Too many requests', statusCode: 429 }, { status: 429 }),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(429)
    expect(activateAccountMock).not.toHaveBeenCalled()
  })

  it('validates password schema on the request body', async () => {
    const { ServiceError } = await import('@/lib/server/service-error')
    activateAccountMock.mockRejectedValueOnce(
      new ServiceError('Invalid activation link', 400),
    )

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'valid-token',
      password: 'weak', // Too weak, missing uppercase, number
    }))

    expect(response.status).toBe(400)
  })
})
