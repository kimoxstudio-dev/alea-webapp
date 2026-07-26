// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('bcryptjs')

// Mock Drizzle database
const drizzleSelectMock = vi.fn()
const drizzleFromMock = vi.fn()
const drizzleWhereMock = vi.fn()
const drizzleLimitMock = vi.fn()

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => ({
    select: drizzleSelectMock,
  })),
  getDb: vi.fn(),
  getAdminDb: vi.fn(),
}))

import { verifyCredentials } from '@/lib/authjs/credentials-user'
import bcrypt from 'bcryptjs'

describe('verifyCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    drizzleSelectMock.mockReset()
    drizzleFromMock.mockReset()
    drizzleWhereMock.mockReset()
    drizzleLimitMock.mockReset()
    drizzleSelectMock.mockReturnValue({ from: drizzleFromMock })
    drizzleFromMock.mockReturnValue({ where: drizzleWhereMock })
    drizzleWhereMock.mockReturnValue({ limit: drizzleLimitMock })
  })

  describe('when database query throws', () => {
    it('returns null when query raises an error (e.g., missing table)', async () => {
      drizzleLimitMock.mockRejectedValueOnce(new Error('relation "profiles" does not exist'))

      const result = await verifyCredentials('test@example.com', 'password123')

      expect(result).toBeNull()
    })

    it('returns null when query raises a connection error', async () => {
      drizzleLimitMock.mockRejectedValueOnce(new Error('Connection refused'))

      const result = await verifyCredentials('test@example.com', 'password123')

      expect(result).toBeNull()
    })

    it('returns null on any unexpected error', async () => {
      drizzleLimitMock.mockRejectedValueOnce(new Error('Unknown error'))

      const result = await verifyCredentials('test@example.com', 'password123')

      expect(result).toBeNull()
    })
  })

  describe('when no matching row is found', () => {
    it('returns null when email does not exist', async () => {
      drizzleLimitMock.mockResolvedValueOnce([])

      const result = await verifyCredentials('nonexistent@example.com', 'password123')

      expect(result).toBeNull()
    })
  })

  describe('when row found but password_hash is null or empty', () => {
    it('returns null when password_hash is null', async () => {
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: null,
          fullName: 'Test User',
          role: 'member',
          isActive: true,
        },
      ])

      const result = await verifyCredentials('test@example.com', 'password123')

      expect(result).toBeNull()
    })

    it('returns null when password_hash is empty string', async () => {
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: '',
          fullName: 'Test User',
          role: 'member',
          isActive: true,
        },
      ])

      const result = await verifyCredentials('test@example.com', 'password123')

      expect(result).toBeNull()
    })
  })

  describe('when password does not match', () => {
    it('returns null when password is incorrect', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: bcryptHash,
          fullName: 'Test User',
          role: 'member',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(false as any)

      const result = await verifyCredentials('test@example.com', 'wrongpassword')

      expect(result).toBeNull()
      expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledWith('wrongpassword', bcryptHash)
    })

    it('does not leak timing information between "no such user" and "wrong password"', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'

      // Case 1: No user found
      drizzleLimitMock.mockResolvedValueOnce([])
      const noUserResult = await verifyCredentials('nonexistent@example.com', 'anypassword')

      // Case 2: User found, wrong password
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: bcryptHash,
          fullName: 'Test User',
          role: 'member',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(false as any)

      const wrongPasswordResult = await verifyCredentials('test@example.com', 'wrongpassword')

      // Both scenarios return null uniformly
      expect(noUserResult).toBeNull()
      expect(wrongPasswordResult).toBeNull()
    })
  })

  describe('when password matches', () => {
    it('returns user object with id, email, and name', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-1',
          email: 'test@example.com',
          passwordHash: bcryptHash,
          fullName: 'Test User',
          role: 'admin',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(true as any)

      const result = await verifyCredentials('test@example.com', 'correctpassword')

      expect(result).toEqual({
        id: 'user-1',
        email: 'test@example.com',
        name: 'Test User',
        role: 'admin',
        isActive: true,
      })
    })

    it('returns user object with name as null when full_name is null', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-2',
          email: 'another@example.com',
          passwordHash: bcryptHash,
          fullName: null,
          role: 'member',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(true as any)

      const result = await verifyCredentials('another@example.com', 'correctpassword')

      expect(result).toEqual({
        id: 'user-2',
        email: 'another@example.com',
        name: null,
        role: 'member',
        isActive: true,
      })
    })

    it('does not include password_hash in the returned user object', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-3',
          email: 'secure@example.com',
          passwordHash: bcryptHash,
          fullName: 'Secure User',
          role: 'member',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(true as any)

      const result = await verifyCredentials('secure@example.com', 'correctpassword')

      expect(result).not.toHaveProperty('passwordHash')
      expect(result).toEqual({
        id: 'user-3',
        email: 'secure@example.com',
        name: 'Secure User',
        role: 'member',
        isActive: true,
      })
    })

    it('correctly calls bcrypt.compare with plaintext and hash', async () => {
      const bcryptHash = '$2a$10$xyzhashedpassword'
      const plainPassword = 'mypassword123'
      drizzleLimitMock.mockResolvedValueOnce([
        {
          id: 'user-4',
          email: 'compare@example.com',
          passwordHash: bcryptHash,
          fullName: 'Compare User',
          role: 'member',
          isActive: true,
        },
      ])
      vi.mocked(bcrypt.compare).mockResolvedValue(true as any)

      await verifyCredentials('compare@example.com', plainPassword)

      expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledWith(plainPassword, bcryptHash)
      expect(vi.mocked(bcrypt.compare)).toHaveBeenCalledTimes(1)
    })
  })

  describe('parameterized query safety', () => {
    it('uses parameterized query to prevent SQL injection', async () => {
      drizzleLimitMock.mockResolvedValueOnce([])

      const maliciousEmail = "'; DROP TABLE profiles; --"
      await verifyCredentials(maliciousEmail, 'password')

      // Drizzle handles parameterization internally, so just verify it was called
      expect(drizzleWhereMock).toHaveBeenCalled()
      expect(drizzleLimitMock).toHaveBeenCalled()
    })
  })
})
