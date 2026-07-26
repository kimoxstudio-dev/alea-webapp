/**
 * Shared Drizzle query builder mock factory and state for service tests
 *
 * This helper provides reusable mock infrastructure for testing Drizzle-based
 * service layers across multiple test files. It handles chainable query builders,
 * transaction wrappers, and common CRUD operations (select, insert, update, delete).
 *
 * ## Why This Exists
 *
 * Unit tests for Drizzle services need to mock the query builder chain:
 * `.select().from().where()`, `.insert().values().returning()`, etc.
 * Without a shared helper, each test file had to hand-wire all these chains locally,
 * creating duplicate mock logic and making it tedious to set up new test files.
 *
 * ## How to Use in a Test File
 *
 * 1. Import the mock state and factory:
 *    ```typescript
 *    import {
 *      createDrizzleQueryBuilder,
 *      selectMock,
 *      insertMock,
 *      updateMock,
 *      deleteMock,
 *      createAdminSession,
 *      createMemberSession,
 *    } from '@/tests/unit/mocks/drizzle-mock'
 *    ```
 *
 * 2. Set up the vi.mock call (must be at the top level of the test file):
 *    ```typescript
 *    vi.mock('@/lib/db', () => ({
 *      getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
 *      getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
 *    }))
 *    ```
 *
 * 3. In beforeEach, reset the mocks:
 *    ```typescript
 *    beforeEach(() => {
 *      vi.resetModules()
 *      vi.clearAllMocks()
 *    })
 *    ```
 *
 * 4. In individual tests, configure the mock responses:
 *    ```typescript
 *    selectMock.mockResolvedValue([{ id: 'row-1', name: 'Example' }])
 *    // or
 *    insertMock.mockResolvedValue([{ id: 'new-row' }])
 *    // or
 *    updateMock.mockResolvedValue([{ id: 'updated-row' }])
 *    // or
 *    deleteMock.mockResolvedValue([{ id: 'deleted-row' }])
 *    ```
 *
 * ## Important Constraint: vi.mock() Must Stay in Each Test File
 *
 * Vitest has a hard constraint: **vi.mock() calls are hoisted to the top of the module
 * they appear in**, and they cannot be imported from a shared helper function. This is
 * a Vitest design constraint (not a bug).
 *
 * Therefore, each test file MUST define its own `vi.mock('@/lib/db', ...)` call at
 * the top level. However, the callback function can reuse the shared `createDrizzleQueryBuilder()`
 * factory defined here.
 *
 * **DO NOT try to:** write a helper function that returns `vi.mock(...)` and then call it
 * from the test file. Vitest will not hoist it correctly and mocks will not be in place when
 * the module under test is imported.
 *
 * See `tables-service.test.ts` and `equipment-service.test.ts` for examples.
 */

import { vi } from 'vitest'

// ── Mock state: global response objects for each query type ─────────────────────
// These are imported by the test file and configured per test in beforeEach/it.
// They back the chainable query builder mocks below.

/**
 * Mock response for SELECT queries.
 * Set with: `selectMock.mockResolvedValue([...rows])`
 */
export const selectMock = vi.fn()

/**
 * Mock response for INSERT queries.
 * Set with: `insertMock.mockResolvedValue([...inserted_rows])`
 */
export const insertMock = vi.fn()

/**
 * Mock response for UPDATE queries.
 * Set with: `updateMock.mockResolvedValue([...updated_rows])`
 */
export const updateMock = vi.fn()

/**
 * Mock response for DELETE queries.
 * Set with: `deleteMock.mockResolvedValue([...deleted_rows])`
 */
export const deleteMock = vi.fn()

/**
 * Captures the arguments passed to every `.where(...)` call across the
 * chainable query builder (select/update/delete), so tests can assert that
 * an authorization/scoping filter (e.g. `eq(partners.active, true)`, the
 * service-layer replacement for a Supabase RLS policy) is actually applied
 * — not just that the resolved rows look right.
 *
 * Usage:
 * ```typescript
 * expect(whereMock).toHaveBeenCalledWith(eq(partners.active, true))
 * ```
 */
export const whereMock = vi.fn()

/**
 * Captures the `.execute(sql\`...\`)` calls for raw SQL queries
 */
export const executeMock = vi.fn()

// ── Session type and factories ──────────────────────────────────────────────────

export type SessionUser = { id: string; role: 'admin' | 'member'; email?: string }

/**
 * Create a default admin session user for tests
 *
 * Usage:
 * ```typescript
 * const adminSession = createAdminSession()
 * const result = await someAdminFunction(adminSession, ...)
 * ```
 */
export function createAdminSession(): SessionUser {
  return { id: 'admin-1', role: 'admin', email: 'admin@example.com' }
}

/**
 * Create a default member session user for tests
 *
 * Usage:
 * ```typescript
 * const memberSession = createMemberSession()
 * const result = await someMemberFunction(memberSession, ...)
 * ```
 */
export function createMemberSession(): SessionUser {
  return { id: 'member-1', role: 'member', email: 'member@example.com' }
}

// ── Drizzle query builder mock factories ────────────────────────────────────────

/**
 * Create a mock for INSERT...VALUES...RETURNING chain.
 * Supports: `.insert().values().returning()` and awaiting directly.
 */
function createInsertValuesMock() {
  return {
    returning: vi.fn(() => insertMock()),
    // Support awaiting on the object itself for cases without .returning()
    then: (onFulfilled: any, onRejected: any) => insertMock().then(onFulfilled, onRejected),
    catch: (onRejected: any) => insertMock().catch(onRejected),
  } as any
}

/**
 * Create a mock for DELETE...WHERE...RETURNING chain.
 * Supports: `.delete().where().returning()` and awaiting directly.
 */
function createDeleteWhereReturningMock() {
  return {
    returning: vi.fn(() => deleteMock()),
    // Support awaiting directly as well
    then: (onFulfilled: any, onRejected: any) => deleteMock().then(onFulfilled, onRejected),
    catch: (onRejected: any) => deleteMock().catch(onRejected),
  } as any
}

/**
 * Create a chainable FROM/JOIN/WHERE/ORDER/LIMIT/OFFSET mock
 * Supports all combinations of chaining methods
 */
function createSelectFromChain() {
  const executeSelect = () => selectMock()

  const limitOffsetChain = {
    offset: vi.fn(() => ({
      then: (onFulfilled: any, onRejected: any) =>
        executeSelect().then(onFulfilled, onRejected),
      catch: (onRejected: any) => executeSelect().catch(onRejected),
    })),
    then: (onFulfilled: any, onRejected: any) =>
      executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  const orderByChain = {
    limit: vi.fn(() => limitOffsetChain),
    then: (onFulfilled: any, onRejected: any) =>
      executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  const whereChain = {
    orderBy: vi.fn(() => orderByChain),
    limit: vi.fn(() => limitOffsetChain),
    then: (onFulfilled: any, onRejected: any) =>
      executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  return {
    // Joins can be chained multiple times
    leftJoin: vi.fn(() => createSelectFromChain()),
    innerJoin: vi.fn(() => createSelectFromChain()),

    // WHERE clause - records filter and returns chainable object
    where: vi.fn((...args) => {
      whereMock(...args)
      return whereChain
    }),

    // Allow queries without WHERE to have direct access to orderBy/limit
    orderBy: vi.fn(() => orderByChain),
    limit: vi.fn(() => limitOffsetChain),

    // Support thenable behavior for direct awaiting (for queries with no WHERE/LIMIT)
    then: (onFulfilled: any, onRejected: any) =>
      executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any
}

/**
 * Create a chainable Drizzle-like query builder mock.
 *
 * Supports the following chains:
 * - `.select().from().where()` → resolves via `selectMock`
 * - `.select().from().where().orderBy().limit().offset()` → resolves via `selectMock`
 * - `.select().from().orderBy()` → resolves via `selectMock`
 * - `.select().from().limit().offset()` → resolves via `selectMock`
 * - `.select().from().leftJoin().leftJoin().where()` → resolves via `selectMock`
 * - `.insert().values().returning()` → resolves via `insertMock`
 * - `.update().set().where().returning()` → resolves via `updateMock`
 * - `.delete().where().returning()` → resolves via `deleteMock`
 * - `.execute(sql\`...\`)` → resolves via `executeMock`
 * - `.transaction(callback)` → calls callback with a new builder instance (for atomic operations)
 *
 * Usage:
 * ```typescript
 * const builder = createDrizzleQueryBuilder()
 * selectMock.mockResolvedValue([{ id: 'row-1' }])
 * const rows = await builder.select().from('table').where()
 * expect(rows).toEqual([{ id: 'row-1' }])
 * ```
 */
export function createDrizzleQueryBuilder() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => createSelectFromChain()),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => createInsertValuesMock()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((...args) => {
          whereMock(...args)
          return { returning: vi.fn(() => updateMock()) }
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((...args) => {
        whereMock(...args)
        return createDeleteWhereReturningMock()
      }),
    })),
    // Support raw SQL execution
    execute: vi.fn((...args) => {
      executeMock(...args)
      return Promise.resolve({ rowCount: 0 })
    }),
    // Support db.transaction() wrapper for atomic operations.
    // The callback receives a query builder (tx) with the same chainable structure.
    transaction: vi.fn(async (callback) => callback(createDrizzleQueryBuilder())),
  }
}
