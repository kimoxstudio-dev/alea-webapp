// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const getCurrentUserMock = vi.fn()
const resolveProfileForClerkUserMock = vi.fn()
const getClerkSessionMock = vi.fn()
const getClerkUserMock = vi.fn()
const routeGetUserMock = vi.fn()
const routeProfileMaybeSingleMock = vi.fn()

vi.mock('@/lib/server/auth-service', () => ({
  getCurrentUser: getCurrentUserMock,
  resolveProfileForClerkUser: resolveProfileForClerkUserMock,
}))

vi.mock('@/lib/server/session', () => ({
  getClerkSession: getClerkSessionMock,
  getClerkUser: getClerkUserMock,
}))

vi.mock('@/lib/server/session', () => ({
  getClerkSession: vi.fn(async () => ({ userId: 'clerk-user-1' })),
  getClerkUser: vi.fn(async () => ({ id: 'clerk-user-1', username: 'alea-100001' })),
}))

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseRouteHandlerClient: vi.fn(() => ({
    supabase: {
      auth: {
        getUser: routeGetUserMock,
      },
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: routeProfileMaybeSingleMock,
          })),
        })),
      })),
    },
    applyCookies: (response: NextResponse) => {
      response.cookies.set('sb-access-token', 'test-session')
      return response
    },
  })),
}))

function createJsonRequest() {
  return new NextRequest('http://localhost:3000/api/auth/me', {
    method: 'GET',
    headers: {
      host: 'localhost:3000',
      origin: 'http://localhost:3000',
      'x-forwarded-for': '10.0.0.1',
      'x-real-ip': '127.0.0.1',
      cookie: 'sb-access-token=test-session',
    },
  })
}

describe('GET /api/auth/me', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    // Default: authenticated session
    getClerkSessionMock.mockResolvedValue({ sessionId: 'session-123', userId: 'clerk-user-2' })
    getClerkUserMock.mockResolvedValue({ id: 'clerk-user-2', username: 'alea-100099' })
    getCurrentUserMock.mockResolvedValue({
      id: 'user-2',
      memberNumber: '100099',
      role: 'member',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })
    resolveProfileForClerkUserMock.mockResolvedValue({
      id: 'user-2',
      role: 'member',
    })
    routeGetUserMock.mockResolvedValue({ data: { user: { id: 'user-2' } }, error: null })
    routeProfileMaybeSingleMock.mockResolvedValue({
      data: { id: 'user-2', role: 'member', is_active: true },
      error: null,
    })
  })

  it('returns the current user profile when authenticated', async () => {
    const { GET } = await import('@/app/api/auth/me/route')

    const response = await GET(createJsonRequest())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      memberNumber: '100099',
      role: 'member',
    })
  })

  it('returns 401 when current-user resolution is unauthorized', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    const { ServiceError } = await import('@/lib/server/service-error')
    getCurrentUserMock.mockRejectedValueOnce(new ServiceError('Unauthorized', 401))

    const response = await GET(createJsonRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 401 })
  })

  it('returns 401 when there is no authenticated session', async () => {
    const { GET } = await import('@/app/api/auth/me/route')
    // No profile for Clerk user
    resolveProfileForClerkUserMock.mockResolvedValueOnce(null)

    const response = await GET(createJsonRequest())

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ statusCode: 401 })
    expect(getCurrentUserMock).not.toHaveBeenCalled()
  })
})
