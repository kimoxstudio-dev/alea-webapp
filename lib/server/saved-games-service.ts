/**
 * Saved-games service — raw SQL (Neon) migration (#301)
 *
 * RLS no longer exists — this project uses a plain Postgres connection via
 * `sql` (lib/db/client.ts), not Supabase. Member isolation is enforced at
 * the application layer via:
 *   - explicit `user_id = session.id` filters on member-scoped reads
 *     (see the non-admin branch of `listSavedGamesForSession` below)
 *   - `assertMemberRowsScoped()` as a defense-in-depth check on top of that
 *     filter, verifying the invariant independent of the query itself
 *   - explicit ownership checks (`current.user_id !== session.id`) before
 *     mutations such as renew
 * Cross-user operations (attendance recording, table/event conflict checks)
 * legitimately need to span users and therefore run unscoped queries.
 */
import type { SavedGame, SavedGameStatus } from '@/lib/types'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { SessionUser } from '@/lib/server/auth'
import { getCurrentClubDate, isValidDateOnlyString } from '@/lib/club-time'
import { serviceError } from '@/lib/server/service-error'
import { assertMemberRowsScoped } from '@/lib/server/data-scoping'
import { blockAppliesToTable } from '@/lib/server/availability'
import { sql } from '@/lib/db/client'
import { runAdvisoryLockedTransaction } from '@/lib/db/transaction'
import { NeonDbError } from '@neondatabase/serverless'
import type { Tables } from '@/lib/supabase/types'

type SavedGameRow = Tables<'saved_games'>
type SavedGameJoinedRow = SavedGameRow & {
  table_name: string | null
  room_name: string | null
}
// renewSavedGameForSession's lock-guarded insert always returns exactly one
// row (see its `(SELECT 1) AS one LEFT JOIN ins` shape) — `id`/etc. are null
// when the `ins` CTE's guard skipped the insert, and `was_inactive` says
// whether that was because the source row lost 'active' status under the
// lock rather than an event-block conflict.
type SavedGameRenewResultRow = Partial<SavedGameJoinedRow> & { was_inactive: boolean }

// `::text` casts on start_date/end_date are load-bearing: without them the
// Neon driver parses the `date` column (OID 1082) into a JS `Date` object,
// not a string, and mapSavedGame's addDays(row.end_date, -14) throws when it
// calls .split('-') on that shape (same failure mode documented in
// reservation-no-show.ts's markExpiredReservationsAsNoShow).
const SAVED_GAME_COLUMNS = 'id, table_id, user_id, start_date::text AS start_date, end_date::text AS end_date, status, attendance_count, renewed_from_id, created_at, updated_at'
// Same shape as SAVED_GAME_COLUMNS plus the table/room join used by
// `listSavedGamesForSession` — used to select back out of the `ins` CTE in
// create/renew so the response includes real roomName/tableName instead of
// nulls (RETURNING alone has no access to joined tables).
const SAVED_GAME_JOINED_COLUMNS = 'sg.id, sg.table_id, sg.user_id, sg.start_date::text AS start_date, sg.end_date::text AS end_date, sg.status, sg.attendance_count, sg.renewed_from_id, sg.created_at, sg.updated_at, t.name AS table_name, rooms.name AS room_name'

function parseDate(value: unknown, field: string) {
  const date = String(value ?? '')
  if (!isValidDateOnlyString(date)) serviceError(`${field} must be a valid date`, 400)
  return date
}

function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function addMonthsClamped(date: string, months: number) {
  const [year, month, day] = date.split('-').map(Number)
  const targetMonth = month - 1 + months
  const targetYear = year + Math.floor(targetMonth / 12)
  const normalizedMonth = ((targetMonth % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay))).toISOString().slice(0, 10)
}

function getMaxEndDate(startDate: string) {
  return addDays(addMonthsClamped(startDate, 3), -1)
}

function mapSavedGame(row: SavedGameJoinedRow, today = getCurrentClubDate()): SavedGame {
  const renewalOpensOn = addDays(row.end_date, -14)
  const status = row.status === 'active' && row.end_date < today ? 'completed' : row.status
  return {
    id: row.id,
    tableId: row.table_id,
    userId: row.user_id,
    startDate: row.start_date,
    endDate: row.end_date,
    status: status as SavedGameStatus,
    attendanceCount: row.attendance_count,
    renewedFromId: row.renewed_from_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    roomName: row.room_name ?? null,
    tableName: row.table_name ?? null,
    renewalOpensOn,
    canRenew: status === 'active' && today >= renewalOpensOn && today <= row.end_date,
  }
}

function isExclusionConflict(error: unknown) {
  return (
    error instanceof NeonDbError &&
    error.code === '23P01' &&
    (error.constraint == null || error.constraint === 'saved_games_no_active_overlap')
  )
}

function isRenewedFromConflict(error: unknown) {
  return (
    error instanceof NeonDbError &&
    error.code === '23505' &&
    (error.constraint == null || error.constraint === 'saved_games_renewed_from_id_key')
  )
}

function isAttendanceConflict(error: unknown) {
  return (
    error instanceof NeonDbError &&
    error.code === '23505' &&
    (error.constraint == null || error.constraint === 'saved_game_attendances_play_reservation_id_key')
  )
}

async function assertTableAndEventAvailability(tableId: string, startDate: string, endDate: string) {
  // Table and event-block lookups span all users/rooms; no member isolation
  // needed — these are global availability checks.
  let tableRows: Array<{ id: string; room_id: string; type: string }>
  try {
    tableRows = await sql`
      SELECT id, room_id, type
      FROM tables
      WHERE id = ${tableId}
      LIMIT 1
    ` as Array<{ id: string; room_id: string; type: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const table = tableRows[0]
  if (!table) serviceError('Table not found', 404)
  if (table.type !== 'removable_top') serviceError(ERROR_CODES.SAVED_GAME_REQUIRES_REMOVABLE_TOP, 400)

  let blocks: Array<{ id: string; table_id: string | null }>
  try {
    blocks = await sql`
      SELECT id, table_id
      FROM event_room_blocks
      WHERE room_id = ${table.room_id}
        AND date >= ${startDate}
        AND date <= ${endDate}
    ` as Array<{ id: string; table_id: string | null }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const hasConflict = blocks.some((block) => blockAppliesToTable(block, tableId))
  if (hasConflict) serviceError(ERROR_CODES.SAVED_GAME_EVENT_CONFLICT, 409)
}

async function assertNoBottomReservationConflict(tableId: string, startDate: string, endDate: string) {
  // Reverse direction of `hasSavedGameBottomConflict` in reservations-service.ts:
  // the pre-migration `validate_saved_game()` DB trigger also blocked creating a
  // saved game that overlaps an active/pending bottom reservation on the same
  // table. That trigger is intentionally out of scope for the Neon schema (see
  // lib/db/schema/014_saved_games.sql) and must be replicated at the app layer.
  let rows: Array<{ id: string }>
  try {
    rows = await sql`
      SELECT id
      FROM reservations
      WHERE table_id = ${tableId}
        AND status IN ('pending', 'active')
        AND (surface IS NULL OR surface = 'bottom')
        AND date >= ${startDate}
        AND date <= ${endDate}
      LIMIT 1
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  if (rows.length > 0) serviceError(ERROR_CODES.SAVED_GAME_BOTTOM_RESERVATION_CONFLICT, 409)
}

function validateDateRange(startDate: string, endDate: string) {
  const today = getCurrentClubDate()
  if (startDate < today) serviceError(ERROR_CODES.SAVED_GAME_START_IN_PAST, 400)
  if (endDate < startDate) serviceError(ERROR_CODES.SAVED_GAME_INVALID_RANGE, 400)
  if (endDate > getMaxEndDate(startDate)) serviceError(ERROR_CODES.SAVED_GAME_MAX_DURATION, 400)
}

export async function listSavedGamesForSession(session: SessionUser): Promise<SavedGame[]> {
  // Member isolation is enforced by the `user_id = session.id` filter below
  // (non-admin path). Admins intentionally receive all rows.
  const today = getCurrentClubDate()
  const isAdmin = session.role === 'admin'

  let rows: SavedGameJoinedRow[]
  try {
    rows = await sql`
      SELECT ${sql.unsafe(SAVED_GAME_JOINED_COLUMNS)}
      FROM saved_games sg
      LEFT JOIN tables t ON t.id = sg.table_id
      LEFT JOIN rooms ON rooms.id = t.room_id
      WHERE (${isAdmin} OR sg.user_id = ${session.id})
      ORDER BY sg.start_date ASC
    ` as SavedGameJoinedRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  // Defense-in-depth: verify the query filter held before mapping rows out.
  const rawRows = assertMemberRowsScoped(rows, session)

  return rawRows.map((row) => mapSavedGame(row, today))
}

export async function createSavedGameForSession(
  session: SessionUser,
  body: { tableId?: unknown; startDate?: unknown; endDate?: unknown },
): Promise<SavedGame> {
  const tableId = String(body.tableId ?? '')
  if (!tableId) serviceError('tableId is required', 400)
  const startDate = parseDate(body.startDate, 'startDate')
  const endDate = parseDate(body.endDate, 'endDate')
  validateDateRange(startDate, endDate)
  await assertTableAndEventAvailability(tableId, startDate, endDate)
  await assertNoBottomReservationConflict(tableId, startDate, endDate)

  // Member isolation is enforced by writing `user_id: session.id` explicitly
  // into the insert — the authenticated user can only create rows for
  // themselves.
  //
  // #334 code-review finding: `assertTableAndEventAvailability` above and
  // this insert are two separate Neon HTTP round trips (no shared session or
  // transaction between them), so an event-block cancellation
  // (`cancelActiveSavedGamesForRoomBlock` below) can run in between and this
  // insert would still land as 'active' even though the table is now
  // blocked. Both sides take the same per-table `pg_advisory_xact_lock`
  // (keyed by `hashtext(table_id::uuid::text)`, matching
  // `cancelActiveSavedGamesForRoomBlock`) as the first statement of a
  // `sql.transaction()`, before touching `event_room_blocks`/`saved_games`.
  // The `::uuid::text` cast canonicalizes `tableId` before hashing
  // (code-review finding) — it's client-supplied here, so a non-canonical
  // spelling Postgres would still accept (uppercase, brace-wrapped) must
  // still hash to the same lock key the other side derives from a
  // DB-read-back (always-canonical) id, or the two sides silently stop
  // coordinating. The lock statement blocks until any concurrent holder
  // commits and releases it; per Neon's `sql.transaction()` (a real
  // non-interactive Postgres transaction, pinned to `ReadCommitted` so this
  // guarantee can't silently change if the client's default ever does), the
  // second statement then gets its own fresh READ COMMITTED snapshot, so the
  // event-block re-check below always sees any concurrent cancellation that
  // won the lock race. The precheck above stays as a fast-fail for the
  // common non-racing case (clear 409 without attempting a write); this
  // re-check is the actual concurrency guard. Same treatment applies to
  // `renewSavedGameForSession` below — see its own comment.
  // #350: this is the shared `runAdvisoryLockedTransaction` helper's proving
  // call site — it encodes exactly this lock-then-guarded-write shape (see
  // lib/db/transaction.ts), so `renewSavedGameForSession` and
  // `cancelActiveSavedGamesForRoomBlock` below still build their own
  // `sql.transaction([...], { isolationLevel: 'ReadCommitted' })` calls
  // directly rather than being retrofitted in this same change.
  let rows: SavedGameJoinedRow[]
  try {
    rows = await runAdvisoryLockedTransaction<SavedGameJoinedRow[]>(
      sql`SELECT pg_advisory_xact_lock(hashtext(${tableId}::uuid::text))`,
      sql`
        WITH input AS (
          SELECT ${tableId}::uuid AS table_id, ${session.id}::uuid AS user_id, ${startDate}::date AS start_date, ${endDate}::date AS end_date
        ),
        conflict AS (
          SELECT 1
          FROM event_room_blocks b
          JOIN tables t ON t.room_id = b.room_id
          CROSS JOIN input
          WHERE t.id = input.table_id
            AND b.date >= input.start_date
            AND b.date <= input.end_date
            -- Mirrors blockAppliesToTable() in lib/server/availability.ts — keep in sync
            AND (b.table_id IS NULL OR b.table_id = input.table_id)
          LIMIT 1
        ),
        ins AS (
          INSERT INTO saved_games (table_id, user_id, start_date, end_date)
          SELECT table_id, user_id, start_date, end_date FROM input
          WHERE NOT EXISTS (SELECT 1 FROM conflict)
          RETURNING *
        )
        SELECT ${sql.unsafe(SAVED_GAME_JOINED_COLUMNS)}
        FROM ins sg
        LEFT JOIN tables t ON t.id = sg.table_id
        LEFT JOIN rooms ON rooms.id = t.room_id
      `,
    )
  } catch (error) {
    if (isExclusionConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    if (error instanceof NeonDbError && error.code === '23514') {
      // Defense-in-depth: these checks are also validated at the app layer
      // (validateDateRange) before the insert runs, so a violation here
      // normally indicates a race or a caller bypassing that validation.
      // Map to the matching normalized code by constraint name instead of
      // leaking the raw Postgres error.message to the client.
      if (error.constraint === 'saved_games_max_duration') serviceError(ERROR_CODES.SAVED_GAME_MAX_DURATION, 400)
      if (error.constraint === 'saved_games_valid_dates') serviceError(ERROR_CODES.SAVED_GAME_INVALID_RANGE, 400)
      serviceError('Internal server error', 500)
    }
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  // `ins`'s WHERE NOT EXISTS guard skips the insert (yielding no row) only
  // when the re-check under the advisory lock found a conflicting event
  // block that the precheck above missed due to a race — surface the same
  // error `assertTableAndEventAvailability` would have thrown.
  if (!data) serviceError(ERROR_CODES.SAVED_GAME_EVENT_CONFLICT, 409)
  return mapSavedGame(data)
}

export async function renewSavedGameForSession(session: SessionUser, id: string): Promise<SavedGame> {
  // Member isolation is enforced by the ownership check below
  // (`current.user_id !== session.id`) which throws 403 before any mutation
  // occurs for non-admin users.
  let currentRows: SavedGameRow[]
  try {
    currentRows = await sql`
      SELECT ${sql.unsafe(SAVED_GAME_COLUMNS)}
      FROM saved_games
      WHERE id = ${id}
      LIMIT 1
    ` as SavedGameRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const current = currentRows[0]
  if (!current) serviceError('Saved Game not found', 404)
  if (session.role !== 'admin' && current.user_id !== session.id) serviceError('Forbidden', 403)
  if (current.status !== 'active') serviceError(ERROR_CODES.SAVED_GAME_NOT_ACTIVE, 409)

  const today = getCurrentClubDate()
  const renewalOpensOn = addDays(current.end_date, -14)
  if (today < renewalOpensOn || today > current.end_date) serviceError(ERROR_CODES.SAVED_GAME_RENEWAL_NOT_OPEN, 409)

  const startDate = addDays(current.end_date, 1)
  const endDate = getMaxEndDate(startDate)
  await assertTableAndEventAvailability(current.table_id, startDate, endDate)
  await assertNoBottomReservationConflict(current.table_id, startDate, endDate)

  // #334 code-review finding: this had the identical unlocked
  // precheck-then-insert race as `createSavedGameForSession` (see its doc
  // comment above) — an event-block cancellation can land between the
  // precheck above and this insert, and since renew always inserts a NEW
  // row, `cancelActiveSavedGamesForRoomBlock`'s already-executed UPDATE
  // can't retroactively catch it either. Same fix: lock + re-check under the
  // lock, in the same statement as the insert. `current.table_id` is read
  // back from the DB just above, so it's already canonical and the
  // `::uuid::text` cast below is a no-op for correctness — kept anyway so
  // all three lock sites in this file stay textually identical rather than
  // relying on the reader noticing which ones can skip it.
  //
  // Second #334 code-review finding: `current.status` above is read BEFORE
  // this lock is acquired, and is never rechecked inside the transaction. If
  // `cancelActiveSavedGamesForRoomBlock` wins the lock race and cancels this
  // exact row in between, the CTE below still saw `current` as active and
  // would insert the renewal anyway. `current_check` re-reads the source
  // row's live status under the lock and the `ins` guard requires it to
  // still be `'active'`, so a row that got cancelled mid-request blocks its
  // own renewal.
  let rows: SavedGameRenewResultRow[]
  try {
    const results = await sql.transaction(
      [
        sql`SELECT pg_advisory_xact_lock(hashtext(${current.table_id}::uuid::text))`,
        sql`
          WITH input AS (
            SELECT ${current.table_id}::uuid AS table_id, ${current.user_id}::uuid AS user_id, ${startDate}::date AS start_date, ${endDate}::date AS end_date, ${current.id}::uuid AS renewed_from_id
          ),
          conflict AS (
            SELECT 1
            FROM event_room_blocks b
            JOIN tables t ON t.room_id = b.room_id
            CROSS JOIN input
            WHERE t.id = input.table_id
              AND b.date >= input.start_date
              AND b.date <= input.end_date
              -- Mirrors blockAppliesToTable() in lib/server/availability.ts — keep in sync
              AND (b.table_id IS NULL OR b.table_id = input.table_id)
            LIMIT 1
          ),
          current_check AS (
            SELECT 1
            FROM saved_games sg
            CROSS JOIN input
            WHERE sg.id = input.renewed_from_id AND sg.status = 'active'
          ),
          ins AS (
            INSERT INTO saved_games (table_id, user_id, start_date, end_date, renewed_from_id)
            SELECT table_id, user_id, start_date, end_date, renewed_from_id FROM input
            WHERE NOT EXISTS (SELECT 1 FROM conflict) AND EXISTS (SELECT 1 FROM current_check)
            RETURNING *
          )
          SELECT ${sql.unsafe(SAVED_GAME_JOINED_COLUMNS)},
            (SELECT NOT EXISTS (SELECT 1 FROM current_check)) AS was_inactive
          FROM (SELECT 1) AS one
          LEFT JOIN ins sg ON true
          LEFT JOIN tables t ON t.id = sg.table_id
          LEFT JOIN rooms ON rooms.id = t.room_id
        `,
      ],
      { isolationLevel: 'ReadCommitted' },
    )
    rows = results[1] as SavedGameRenewResultRow[]
  } catch (error) {
    if (isRenewedFromConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_ALREADY_RENEWED, 409)
    if (isExclusionConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  // The `one`/`LEFT JOIN ins` shape above always returns exactly one row from
  // Postgres, so `data.id == null` (rather than `!data`) is what signals the
  // `ins` guard skipped the insert. `was_inactive` (computed from the same
  // `current_check` CTE the guard used, under the same lock) distinguishes
  // *why*: the source row lost its 'active' status to a concurrent
  // cancellation (`cancelActiveSavedGamesForRoomBlock`), vs. an event block
  // landing on the new period. No follow-up query needed — both facts come
  // back from the one locked transaction. The optional chaining below is
  // still real belt-and-braces against a malformed/empty mock or driver
  // response, not a sign the "always one row" guarantee is in doubt.
  if (data?.id == null) {
    if (data?.was_inactive) serviceError(ERROR_CODES.SAVED_GAME_NOT_ACTIVE, 409)
    serviceError(ERROR_CODES.SAVED_GAME_EVENT_CONFLICT, 409)
  }
  return mapSavedGame(data as SavedGameJoinedRow, today)
}

export async function recordSavedGameAttendance(playReservation: Tables<'reservations'>): Promise<void> {
  if (playReservation.surface !== 'top' || playReservation.status !== 'active') return

  // Called from a system/cron context (not a user request) and intentionally
  // reads across all users to match a reservation to its saved game. No
  // per-user scoping is appropriate here.
  let savedGameRows: Array<{ id: string }>
  try {
    savedGameRows = await sql`
      SELECT id
      FROM saved_games
      WHERE table_id = ${playReservation.table_id}
        AND user_id = ${playReservation.user_id}
        AND status = 'active'
        AND start_date <= ${playReservation.date}
        AND end_date >= ${playReservation.date}
      LIMIT 1
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const savedGame = savedGameRows[0]
  if (!savedGame) return

  try {
    await sql`
      WITH ins AS (
        INSERT INTO saved_game_attendances (saved_game_id, play_reservation_id, attended_on)
        VALUES (${savedGame.id}, ${playReservation.id}, ${playReservation.date})
        RETURNING saved_game_id
      )
      UPDATE saved_games
      SET attendance_count = attendance_count + 1, updated_at = now()
      WHERE id = (SELECT saved_game_id FROM ins)
    `
  } catch (error) {
    if (isAttendanceConflict(error)) return
    serviceError('Internal server error', 500)
  }
}

/**
 * #334 — port of the legacy `cancel_saved_games_for_event_block()` trigger
 * function, with two deliberate departures from the original SQL (both
 * code-review findings, fixed after the initial port):
 *   - Fires per newly-written `event_room_blocks` row (`NEW`), matched here
 *     to a single inserted block (`tableIds`/`date` = that row's scope and
 *     date).
 *   - Cancels `saved_games` rows whose `table_id` is in `tableIds` — the
 *     caller passes the SAME scoped table-id list it already computed
 *     for the reservation cancellation right above this call site
 *     (table-scoped when the block's own `table_id` is set, room-wide only
 *     when it's null). The legacy trigger always cancelled room-wide,
 *     ignoring the block's own `table_id`, because it predates OIR-208's
 *     per-table `event_room_blocks` scoping; that room-wide-always behavior
 *     was a bug relative to `assertTableAndEventAvailability` above (which
 *     only rejects new games on the specifically blocked table), not a
 *     semantic worth preserving, so this port does not carry it forward.
 *   - Only rows with `status = 'active'` are eligible.
 *   - Overlap condition: `date BETWEEN saved.start_date AND saved.end_date`
 *     (inclusive on both ends), where `date` is the block's date — not a
 *     start/end-time overlap, since saved_games are whole-day date ranges.
 * The original function also took an advisory xact lock per table in the
 * room before the UPDATE, guarding concurrent saved-game inserts/renewals
 * inside the same DB transaction. This port now has an equivalent (see the
 * race-condition paragraph below) instead of omitting it.
 *
 * Captures each cancelled row's id AND its pre-cancellation `updated_at`
 * (via `UPDATE ... FROM (subquery) ... RETURNING`, same reservation-capturing
 * pattern used in `events-service.ts`'s `restoreCancelledReservations`) so a
 * later failure in the same call can restore it exactly — including the
 * timestamp, not just the status (code-review finding: the original restore
 * flipped `status` back but left `updated_at` at the cancellation-time
 * value, so a rolled-back event mutation still left the saved game's public
 * `updatedAt` changed). Every cancelled row's pre-cancellation status was
 * always `'active'` (the trigger's own WHERE clause), so no status needs
 * capturing, only the timestamp.
 *
 * Takes the room's already-resolved table ids (`tableIds`) rather than
 * re-joining `tables` by `room_id` itself (code-review finding, high-effort
 * pass) — every caller already batches every room's table ids into a
 * room->table-ids map up front specifically to avoid a redundant per-block
 * `tables` lookup (the #304/#354 code-review optimization); joining inline
 * here would reintroduce exactly that redundant lookup, once per block.
 *
 * Race with `createSavedGameForSession` above (code-review finding):
 * removing the legacy trigger's advisory lock left a check-then-insert race —
 * that function's event-block precheck and its insert are two separate Neon
 * HTTP round trips, so this UPDATE could run between them and the new saved
 * game would stay `'active'` even though it should have been blocked. Both
 * sides now take the same per-table `pg_advisory_xact_lock` (keyed by
 * `hashtext(table_id)`) as the first statement of a `sql.transaction()`,
 * before touching `saved_games` — the lock statement blocks until any
 * concurrent holder commits and releases it, and (per Neon's
 * `sql.transaction()`, a real non-interactive Postgres transaction) each
 * statement after it gets its own fresh READ COMMITTED snapshot, so the
 * second statement here always runs after any concurrent
 * `createSavedGameForSession` insert has either committed or is blocked
 * behind this same lock.
 *
 * Called from two places: `club-events-service.ts`'s
 * `applyClubEventBlocksAndMaterials` (the create/update path) and
 * `events-service.ts`'s `deleteEventCascade` (#375 — the delete path used to
 * cancel overlapping reservations but not overlapping saved games). Lives
 * here rather than in either of those files because it's pure `saved_games`
 * mutation logic that has to stay lock-compatible with
 * `createSavedGameForSession`/`renewSavedGameForSession` above, not because
 * either caller owns it.
 */
export async function cancelActiveSavedGamesForRoomBlock(
  tableIds: string[],
  date: string,
): Promise<Array<{ id: string; updatedAt: string }>> {
  if (tableIds.length === 0) return []

  let cancelledRows: Array<{ id: string; updated_at: string | Date }>
  try {
    const results = await sql.transaction(
      [
        sql`
          SELECT pg_advisory_xact_lock(hashtext(t::text))
          FROM (
            -- Cast to uuid before hashtext (code-review finding): canonicalizes
            -- each id's text form so this always hashes to the same lock key
            -- createSavedGameForSession's own lock derives, regardless of
            -- spelling — matters there since that id is client-supplied, and
            -- kept consistent here too so both sides key off the identical
            -- canonicalization rule. Ordered ascending (ORDER BY 1) so two
            -- concurrent calls whose tableIds overlap always acquire the
            -- per-table locks in the same order — without this, call A locking
            -- [x, y] while call B locks [y, x] concurrently can deadlock.
            SELECT unnest(${tableIds}::uuid[]) AS t ORDER BY 1
          ) AS ordered_tables
        `,
        sql`
          UPDATE saved_games AS saved
          SET status = 'cancelled', updated_at = now()
          FROM (
            SELECT id, updated_at FROM saved_games
            WHERE table_id = ANY(${tableIds})
              AND status = 'active'
              AND ${date} BETWEEN start_date AND end_date
          ) AS prior
          WHERE saved.id = prior.id
          RETURNING saved.id, prior.updated_at
        `,
      ],
      { isolationLevel: 'ReadCommitted' },
    )
    cancelledRows = results[1] as Array<{ id: string; updated_at: string | Date }>
  } catch {
    serviceError('Internal server error', 500)
  }
  // @neondatabase/serverless returns `timestamptz` columns as `Date`
  // instances, not strings (code-review finding) — normalize here so
  // `restoreCancelledSavedGames`'s "restore it exactly" round-trips through
  // the same `timestamptz` cast it started from, matching the
  // `instanceof Date` normalization pattern already used in
  // equipment-service.ts's `toEquipment`.
  return cancelledRows.map((row) => ({
    id: row.id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }))
}

/**
 * Compensating restore for `cancelActiveSavedGamesForRoomBlock` above (#334,
 * mirrors `events-service.ts`'s `restoreCancelledReservations`). Every row
 * cancelled by that function was `'active'` beforehand, so restoration is a
 * plain status flip back — no per-row status needs to be tracked, unlike
 * reservations (which can be 'active' or 'pending'). Restores each row's own
 * captured pre-cancellation `updated_at` alongside its status (code-review
 * finding — see `cancelActiveSavedGamesForRoomBlock`'s doc comment), not
 * just the status, so a rolled-back event mutation leaves no trace on the
 * saved game's public `updatedAt`. Best-effort: errors are logged and
 * swallowed, matching every other compensating step in this codebase's
 * raw-SQL services.
 */
export async function restoreCancelledSavedGames(cancelled: Array<{ id: string; updatedAt: string }>): Promise<void> {
  if (cancelled.length === 0) return
  try {
    const ids = cancelled.map((row) => row.id)
    const updatedAts = cancelled.map((row) => row.updatedAt)
    await sql`
      UPDATE saved_games
      SET status = 'active', updated_at = restored.updated_at
      FROM (
        SELECT * FROM unnest(${ids}::uuid[], ${updatedAts}::timestamptz[]) AS restored(id, updated_at)
      ) AS restored
      WHERE saved_games.id = restored.id AND saved_games.status = 'cancelled'
    `
  } catch (rollbackError) {
    console.error('saved-games-service: compensating saved-game restore failed (non-fatal):', rollbackError)
  }
}
