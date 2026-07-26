// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toPublicUser } from '@/lib/server/users/profile-mappers'
import type { profiles } from '@/lib/db/schema'

type ProfileRow = typeof profiles.$inferSelect

describe('profile mappers', () => {
  describe('toPublicUser', () => {
    it('maps a complete profile row to User with all fields', () => {
      const profile: ProfileRow = {
        id: 'user-123',
        memberNumber: '100001',
        fullName: 'John Doe',
        authEmail: 'john@alea.club',
        email: 'john.doe@personal.com',
        phone: '+34 123 456 789',
        role: 'member',
        isActive: true,
        activeFrom: new Date('2024-01-15T10:00:00.000Z'),
        noShowCount: 2,
        blockedUntil: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T14:30:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      expect(user).toEqual({
        id: 'user-123',
        memberNumber: '100001',
        fullName: 'John Doe',
        email: 'john.doe@personal.com',
        phone: '+34 123 456 789',
        role: 'member',
        isActive: true,
        activeFrom: '2024-01-15T10:00:00.000Z',
        noShowCount: 2,
        blockedUntil: null,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-06-20T14:30:00.000Z',
      })
    })

    it('handles null/optional fields correctly', () => {
      const profile: ProfileRow = {
        id: 'user-456',
        memberNumber: '100002',
        fullName: null,
        authEmail: 'user@alea.club',
        email: null,
        phone: null,
        role: 'admin',
        isActive: false,
        activeFrom: null,
        noShowCount: 0,
        blockedUntil: null,
        createdAt: new Date('2024-02-01T00:00:00.000Z'),
        updatedAt: new Date('2024-02-01T00:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      expect(user).toEqual({
        id: 'user-456',
        memberNumber: '100002',
        fullName: null,
        email: null,
        phone: null,
        role: 'admin',
        isActive: false,
        activeFrom: null,
        noShowCount: 0,
        blockedUntil: null,
        createdAt: '2024-02-01T00:00:00.000Z',
        updatedAt: '2024-02-01T00:00:00.000Z',
      })
    })

    it('preserves blocked_until when set', () => {
      const blockDate = new Date('2024-07-01T00:00:00.000Z')
      const profile: ProfileRow = {
        id: 'user-blocked',
        memberNumber: '100003',
        fullName: 'Blocked User',
        authEmail: 'blocked@alea.club',
        email: 'blocked@personal.com',
        phone: null,
        role: 'member',
        isActive: true,
        activeFrom: new Date('2024-01-01T00:00:00.000Z'),
        noShowCount: 5,
        blockedUntil: blockDate,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T14:30:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      expect(user.blockedUntil).toBe(blockDate.toISOString())
    })

    it('converts snake_case column names to camelCase', () => {
      const profile: ProfileRow = {
        id: 'test-user',
        memberNumber: '999999',
        fullName: 'Test Name',
        authEmail: 'test@alea.club',
        email: 'test@personal.com',
        phone: '555-1234',
        role: 'member',
        isActive: true,
        activeFrom: new Date('2024-06-01T00:00:00.000Z'),
        noShowCount: 1,
        blockedUntil: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T12:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      // Verify all camelCase fields are present
      expect(user).toHaveProperty('memberNumber', profile.memberNumber)
      expect(user).toHaveProperty('fullName', profile.fullName)
      expect(user).toHaveProperty('isActive', profile.isActive)
      expect(user).toHaveProperty('activeFrom', profile.activeFrom.toISOString())
      expect(user).toHaveProperty('noShowCount', profile.noShowCount)
      expect(user).toHaveProperty('blockedUntil', profile.blockedUntil)
      expect(user).toHaveProperty('createdAt', profile.createdAt.toISOString())
      expect(user).toHaveProperty('updatedAt', profile.updatedAt.toISOString())
    })

    it('handles admin role', () => {
      const profile: ProfileRow = {
        id: 'admin-user',
        memberNumber: '100000',
        fullName: 'Admin User',
        authEmail: 'admin@alea.club',
        email: 'admin@personal.com',
        phone: null,
        role: 'admin',
        isActive: true,
        activeFrom: new Date('2024-01-01T00:00:00.000Z'),
        noShowCount: 0,
        blockedUntil: null,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      expect(user.role).toBe('admin')
    })

    it('handles zero and negative no_show_count values', () => {
      const profileZero: ProfileRow = {
        id: 'user-zero',
        memberNumber: '100010',
        fullName: 'Zero Shows',
        authEmail: 'zero@alea.club',
        email: null,
        phone: null,
        role: 'member',
        isActive: true,
        activeFrom: new Date('2024-06-01T00:00:00.000Z'),
        noShowCount: 0,
        blockedUntil: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profileZero)

      expect(user.noShowCount).toBe(0)
    })

    it('handles long no_show_count values', () => {
      const profile: ProfileRow = {
        id: 'user-many',
        memberNumber: '100011',
        fullName: 'Many Shows',
        authEmail: 'many@alea.club',
        email: null,
        phone: null,
        role: 'member',
        isActive: false,
        activeFrom: null,
        noShowCount: 10,
        blockedUntil: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profile)

      expect(user.noShowCount).toBe(10)
    })

    it('preserves active_from as nullable', () => {
      const profileWithActiveFrom: ProfileRow = {
        id: 'user-active',
        memberNumber: '100012',
        fullName: 'Active User',
        authEmail: 'active@alea.club',
        email: null,
        phone: null,
        role: 'member',
        isActive: true,
        activeFrom: new Date('2025-01-01T00:00:00.000Z'),
        noShowCount: 0,
        blockedUntil: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
        pswChanged: null,
      }

      const user = toPublicUser(profileWithActiveFrom)

      expect(user.activeFrom).toBe('2025-01-01T00:00:00.000Z')

      const profileWithoutActiveFrom: ProfileRow = {
        ...profileWithActiveFrom,
        activeFrom: null,
      }

      const user2 = toPublicUser(profileWithoutActiveFrom)

      expect(user2.activeFrom).toBeNull()
    })
  })
})
