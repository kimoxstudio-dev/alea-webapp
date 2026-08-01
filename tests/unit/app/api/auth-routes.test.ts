// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

let requestCounter = 0

const registerMock = vi.fn()
const getCurrentUserMock = vi.fn()
const clerkAuthMock = vi.fn()
const drizzleSelectMock = vi.fn()
const drizzleFromMock = vi.fn()
const drizzleWhereMock = vi.fn()
const drizzleLimitMock = vi.fn()

vi.mock('@clerk/nextjs/server', () => ({
  auth: clerkAuthMock,
  clerkMiddleware: vi.fn((handler: unknown) => handler),
}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => ({
    select: drizzleSelectMock,
  })),
  getDb: vi.fn(),
  getAdminDb: vi.fn(),
}))

vi.mock('@/lib/server/auth/auth-service', () => ({
  register: registerMock,
  getCurrentUser: getCurrentUserMock,
}))

function createJsonRequest(
  path: string,
  body?: unknown,
  options?: {
    method?: string
    origin?: string
    cookie?: string
    csrfToken?: string | null
    fetchSite?: string
    forwardedFor?: string
    realIp?: string
  },
) {
  const origin = options?.origin ?? 'http://localhost:3000'
  const csrfToken = options?.csrfToken === undefined ? 'test-csrf-token' : options.csrfToken
  const cookie = [options?.cookie, csrfToken ? `alea-csrf-token=${csrfToken}` : null]
    .filter(Boolean)
    .join('; ')
  const clientIp = options?.forwardedFor ?? `10.0.0.${requestCounter + 1}`
  const realIp = options?.realIp ?? '127.0.0.1'
  requestCounter += 1

  return new NextRequest(`http://localhost:3000${path}`, {
    method: options?.method ?? 'POST',
    headers: {
      host: 'localhost:3000',
      origin,
      'x-forwarded-for': clientIp,
      'x-real-ip': realIp,
      ...(options?.fetchSite ? { 'sec-fetch-site': options.fetchSite } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
}

describe('auth API routes', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    const { resetRateLimitStoreForTests } = await import('@/lib/server/shared/security')
    resetRateLimitStoreForTests()
    vi.stubEnv('TRUST_PROXY_HEADERS', 'true')
    vi.stubEnv('TRUSTED_PROXY_CIDRS', '127.0.0.1/32')
    requestCounter = 0
    registerMock.mockResolvedValue({
      id: 'new-user-id',
      memberNumber: '100099',
      role: 'member',
      isActive: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    getCurrentUserMock.mockResolvedValue({
      id: 'user-2',
      memberNumber: '100099',
      role: 'member',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    clerkAuthMock.mockResolvedValue({ userId: null })
    drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
    drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
    drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
    drizzleLimitMock.mockResolvedValue([{ id: 'user-2', role: 'member', isActive: true }])
  })

  it('retires the legacy login route with a 410 response', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    const response = await POST(
      createJsonRequest('/api/auth/login', {
        identifier: '100001',
        password: 'Admin123',
      }),
    )

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 410 })
  })

  it('rejects login requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    const response = await POST(
      createJsonRequest('/api/auth/login', { identifier: '100001', password: 'Admin123' }, {
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects login requests without a CSRF token', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    const response = await POST(
      createJsonRequest('/api/auth/login', { identifier: '100001', password: 'Admin123' }, {
        csrfToken: null,
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rate limits repeated login attempts from the same client', async () => {
    const { POST } = await import('@/app/api/auth/login/route')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await POST(
        createJsonRequest('/api/auth/login', { identifier: '100001', password: 'Admin123' }, {
          forwardedFor: '203.0.113.10',
        }),
      )

      expect(response.status).toBe(410)
    }

    const blocked = await POST(
      createJsonRequest('/api/auth/login', { identifier: '100001', password: 'Admin123' }, {
        forwardedFor: '203.0.113.10',
      }),
    )

    expect(blocked.status).toBe(429)
  })

  it('returns 410 when self-registration is disabled', async () => {
    const { POST } = await import('@/app/api/auth/register/route')

    const response = await POST(
      createJsonRequest('/api/auth/register', {
        memberNumber: '100099',
        password: 'Password123',
      }),
    )

    expect(response.status).toBe(410)
    expect(registerMock).not.toHaveBeenCalled()
  })

  it('retires the legacy logout route with a 410 response', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(createJsonRequest('/api/auth/logout'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 410 })
  })

  it('rejects logout requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, {
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects logout requests without a CSRF token', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, {
        csrfToken: null,
      }),
    )

    expect(response.status).toBe(403)
  })

  it('retires the legacy logout route with a 410 response', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(createJsonRequest('/api/auth/logout'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 410 })
  })

  it('rejects logout requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, {
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects logout requests without a CSRF token', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, {
        csrfToken: null,
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects register requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/register/route')

    const response = await POST(
      createJsonRequest('/api/auth/register', { memberNumber: '100099', password: 'Password123' }, {
        origin: 'https://attacker.example',
      }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects register requests without a CSRF token', async () => {
    const { POST } = await import('@/app/api/auth/register/route')

    const response = await POST(
      createJsonRequest('/api/auth/register', { memberNumber: '100099', password: 'Password123' }, {
        csrfToken: null,
      }),
    )

    expect(response.status).toBe(403)
  })

  it('reads the session from /me for a mapped Clerk user', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-user-2' })
    drizzleLimitMock.mockResolvedValueOnce([{ id: 'user-2', role: 'member', isActive: true }])

    const response = await GET(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      memberNumber: '100099',
      role: 'member',
    })
  })

  it('uses the Neon profile role for a mapped Clerk admin', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-admin' })
    drizzleLimitMock.mockResolvedValueOnce([{ id: 'admin-1', role: 'admin', isActive: true }])
    getCurrentUserMock.mockResolvedValueOnce({
      id: 'admin-1',
      memberNumber: '100001',
      role: 'admin',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })

    const response = await GET(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ role: 'admin' })
  })

  it('returns 401 from /me when there is no authenticated session', async () => {
    const { GET } = await import('@/app/api/auth/me/route')

    const response = await GET(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 401 })
  })

  it('returns 401 from /me when the Clerk user is unmapped', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-unmapped' })
    drizzleLimitMock.mockResolvedValueOnce([])

    const response = await GET(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.status).toBe(401)
  })

  it('returns 401 from /me when the mapped profile is inactive', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-suspended' })
    drizzleLimitMock.mockResolvedValueOnce([{ id: 'user-2', role: 'member', isActive: false }])

    const response = await GET(new NextRequest('http://localhost:3000/api/auth/me'))

    expect(response.status).toBe(401)
  })

  it('retires the legacy logout route with a 410 response', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(createJsonRequest('/api/auth/logout'))

    expect(response.status).toBe(410)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 410 })
  })

  it('rejects logout requests from a different origin', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, { origin: 'https://attacker.example' }),
    )

    expect(response.status).toBe(403)
  })

  it('rejects logout requests without a CSRF token', async () => {
    const { POST } = await import('@/app/api/auth/logout/route')

    const response = await POST(
      createJsonRequest('/api/auth/logout', undefined, { csrfToken: null }),
    )

    expect(response.status).toBe(403)
  })
})
