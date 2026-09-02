import { sql } from './client'

/**
 * Shared atomic-transaction helper for multi-statement raw-SQL writes (#350).
 *
 * Every N1/N2 raw-SQL service that needed to write several related rows
 * atomically hand-rolled its own `sql.transaction([...])` call, and got a
 * subtle detail wrong each time — caught by code review, not by design:
 *
 * - #300 (reservations-service.ts): a compensating DELETE rollback wasn't
 *   wrapped in try/catch, and the array cast was missing `::uuid[]`.
 * - #334 (club-events-service.ts / saved-games-service.ts): the identical
 *   `sql.transaction([lock, checkAndWrite], { isolationLevel: 'ReadCommitted' })`
 *   shape was written out three separate times across two files
 *   (`cancelActiveSavedGamesForRoomBlock`, `createSavedGameForSession`,
 *   `renewSavedGameForSession`), each with its own per-table advisory lock
 *   via `pg_advisory_xact_lock(hashtext(id::uuid::text))`.
 *
 * `runAdvisoryLockedTransaction` below encodes exactly that proven shape —
 * lock statement first, `ReadCommitted` pinned, only the guarded statement's
 * result returned — so isolation level and result-index are no longer
 * something each call site has to get right on its own. `runTransaction`
 * covers the simpler N-statements-atomically case (#300) with no locking of
 * its own.
 *
 * ## Retrofit scope decision (#350 acceptance criteria)
 *
 * This helper is **not** retrofitted onto already-migrated services (#300
 * reservations, #302 rooms, #305 equipment, #333 tables, #303/#304 events,
 * #301/#306/#307 saved-games/library-games/partners, #334, #360). Those call
 * sites are already correct and already reviewed — converting them is broad,
 * low-value churn on working code, not a bug fix. This helper applies to new
 * multi-statement write work going forward.
 *
 * ## Error handling stays with the caller
 *
 * Neither function catches or wraps errors. Existing call sites each map
 * different Postgres error conditions to different domain errors (exclusion
 * conflicts, `23514` check-constraint violations, `23505` unique
 * violations) — a shared try/catch here would either have to guess at that
 * mapping or lose it. Callers wrap the call in their own try/catch exactly
 * as they do today; this helper only removes the parts of the shape that
 * were being copy-pasted (and occasionally copy-pasted wrong).
 */

export type TransactionIsolationLevel =
  | 'ReadUncommitted'
  | 'ReadCommitted'
  | 'RepeatableRead'
  | 'Serializable'

export interface TransactionOptions {
  isolationLevel?: TransactionIsolationLevel
}

/** A single already-invoked tagged-template `sql` call, as batched into `sql.transaction([...])`. */
export type SqlStatement = ReturnType<typeof sql>

/**
 * Runs N already-invoked `sql` statements as one atomic Neon transaction —
 * all succeed together, or the whole batch is reported as failed. Use this
 * for a multi-statement write with no locking/isolation need of its own
 * (the #300 reservations-service shape: an insert plus a compensating
 * cleanup on a later failure).
 *
 * Returns the raw per-statement row arrays, in the same order as
 * `statements` — callers cast each element to the row shape they expect,
 * the same way every existing `sql.transaction()` call site already does.
 */
export async function runTransaction(
  statements: SqlStatement[],
  options?: TransactionOptions,
): Promise<unknown[][]> {
  return sql.transaction(statements, options)
}

/**
 * Runs the advisory-lock-guarded two-statement transaction shape proven in
 * #334: a leading `pg_advisory_xact_lock(hashtext(...))` statement, followed
 * by a guarded check+write, under `ReadCommitted` isolation. Returns only
 * the guarded statement's rows — every existing caller of this pattern only
 * ever reads `results[1]`.
 *
 * `lockStatement` and `guardedStatement` are built by the caller (via the
 * `sql` tagged template) since the lock key and the guarded query body are
 * specific to each call site — this only fixes the two things that were
 * getting duplicated (and occasionally dropped): the `ReadCommitted`
 * isolation level, and always reading the second result.
 */
export async function runAdvisoryLockedTransaction<T = unknown[]>(
  lockStatement: SqlStatement,
  guardedStatement: SqlStatement,
): Promise<T> {
  const results = await sql.transaction([lockStatement, guardedStatement], {
    isolationLevel: 'ReadCommitted',
  })
  return results[1] as T
}
