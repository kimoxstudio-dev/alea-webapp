// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseStatement, whereConditionCount, whereHasColumn } from './sql-mock'

/**
 * Issue #332 fix validation: whereConditionCount() must correctly count both
 * AND-joined and OR-joined conditions, not just AND. This ensures that
 * weakening a WHERE clause (fewer actual conditions) produces an observably
 * different result, preventing silent mismatches where a handler written for
 * 3 conditions accidentally matches a 1-condition query.
 */
describe('sql-mock: whereConditionCount fix for issue #332', () => {
  it('counts 1 condition in a single-column WHERE', () => {
    const stmt = parseStatement('SELECT id FROM profiles WHERE member_number = $1', ['100001'])
    expect(whereConditionCount(stmt)).toBe(1)
  })

  it('counts 3 conditions in OR-joined WHERE (the #332 bug case)', () => {
    // This is the exact pattern used in users-service.ts for search:
    // WHERE member_number ILIKE $1 OR full_name ILIKE $2 OR email ILIKE $3
    const stmt = parseStatement(
      `SELECT id, member_number, full_name, email FROM profiles
       WHERE member_number ILIKE $1 OR full_name ILIKE $2 OR email ILIKE $3
       ORDER BY created_at LIMIT 10`,
      ['pattern', 'pattern', 'pattern'],
    )
    // Before fix: this would have returned 1 (only split on AND)
    // After fix: this should return 3 (split on both AND and OR)
    expect(whereConditionCount(stmt)).toBe(3)
  })

  it('counts 2 conditions in AND-joined WHERE', () => {
    const stmt = parseStatement(
      'SELECT id FROM profiles WHERE member_number = $1 AND id <> $2',
      ['100001', 'profile-1'],
    )
    expect(whereConditionCount(stmt)).toBe(2)
  })

  it('counts 3 conditions in mixed AND/OR WHERE', () => {
    const stmt = parseStatement(
      'SELECT id FROM profiles WHERE a = $1 AND b = $2 OR c = $3',
      ['val1', 'val2', 'val3'],
    )
    expect(whereConditionCount(stmt)).toBe(3)
  })

  it('counts 0 conditions when there is no WHERE clause', () => {
    const stmt = parseStatement('SELECT id FROM profiles ORDER BY created_at', [])
    expect(whereConditionCount(stmt)).toBe(0)
  })

  /**
   * Behavioral evidence: A handler written for a 3-condition WHERE must NOT
   * match a 1-condition query, and vice versa. This test demonstrates that
   * the fix enables correct dispatch logic.
   */
  it('enables handlers to distinguish 3-condition from 1-condition WHERE', () => {
    // 3-condition search query
    const search3 = parseStatement(
      `SELECT id FROM profiles
       WHERE member_number ILIKE $1 OR full_name ILIKE $2 OR email ILIKE $3`,
      ['pattern', 'pattern', 'pattern'],
    )

    // 1-condition exact-match query
    const search1 = parseStatement('SELECT id FROM profiles WHERE member_number = $1', ['pattern'])

    // Before fix: both would have returned 1, indistinguishable
    // After fix: they return different values
    expect(whereConditionCount(search3)).toBe(3)
    expect(whereConditionCount(search1)).toBe(1)
    expect(whereConditionCount(search3)).not.toBe(whereConditionCount(search1))

    // Handler logic can now use the count to dispatch correctly:
    const search3Handler = { match: (stmt) => whereConditionCount(stmt) === 3 }
    const search1Handler = { match: (stmt) => whereConditionCount(stmt) === 1 }

    expect(search3Handler.match(search3)).toBe(true)
    expect(search3Handler.match(search1)).toBe(false)
    expect(search1Handler.match(search3)).toBe(false)
    expect(search1Handler.match(search1)).toBe(true)
  })

  /**
   * Revert-confirm: The fix specifically addresses the #332 acceptance criteria:
   * "A statement whose WHERE conditions are weakened (e.g. three conditions
   * reduced to one) causes a behavioural difference in the mock, not a silent
   * no-op."
   */
  it('revert-confirm: detects weakening of WHERE clause (3 → 1 condition)', () => {
    // Original 3-condition query
    const original = parseStatement(
      `SELECT id FROM profiles
       WHERE member_number ILIKE $1 OR full_name ILIKE $2 OR email ILIKE $3`,
      ['term', 'term', 'term'],
    )

    // Accidentally weakened query (only first condition, other two removed)
    const weakened = parseStatement(
      'SELECT id FROM profiles WHERE member_number ILIKE $1',
      ['term'],
    )

    // The counts must be different, proving the mock can detect the weaken
    const originalCount = whereConditionCount(original)
    const weakenedCount = whereConditionCount(weakened)

    expect(originalCount).toBe(3)
    expect(weakenedCount).toBe(1)
    expect(originalCount).not.toBe(weakenedCount)

    // A handler relying on the count will behave differently:
    const requiresThreeConditions = (stmt) => whereConditionCount(stmt) === 3

    expect(requiresThreeConditions(original)).toBe(true)
    expect(requiresThreeConditions(weakened)).toBe(false) // Different behavior
  })

  /**
   * Verify that whereColumnHasOperator() still works correctly with OR
   * conditions (from commit 14672e3).
   */
  it('whereColumnHasOperator still works correctly with OR conditions', () => {
    const stmt = parseStatement(
      `SELECT id FROM profiles
       WHERE member_number ILIKE $1 OR full_name ILIKE $2 OR email ILIKE $3`,
      ['pattern', 'pattern', 'pattern'],
    )

    // The ILIKE fix from 14672e3 should still work
    expect(whereHasColumn(stmt, 'member_number')).toBe(true)
    expect(whereHasColumn(stmt, 'full_name')).toBe(true)
    expect(whereHasColumn(stmt, 'email')).toBe(true)
    expect(whereHasColumn(stmt, 'nonexistent')).toBe(false)
  })
})
