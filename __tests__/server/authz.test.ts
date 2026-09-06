// @vitest-environment node
/**
 * Unit tests for lib/server/authz.ts — App-layer authorization seam (#298).
 *
 * Validates:
 * 1. isAdmin(): role check correctness
 * 2. requireAdminRole(): permission enforcement on admin-only operations
 * 3. assertOwnsResource(): ownership + admin bypass checks
 * 4. assertMemberRowsScopedSql(): member-scoped read validation and defense-in-depth
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@/lib/server/auth'
import type { ServiceError } from '@/lib/server/service-error'
import type { OwnedRow } from '@/lib/server/authz'
import { assertMemberRowsScopedSql } from '@/lib/server/authz'
import { testMemberRowScopingInvariant } from '../helpers/member-row-scoping-contract'

// Mock 'server-only' (no-op)
vi.mock('server-only', () => ({}))

// Mock serviceError to throw synchronously
vi.mock('@/lib/server/service-error', () => ({
  serviceError: vi.fn((message: string, statusCode: number) => {
    const err = new Error(message) as ServiceError
    err.name = 'ServiceError'
    err.statusCode = statusCode
    throw err
  }),
}))

describe('lib/server/authz.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('isAdmin()', () => {
    it('returns true when session role is "admin"', async () => {
      const { isAdmin } = await import('@/lib/server/authz')
      const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

      const result = isAdmin(adminSession)

      expect(result).toBe(true)
    })

    it('returns false when session role is "member"', async () => {
      const { isAdmin } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }

      const result = isAdmin(memberSession)

      expect(result).toBe(false)
    })
  })

  describe('requireAdminRole()', () => {
    it('throws 403 when session is not admin', async () => {
      const { requireAdminRole } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }

      expect(() => {
        requireAdminRole(memberSession)
      }).toThrow()

      try {
        requireAdminRole(memberSession)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.statusCode).toBe(403)
        expect(err.message).toBe('Forbidden: admin role required')
      }
    })

    it('does not throw when session is admin', async () => {
      const { requireAdminRole } = await import('@/lib/server/authz')
      const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

      expect(() => {
        requireAdminRole(adminSession)
      }).not.toThrow()
    })
  })

  describe('assertOwnsResource()', () => {
    it('does not throw when member owns the resource', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }
      const resourceOwnerId = 'user-member-1'

      expect(() => {
        assertOwnsResource(memberSession, resourceOwnerId)
      }).not.toThrow()
    })

    it('throws 403 when member does not own the resource', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }
      const resourceOwnerId = 'user-other-2'

      expect(() => {
        assertOwnsResource(memberSession, resourceOwnerId)
      }).toThrow()

      try {
        assertOwnsResource(memberSession, resourceOwnerId)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.statusCode).toBe(403)
        expect(err.message).toBe('Forbidden: you do not own this resource')
      }
    })

    it('throws 403 when resourceOwnerId is null', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }

      expect(() => {
        assertOwnsResource(memberSession, null)
      }).toThrow()

      try {
        assertOwnsResource(memberSession, null)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.statusCode).toBe(403)
        expect(err.message).toBe('Forbidden: you do not own this resource')
      }
    })

    it('throws 403 when resourceOwnerId is undefined', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }

      expect(() => {
        assertOwnsResource(memberSession, undefined)
      }).toThrow()

      try {
        assertOwnsResource(memberSession, undefined)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.statusCode).toBe(403)
        expect(err.message).toBe('Forbidden: you do not own this resource')
      }
    })

    it('does not throw when admin regardless of resourceOwnerId', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

      expect(() => {
        assertOwnsResource(adminSession, 'user-other-2')
      }).not.toThrow()
    })

    it('does not throw when admin with null resourceOwnerId', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

      expect(() => {
        assertOwnsResource(adminSession, null)
      }).not.toThrow()
    })

    it('does not throw when admin with undefined resourceOwnerId', async () => {
      const { assertOwnsResource } = await import('@/lib/server/authz')
      const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

      expect(() => {
        assertOwnsResource(adminSession, undefined)
      }).not.toThrow()
    })
  })

  describe('assertMemberRowsScopedSql()', () => {
    testMemberRowScopingInvariant(assertMemberRowsScopedSql)
  })

  describe('Module exports signature validation', () => {
    it('exports all required functions', async () => {
      const authz = await import('@/lib/server/authz')

      expect(typeof authz.isAdmin).toBe('function')
      expect(typeof authz.requireAdminRole).toBe('function')
      expect(typeof authz.assertOwnsResource).toBe('function')
      expect(typeof authz.assertMemberRowsScopedSql).toBe('function')
    })

    it('OwnedRow type shape is satisfied by a minimal fixture (compile-time check)', async () => {
      // This test verifies at compile-time that OwnedRow type exists and has the expected shape.
      // If OwnedRow is removed or its shape changes incompatibly, tsc --noEmit will fail.
      const _ownedRowFixture: OwnedRow = { user_id: 'user-123' }

      expect(_ownedRowFixture.user_id).toBe('user-123')
    })
  })
})
