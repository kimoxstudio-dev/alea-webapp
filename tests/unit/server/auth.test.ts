// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const clerkAuthMock = vi.fn()
const drizzleSelectMock = vi.fn()
const drizzleFromMock = vi.fn()
const drizzleWhereMock = vi.fn()
const drizzleLimitMock = vi.fn()
const eqMock = vi.fn((column, value) => ({ column, value }))

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>()
  return { ...actual, eq: eqMock }
})

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

function withSession(userId = 'clerk-user-1', role: 'member' | 'admin' = 'admin') {
  clerkAuthMock.mockResolvedValue({ userId })
  drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
  drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
  drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
  drizzleLimitMock.mockResolvedValue([
    {
      id: 'profile-1',
      role,
      isActive: true,
    },
  ])
}

describe('server auth helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    clerkAuthMock.mockResolvedValue({ userId: null })
    drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
    drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
    drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
    drizzleLimitMock.mockResolvedValue([])
  })

  it('reads the session from a Clerk identity mapped in Drizzle', async () => {
    withSession('clerk-admin', 'admin')
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')
    const { profiles } = await import('@/lib/db/schema')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({
      session: { id: 'profile-1', role: 'admin' },
      applyCookies: expect.any(Function),
    })
    expect(eqMock).toHaveBeenCalledWith(profiles.clerkUserId, 'clerk-admin')
  })

  it('reads the session from server cookies for SSR hydration', async () => {
    withSession('clerk-member', 'member')
    const { getSessionFromServerCookies } = await import('@/lib/server/auth/auth')

    await expect(getSessionFromServerCookies()).resolves.toEqual({
      id: 'profile-1',
      role: 'member',
    })
  })

  it('returns null when the Clerk user has no mapped profile', async () => {
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-unmapped' })
    drizzleLimitMock.mockResolvedValueOnce([])
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({ session: null })
  })

  it('returns null when the mapped profile is inactive', async () => {
    clerkAuthMock.mockResolvedValueOnce({ userId: 'clerk-suspended' })
    drizzleLimitMock.mockResolvedValueOnce([
      { id: 'profile-1', role: 'admin', isActive: false },
    ])
    const { getSessionFromRequest } = await import('@/lib/server/auth/auth')

    await expect(
      getSessionFromRequest(new NextRequest('http://localhost:3000/api/auth/me')),
    ).resolves.toMatchObject({ session: null })
  })

  it('returns 401 from requireAuth when no Clerk session is present', async () => {
    const { requireAuth } = await import('@/lib/server/auth/auth')

    const response = await requireAuth(new NextRequest('http://localhost:3000/api/users'))
    expect(response).toBeInstanceOf(NextResponse)
    expect((response as NextResponse).status).toBe(401)
  })

  it('returns 403 from requireAdmin for authenticated members', async () => {
    withSession('clerk-member', 'member')
    const { requireAdmin } = await import('@/lib/server/auth/auth')

    const response = await requireAdmin(new NextRequest('http://localhost:3000/api/users'))
    expect(response).toBeInstanceOf(NextResponse)
    expect((response as NextResponse).status).toBe(403)
  })

  it('returns the session user from requireAdmin for admins', async () => {
    withSession('clerk-admin', 'admin')
    const { requireAdmin } = await import('@/lib/server/auth/auth')

    await expect(
      requireAdmin(new NextRequest('http://localhost:3000/api/users')),
    ).resolves.toMatchObject({
      session: { id: 'profile-1', role: 'admin' },
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
      new NextRequest('http://localhost:3000/api/auth/login', { method: 'POST' }),
    )
    expect(missingOrigin?.status).toBe(403)

    const malformedOrigin = enforceSameOriginForMutation(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { origin: 'not-a-valid-origin' },
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
        headers: { origin: 'http://localhost:3000' },
      }),
    )
    expect(missingCsrf?.status).toBe(403)
  })
})
