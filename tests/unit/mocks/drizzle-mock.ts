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
 * Create a mock for SELECT...WHERE chain.
 * Returns a function that delegates to selectMock, and also supports .orderBy().
 */
function createSelectWhereMock() {
  const whereFn = vi.fn(() => selectMock())
  whereFn.orderBy = vi.fn(() => selectMock())
  return whereFn
}

/**
 * Create a chainable Drizzle-like query builder mock.
 *
 * Supports the following chains:
 * - `.select().from().where()` → resolves via `selectMock`
 * - `.select().from().orderBy()` → resolves via `selectMock`
 * - `.select().from().innerJoin().where()` → resolves via `selectMock`
 * - `.insert().values().returning()` → resolves via `insertMock`
 * - `.update().set().where().returning()` → resolves via `updateMock`
 * - `.delete().where().returning()` → resolves via `deleteMock`
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
      from: vi.fn(() => {
        const whereChain = createSelectWhereMock()
        return {
          orderBy: createSelectWhereMock(),
          innerJoin: vi.fn(() => ({
            where: createSelectWhereMock(),
          })),
          where: vi.fn(() => {
            // Return an object that has both the thenable behavior and orderBy
            const result = whereChain()
            const chainObj = {
              orderBy: vi.fn(() => result),
              then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected),
              catch: (onRejected) => Promise.resolve(result).catch(onRejected),
            }
            return chainObj
          }),
        }
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => createInsertValuesMock()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => updateMock()),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => createDeleteWhereReturningMock()),
    })),
    // Support db.transaction() wrapper for atomic operations.
    // The callback receives a query builder (tx) with the same chainable structure.
    transaction: vi.fn(async (callback) => callback(createDrizzleQueryBuilder())),
  }
}

// ── Fixture data by table (extensible) ──────────────────────────────────────

/**
 * Per-test fixture overrides and defaults.
 * Each test can call setFixture() to override what a specific table returns,
 * or setDefaultMockResponse() to set a global fallback for insert/update/delete.
 */
const fixtureState = {
  tableFixtures: new Map<string, any[]>(),
  defaultInsertResponse: null as any,
  defaultUpdateResponse: null as any,
  defaultDeleteResponse: null as any,
}

/**
 * Reset all fixtures and defaults before each test.
 * Call this in beforeEach to clear per-test state.
 */
export function resetFixtures() {
  fixtureState.tableFixtures.clear()
  fixtureState.defaultInsertResponse = null
  fixtureState.defaultUpdateResponse = null
  fixtureState.defaultDeleteResponse = null
}

/**
 * Set fixture rows for a specific table.
 * Example: setFixture('events', [{ id: 'evt-1', title: 'Event 1' }])
 */
export function setFixture(tableName: string, rows: any[]) {
  fixtureState.tableFixtures.set(tableName, rows)
}

/**
 * Set default responses for insert/update/delete operations.
 * These are used when a test doesn't explicitly mock a specific operation.
 * Example: setDefaultMockResponse('insert', [{ id: 'new-id' }])
 */
export function setDefaultMockResponse(operation: 'insert' | 'update' | 'delete', response: any[]) {
  if (operation === 'insert') {
    fixtureState.defaultInsertResponse = response
  } else if (operation === 'update') {
    fixtureState.defaultUpdateResponse = response
  } else if (operation === 'delete') {
    fixtureState.defaultDeleteResponse = response
  }
}

/**
 * Built-in fixtures for common tables.
 * These are returned if no test-specific fixture is set.
 */
const builtInFixtures: Record<string, any[]> = {
  events: [
    {
      id: 'evt-default-1',
      title: 'Default Event',
      titleEs: 'Evento Predeterminado',
      titleEn: 'Default Event',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '20:00:00',
      dateKind: 'single',
      endDate: null,
      description: 'A default event',
      descriptionEs: 'Un evento predeterminado',
      descriptionEn: 'A default event',
      createdBy: null,
      createdAt: '2026-04-01T00:00:00Z',
      imageUrl: null,
      linkUrl: null,
      blurbEs: null,
      blurbEn: null,
      recurrenceLabelEs: null,
      recurrenceLabelEn: null,
      categoryEs: null,
      categoryEn: null,
    },
  ],
  event_room_blocks: [
    {
      id: 'erb-default-1',
      eventId: 'evt-default-1',
      roomId: 'room-default-1',
      date: '2026-04-15',
      startTime: '18:00:00',
      endTime: '20:00:00',
      allDay: false,
      tableId: null,
    },
  ],
  tables: [
    {
      id: 'table-default-1',
      roomId: 'room-default-1',
      name: 'Table 1',
      type: 'small',
      qrCode: null,
      posX: 0,
      posY: 0,
      createdAt: '2026-04-01T00:00:00Z',
      qrCodeInf: null,
    },
  ],
  rooms: [
    {
      id: 'room-default-1',
      name: 'Main Room',
      tableCount: 10,
      description: 'Main gaming room',
      createdAt: '2026-04-01T00:00:00Z',
    },
  ],
  equipment: [
    {
      id: 'eq-default-1',
      name: 'Dice Set',
      description: 'Standard dice set',
      createdAt: '2026-04-01T00:00:00Z',
    },
  ],
  library_games: [
    {
      id: 'game-default-1',
      title: 'Sample Game',
      categoryEs: 'Estrategia',
      categoryEn: 'Strategy',
      players: '2-4',
      playTime: '45-60 min',
      weight: 2.5,
      sortOrder: 1,
      active: true,
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T00:00:00Z',
      imgUrl: null,
    },
  ],
}

/**
 * Get fixture for a table, falling back to built-in if no override is set.
 */
function getFixture(tableName: string): any[] {
  if (fixtureState.tableFixtures.has(tableName)) {
    return fixtureState.tableFixtures.get(tableName)!
  }
  return builtInFixtures[tableName] || []
}

/**
 * Create a dispatching SELECT mock that identifies the table being queried
 * and returns the appropriate fixture rows.
 *
 * This mock tracks the current table context as the chain progresses:
 * .select() → remember we're selecting
 * .from(table) → identify WHICH table
 * .where(...) / .orderBy(...) → resolve via the table's fixture
 *
 * The key insight: instead of positional .mockResolvedValueOnce(),
 * we dispatch based on *which* table was queried, making tests resilient
 * to call-order changes.
 */
function createDispatchingSelectMock() {
  let currentTable: string | null = null

  return {
    select: vi.fn(() => ({
      from: vi.fn(function (table: any) {
        // Capture which table is being queried. Handle both string names
        // and Drizzle table objects (check for .name or ._ properties).
        if (typeof table === 'string') {
          currentTable = table
        } else if (table && typeof table === 'object') {
          // Drizzle table object: try ._ first (metadata), fall back to .name
          currentTable = table._.name ?? table.name ?? null
        }

        const fixture = getFixture(currentTable || 'unknown')

        return {
          where: vi.fn(() => Promise.resolve(fixture)),
          orderBy: vi.fn(() => Promise.resolve(fixture)),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(fixture)),
          })),
          // Support direct await without .where()/.orderBy()
          [Symbol.toStringTag]: 'Promise',
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(fixture).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(fixture).catch(onRejected),
        }
      }),
    })),
  }
}

// ── MockServiceError: Error class for mocking serviceError() throws ────────

/**
 * Mock version of ServiceError for use in tests.
 * Replicates the real class so mocked serviceError throws work correctly.
 */
export class MockServiceError extends Error {
  readonly statusCode: number
  readonly name = 'ServiceError'

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

/**
 * Wire up the serviceError mock to throw MockServiceError.
 * Call this in your test file's vi.mock setup:
 *
 * ```typescript
 * vi.mock('@/lib/server/shared/service-error', () => ({
 *   ServiceError: MockServiceError,
 *   serviceError: createMockServiceError(),
 * }))
 * ```
 */
export function createMockServiceError() {
  return (message: string, statusCode: number) => {
    throw new MockServiceError(message, statusCode)
  }
}

// ── Updated factory: integrating dispatching select mock ──────────────────

/**
 * Create an updated Drizzle query builder mock that uses the dispatching
 * select mechanism and supports per-test-overridable insert/update/delete.
 *
 * Usage:
 * ```typescript
 * beforeEach(() => {
 *   resetFixtures()
 *   vi.clearAllMocks()
 * })
 *
 * it('queries events by name', async () => {
 *   setFixture('events', [{ id: 'evt-1', title: 'My Event' }])
 *   const db = createDrizzleQueryBuilder()
 *   const rows = await db.select().from('events').where(...)
 *   expect(rows).toEqual([{ id: 'evt-1', title: 'My Event' }])
 * })
 *
 * it('inserts with custom response', async () => {
 *   setDefaultMockResponse('insert', [{ id: 'new-id', title: 'New' }])
 *   const db = createDrizzleQueryBuilder()
 *   insertMock.mockResolvedValue([{ id: 'new-id', title: 'New' }])
 *   const result = await db.insert(schema.events).values(...).returning()
 *   expect(result[0].id).toBe('new-id')
 * })
 * ```
 */
export function createDrizzleQueryBuilderWithDispatching() {
  const dispatchingSelect = createDispatchingSelectMock()

  return {
    select: vi.fn(() => ({
      from: dispatchingSelect.select().from,
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() =>
          insertMock().then((result) => result || fixtureState.defaultInsertResponse || [])
        ),
        then: (onFulfilled: any, onRejected: any) =>
          insertMock()
            .then((result) => result || fixtureState.defaultInsertResponse || [])
            .then(onFulfilled, onRejected),
        catch: (onRejected: any) =>
          insertMock()
            .then((result) => result || fixtureState.defaultInsertResponse || [])
            .catch(onRejected),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() =>
            updateMock().then((result) => result || fixtureState.defaultUpdateResponse || [])
          ),
          then: (onFulfilled: any, onRejected: any) =>
            updateMock()
              .then((result) => result || fixtureState.defaultUpdateResponse || [])
              .then(onFulfilled, onRejected),
          catch: (onRejected: any) =>
            updateMock()
              .then((result) => result || fixtureState.defaultUpdateResponse || [])
              .catch(onRejected),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() =>
          deleteMock().then((result) => result || fixtureState.defaultDeleteResponse || [])
        ),
        then: (onFulfilled: any, onRejected: any) =>
          deleteMock()
            .then((result) => result || fixtureState.defaultDeleteResponse || [])
            .then(onFulfilled, onRejected),
        catch: (onRejected: any) =>
          deleteMock()
            .then((result) => result || fixtureState.defaultDeleteResponse || [])
            .catch(onRejected),
      })),
    })),
    transaction: vi.fn(async (callback) => callback(createDrizzleQueryBuilderWithDispatching())),
  }
}
