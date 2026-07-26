// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const authJsAuthMock = vi.fn()
const drizzleSelectMock = vi.fn()
const drizzleFromMock = vi.fn()
const drizzleWhereMock = vi.fn()
const drizzleLimitMock = vi.fn()

// Mock Auth.js auth() to prevent loading next-auth
vi.mock('@/lib/authjs/auth', () => ({
  auth: authJsAuthMock,
  handlers: { GET: vi.fn(), POST: vi.fn() },
}))

// Mock Drizzle database
vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => ({
    select: drizzleSelectMock,
  })),
  getDb: vi.fn(),
  getAdminDb: vi.fn(),
}))

// Mock next-auth/jwt to prevent loading next-auth
vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}))

function withSession(userId = 'user-1', role: 'member' | 'admin' = 'admin') {
  const sessionResult = { user: { id: userId } }
  const profileResult = [
    {
      id: userId,
      role,
      isActive: true,
      email: 'admin@alea.club',
      memberNumber: '100001',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
  ]
  authJsAuthMock.mockResolvedValue(sessionResult)
  drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
  drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
  drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
  drizzleLimitMock.mockResolvedValue(profileResult)
}

describe('server auth helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    authJsAuthMock.mockResolvedValue(null)
    drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
    drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
    drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
    drizzleLimitMock.mockResolvedValue([])
  })

  it('reads the session from a request-scoped Drizzle client', async () => {
    withSession('user-1', 'admin')
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({
      session: { id: 'user-1', role: 'admin' },
      applyCookies: expect.any(Function),
    })
  })

  it('reads the session from server cookies for SSR hydration', async () => {
    withSession('user-2', 'member')
    const { getSessionFromServerCookies } = await import('@/lib/server/auth/auth')

    await expect(getSessionFromServerCookies()).resolves.toEqual({
      id: 'user-2',
      role: 'member',
    })
  })

  it('returns null when the profile lookup fails after a valid auth session', async () => {
    authJsAuthMock.mockResolvedValueOnce({ user: { id: 'user-1' } })
    drizzleLimitMock.mockResolvedValueOnce([])
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({ session: null })
  })

  it('returns null when the profile is inactive', async () => {
    authJsAuthMock.mockResolvedValueOnce({ user: { id: 'user-1' } })
    drizzleLimitMock.mockResolvedValueOnce([
      { id: 'user-1', role: 'admin', isActive: false },
    ])
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({ session: null })
  })

  it('returns 401 from requireAuth when no Auth.js session is present', async () => {
    const { requireAuth } = await import('@/lib/server/auth/auth')

    const response = await requireAuth(new NextRequest('http://localhost:3000/api/users'))
    expect(response).toBeInstanceOf(NextResponse)
    expect((response as NextResponse).status).toBe(401)
  })

  it('returns 403 from requireAdmin for authenticated members', async () => {
    withSession('user-2', 'member')
    const { requireAdmin } = await import('@/lib/server/auth/auth')

    const response = await requireAdmin(new NextRequest('http://localhost:3000/api/users'))
    expect(response).toBeInstanceOf(NextResponse)
    expect((response as NextResponse).status).toBe(403)
  })

  it('returns the session user from requireAdmin for admins', async () => {
    withSession('user-1', 'admin')
    const { requireAdmin } = await import('@/lib/server/auth/auth')

    await expect(
      requireAdmin(new NextRequest('http://localhost:3000/api/users')),
    ).resolves.toMatchObject({
      session: { id: 'user-1', role: 'admin' },
      applyCookies: expect.any(Function),
    })
  })

  it('enforces same-origin for unsafe methods and skips GET requests', async () => {
    const { enforceSameOriginForMutation } = await import('@/lib/server/auth/auth')

    expect(
      enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/me', { method: 'GET' }),
      ),
    ).toBeNull()

    expect(
      enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: 'alea-csrf-token=test-csrf-token',
            'x-csrf-token': 'test-csrf-token',
          },
        }),
      ),
    ).toBeNull()

    expect(
      enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: 'alea-csrf-token=test-csrf-token',
            'x-csrf-token': 'test-csrf-token',
            'sec-fetch-site': 'same-origin',
          },
        }),
      ),
    ).toBeNull()

    const schemeMismatch = enforceSameOriginForMutation(
      new NextRequest('https://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          cookie: 'alea-csrf-token=test-csrf-token',
          'x-csrf-token': 'test-csrf-token',
        },
      }),
    )

    expect(schemeMismatch?.status).toBe(403)

    const rejected = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          origin: 'https://attacker.example',
          cookie: 'alea-csrf-token=test-csrf-token',
          'x-csrf-token': 'test-csrf-token',
        },
      }),
    )

    expect(rejected?.status).toBe(403)

    const missingOrigin = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
      }),
    )
    expect(missingOrigin?.status).toBe(403)

    const malformedOrigin = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          origin: 'not-a-valid-origin',
        },
      }),
    )
    expect(malformedOrigin?.status).toBe(403)

    const crossSite = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          cookie: 'alea-csrf-token=test-csrf-token',
          'x-csrf-token': 'test-csrf-token',
          'sec-fetch-site': 'cross-site',
        },
      }),
    )
    expect(crossSite?.status).toBe(403)

    const missingCsrf = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
        },
      }),
    )
    expect(missingCsrf?.status).toBe(403)
  })
})
