// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const clerkGetSessionMock = vi.fn()
const clerkGetUserMock = vi.fn()
const resolveProfileForClerkUserMock = vi.fn()

vi.mock('@/lib/server/session', () => ({
  getClerkSession: clerkGetSessionMock,
  getClerkUser: clerkGetUserMock,
}))

vi.mock('@/lib/server/auth-service', () => ({
  resolveProfileForClerkUser: resolveProfileForClerkUserMock,
}))

describe('server auth helpers (Clerk username model)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    clerkGetSessionMock.mockResolvedValue(null)
    clerkGetUserMock.mockResolvedValue(null)
    resolveProfileForClerkUserMock.mockResolvedValue(null)
  })

  describe('getSessionFromRequest', () => {
    it('resolves Clerk session to profile by username when authenticated', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-100001',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce({
        id: 'user-1',
        role: 'admin',
      })

      const { getSessionFromRequest } = await import('@/lib/server/auth')

      const result = await getSessionFromRequest(
        new NextRequest('http://localhost:3000/api/auth/me'),
      )

      expect(result).toMatchObject({
        session: { id: 'user-1', role: 'admin' },
        applyCookies: expect.any(Function),
      })
      expect(resolveProfileForClerkUserMock).toHaveBeenCalledWith({
        username: 'alea-100001',
      })
    })

    it('returns null session when no Clerk session exists', async () => {
      clerkGetSessionMock.mockResolvedValueOnce(null)

      const { getSessionFromRequest } = await import('@/lib/server/auth')

      const result = await getSessionFromRequest(
        new NextRequest('http://localhost:3000/api/auth/me'),
      )

      expect(result.session).toBeNull()
      expect(clerkGetUserMock).not.toHaveBeenCalled()
      expect(resolveProfileForClerkUserMock).not.toHaveBeenCalled()
    })

    it('returns null session when Clerk user has no username', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: null, // No username
      })

      const { getSessionFromRequest } = await import('@/lib/server/auth')

      const result = await getSessionFromRequest(
        new NextRequest('http://localhost:3000/api/auth/me'),
      )

      expect(result.session).toBeNull()
      expect(resolveProfileForClerkUserMock).not.toHaveBeenCalled()
    })

    it('returns null session when profile cannot be resolved from Clerk username', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-999999', // Profile does not exist
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce(null)

      const { getSessionFromRequest } = await import('@/lib/server/auth')

      const result = await getSessionFromRequest(
        new NextRequest('http://localhost:3000/api/auth/me'),
      )

      expect(result.session).toBeNull()
    })

    it('applyCookies passthrough does not mutate the response', async () => {
      clerkGetSessionMock.mockResolvedValueOnce(null)

      const { getSessionFromRequest } = await import('@/lib/server/auth')

      const result = await getSessionFromRequest(
        new NextRequest('http://localhost:3000/api/auth/me'),
      )

      const testResponse = new NextResponse()
      const returned = result.applyCookies(testResponse)
      expect(returned).toBe(testResponse)
    })
  })

  describe('getSessionFromServerCookies', () => {
    it('resolves server-side Clerk session to profile', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-456',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-456',
        username: 'alea-100002',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce({
        id: 'user-2',
        role: 'member',
      })

      const { getSessionFromServerCookies } = await import('@/lib/server/auth')

      const result = await getSessionFromServerCookies()

      expect(result).toEqual({ id: 'user-2', role: 'member' })
    })

    it('returns null when no server-side session exists', async () => {
      clerkGetSessionMock.mockResolvedValueOnce(null)

      const { getSessionFromServerCookies } = await import('@/lib/server/auth')

      const result = await getSessionFromServerCookies()

      expect(result).toBeNull()
    })
  })

  describe('requireAuth', () => {
    it('returns session and applyCookies when authenticated', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-100001',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce({
        id: 'user-1',
        role: 'member',
      })

      const { requireAuth } = await import('@/lib/server/auth')

      const result = await requireAuth(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toMatchObject({
        session: { id: 'user-1', role: 'member' },
        applyCookies: expect.any(Function),
      })
    })

    it('returns 401 when no session is authenticated', async () => {
      clerkGetSessionMock.mockResolvedValueOnce(null)

      const { requireAuth } = await import('@/lib/server/auth')

      const result = await requireAuth(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(401)
      const json = await (result as NextResponse).json()
      expect(json.message).toBe('Unauthorized')
    })

    it('returns 401 when profile cannot be resolved from Clerk username', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-100001',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce(null)

      const { requireAuth } = await import('@/lib/server/auth')

      const result = await requireAuth(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(401)
    })
  })

  describe('requireAdmin', () => {
    it('returns session when user is admin', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-100000',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce({
        id: 'admin-1',
        role: 'admin',
      })

      const { requireAdmin } = await import('@/lib/server/auth')

      const result = await requireAdmin(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toMatchObject({
        session: { id: 'admin-1', role: 'admin' },
        applyCookies: expect.any(Function),
      })
    })

    it('returns 403 when authenticated user is a member, not admin', async () => {
      clerkGetSessionMock.mockResolvedValueOnce({
        sessionId: 'clerk-session-123',
      })
      clerkGetUserMock.mockResolvedValueOnce({
        id: 'clerk-user-123',
        username: 'alea-100001',
      })
      resolveProfileForClerkUserMock.mockResolvedValueOnce({
        id: 'user-1',
        role: 'member',
      })

      const { requireAdmin } = await import('@/lib/server/auth')

      const result = await requireAdmin(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
      const json = await (result as NextResponse).json()
      expect(json.message).toBe('Forbidden')
    })

    it('returns 401 when no session exists', async () => {
      clerkGetSessionMock.mockResolvedValueOnce(null)

      const { requireAdmin } = await import('@/lib/server/auth')

      const result = await requireAdmin(new NextRequest('http://localhost:3000/api/users'))

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(401)
    })
  })

  describe('enforceSameOriginForMutation', () => {
    it('allows GET requests without origin check', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/me', { method: 'GET' }),
      )

      expect(result).toBeNull()
    })

    it('allows POST from same origin with matching CSRF token', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: 'alea-csrf-token=test-csrf-token',
            'x-csrf-token': 'test-csrf-token',
          },
        }),
      )

      expect(result).toBeNull()
    })

    it('rejects POST with mismatched origin scheme', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('https://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: 'alea-csrf-token=test-csrf-token',
            'x-csrf-token': 'test-csrf-token',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects POST from cross-origin', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'https://attacker.example',
            cookie: 'alea-csrf-token=test-csrf-token',
            'x-csrf-token': 'test-csrf-token',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects POST when origin header is missing', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects POST when CSRF token is missing', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects POST with mismatched CSRF token', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/auth/login', {
          method: 'POST',
          headers: {
            origin: 'http://localhost:3000',
            cookie: 'alea-csrf-token=correct-token',
            'x-csrf-token': 'wrong-token',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects PUT requests with same security checks as POST', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/users', {
          method: 'PUT',
          headers: {
            origin: 'https://attacker.example',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })

    it('rejects DELETE requests with same security checks', async () => {
      const { enforceSameOriginForMutation } = await import('@/lib/server/auth')

      const result = enforceSameOriginForMutation(
        new NextRequest('http://localhost:3000/api/users', {
          method: 'DELETE',
          headers: {
            origin: 'https://attacker.example',
          },
        }),
      )

      expect(result).toBeInstanceOf(NextResponse)
      expect((result as NextResponse).status).toBe(403)
    })
  })
})
