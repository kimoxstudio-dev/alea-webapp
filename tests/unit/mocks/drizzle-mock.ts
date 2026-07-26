/**
 * Shared Drizzle mock infrastructure for service-layer unit tests.
 *
 * This file exposes TWO independent mock flavours. Pick one per test file —
 * they do not interact.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. STATE-DRIVEN MOCK (`createStatefulDrizzleDb`) — preferred (KIM-443)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An in-memory JS store (a `Map` keyed by table name) that answers every query
 * by *inspecting the builder chain* (table, joins, where-condition, order,
 * limit) and evaluating it against the seeded rows. There is NO reliance on
 * call ordering, so it is correct for services that issue concurrent or
 * interleaved queries (e.g. `importMembersFromCsv`, which runs with
 * `concurrencyLimit = 10`).
 *
 * There is no real database here: no pglite, no embedded/containerised
 * Postgres, no SQL engine, no connection. Conditions built with `eq`, `and`,
 * `or`, `inArray`, `gte`, … are decoded from Drizzle's own `SQL` AST and
 * evaluated against plain JS objects.
 *
 * ### Usage
 *
 * ```typescript
 * import {
 *   createStatefulDrizzleDb,
 *   seed,
 *   resetDb,
 *   getRows,
 * } from '@/tests/unit/mocks/drizzle-mock'
 *
 * // vi.mock() is hoisted, so it must live in the test file itself (see the
 * // note at the bottom of this header) — but the factory can be shared.
 * vi.mock('@/lib/db', () => ({
 *   getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
 *   getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
 * }))
 *
 * beforeEach(() => {
 *   resetDb()
 *   vi.clearAllMocks()
 * })
 *
 * it('returns only the member own reservations', async () => {
 *   seed({
 *     reservations: [
 *       { id: 'r-1', userId: 'member-1', tableId: 't-1', date: '2026-08-01' },
 *       { id: 'r-2', userId: 'member-2', tableId: 't-1', date: '2026-08-01' },
 *     ],
 *     tables: [{ id: 't-1', roomId: 'room-1', name: 'Table 1' }],
 *   })
 *
 *   const result = await listReservationsForSession(createMemberSession())
 *
 *   expect(result).toHaveLength(1)
 *   // writes are visible to later reads in the same test:
 *   expect(getRows('reservations')).toHaveLength(1)
 * })
 * ```
 *
 * ### Public API
 *
 * | Export | Purpose |
 * | --- | --- |
 * | `createStatefulDrizzleDb()` | Returns the `db` object to hand to `vi.mock('@/lib/db')`. |
 * | `seed(data)` | Seed rows for one or more tables. Replaces only the tables named. |
 * | `seedTable(table, rows)` | Same, for a single table (accepts a Drizzle table object). |
 * | `resetDb()` | Clears the store, the query log and any injected failures. |
 * | `getRows(table)` | Snapshot of the current rows of a table (post-write assertions). |
 * | `failNextQuery(spec)` | Make the next matching query reject (error-path tests). |
 * | `getQueryLog()` | Ordered log of executed operations, for coarse assertions. |
 *
 * Table keys are normalised — `'saved_games'`, `'savedGames'` and the Drizzle
 * `savedGames` table object all address the same store entry. Row keys accept
 * either the Drizzle property name (`userId`, what queries return) or the
 * database column name (`user_id`).
 *
 * ### Supported chain surface
 *
 * - `select()` / `select(fields)` / `selectDistinct(fields)` `.from(t)`
 * - `.innerJoin(t, on)` / `.leftJoin(t, on)`, chained any number of times
 * - `.where(cond | undefined)`, `.orderBy(asc(c), desc(c), c)`, `.groupBy(...)`
 * - `.limit(n)`, `.offset(n)`, `.execute()`, or plain `await`
 * - `insert(t).values(row | rows)[.onConflictDoNothing()|.onConflictDoUpdate()][.returning(fields?)]`
 * - `update(t).set(values).where(cond)[.returning(fields?)]`
 * - `delete(t).where(cond)[.returning(fields?)]`
 * - `transaction(cb)` — rolls the store back if `cb` throws
 * - `execute(sql)` — recorded in the query log, delegates to `executeMock`,
 *   and honours `failNextQuery({ op: 'execute' })` like any other operation
 *
 * Conditions: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `and`, `or`, `not`,
 * `inArray`, `notInArray`, `isNull`, `isNotNull`, `between`, `notBetween`,
 * `like`, `notLike`, `ilike`, `notIlike`, and column-to-column comparisons.
 * Aggregates: `count()` / `count(col)`, `sum`, `avg`, `min`, `max`.
 *
 * ### Known limitations (deliberately NOT faked)
 *
 * Anything outside the surface above throws a `[drizzle-mock]` error naming the
 * unsupported construct instead of silently returning wrong rows. In
 * particular: subqueries / CTEs / `EXISTS`, `rightJoin` / `fullJoin`,
 * `.having()`, window functions, and raw `db.execute(sql)` results (that call
 * returns whatever `executeMock` is configured to return — the store is not
 * consulted, because arbitrary SQL cannot be evaluated without a SQL engine).
 * Column-level constraints (`notNull`, unique indexes, FKs) are not enforced.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. LEGACY SEQUENCE-DRIVEN MOCK (`createDrizzleQueryBuilder`) — kept for
 *    backward compatibility
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Resolves every query from the shared `selectMock` / `insertMock` /
 * `updateMock` / `deleteMock` `vi.fn()`s, i.e. by call sequence. Fine for
 * services that issue one query at a time; it cannot express "this table has
 * these rows", so prefer the state-driven mock for anything new.
 *
 * ```typescript
 * vi.mock('@/lib/db', () => ({
 *   getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
 *   getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
 * }))
 *
 * selectMock.mockResolvedValue([{ id: 'row-1', name: 'Example' }])
 * ```
 *
 * ## Important Constraint: vi.mock() Must Stay in Each Test File
 *
 * Vitest hoists `vi.mock()` to the top of the module it appears in, and it
 * cannot be imported from a shared helper function. This is a Vitest design
 * constraint (not a bug). Each test file MUST therefore declare its own
 * `vi.mock('@/lib/db', ...)`; only the factory inside the callback is shared.
 *
 * **DO NOT try to:** write a helper that returns `vi.mock(...)` and call it
 * from the test file — Vitest will not hoist it and the mock will not be in
 * place when the module under test is imported.
 */

import { vi } from 'vitest'
import { Column, Param, SQL, StringChunk, Table, getTableColumns, getTableName, is } from 'drizzle-orm'

// ── Mock state: global response objects for each query type (legacy mock) ───────
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
 *
 * Receives the object passed to `.set(...)` as its first argument, so tests
 * can assert on the update payload:
 * `expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ fullName: 'X' }))`
 */
export const updateMock = vi.fn()

/**
 * Mock response for DELETE queries.
 * Set with: `deleteMock.mockResolvedValue([...deleted_rows])`
 */
export const deleteMock = vi.fn()

/**
 * Records every raw `db.execute(...)` call (e.g. `db.execute(sql\`...\`)`).
 * Set a return value with `executeMock.mockResolvedValue({ rows: [] })`.
 */
export const executeMock = vi.fn()

/**
 * Captures the arguments passed to every `.where(...)` call across both mock
 * flavours, so tests can assert that an authorization/scoping filter (e.g.
 * `eq(partners.active, true)`, the service-layer replacement for a Supabase
 * RLS policy) is actually applied — not just that resolved rows look right.
 *
 * Usage:
 * ```typescript
 * expect(whereMock).toHaveBeenCalledWith(eq(partners.active, true))
 * ```
 */
export const whereMock = vi.fn()

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

// ── MockServiceError: Error class for mocking serviceError() throws ─────────────

/**
 * Mock version of ServiceError for use in tests.
 * Replicates the real class so mocked `serviceError()` throws work correctly.
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
 * Wire up the `serviceError` mock to throw `MockServiceError`.
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

// ═══════════════════════════════════════════════════════════════════════════════
// LEGACY SEQUENCE-DRIVEN MOCK
// ═══════════════════════════════════════════════════════════════════════════════

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
 * Create a chainable FROM/JOIN/WHERE/ORDER/LIMIT/OFFSET mock.
 * Joins can be chained any number of times; every terminal resolves via
 * `selectMock`.
 */
function createLegacySelectFromChain(): any {
  const executeSelect = () => selectMock()

  const limitOffsetChain = {
    offset: vi.fn(() => ({
      then: (onFulfilled: any, onRejected: any) => executeSelect().then(onFulfilled, onRejected),
      catch: (onRejected: any) => executeSelect().catch(onRejected),
    })),
    then: (onFulfilled: any, onRejected: any) => executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  const orderByChain = {
    limit: vi.fn(() => limitOffsetChain),
    offset: vi.fn(() => limitOffsetChain),
    then: (onFulfilled: any, onRejected: any) => executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  const whereChain = {
    orderBy: vi.fn(() => orderByChain),
    limit: vi.fn(() => limitOffsetChain),
    offset: vi.fn(() => limitOffsetChain),
    then: (onFulfilled: any, onRejected: any) => executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any

  return {
    // Joins can be chained multiple times
    leftJoin: vi.fn(() => createLegacySelectFromChain()),
    innerJoin: vi.fn(() => createLegacySelectFromChain()),

    // WHERE clause — records the filter and returns a chainable object
    where: vi.fn((...args: unknown[]) => {
      whereMock(...args)
      return whereChain
    }),

    // Queries without WHERE still reach orderBy/limit/offset
    orderBy: vi.fn(() => orderByChain),
    limit: vi.fn(() => limitOffsetChain),
    offset: vi.fn(() => limitOffsetChain),

    // Direct awaiting (no WHERE/ORDER/LIMIT in the chain)
    then: (onFulfilled: any, onRejected: any) => executeSelect().then(onFulfilled, onRejected),
    catch: (onRejected: any) => executeSelect().catch(onRejected),
  } as any
}

/**
 * Create a chainable Drizzle-like query builder mock (sequence-driven).
 *
 * Supports the following chains:
 * - `.select().from().where()` → resolves via `selectMock`
 * - `.select().from().where().orderBy().limit().offset()` → resolves via `selectMock`
 * - `.select().from().orderBy()` → resolves via `selectMock`
 * - `.select().from().leftJoin().innerJoin().where()` → resolves via `selectMock`
 * - `.insert().values().returning()` → resolves via `insertMock`
 * - `.update().set().where().returning()` → resolves via `updateMock` (also awaitable without `.returning()`)
 * - `.delete().where().returning()` → resolves via `deleteMock`
 * - `.execute(sql\`...\`)` → records into `executeMock`
 * - `.transaction(callback)` → calls callback with a new builder instance
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
      from: vi.fn(() => createLegacySelectFromChain()),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => createInsertValuesMock()),
    })),
    update: vi.fn(() => ({
      set: vi.fn((updates: Record<string, unknown>) => ({
        where: vi.fn((...args: unknown[]) => {
          whereMock(...args)
          // Some callers chain `.returning(...)` (result rows needed); others
          // just `await` the `.where(...)` call directly (fire-and-forget
          // update, e.g. the "update existing member" import path in
          // users-service.ts). Support both by making the returned object both
          // callable via `.returning()` and directly thenable.
          return {
            returning: vi.fn(() => updateMock(updates)),
            then: (onFulfilled: any, onRejected: any) => updateMock(updates).then(onFulfilled, onRejected),
            catch: (onRejected: any) => updateMock(updates).catch(onRejected),
          }
        }),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((...args: unknown[]) => {
        whereMock(...args)
        return createDeleteWhereReturningMock()
      }),
    })),
    // Raw SQL execution
    execute: vi.fn((...args: unknown[]) => {
      executeMock(...args)
      return Promise.resolve({ rowCount: 0 })
    }),
    // Support db.transaction() wrapper for atomic operations.
    // The callback receives a query builder (tx) with the same chainable structure.
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(createDrizzleQueryBuilder())),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE-DRIVEN MOCK
// ═══════════════════════════════════════════════════════════════════════════════

/** A row in the in-memory store — plain JS, keyed by Drizzle property name. */
export type MockRow = Record<string, unknown>

/** Anything that can address a table: the Drizzle table object or its name. */
export type TableRef = Table | string

type JoinKind = 'inner' | 'left'
type QueryOp = 'select' | 'insert' | 'update' | 'delete' | 'execute'

/** One executed operation, in order. See {@link getQueryLog}. */
export type MockQueryLogEntry = {
  op: QueryOp
  /** Normalised table key (lower-case, punctuation stripped), e.g. `savedgames`. */
  table: string
  /** Rows returned (select) or affected (insert/update/delete). */
  rowCount: number
}

function mockError(message: string): Error {
  return new Error(`[drizzle-mock] ${message}`)
}

// ── Store ──────────────────────────────────────────────────────────────────────

const store = new Map<string, MockRow[]>()
const queryLog: MockQueryLogEntry[] = []

type FailureSpec = { op?: QueryOp; table?: string; times: number; error: unknown }
const failures: FailureSpec[] = []

/**
 * Table key used for raw `db.execute(sql\`...\`)` calls, in the query log and
 * when matching injected failures. Raw SQL names no table the mock can parse,
 * so `execute` gets the empty key: op-only and unfiltered failures match it,
 * table-scoped ones deliberately do not.
 */
const EXECUTE_TABLE_KEY = ''

/** Normalise any table reference to a single store key. */
function tableKey(ref: TableRef): string {
  const name = typeof ref === 'string' ? ref : getTableName(ref)
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '')
}

function ensureTable(ref: TableRef): MockRow[] {
  const key = tableKey(ref)
  let rows = store.get(key)
  if (!rows) {
    rows = []
    store.set(key, rows)
  }
  return rows
}

/**
 * Seed rows for one or more tables. Only the tables named are replaced —
 * anything already seeded for other tables is left alone.
 *
 * ```typescript
 * seed({
 *   reservations: [{ id: 'r-1', userId: 'member-1' }],
 *   tables: [{ id: 't-1', roomId: 'room-1' }],
 * })
 * ```
 */
export function seed(data: Record<string, MockRow[]>): void {
  for (const [name, rows] of Object.entries(data)) seedTable(name, rows)
}

/** Seed a single table. Accepts a Drizzle table object or a table name. */
export function seedTable(table: TableRef, rows: MockRow[]): void {
  store.set(
    tableKey(table),
    rows.map((row) => ({ ...row })),
  )
}

/** Clear the store, the query log and any injected failures. Call in `beforeEach`. */
export function resetDb(): void {
  store.clear()
  queryLog.length = 0
  failures.length = 0
}

/** Snapshot of a table's current rows — use it to assert what a write persisted. */
export function getRows(table: TableRef): MockRow[] {
  return (store.get(tableKey(table)) ?? []).map((row) => ({ ...row }))
}

/** Ordered log of every executed operation. Cleared by {@link resetDb}. */
export function getQueryLog(): MockQueryLogEntry[] {
  return queryLog.map((entry) => ({ ...entry }))
}

/**
 * Make the next matching query reject, for error-path tests.
 *
 * ```typescript
 * failNextQuery({ op: 'update', table: profiles })
 * // the service's catch-block path is now exercised
 * ```
 *
 * Applies to every operation in {@link QueryOp}, `execute` included:
 *
 * ```typescript
 * failNextQuery({ op: 'execute' })
 * // the next db.execute(sql`...`) rejects; the one after it resolves normally
 * ```
 *
 * `table` cannot be used together with `op: 'execute'` — a raw-SQL statement
 * names no table the mock can parse, so such a spec could never match. That
 * combination throws here rather than sitting in the queue and never firing.
 */
export function failNextQuery(spec: {
  op?: QueryOp
  table?: TableRef
  times?: number
  error?: unknown
} = {}): void {
  if (spec.op === 'execute' && spec.table !== undefined) {
    throw mockError(
      "failNextQuery({ op: 'execute' }) cannot be scoped by table — raw SQL names no table the mock can " +
        'parse. Drop the `table` field to fail the next execute regardless of the statement.',
    )
  }
  failures.push({
    op: spec.op,
    table: spec.table === undefined ? undefined : tableKey(spec.table),
    times: spec.times ?? 1,
    error: spec.error ?? mockError('injected query failure'),
  })
}

function consumeFailure(op: QueryOp, table: string): void {
  const index = failures.findIndex(
    (failure) =>
      failure.times > 0 &&
      (failure.op === undefined || failure.op === op) &&
      (failure.table === undefined || failure.table === table),
  )
  if (index === -1) return
  const failure = failures[index]
  failure.times -= 1
  if (failure.times <= 0) failures.splice(index, 1)
  throw failure.error instanceof Error ? failure.error : mockError(String(failure.error))
}

function snapshotStore(): Map<string, MockRow[]> {
  const copy = new Map<string, MockRow[]>()
  for (const [key, rows] of store) copy.set(key, rows.map((row) => ({ ...row })))
  return copy
}

function restoreStore(snapshot: Map<string, MockRow[]>): void {
  store.clear()
  for (const [key, rows] of snapshot) store.set(key, rows)
}

// ── Column ↔ row-property resolution ───────────────────────────────────────────

const columnKeyCache = new WeakMap<object, Map<string, string>>()

/** Map a Drizzle column back to the property name its rows use (`user_id` → `userId`). */
function columnPropertyKey(column: Column): string {
  const table = column.table as unknown as object
  let map = columnKeyCache.get(table)
  if (!map) {
    map = new Map<string, string>()
    for (const [prop, col] of Object.entries(getTableColumns(column.table))) {
      map.set((col as Column).name, prop)
    }
    columnKeyCache.set(table, map)
  }
  return map.get(column.name) ?? column.name
}

/** Read a column value out of a row, accepting either naming convention. */
function readColumn(row: MockRow | null | undefined, column: Column): unknown {
  if (row === null || row === undefined) return null
  const prop = columnPropertyKey(column)
  if (prop in row) return row[prop]
  if (column.name in row) return row[column.name]
  return null
}

/** A joined result set: normalised table key → the row contributed by that table. */
type QueryContext = Record<string, MockRow | null>

function resolveColumn(ctx: QueryContext, column: Column): unknown {
  const key = tableKey(column.table)
  if (!(key in ctx)) {
    throw mockError(
      `condition references table "${getTableName(column.table)}", which is not part of this query ` +
        `(available: ${Object.keys(ctx).join(', ') || 'none'})`,
    )
  }
  return readColumn(ctx[key], column)
}

/** Project a row down to the table's declared columns, as a real SELECT would. */
function pickTableColumns(table: Table, row: MockRow | null | undefined): MockRow | null {
  if (row === null || row === undefined) return null
  const out: MockRow = {}
  for (const [prop, col] of Object.entries(getTableColumns(table))) {
    out[prop] = readColumn(row, col as Column)
  }
  return out
}

// ── SQL AST decoding ───────────────────────────────────────────────────────────

type Token =
  | { t: 'text'; v: string }
  | { t: 'col'; v: Column }
  | { t: 'val'; v: unknown }
  | { t: 'list'; v: unknown[] }
  | { t: 'sql'; v: SQL }

function unwrapValue(chunk: unknown): unknown {
  if (is(chunk, Param)) return (chunk as Param).value
  return chunk
}

function tokenize(chunks: readonly unknown[]): Token[] {
  const tokens: Token[] = []
  for (const chunk of chunks) {
    if (is(chunk, StringChunk)) {
      const text = (chunk.value as string[]).join('').trim()
      if (text !== '') tokens.push({ t: 'text', v: text })
    } else if (is(chunk, Column)) {
      tokens.push({ t: 'col', v: chunk })
    } else if (is(chunk, Param)) {
      tokens.push({ t: 'val', v: (chunk as Param).value })
    } else if (is(chunk, SQL.Aliased)) {
      tokens.push({ t: 'sql', v: (chunk as SQL.Aliased).sql })
    } else if (is(chunk, SQL)) {
      tokens.push({ t: 'sql', v: chunk })
    } else if (Array.isArray(chunk)) {
      tokens.push({ t: 'list', v: chunk.map(unwrapValue) })
    } else {
      tokens.push({ t: 'val', v: chunk })
    }
  }
  return tokens
}

/** Best-effort rendering of a SQL node, used only for error messages. */
function renderSql(node: SQL): string {
  return tokenize(node.queryChunks)
    .map((token) => {
      switch (token.t) {
        case 'text':
          return token.v
        case 'col':
          return `${getTableName(token.v.table)}.${token.v.name}`
        case 'sql':
          return `(${renderSql(token.v)})`
        case 'list':
          return `(${token.v.map((v) => JSON.stringify(v)).join(', ')})`
        default:
          return JSON.stringify(token.v)
      }
    })
    .join(' ')
}

// ── Value semantics ────────────────────────────────────────────────────────────

function isNil(value: unknown): boolean {
  return value === null || value === undefined
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'string') {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

function isNumericLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Number(value))
  return false
}

/** SQL `=` semantics, tolerant of the string/number/Date shapes rows carry. */
function looseEquals(left: unknown, right: unknown): boolean {
  if (isNil(left) || isNil(right)) return false
  if (left instanceof Date || right instanceof Date) {
    const a = asTime(left)
    const b = asTime(right)
    return a !== null && b !== null && a === b
  }
  if (typeof left === typeof right) return left === right
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right)
  if (isNumericLike(left) && isNumericLike(right)) return Number(left) === Number(right)
  return left === right
}

/** Returns -1/0/1, or `null` when the comparison is unknown (SQL NULL). */
function compareValues(left: unknown, right: unknown): number | null {
  if (isNil(left) || isNil(right)) return null
  if (left instanceof Date || right instanceof Date) {
    const a = asTime(left)
    const b = asTime(right)
    if (a === null || b === null) return null
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (isNumericLike(left) && isNumericLike(right)) {
    const a = Number(left)
    const b = Number(right)
    return a === b ? 0 : a < b ? -1 : 1
  }
  const a = String(left)
  const b = String(right)
  return a === b ? 0 : a < b ? -1 : 1
}

function likeToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\' && index + 1 < pattern.length) {
      source += pattern[index + 1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      index += 1
    } else if (char === '%') {
      source += '.*'
    } else if (char === '_') {
      source += '.'
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'is' : 's')
}

// ── Condition evaluation ───────────────────────────────────────────────────────

/** Evaluate a Drizzle `where`/`on` condition against one joined result row. */
function evaluateCondition(condition: unknown, ctx: QueryContext): boolean {
  if (condition === undefined || condition === null) return true
  if (typeof condition === 'boolean') return condition
  if (is(condition, SQL.Aliased)) return evaluateCondition((condition as SQL.Aliased).sql, ctx)
  if (is(condition, SQL)) return evaluateTokens(tokenize(condition.queryChunks), ctx, condition)
  throw mockError(`unsupported condition of type ${typeof condition}`)
}

function stripOuterParens(tokens: Token[]): Token[] {
  let current = tokens
  while (
    current.length >= 2 &&
    current[0].t === 'text' &&
    current[0].v === '(' &&
    current[current.length - 1].t === 'text' &&
    current[current.length - 1].v === ')'
  ) {
    current = current.slice(1, -1)
  }
  return current
}

function splitOnConnective(tokens: Token[], word: 'and' | 'or'): Token[][] | null {
  const parts: Token[][] = []
  let current: Token[] = []
  let found = false
  for (const token of tokens) {
    if (token.t === 'text' && token.v.toLowerCase() === word) {
      found = true
      parts.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  if (!found) return null
  parts.push(current)
  return parts
}

function evaluateTokens(rawTokens: Token[], ctx: QueryContext, source: SQL): boolean {
  const tokens = stripOuterParens(rawTokens)

  if (tokens.length === 0) return true

  if (tokens.length === 1) {
    const only = tokens[0]
    if (only.t === 'sql') return evaluateTokens(tokenize(only.v.queryChunks), ctx, only.v)
    if (only.t === 'text') {
      const literal = only.v.toLowerCase()
      if (literal === 'true') return true
      if (literal === 'false') return false
    }
    if (only.t === 'col') return Boolean(resolveColumn(ctx, only.v))
    if (only.t === 'val') return Boolean(only.v)
  }

  // `between` embeds an " and " that is NOT a boolean connective — handle first.
  const betweenIndex = tokens.findIndex(
    (token) => token.t === 'text' && /^(not )?between$/.test(token.v.toLowerCase()),
  )
  if (betweenIndex > 0) {
    const negated = (tokens[betweenIndex] as { v: string }).v.toLowerCase().startsWith('not')
    const subject = evaluateOperand(tokens.slice(0, betweenIndex), ctx)
    const rest = tokens.slice(betweenIndex + 1)
    const andIndex = rest.findIndex((token) => token.t === 'text' && token.v.toLowerCase() === 'and')
    if (andIndex === -1) throw mockError(`malformed BETWEEN in: ${renderSql(source)}`)
    const lower = evaluateOperand(rest.slice(0, andIndex), ctx)
    const upper = evaluateOperand(rest.slice(andIndex + 1), ctx)
    const low = compareValues(subject, lower)
    const high = compareValues(subject, upper)
    if (low === null || high === null) return false
    const inRange = low >= 0 && high <= 0
    return negated ? !inRange : inRange
  }

  // `or` binds looser than `and`.
  const orParts = splitOnConnective(tokens, 'or')
  if (orParts) return orParts.some((part) => evaluateTokens(part, ctx, source))

  const andParts = splitOnConnective(tokens, 'and')
  if (andParts) return andParts.every((part) => evaluateTokens(part, ctx, source))

  if (tokens[0].t === 'text' && tokens[0].v.toLowerCase() === 'not') {
    return !evaluateTokens(tokens.slice(1), ctx, source)
  }

  return evaluateComparison(tokens, ctx, source)
}

function evaluateComparison(tokens: Token[], ctx: QueryContext, source: SQL): boolean {
  const operatorIndex = tokens.findIndex((token) => token.t === 'text')
  if (operatorIndex <= 0) throw mockError(`unsupported condition: ${renderSql(source)}`)

  const operator = (tokens[operatorIndex] as { v: string }).v.toLowerCase()
  const left = evaluateOperand(tokens.slice(0, operatorIndex), ctx)
  const rightTokens = tokens.slice(operatorIndex + 1)

  switch (operator) {
    case 'is null':
      return isNil(left)
    case 'is not null':
      return !isNil(left)
    case 'is true':
      return left === true
    case 'is false':
      return left === false
    default:
      break
  }

  const right = evaluateOperand(rightTokens, ctx)

  switch (operator) {
    case '=':
      return looseEquals(left, right)
    case '<>':
    case '!=':
      return !isNil(left) && !isNil(right) && !looseEquals(left, right)
    case '>':
    case '>=':
    case '<':
    case '<=': {
      const order = compareValues(left, right)
      if (order === null) return false
      if (operator === '>') return order > 0
      if (operator === '>=') return order >= 0
      if (operator === '<') return order < 0
      return order <= 0
    }
    case 'in':
    case 'not in': {
      const list = Array.isArray(right) ? right : [right]
      const contained = list.some((candidate) => looseEquals(left, candidate))
      return operator === 'in' ? contained : !isNil(left) && !contained
    }
    case 'like':
    case 'not like':
    case 'ilike':
    case 'not ilike': {
      if (isNil(left) || isNil(right)) return false
      const matched = likeToRegExp(String(right), operator.includes('ilike')).test(String(left))
      return operator.startsWith('not') ? !matched : matched
    }
    default:
      throw mockError(`unsupported SQL operator "${operator}" in: ${renderSql(source)}`)
  }
}

function evaluateOperand(tokens: Token[], ctx: QueryContext): unknown {
  const stripped = stripOuterParens(tokens)
  if (stripped.length !== 1) {
    if (stripped.length === 0) return null
    throw mockError(`unsupported compound operand with ${stripped.length} parts`)
  }
  const token = stripped[0]
  switch (token.t) {
    case 'col':
      return resolveColumn(ctx, token.v)
    case 'val':
      return token.v
    case 'list':
      return token.v
    case 'sql':
      return evaluateScalar(token.v, ctx)
    default:
      throw mockError(`unsupported operand "${token.v}"`)
  }
}

/** Evaluate a non-aggregate scalar expression (projection field, `.set()` value). */
function evaluateScalar(node: SQL, ctx: QueryContext): unknown {
  const tokens = stripOuterParens(tokenize(node.queryChunks))

  if (tokens.length === 1) {
    const only = tokens[0]
    if (only.t === 'col') return resolveColumn(ctx, only.v)
    if (only.t === 'val') return only.v
    if (only.t === 'sql') return evaluateScalar(only.v, ctx)
    if (only.t === 'text') {
      const literal = only.v.toLowerCase()
      if (literal === 'null') return null
      if (literal === 'true') return true
      if (literal === 'false') return false
      if (literal === 'now()' || literal === 'current_timestamp') return new Date()
      if (literal === 'gen_random_uuid()' || literal === 'uuid_generate_v4()') return randomUuid()
    }
  }

  // Single-argument functions: `lower(x)`, `upper(x)`, `trim(x)`.
  if (tokens.length === 3 && tokens[0].t === 'text' && tokens[2].t === 'text' && tokens[2].v === ')') {
    const fn = tokens[0].v.toLowerCase()
    const argument = evaluateOperand([tokens[1]], ctx)
    if (fn === 'lower(') return isNil(argument) ? null : String(argument).toLowerCase()
    if (fn === 'upper(') return isNil(argument) ? null : String(argument).toUpperCase()
    if (fn === 'trim(') return isNil(argument) ? null : String(argument).trim()
  }

  // Binary arithmetic / concatenation.
  if (tokens.length === 3 && tokens[1].t === 'text') {
    const operator = tokens[1].v
    const left = evaluateOperand([tokens[0]], ctx)
    const right = evaluateOperand([tokens[2]], ctx)
    if (operator === '||') return `${left ?? ''}${right ?? ''}`
    if (['+', '-', '*', '/'].includes(operator)) {
      if (isNil(left) || isNil(right)) return null
      const a = Number(left)
      const b = Number(right)
      if (operator === '+') return a + b
      if (operator === '-') return a - b
      if (operator === '*') return a * b
      return b === 0 ? null : a / b
    }
  }

  throw mockError(
    `unsupported SQL expression: ${renderSql(node)}. ` +
      'Extend tests/unit/mocks/drizzle-mock.ts rather than working around it.',
  )
}

// ── Aggregates ─────────────────────────────────────────────────────────────────

type AggregateSpec = { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; column: Column | null }

function detectAggregate(value: unknown): AggregateSpec | null {
  const node = is(value, SQL.Aliased) ? (value as SQL.Aliased).sql : value
  if (!is(node, SQL)) return null
  const tokens = tokenize((node as SQL).queryChunks)
  if (tokens.length === 0 || tokens[0].t !== 'text') return null
  const match = /^(count|sum|avg|min|max)\($/i.exec(tokens[0].v)
  if (!match) return null
  const argument = tokens[1]
  const column = argument !== undefined && argument.t === 'col' ? argument.v : null
  return { fn: match[1].toLowerCase() as AggregateSpec['fn'], column }
}

function computeAggregate(spec: AggregateSpec, group: QueryContext[]): unknown {
  if (spec.fn === 'count') {
    if (spec.column === null) return group.length
    return group.filter((ctx) => !isNil(resolveColumn(ctx, spec.column as Column))).length
  }
  const values = group
    .map((ctx) => (spec.column === null ? null : resolveColumn(ctx, spec.column)))
    .filter((value) => !isNil(value))
  if (values.length === 0) return null
  if (spec.fn === 'min') return values.reduce((a, b) => ((compareValues(b, a) ?? 0) < 0 ? b : a))
  if (spec.fn === 'max') return values.reduce((a, b) => ((compareValues(b, a) ?? 0) > 0 ? b : a))
  const numbers = values.map((value) => Number(value))
  const total = numbers.reduce((a, b) => a + b, 0)
  return spec.fn === 'sum' ? total : total / numbers.length
}

// ── Projection ─────────────────────────────────────────────────────────────────

type FieldMap = Record<string, unknown>

function projectFields(fields: FieldMap, ctx: QueryContext): MockRow {
  const out: MockRow = {}
  for (const [key, value] of Object.entries(fields)) {
    if (is(value, Column)) out[key] = resolveColumn(ctx, value)
    else if (is(value, SQL.Aliased)) out[key] = evaluateScalar((value as SQL.Aliased).sql, ctx)
    else if (is(value, SQL)) out[key] = evaluateScalar(value, ctx)
    else if (is(value, Table)) out[key] = pickTableColumns(value, ctx[tableKey(value)])
    else if (value !== null && typeof value === 'object') out[key] = projectFields(value as FieldMap, ctx)
    else out[key] = value
  }
  return out
}

// ── Defaults for INSERT ────────────────────────────────────────────────────────

function randomUuid(): string {
  const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID()
  return `mock-${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`
}

function columnDefault(column: Column): unknown {
  const meta = column as unknown as { defaultFn?: () => unknown; hasDefault?: boolean; default?: unknown }
  if (typeof meta.defaultFn === 'function') return meta.defaultFn()
  if (!meta.hasDefault) return null
  const value = meta.default
  if (is(value, SQL)) {
    try {
      return evaluateScalar(value as SQL, {})
    } catch {
      return null
    }
  }
  return value ?? null
}

/** Build a stored row from `.values()` input: map keys, then fill schema defaults. */
function materializeInsertRow(table: Table, values: MockRow): MockRow {
  const row: MockRow = {}
  const columns = Object.entries(getTableColumns(table)) as Array<[string, Column]>
  const consumed = new Set<string>()

  for (const [prop, column] of columns) {
    let raw: unknown
    if (prop in values) {
      raw = values[prop]
      consumed.add(prop)
    } else if (column.name in values) {
      raw = values[column.name]
      consumed.add(column.name)
    } else {
      row[prop] = columnDefault(column)
      continue
    }
    row[prop] = is(raw, SQL) ? evaluateScalar(raw as SQL, {}) : raw
  }

  // Keep any extra keys the caller passed (e.g. a column not in the schema yet)
  // so tests that assert on them do not silently lose data.
  for (const [key, value] of Object.entries(values)) {
    if (!consumed.has(key) && !(key in row)) row[key] = value
  }
  return row
}

function applyUpdateValues(table: Table, row: MockRow, values: MockRow): void {
  const columns = getTableColumns(table) as Record<string, Column>
  const byColumnName = new Map<string, string>()
  for (const [prop, column] of Object.entries(columns)) byColumnName.set(column.name, prop)

  for (const [key, value] of Object.entries(values)) {
    const prop = key in columns ? key : (byColumnName.get(key) ?? key)
    const ctx: QueryContext = { [tableKey(table)]: row }
    row[prop] = is(value, SQL) ? evaluateScalar(value as SQL, ctx) : value
  }
}

// ── Builders ───────────────────────────────────────────────────────────────────

type JoinSpec = { table: Table; on: unknown; kind: JoinKind }
type OrderSpec = { column: Column; direction: 'asc' | 'desc' }

function parseOrderBy(expression: unknown): OrderSpec {
  if (is(expression, Column)) return { column: expression, direction: 'asc' }
  const node = is(expression, SQL.Aliased) ? (expression as SQL.Aliased).sql : expression
  if (!is(node, SQL)) throw mockError('unsupported orderBy expression')
  const tokens = tokenize((node as SQL).queryChunks)
  const columnToken = tokens.find((token) => token.t === 'col')
  if (!columnToken || columnToken.t !== 'col') {
    throw mockError(`unsupported orderBy expression: ${renderSql(node as SQL)}`)
  }
  const descending = tokens.some((token) => token.t === 'text' && token.v.toLowerCase().includes('desc'))
  return { column: columnToken.v, direction: descending ? 'desc' : 'asc' }
}

class MockSelectBuilder {
  private fields: FieldMap | undefined
  private distinct: boolean
  private table: Table | null = null
  private joins: JoinSpec[] = []
  private condition: unknown = undefined
  private orders: OrderSpec[] = []
  private groups: Column[] = []
  private limitValue: number | undefined
  private offsetValue: number | undefined

  constructor(fields: FieldMap | undefined, distinct: boolean) {
    this.fields = fields
    this.distinct = distinct
  }

  from(table: Table): this {
    this.table = table
    return this
  }

  innerJoin(table: Table, on: unknown): this {
    this.joins.push({ table, on, kind: 'inner' })
    return this
  }

  leftJoin(table: Table, on: unknown): this {
    this.joins.push({ table, on, kind: 'left' })
    return this
  }

  rightJoin(): never {
    throw mockError('rightJoin() is not supported — use leftJoin() with the tables swapped')
  }

  fullJoin(): never {
    throw mockError('fullJoin() is not supported')
  }

  where(condition: unknown): this {
    whereMock(condition)
    this.condition = condition
    return this
  }

  orderBy(...expressions: unknown[]): this {
    this.orders = expressions.filter((expression) => expression !== undefined).map(parseOrderBy)
    return this
  }

  groupBy(...columns: unknown[]): this {
    this.groups = columns.map((column) => {
      if (is(column, Column)) return column
      throw mockError('groupBy() only supports plain columns')
    })
    return this
  }

  having(): never {
    throw mockError('having() is not supported')
  }

  limit(value: number): this {
    this.limitValue = value
    return this
  }

  offset(value: number): this {
    this.offsetValue = value
    return this
  }

  execute(): Promise<MockRow[]> {
    return this.run()
  }

  then<TResult1 = MockRow[], TResult2 = never>(
    onFulfilled?: ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected)
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<MockRow[] | TResult> {
    return this.run().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<MockRow[]> {
    return this.run().finally(onFinally)
  }

  private async run(): Promise<MockRow[]> {
    if (this.table === null) throw mockError('select() was awaited without .from(table)')
    const baseKey = tableKey(this.table)
    consumeFailure('select', baseKey)

    let contexts: QueryContext[] = ensureTable(this.table).map((row) => ({ [baseKey]: row }))

    for (const join of this.joins) {
      const joinKey = tableKey(join.table)
      const joinRows = ensureTable(join.table)
      const next: QueryContext[] = []
      for (const ctx of contexts) {
        let matched = false
        for (const joinRow of joinRows) {
          const candidate: QueryContext = { ...ctx, [joinKey]: joinRow }
          if (evaluateCondition(join.on, candidate)) {
            next.push(candidate)
            matched = true
          }
        }
        if (!matched && join.kind === 'left') next.push({ ...ctx, [joinKey]: null })
      }
      contexts = next
    }

    if (this.condition !== undefined) {
      contexts = contexts.filter((ctx) => evaluateCondition(this.condition, ctx))
    }

    const rows = this.hasAggregate() ? this.projectAggregated(contexts) : this.projectRows(contexts)
    queryLog.push({ op: 'select', table: baseKey, rowCount: rows.length })
    return rows
  }

  private hasAggregate(): boolean {
    if (this.fields === undefined) return false
    return Object.values(this.fields).some((value) => detectAggregate(value) !== null)
  }

  private projectAggregated(contexts: QueryContext[]): MockRow[] {
    const fields = this.fields as FieldMap
    const groups: QueryContext[][] =
      this.groups.length === 0
        ? [contexts]
        : Array.from(
            contexts
              .reduce((map, ctx) => {
                const key = JSON.stringify(this.groups.map((column) => resolveColumn(ctx, column)))
                const bucket = map.get(key)
                if (bucket) bucket.push(ctx)
                else map.set(key, [ctx])
                return map
              }, new Map<string, QueryContext[]>())
              .values(),
          )

    return groups.map((group) => {
      const out: MockRow = {}
      for (const [key, value] of Object.entries(fields)) {
        const aggregate = detectAggregate(value)
        if (aggregate) {
          out[key] = computeAggregate(aggregate, group)
        } else if (is(value, Column)) {
          out[key] = group.length > 0 ? resolveColumn(group[0], value) : null
        } else {
          out[key] = group.length > 0 ? projectFields({ value }, group[0]).value : null
        }
      }
      return out
    })
  }

  private projectRows(contexts: QueryContext[]): MockRow[] {
    let ordered = contexts
    if (this.orders.length > 0) {
      ordered = [...contexts].sort((left, right) => {
        for (const order of this.orders) {
          const a = resolveColumn(left, order.column)
          const b = resolveColumn(right, order.column)
          if (isNil(a) && isNil(b)) continue
          if (isNil(a)) return 1
          if (isNil(b)) return -1
          const result = compareValues(a, b) ?? 0
          if (result !== 0) return order.direction === 'desc' ? -result : result
        }
        return 0
      })
    }

    const start = this.offsetValue ?? 0
    const end = this.limitValue === undefined ? undefined : start + this.limitValue
    const page = ordered.slice(start, end)

    const projected = page.map((ctx) => this.projectOne(ctx))
    if (!this.distinct) return projected

    const seen = new Set<string>()
    return projected.filter((row) => {
      const key = JSON.stringify(row)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private projectOne(ctx: QueryContext): MockRow {
    const table = this.table as Table
    if (this.fields !== undefined) return projectFields(this.fields, ctx)
    if (this.joins.length === 0) return pickTableColumns(table, ctx[tableKey(table)]) ?? {}
    const out: MockRow = {}
    out[String(getTableName(table))] = pickTableColumns(table, ctx[tableKey(table)])
    for (const join of this.joins) {
      out[String(getTableName(join.table))] = pickTableColumns(join.table, ctx[tableKey(join.table)])
    }
    return out
  }
}

type ConflictTarget = { columns: Column[]; set?: MockRow; action: 'nothing' | 'update' } | null

class MockInsertBuilder {
  private table: Table
  private rows: MockRow[] = []
  private conflict: ConflictTarget = null
  private returningFields: FieldMap | undefined
  private wantsReturning = false

  constructor(table: Table) {
    this.table = table
  }

  values(input: MockRow | MockRow[]): this {
    this.rows = Array.isArray(input) ? input : [input]
    return this
  }

  onConflictDoNothing(config?: { target?: Column | Column[] }): this {
    this.conflict = { columns: normalizeTarget(config?.target), action: 'nothing' }
    return this
  }

  onConflictDoUpdate(config: { target?: Column | Column[]; set: MockRow }): this {
    this.conflict = { columns: normalizeTarget(config.target), set: config.set, action: 'update' }
    return this
  }

  returning(fields?: FieldMap): this {
    this.wantsReturning = true
    this.returningFields = fields
    return this
  }

  execute(): Promise<MockRow[]> {
    return this.run()
  }

  then<TResult1 = MockRow[], TResult2 = never>(
    onFulfilled?: ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected)
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<MockRow[] | TResult> {
    return this.run().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<MockRow[]> {
    return this.run().finally(onFinally)
  }

  private async run(): Promise<MockRow[]> {
    const key = tableKey(this.table)
    consumeFailure('insert', key)
    const stored = ensureTable(this.table)
    const touched: MockRow[] = []

    for (const input of this.rows) {
      const candidate = materializeInsertRow(this.table, input)
      const existing =
        this.conflict !== null && this.conflict.columns.length > 0
          ? stored.find((row) =>
              (this.conflict as { columns: Column[] }).columns.every((column) =>
                looseEquals(readColumn(row, column), readColumn(candidate, column)),
              ),
            )
          : undefined

      if (existing !== undefined && this.conflict !== null) {
        // An existing row matched the conflict target: this is an UPDATE, not
        // an INSERT. Deciding it here (against the store, at execution time)
        // is what keeps interleaved create/update flows correct.
        if (this.conflict.action === 'update' && this.conflict.set) {
          applyUpdateValues(this.table, existing, this.conflict.set)
          touched.push(existing)
        }
        continue
      }

      stored.push(candidate)
      touched.push(candidate)
    }

    queryLog.push({ op: 'insert', table: key, rowCount: touched.length })
    if (!this.wantsReturning) return []
    return touched.map((row) => this.project(row))
  }

  private project(row: MockRow): MockRow {
    const ctx: QueryContext = { [tableKey(this.table)]: row }
    if (this.returningFields !== undefined) return projectFields(this.returningFields, ctx)
    return pickTableColumns(this.table, row) ?? {}
  }
}

function normalizeTarget(target: Column | Column[] | undefined): Column[] {
  if (target === undefined) return []
  return Array.isArray(target) ? target : [target]
}

class MockUpdateBuilder {
  private table: Table
  private values: MockRow
  private condition: unknown = undefined
  private returningFields: FieldMap | undefined
  private wantsReturning = false

  constructor(table: Table, values: MockRow) {
    this.table = table
    this.values = values
  }

  where(condition: unknown): this {
    whereMock(condition)
    this.condition = condition
    return this
  }

  returning(fields?: FieldMap): this {
    this.wantsReturning = true
    this.returningFields = fields
    return this
  }

  execute(): Promise<MockRow[]> {
    return this.run()
  }

  then<TResult1 = MockRow[], TResult2 = never>(
    onFulfilled?: ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected)
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<MockRow[] | TResult> {
    return this.run().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<MockRow[]> {
    return this.run().finally(onFinally)
  }

  private async run(): Promise<MockRow[]> {
    const key = tableKey(this.table)
    consumeFailure('update', key)
    const stored = ensureTable(this.table)
    // An UPDATE only ever touches rows that already exist — it never creates
    // one, even if the where-clause matches nothing.
    const matched = stored.filter((row) => evaluateCondition(this.condition, { [key]: row }))
    for (const row of matched) applyUpdateValues(this.table, row, this.values)

    queryLog.push({ op: 'update', table: key, rowCount: matched.length })
    if (!this.wantsReturning) return []
    return matched.map((row) => {
      const ctx: QueryContext = { [key]: row }
      if (this.returningFields !== undefined) return projectFields(this.returningFields, ctx)
      return pickTableColumns(this.table, row) ?? {}
    })
  }
}

class MockDeleteBuilder {
  private table: Table
  private condition: unknown = undefined
  private returningFields: FieldMap | undefined
  private wantsReturning = false

  constructor(table: Table) {
    this.table = table
  }

  where(condition: unknown): this {
    whereMock(condition)
    this.condition = condition
    return this
  }

  returning(fields?: FieldMap): this {
    this.wantsReturning = true
    this.returningFields = fields
    return this
  }

  execute(): Promise<MockRow[]> {
    return this.run()
  }

  then<TResult1 = MockRow[], TResult2 = never>(
    onFulfilled?: ((value: MockRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onFulfilled, onRejected)
  }

  catch<TResult = never>(
    onRejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<MockRow[] | TResult> {
    return this.run().catch(onRejected)
  }

  finally(onFinally?: (() => void) | null): Promise<MockRow[]> {
    return this.run().finally(onFinally)
  }

  private async run(): Promise<MockRow[]> {
    const key = tableKey(this.table)
    consumeFailure('delete', key)
    const stored = ensureTable(this.table)
    const removed: MockRow[] = []
    for (let index = stored.length - 1; index >= 0; index -= 1) {
      if (evaluateCondition(this.condition, { [key]: stored[index] })) {
        removed.unshift(stored[index])
        stored.splice(index, 1)
      }
    }

    queryLog.push({ op: 'delete', table: key, rowCount: removed.length })
    if (!this.wantsReturning) return []
    return removed.map((row) => {
      const ctx: QueryContext = { [key]: row }
      if (this.returningFields !== undefined) return projectFields(this.returningFields, ctx)
      return pickTableColumns(this.table, row) ?? {}
    })
  }
}

/** The mock `db` object handed to `vi.mock('@/lib/db')`. */
export type StatefulDrizzleDb = ReturnType<typeof createStatefulDrizzleDb>

/**
 * Create a state-driven Drizzle db mock backed by the shared in-memory store.
 *
 * Every call returns an independent builder that captures its own table,
 * values and conditions and resolves them against the store *at await time* —
 * so interleaved and concurrent queries cannot steal each other's results, and
 * a write is visible to any read that happens after it.
 */
export function createStatefulDrizzleDb() {
  return {
    select: vi.fn((fields?: FieldMap) => new MockSelectBuilder(fields, false)),
    selectDistinct: vi.fn((fields?: FieldMap) => new MockSelectBuilder(fields, true)),
    insert: vi.fn((table: Table) => new MockInsertBuilder(table)),
    update: vi.fn((table: Table) => ({
      set: vi.fn((values: MockRow) => new MockUpdateBuilder(table, values)),
    })),
    delete: vi.fn((table: Table) => new MockDeleteBuilder(table)),
    /**
     * Raw SQL passthrough. The store is never consulted (arbitrary SQL cannot be
     * evaluated without a SQL engine), so the result comes from `executeMock`,
     * defaulting to `{ rows: [], rowCount: 0 }`.
     *
     * Failure injection applies here exactly as it does to the other operations:
     * `failNextQuery({ op: 'execute' })` — or an unfiltered `failNextQuery()` —
     * makes the next call reject *before* `executeMock` is reached, and the
     * rejected call is left out of the query log.
     *
     * A raw-SQL statement names no table the mock can parse, so `execute` is
     * matched against {@link EXECUTE_TABLE_KEY} (the empty key) rather than a
     * real one: a table-scoped failure such as `failNextQuery({ table: rooms })`
     * deliberately does not fire on `execute`. The one combination that could
     * never fire — an explicit `{ op: 'execute', table }` — is rejected up front
     * by {@link failNextQuery} rather than silently ignored.
     */
    execute: vi.fn(async (...args: unknown[]) => {
      consumeFailure('execute', EXECUTE_TABLE_KEY)
      queryLog.push({ op: 'execute', table: EXECUTE_TABLE_KEY, rowCount: 0 })
      const result = executeMock(...args)
      return result ?? { rows: [], rowCount: 0 }
    }),
    /**
     * Runs `callback` against the same store. If it throws, every write made
     * inside is rolled back before the error propagates.
     */
    transaction: vi.fn(async <T>(callback: (tx: StatefulDrizzleDb) => Promise<T> | T): Promise<T> => {
      const snapshot = snapshotStore()
      try {
        return await callback(createStatefulDrizzleDb())
      } catch (error) {
        restoreStore(snapshot)
        throw error
      }
    }),
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
  // Per-table INSERT...RETURNING overrides (KIM-434 3/5). Unlike select,
  // which always dispatches by table, insert historically resolved via a
  // single shared `insertMock()` regardless of which table was targeted —
  // fine for single-table scenarios, but wrong once a test needs two
  // different tables inserted into within the same transaction (e.g.
  // `events` returning one row, `event_room_blocks` returning N rows).
  // `setInsertFixture(table, rows)` lets a test configure that per table;
  // `insertMock` remains the fallback for tables with no fixture set, so
  // existing single-table tests keep working unmodified.
  insertFixtures: new Map<string, any[]>(),
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
  fixtureState.insertFixtures.clear()
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
 * Set the rows returned by `db.insert(<table>).values(...).returning()` for
 * a SPECIFIC table, dispatching the same way `setFixture`/select does.
 *
 * Use this when a test needs different insert results for different tables
 * within the same transaction (e.g. inserting into `events` returns one row,
 * inserting into `event_room_blocks` returns N rows). Takes precedence over
 * `insertMock` / `setDefaultMockResponse('insert', ...)` for the table it's
 * set on; other tables continue to resolve via `insertMock` as before.
 *
 * Example: setInsertFixture('event_room_blocks', [blockRow1, blockRow2])
 */
export function setInsertFixture(tableName: string, rows: any[]) {
  fixtureState.insertFixtures.set(tableName, rows)
}

/**
 * Extract a Drizzle table's name from either a plain string or a Drizzle
 * table object (which stores its name under a `Symbol(drizzle:Name)` key).
 * Shared by every dispatching mock (select/insert) below so table-name
 * resolution stays consistent in one place.
 */
function extractTableName(table: any): string | null {
  if (typeof table === 'string') return table
  if (table && typeof table === 'object') {
    const symbols = Object.getOwnPropertySymbols(table)
    const drizzleNameSymbol = symbols.find((s) => s.toString() === 'Symbol(drizzle:Name)')
    if (drizzleNameSymbol && table[drizzleNameSymbol]) {
      return table[drizzleNameSymbol]
    }
    return table?._?.name ?? table?.name ?? table?.dbName ?? null
  }
  return null
}

/**
 * Create a dispatching mock for `db.insert(<table>).values(...).returning()`
 * (and direct-await without `.returning()`).
 *
 * Dispatch order per table:
 * 1. A per-table fixture set via `setInsertFixture(table, rows)` — used as-is.
 * 2. Otherwise, falls back to the shared `insertMock()` (+ default insert
 *    response), preserving existing single-table test behavior.
 */
function createDispatchingInsertMock() {
  return vi.fn((table: any) => {
    const tableName = extractTableName(table)
    const resolve = () => {
      if (tableName && fixtureState.insertFixtures.has(tableName)) {
        return Promise.resolve(fixtureState.insertFixtures.get(tableName))
      }
      return insertMock().then((result: any) => result || fixtureState.defaultInsertResponse || [])
    }

    return {
      values: vi.fn(() => ({
        returning: vi.fn(() => resolve()),
        then: (onFulfilled: any, onRejected: any) => resolve().then(onFulfilled, onRejected),
        catch: (onRejected: any) => resolve().catch(onRejected),
      })),
    }
  })
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
      weight: '2.5',
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
          // Drizzle table objects use Symbol keys for metadata
          // The table name is stored in Symbol(drizzle:Name)
          let extracted = undefined
          
          // Try to find the Drizzle Name symbol
          const symbols = Object.getOwnPropertySymbols(table)
          const drizzleNameSymbol = symbols.find(s => s.toString() === 'Symbol(drizzle:Name)')
          if (drizzleNameSymbol && table[drizzleNameSymbol]) {
            extracted = table[drizzleNameSymbol]
          }
          
          // Fallback to other patterns if symbol-based extraction didn't work
          if (!extracted) {
            extracted = table?._?.name ?? table?.name ?? table?.dbName
          }
          
          currentTable = extracted ?? null
        }

        const fixture = getFixture(currentTable || 'unknown')

        // Create a chainable where that returns an object with orderBy support
        const createChainableWhereResult = () => ({
          orderBy: vi.fn(() => Promise.resolve(fixture)),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(fixture).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(fixture).catch(onRejected),
        })

        return {
          where: vi.fn(() => createChainableWhereResult()),
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
    insert: createDispatchingInsertMock(),
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

// ── Fixture state inspection (for tests to verify state after operations) ────

/**
 * Get the current fixture state for a specific table.
 * Useful for tests to verify that transaction rollback discarded writes.
 */
export function getFixtureState(tableName: string): any[] {
  if (fixtureState.tableFixtures.has(tableName)) {
    return fixtureState.tableFixtures.get(tableName)!
  }
  return builtInFixtures[tableName] || []
}

// ── Transaction-aware mock support ────────────────────────────────────────

/**
 * TransactionScope maintains an isolated copy of the fixture state for a single
 * transaction's lifetime.
 */
class TransactionScope {
  private scopedFixtures: Map<string, any[]>

  constructor(currentFixtures: Map<string, any[]>) {
    this.scopedFixtures = new Map(
      Array.from(currentFixtures.entries()).map(([tableName, rows]) => [
        tableName,
        rows.map((row) => ({ ...row })),
      ]),
    )
  }

  getFixture(tableName: string): any[] {
    if (this.scopedFixtures.has(tableName)) {
      return this.scopedFixtures.get(tableName)!
    }
    return builtInFixtures[tableName] || []
  }

  setFixture(tableName: string, rows: any[]) {
    this.scopedFixtures.set(tableName, rows.map((row) => ({ ...row })))
  }

  mergeIntoGlobal() {
    for (const [tableName, rows] of this.scopedFixtures) {
      fixtureState.tableFixtures.set(tableName, rows.map((row) => ({ ...row })))
    }
  }
}

/**
 * Create a dispatching select mock that calls selectMock if it's been mocked,
 * otherwise falls back to fixture data.
 */
function createDispatchingSelectMockWithSelectMockFallback() {
  let currentTable: string | null = null

  return {
    select: vi.fn(() => ({
      from: vi.fn(function (table: any) {
        if (typeof table === 'string') {
          currentTable = table
        } else if (table && typeof table === 'object') {
          const symbols = Object.getOwnPropertySymbols(table)
          const drizzleNameSymbol = symbols.find(s => s.toString() === 'Symbol(drizzle:Name)')
          if (drizzleNameSymbol && table[drizzleNameSymbol]) {
            currentTable = table[drizzleNameSymbol]
          } else {
            currentTable = table?._?.name ?? table?.name ?? table?.dbName ?? null
          }
        }

        const fixture = getFixture(currentTable || 'unknown')

        // Call selectMock to check if it's been mocked; use its result if defined
        const selectMockResult = selectMock()
        const resolvedResult = selectMockResult !== undefined ? selectMockResult : fixture

        const createChainableWhereResult = () => ({
          orderBy: vi.fn(() => Promise.resolve(resolvedResult)),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolvedResult).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(resolvedResult).catch(onRejected),
        })

        return {
          where: vi.fn(() => createChainableWhereResult()),
          orderBy: vi.fn(() => Promise.resolve(resolvedResult)),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(resolvedResult)),
          })),
          [Symbol.toStringTag]: 'Promise',
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolvedResult).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(resolvedResult).catch(onRejected),
        }
      }),
    })),
  }
}

function createTransactionScopedBuilder(scope: TransactionScope) {
  let currentTable: string | null = null

  const selectBuilder = {
    select: vi.fn(() => ({
      from: vi.fn(function (table: any) {
        if (typeof table === 'string') {
          currentTable = table
        } else if (table && typeof table === 'object') {
          const symbols = Object.getOwnPropertySymbols(table)
          const drizzleNameSymbol = symbols.find(s => s.toString() === 'Symbol(drizzle:Name)')
          if (drizzleNameSymbol && table[drizzleNameSymbol]) {
            currentTable = table[drizzleNameSymbol]
          } else {
            currentTable = table?._?.name ?? table?.name ?? table?.dbName ?? null
          }
        }

        const fixture = scope.getFixture(currentTable || 'unknown')
        const selectMockResult = selectMock()
        const resolvedResult = selectMockResult !== undefined ? selectMockResult : fixture

        const createChainableWhereResult = () => ({
          orderBy: vi.fn(() => Promise.resolve(resolvedResult)),
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolvedResult).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(resolvedResult).catch(onRejected),
        })

        return {
          where: vi.fn(() => createChainableWhereResult()),
          orderBy: vi.fn(() => Promise.resolve(resolvedResult)),
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => Promise.resolve(resolvedResult)),
          })),
          [Symbol.toStringTag]: 'Promise',
          then: (onFulfilled: any, onRejected: any) =>
            Promise.resolve(resolvedResult).then(onFulfilled, onRejected),
          catch: (onRejected: any) => Promise.resolve(resolvedResult).catch(onRejected),
        }
      }),
    })),
  }

  return {
    select: vi.fn(() => ({
      from: selectBuilder.select().from,
    })),
    insert: createDispatchingInsertMock(),
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
    transaction: vi.fn(async (callback) => callback(createTransactionScopedBuilder(scope))),
  }
}

/**
 * Create a transaction-aware Drizzle query builder mock.
 *
 * Maintains isolated state inside transactions: on success, writes are merged
 * into global state; on failure, scoped state is discarded (simulating rollback).
 */
export function createTransactionAwareMockBuilder() {
  const dispatchingSelect = createDispatchingSelectMockWithSelectMockFallback()

  return {
    select: vi.fn(() => ({
      from: dispatchingSelect.select().from,
    })),
    insert: createDispatchingInsertMock(),
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
    transaction: (callback) => {
      const scope = new TransactionScope(fixtureState.tableFixtures)
      const scopedBuilder = createTransactionScopedBuilder(scope)
      
      return Promise.resolve().then(() => callback(scopedBuilder)).then(
        (result) => {
          scope.mergeIntoGlobal()
          return result
        },
        (error) => {
          throw error
        }
      )
    },
  }
}
