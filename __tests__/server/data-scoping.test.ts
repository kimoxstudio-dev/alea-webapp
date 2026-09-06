// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertMemberRowsScoped } from '@/lib/server/data-scoping'
import { testMemberRowScopingInvariant } from '../helpers/member-row-scoping-contract'

describe('data-scoping: assertMemberRowsScoped', () => {
  // Shared invariant matrix (admin passthrough, member match/foreign/null/undefined
  // rows, position-of-violation, instance identity) — see
  // __tests__/helpers/member-row-scoping-contract.ts. This function is a second,
  // independently-live production guard alongside authz.ts's
  // assertMemberRowsScopedSql(); the contract is defined once and exercised
  // against both from their own test files.
  testMemberRowScopingInvariant(assertMemberRowsScoped as any)

  describe('edge cases', () => {
    it('works with rows that have additional fields beyond user_id', () => {
      const memberSession = { id: 'user-123', role: 'member' as const }
      const rows = [
        { id: 'row-1', user_id: 'user-123', name: 'Test', status: 'active' },
        { id: 'row-2', user_id: 'user-123', name: 'Another', status: 'pending' },
      ]

      const result = assertMemberRowsScoped(rows, memberSession)

      expect(result).toHaveLength(2)
      expect(result[0]).toHaveProperty('name', 'Test')
      expect(result[1]).toHaveProperty('name', 'Another')
    })

    it('detects foreign rows with additional fields', () => {
      const memberSession = { id: 'user-123', role: 'member' as const }
      const rows = [
        { id: 'row-1', user_id: 'user-123', name: 'Safe' },
        { id: 'row-2', user_id: 'user-456', name: 'Leaked' },
      ]

      expect(() => assertMemberRowsScoped(rows, memberSession)).toThrow(
        'Data isolation violation: member read returned foreign rows',
      )
    })
  })
})
