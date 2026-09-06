import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@/lib/server/auth'

/**
 * Shared contract-test matrix for the "member row scoping" invariant enforced
 * independently by two live, non-duplicate production functions:
 * `assertMemberRowsScopedSql()` (lib/server/authz.ts, guards users-service.ts)
 * and `assertMemberRowsScoped()` (lib/server/data-scoping.ts, guards
 * saved-games-service.ts and reservations-service.ts). Both enforce the same
 * behavior (admin passthrough; member rows must all match session.id; a
 * single foreign/null/undefined user_id throws a 500 "Data isolation
 * violation" ServiceError) so the ~12-case matrix is defined once here and
 * exercised against each function from its own test file, instead of being
 * hand-duplicated. A fix to the shared invariant can no longer be silently
 * un-mirrored between the two guards.
 */
export function testMemberRowScopingInvariant(
  fn: (rows: readonly any[], session: SessionUser) => readonly any[],
) {
  const memberSession: SessionUser = { id: 'user-member-1', role: 'member' }
  const adminSession: SessionUser = { id: 'user-admin-1', role: 'admin' }

  describe('member session', () => {
    it('passes through rows unchanged when all rows match the session id', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1', title: 'Row 1' },
        { user_id: 'user-member-1', id: 'row-2', title: 'Row 2' },
      ]

      const result = fn(rows, memberSession)

      expect(result).toEqual(rows)
      expect(result).toHaveLength(2)
    })

    it('returns the same array instance (not a copy)', () => {
      const rows = [{ user_id: 'user-member-1', id: 'row-1' }]

      expect(fn(rows, memberSession)).toBe(rows)
    })

    it('returns empty array unchanged when there are no rows', () => {
      const result = fn([], memberSession)

      expect(result).toEqual([])
      expect(result).toHaveLength(0)
    })

    it('throws a 500 isolation violation when a foreign-owned row is present', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1', title: 'Row 1' },
        { user_id: 'user-other-2', id: 'row-2', title: 'Row 2' },
      ]

      try {
        fn(rows, memberSession)
        expect.fail('Should have thrown')
      } catch (err: any) {
        expect(err.statusCode).toBe(500)
        expect(err.message).toBe('Data isolation violation: member read returned foreign rows')
      }
    })

    it('throws when a row has a null user_id', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: null, id: 'row-2' },
      ]

      expect(() => fn(rows, memberSession)).toThrow(
        'Data isolation violation: member read returned foreign rows',
      )
    })

    it('throws when a row has an undefined user_id', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: undefined, id: 'row-2' },
      ]

      expect(() => fn(rows, memberSession)).toThrow(
        'Data isolation violation: member read returned foreign rows',
      )
    })

    it('detects a violation regardless of the offending row position (first/middle/last)', () => {
      const first = [
        { user_id: 'user-other-2', id: 'row-1' },
        { user_id: 'user-member-1', id: 'row-2' },
      ]
      const middle = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: 'user-other-2', id: 'row-2' },
        { user_id: 'user-member-1', id: 'row-3' },
      ]
      const last = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: 'user-member-1', id: 'row-2' },
        { user_id: 'user-other-2', id: 'row-3' },
      ]

      for (const rows of [first, middle, last]) {
        expect(() => fn(rows, memberSession)).toThrow(
          'Data isolation violation: member read returned foreign rows',
        )
      }
    })
  })

  describe('admin session', () => {
    it('passes through all rows unchanged with mixed owners', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: 'user-other-2', id: 'row-2' },
        { user_id: 'user-admin-1', id: 'row-3' },
      ]

      const result = fn(rows, adminSession)

      expect(result).toEqual(rows)
      expect(result).toHaveLength(3)
    })

    it('passes through rows with a null or undefined user_id', () => {
      const rows = [
        { user_id: 'user-member-1', id: 'row-1' },
        { user_id: null, id: 'row-2' },
        { user_id: undefined, id: 'row-3' },
      ]

      const result = fn(rows, adminSession)

      expect(result).toEqual(rows)
      expect(result).toHaveLength(3)
    })

    it('returns empty array without error', () => {
      expect(fn([], adminSession)).toEqual([])
    })
  })
}
