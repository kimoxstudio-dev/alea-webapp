// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const activateAccountMock = vi.fn()
const enforceMutationSecurityMock = vi.fn()
const enforceRateLimitMock = vi.fn()

vi.mock('@/lib/server/auth/auth-service', () => ({
  activateAccount: activateAccountMock,
}))

vi.mock('@/lib/server/shared/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/shared/security')>()
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
      signInFailed: false,
      user: {
        id: 'user-20',
        memberNumber: '100020',
        role: 'member',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    })
  })

  it('activates account, signs member in, returns user payload and cookies', async () => {
    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      memberNumber: '100020',
      isActive: true,
    })
    expect(activateAccountMock).toHaveBeenCalledWith({
      token: 'plain-token',
      password: 'Password123',
    })
  })

  it('maps activation failures to service error responses', async () => {
    const { ServiceError } = await import('@/lib/server/shared/service-error')
    activateAccountMock.mockRejectedValueOnce(new ServiceError('Activation link has already been used', 400))

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'used-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      message: 'Activation link has already been used',
      statusCode: 400,
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
    await expect(response.json()).resolves.toMatchObject({
      message: 'Invalid JSON request body.',
      statusCode: 400,
    })
    expect(activateAccountMock).not.toHaveBeenCalled()
  })

  it('treats valid non-object JSON bodies as empty payloads', async () => {
    const { ServiceError } = await import('@/lib/server/shared/service-error')
    activateAccountMock.mockRejectedValueOnce(new ServiceError('Invalid activation link', 400))

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createRawJsonRequest('"plain-string"'))

    expect(response.status).toBe(400)
    expect(activateAccountMock).toHaveBeenCalledWith({
      token: undefined,
      password: undefined,
    })
  })

  it('returns 500 when activation succeeds but automatic sign-in fails', async () => {
    activateAccountMock.mockResolvedValueOnce({
      signInFailed: true,
      user: {
        id: 'user-20',
        memberNumber: '100020',
        role: 'member',
        isActive: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
    })

    const { POST } = await import('@/app/api/auth/activate/route')
    const response = await POST(createJsonRequest({
      token: 'plain-token',
      password: 'Password123',
    }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      message: 'Account activated, but automatic sign-in failed. Please sign in with your member number and new password.',
      statusCode: 500,
    })
  })

  it('returns the security response before touching activation logic', async () => {
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

  it('returns the rate-limit response before touching activation logic', async () => {
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
})
