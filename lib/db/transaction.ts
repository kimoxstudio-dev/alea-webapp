import { sql } from './client'

/**
 * Shared atomic-transaction helper for multi-statement raw-SQL writes (#350).
 *
 * Two shapes of hand-rolled `sql.transaction([...])` call kept recurring
 * across N1/N2 raw-SQL service migrations, each getting a subtle detail
 * wrong at least once — caught by code review, not by design:
 *
 * - A plain N-statements-atomically batch, no locking of its own. Only one
 *   real instance of this exists in the codebase today:
 *   `equipment-service.ts`'s `setRoomDefaultEquipment` (DELETE + INSERT, so
 *   a failing INSERT never leaves a room's defaults deleted with nothing
 *   replacing them) — now retrofitted onto `runTransaction` below.
 * - #334 (`club-events-service.ts` / `saved-games-service.ts`): a leading
 *   `pg_advisory_xact_lock(hashtext(id::uuid::text))` statement followed by
 *   a guarded check+write, pinned to `isolationLevel: 'ReadCommitted'`. This
 *   exact shape was hand-written three separate times across two files
 *   (`cancelActiveSavedGamesForRoomBlock`, `createSavedGameForSession`,
 *   `renewSavedGameForSession`). `saved-games-service.ts`'s
 *   `createSavedGameForSession` — the smallest of the three — is retrofitted
 *   onto `runAdvisoryLockedTransaction` below, as the proof this API fits a
 *   real call site; `cancelActiveSavedGamesForRoomBlock` and
 *   `renewSavedGameForSession` are not touched by this change (see retrofit
 *   scope decision below).
 *
 * ## What this does NOT cover
 *
 * `sql.transaction([...])` batches already-invoked `sql` statements in one
 * round trip — it cannot express a later statement that depends on an
 * earlier statement's *result* decided outside the batch (e.g. a
 * compensating DELETE keyed by an id an INSERT just returned). That shape —
 * present in `reservations-service.ts` (the INSERT-then-conditional-DELETE
 * around line 766) — isn't a `sql.transaction()` candidate as written; the
 * fix there would be batching the original reservation + equipment INSERTs
 * into one `runTransaction([...])` up front, so the compensating DELETE
 * is never needed at all. That's a change to `reservations-service.ts`
 * itself and this branch does not make it.
 *
 * ## Retrofit scope decision (#350 acceptance criteria)
 *
 * This helper gets exactly one real call site per shape in this change —
 * enough to prove the API fits code that already works, not a full sweep.
 * It is **not** retrofitted onto the rest of the already-migrated services
 * (#300 reservations, #302 rooms, #305 the rest of equipment-service.ts,
 * #333 tables, #303/#304 events, #301/#306/#307 the rest of
 * saved-games/library-games/partners, #334's other two lock sites, #360).
 * Converting all of those is broad, low-value churn on code that's already
 * correct and reviewed. This helper applies to new multi-statement write
 * work going forward, and to the two call sites above.
 *
 * ## Error handling stays with the caller
 *
 * Neither function catches or wraps errors. Existing call sites each map
 * different Postgres error conditions to different domain errors (exclusion
 * conflicts, `23514` check-constraint violations, `23505` unique
 * violations) — a shared try/catch here would either have to guess at that
 * mapping or lose it. Callers wrap the call in their own try/catch exactly
 * as they do today.
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
 * (`equipment-service.ts`'s `setRoomDefaultEquipment` DELETE + INSERT).
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
 *
 * `T` is constrained to an array type since `results[1]` is always a row
 * array at runtime — a caller passing a single-row type instead of a
 * row-array type is a type error here rather than a silently wrong cast.
 */
export async function runAdvisoryLockedTransaction<T extends unknown[] = unknown[]>(
  lockStatement: SqlStatement,
  guardedStatement: SqlStatement,
): Promise<T> {
  const results = await sql.transaction([lockStatement, guardedStatement], {
    isolationLevel: 'ReadCommitted',
  })
  return results[1] as T
}
