import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Clerk session helpers test
 *
 * Mocks @clerk/nextjs/server's auth() and currentUser() functions,
 * and verifies that the session helpers (getClerkSession, requireClerkSession, getClerkUser)
 * behave correctly for both authenticated and unauthenticated cases.
 */

// Mock server-only to allow testing server components
vi.mock('server-only', () => ({}))

const { authMock, currentUserMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  currentUserMock: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({
  auth: authMock,
  currentUser: currentUserMock,
}))

import {
  getClerkSession,
  getClerkUser,
  requireClerkSession,
  type ClerkSession,
} from '@/lib/server/session'

describe('Clerk session helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getClerkSession', () => {
    it('returns session object when user is authenticated', async () => {
      authMock.mockResolvedValue({ userId: 'user_123', sessionId: 'sess_123' })

      const session = await getClerkSession()

      expect(session).not.toBeNull()
      expect(session).toEqual({ userId: 'user_123', sessionId: 'sess_123' })
    })

    it('returns null when user is not authenticated', async () => {
      authMock.mockResolvedValue({ userId: null })

      const session = await getClerkSession()

      expect(session).toBeNull()
    })

    it('returns null when auth resolves with undefined userId', async () => {
      authMock.mockResolvedValue({})

      const session = await getClerkSession()

      expect(session).toBeNull()
    })
  })

  describe('requireClerkSession', () => {
    it('returns session object when user is authenticated', async () => {
      authMock.mockResolvedValue({ userId: 'user_456', sessionId: 'sess_456' })

      const session = await requireClerkSession()

      expect(session).toEqual({ userId: 'user_456', sessionId: 'sess_456' })
    })

    it('throws error when user is not authenticated', async () => {
      authMock.mockResolvedValue({ userId: null })

      await expect(requireClerkSession()).rejects.toThrow('Unauthorized')
    })

    it('throws error when userId is undefined', async () => {
      authMock.mockResolvedValue({})

      await expect(requireClerkSession()).rejects.toThrow('Unauthorized')
    })
  })

  describe('getClerkUser', () => {
    it('returns full Clerk user object when authenticated', async () => {
      const mockUser = {
        id: 'user_789',
        firstName: 'John',
        lastName: 'Doe',
        emailAddresses: [{ emailAddress: 'john@example.com' }],
      }
      currentUserMock.mockResolvedValue(mockUser)

      const user = await getClerkUser()

      expect(user).toEqual(mockUser)
    })

    it('returns null when not authenticated', async () => {
      currentUserMock.mockResolvedValue(null)

      const user = await getClerkUser()

      expect(user).toBeNull()
    })
  })
})
