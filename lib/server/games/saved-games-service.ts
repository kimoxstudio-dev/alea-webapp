/**
 * Saved-games service — KIM-441 (F3c PR6): migrated off the legacy Supabase
 * `getDb()`/`getAdminDb()` seam onto the Drizzle/Neon client
 * (`getDrizzleDb()`/`getDrizzleAdminDb()`), following the pilot pattern from
 * `lib/server/equipment/equipment-service.ts` (PR1) and
 * `lib/server/partners/partners-service.ts`.
 *
 * `saved_games` / `saved_game_attendances` (this service's own domain) and
 * `tables` / `rooms` (already migrated — `lib/server/tables/tables-service.ts`
 * PR2, `lib/server/rooms/rooms-service.ts` PR2) are read/written via Drizzle
 * below.
 *
 * `event_room_blocks` is NOT yet migrated — `lib/server/events/events-service.ts`
 * still owns that domain on the legacy Supabase seam — so
 * `assertTableAndEventAvailability()` intentionally keeps reading it via
 * `getAdminDb()`, mirroring the exact "split-brain" disclosure documented in
 * `tables-service.ts` for the same table: combining a Neon read (tables) with
 * a Supabase read (event_room_blocks) here is two independent round-trips
 * joined in application code, not a single SQL join.
 *
 * Member isolation policy (unchanged from the pre-migration version):
 *   - explicit `user_id = session.id` filter on member-scoped reads (see the
 *     non-admin branch of `listSavedGamesForSession` below)
 *   - explicit ownership checks (`current.userId !== session.id`) before
 *     mutations such as renew
 *   - `assertMemberRowsScoped()` (KIM-397) as defense-in-depth on the
 *     multi-row read in `listSavedGamesForSession`, run AFTER the DB fetch
 *     and BEFORE mapping rows to the public `SavedGame` shape
 * Cross-user operations (attendance recording, table/event conflict checks)
 * legitimately need to span users and therefore require the admin client.
 */
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import type { SavedGame, SavedGameStatus } from '@/lib/types'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { SessionUser } from '@/lib/server/auth/auth'
import { getCurrentClubDate, isValidDateOnlyString } from '@/lib/club-time'
import { getAdminDb, getDrizzleAdminDb, type AdminDbClient } from '@/lib/db'
import { rooms, savedGameAttendances, savedGames, tables } from '@/lib/db/schema'
import { ServiceError, serviceError } from '@/lib/server/shared/service-error'
import { assertMemberRowsScoped } from '@/lib/server/shared/data-scoping'
import type { Tables } from '@/lib/supabase/types'

/** Same transaction-callback parameter type events-service.ts derives for its
 * own admin-transaction helpers (see `AdminTx` there) — kept local here to
 * avoid a cross-service type import for a one-line alias. */
type AdminTx = Parameters<Parameters<AdminDbClient['transaction']>[0]>[0]

const SAVED_GAME_JOIN_SELECTION = {
  id: savedGames.id,
  tableId: savedGames.tableId,
  userId: savedGames.userId,
  startDate: savedGames.startDate,
  endDate: savedGames.endDate,
  status: savedGames.status,
  attendanceCount: savedGames.attendanceCount,
  renewedFromId: savedGames.renewedFromId,
  createdAt: savedGames.createdAt,
  updatedAt: savedGames.updatedAt,
  tableName: tables.name,
  roomName: rooms.name,
} as const

type SavedGameJoinedRow = {
  id: string
  tableId: string
  userId: string
  startDate: string
  endDate: string
  status: string
  attendanceCount: number
  renewedFromId: string | null
  createdAt: Date
  updatedAt: Date
  tableName: string
  roomName: string
}

/**
 * Runs a Drizzle query, translating any thrown DB/driver error into a
 * uniform 500 ServiceError. Business-logic outcomes (e.g. "no row
 * returned" -> 404, validation -> 400) are handled by callers, outside this
 * wrapper, so their specific status codes aren't swallowed into a 500.
 */
async function runQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch {
    serviceError('Internal server error', 500)
  }
}

/**
 * `node-postgres` (the driver behind the Drizzle/Neon seam) throws raw `pg`
 * `DatabaseError` instances with a `code` shape on constraint violations; it
 * does not wrap them. Duck-typed here rather than importing `pg`'s error
 * class to keep this check dependency-light.
 */
function getPgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const { code } = error as { code?: unknown }
  return typeof code === 'string' ? code : undefined
}

/** Builds the saved_games -> tables -> rooms join used by every read below. */
function savedGamesJoinedQuery(db: ReturnType<typeof getDrizzleAdminDb>) {
  return db
    .select(SAVED_GAME_JOIN_SELECTION)
    .from(savedGames)
    .innerJoin(tables, eq(savedGames.tableId, tables.id))
    .innerJoin(rooms, eq(tables.roomId, rooms.id))
}

async function fetchJoinedSavedGame(id: string): Promise<SavedGameJoinedRow | undefined> {
  const db = getDrizzleAdminDb()
  const [row] = await runQuery(savedGamesJoinedQuery(db).where(eq(savedGames.id, id)))
  return row
}

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
  const renewalOpensOn = addDays(row.endDate, -14)
  const status = row.status === 'active' && row.endDate < today ? 'completed' : row.status
  return {
    id: row.id,
    tableId: row.tableId,
    userId: row.userId,
    startDate: row.startDate,
    endDate: row.endDate,
    status: status as SavedGameStatus,
    attendanceCount: row.attendanceCount,
    renewedFromId: row.renewedFromId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    roomName: row.roomName ?? null,
    tableName: row.tableName ?? null,
    renewalOpensOn,
    canRenew: status === 'active' && today >= renewalOpensOn && today <= row.endDate,
  }
}

/**
 * `tx` is always the caller's advisory-lock-guarded transaction (see
 * `createSavedGameForSession` / `renewSavedGameForSession` below) — this
 * function never opens its own connection for the Neon read, so the
 * conflict check it performs is guaranteed to run after the lock is held.
 */
async function assertTableAndEventAvailability(tx: AdminTx, tableId: string, startDate: string, endDate: string) {
  // Drizzle/Neon read: `tables` is already migrated (tables-service.ts PR2),
  // so its source of truth lives in Neon.
  const [table] = await runQuery(
    tx
      .select({ id: tables.id, roomId: tables.roomId, type: tables.type })
      .from(tables)
      .where(eq(tables.id, tableId)),
  )

  if (!table) serviceError('Table not found', 404)
  if (table.type !== 'removable_top') serviceError(ERROR_CODES.SAVED_GAME_REQUIRES_REMOVABLE_TOP, 400)

  // Legacy Supabase read: `event_room_blocks` is owned by events-service.ts,
  // which has not migrated yet — see file header "split-brain" disclosure.
  const admin = getAdminDb()
  const { data: blocks, error: blocksError } = await admin
    .from('event_room_blocks')
    .select('id, table_id')
    .eq('room_id', table.roomId)
    .gte('date', startDate)
    .lte('date', endDate)

  if (blocksError) serviceError('Internal server error', 500)

  // OIR-208: a block with a table_id only conflicts with that single table;
  // NULL (the pre-OIR-208 default) conflicts with every table of the room —
  // saved games only ever live on a single removable-top table.
  const hasConflict = ((blocks ?? []) as Array<{ id: string; table_id: string | null }>).some(
    (block) => block.table_id == null || block.table_id === tableId,
  )
  if (hasConflict) serviceError(ERROR_CODES.SAVED_GAME_EVENT_CONFLICT, 409)
}

function validateDateRange(startDate: string, endDate: string) {
  const today = getCurrentClubDate()
  if (startDate < today) serviceError(ERROR_CODES.SAVED_GAME_START_IN_PAST, 400)
  if (endDate < startDate) serviceError(ERROR_CODES.SAVED_GAME_INVALID_RANGE, 400)
  if (endDate > getMaxEndDate(startDate)) serviceError(ERROR_CODES.SAVED_GAME_MAX_DURATION, 400)
}

export async function listSavedGamesForSession(session: SessionUser): Promise<SavedGame[]> {
  // Admin client required: Neon has no RLS. Member isolation is enforced by
  // the `eq(savedGames.userId, session.id)` filter below (non-admin path).
  // Admins intentionally receive all rows.
  const db = getDrizzleAdminDb()
  const today = getCurrentClubDate()

  const rows = await runQuery(
    savedGamesJoinedQuery(db)
      .where(session.role !== 'admin' ? eq(savedGames.userId, session.id) : undefined)
      .orderBy(asc(savedGames.startDate)),
  )

  // Defense-in-depth: verify the query filter held before mapping rows out.
  // `assertMemberRowsScoped()` requires a `user_id` (snake_case) field; the
  // Drizzle row uses `userId` (camelCase), so it's bridged here rather than
  // changing the shared helper's contract (also used by other services).
  const rawRows = assertMemberRowsScoped(
    rows.map((row) => ({ ...row, user_id: row.userId })),
    session,
  )

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

  // Admin client required: Neon has no RLS. Member isolation is enforced by
  // writing `userId: session.id` explicitly into the insert payload — the
  // authenticated user can only create rows for themselves.
  const db = getDrizzleAdminDb()
  let row: { id: string } | undefined
  try {
    row = await db.transaction(async (tx) => {
      // Reimplemented `pg_advisory_xact_lock` guard from the dropped
      // `validate_saved_game` trigger
      // (supabase/migrations/20260619000006_kim384_saved_game_validation_trigger.sql)
      // — same lock key (`hashtextextended(table_id::text, 0)`) as the
      // matching guard in events-service.ts's `cancelSavedGamesForBlockedRoom()`.
      // Taken BEFORE the conflict check, inside the same transaction as the
      // insert, so this create and a concurrent "block this room's event"
      // transaction can't each act on a pre-commit view of the other's
      // write (see the doc comment on `cancelSavedGamesForBlockedRoom` for
      // the full race-condition rationale — this is the other side of it).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${tableId}::text, 0))`)
      await assertTableAndEventAvailability(tx, tableId, startDate, endDate)

      const [inserted] = await tx
        .insert(savedGames)
        .values({ tableId, userId: session.id, startDate, endDate })
        .returning({ id: savedGames.id })
      return inserted
    })
  } catch (err) {
    if (err instanceof ServiceError) throw err
    const code = getPgErrorCode(err)
    if (code === '23P01') serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    if (code === '23514') serviceError((err as Error).message, 400)
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Internal server error', 500)

  const joined = await fetchJoinedSavedGame(row.id)
  if (!joined) serviceError('Internal server error', 500)
  return mapSavedGame(joined)
}

export async function renewSavedGameForSession(session: SessionUser, id: string): Promise<SavedGame> {
  // Admin client required: Neon has no RLS. Member isolation is enforced by
  // the ownership check below (`current.userId !== session.id`) which throws
  // 403 before any mutation occurs for non-admin users.
  const db = getDrizzleAdminDb()
  const [current] = await runQuery(
    db
      .select({
        id: savedGames.id,
        tableId: savedGames.tableId,
        userId: savedGames.userId,
        startDate: savedGames.startDate,
        endDate: savedGames.endDate,
        status: savedGames.status,
      })
      .from(savedGames)
      .where(eq(savedGames.id, id)),
  )

  if (!current) serviceError('Saved Game not found', 404)
  if (session.role !== 'admin' && current.userId !== session.id) serviceError('Forbidden', 403)
  if (current.status !== 'active') serviceError(ERROR_CODES.SAVED_GAME_NOT_ACTIVE, 409)

  const today = getCurrentClubDate()
  const renewalOpensOn = addDays(current.endDate, -14)
  if (today < renewalOpensOn || today > current.endDate) serviceError(ERROR_CODES.SAVED_GAME_RENEWAL_NOT_OPEN, 409)

  const startDate = addDays(current.endDate, 1)
  const endDate = getMaxEndDate(startDate)

  let row: { id: string } | undefined
  try {
    row = await db.transaction(async (tx) => {
      // Same advisory-lock guard as createSavedGameForSession above — see
      // its doc comment for the full race-condition rationale.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${current.tableId}::text, 0))`)
      await assertTableAndEventAvailability(tx, current.tableId, startDate, endDate)

      const [inserted] = await tx
        .insert(savedGames)
        .values({
          tableId: current.tableId,
          userId: current.userId,
          startDate,
          endDate,
          renewedFromId: current.id,
        })
        .returning({ id: savedGames.id })
      return inserted
    })
  } catch (err) {
    if (err instanceof ServiceError) throw err
    const code = getPgErrorCode(err)
    if (code === '23505') serviceError(ERROR_CODES.SAVED_GAME_ALREADY_RENEWED, 409)
    if (code === '23P01') serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Internal server error', 500)

  const joined = await fetchJoinedSavedGame(row.id)
  if (!joined) serviceError('Internal server error', 500)
  return mapSavedGame(joined, today)
}

/**
 * Only the fields this function actually reads from a reservation row — kept
 * as a `Pick` (rather than the full `Tables<'reservations'>` shape) so
 * callers that only have a Drizzle `reservations.$inferSelect` row (which is
 * camelCase and lacks several legacy columns) can bridge just these six
 * fields instead of fabricating an entire legacy Supabase row.
 */
type PlayReservationForAttendance = Pick<
  Tables<'reservations'>,
  'id' | 'table_id' | 'user_id' | 'date' | 'surface' | 'status'
>

/**
 * Reimplements two dropped triggers together, atomically, since neither
 * exists anymore and both used to fire off the same check-in event:
 *   - `record_saved_game_attendance_after_activation` (AFTER UPDATE OF
 *     status ON reservations -> records a `saved_game_attendances` row when
 *     a reservation's top-surface play activates)
 *   - `saved_game_attendance_count` (AFTER INSERT ON saved_game_attendances
 *     -> increment_saved_game_attendance(), bumps the parent
 *     `saved_games.attendance_count`)
 * Both steps run inside one `db.transaction()` so the attendance insert and
 * the counter increment can never diverge.
 */
export async function recordSavedGameAttendance(playReservation: PlayReservationForAttendance): Promise<void> {
  if (playReservation.surface !== 'top' || playReservation.status !== 'active') return

  // Admin client required: this function is called from a system/cron context
  // (not a user request) and intentionally reads across all users to match a
  // reservation to its saved game. No per-user scoping is appropriate here.
  const db = getDrizzleAdminDb()

  try {
    await db.transaction(async (tx) => {
      const [savedGame] = await tx
        .select({ id: savedGames.id, attendanceCount: savedGames.attendanceCount })
        .from(savedGames)
        .where(
          and(
            eq(savedGames.tableId, playReservation.table_id),
            eq(savedGames.userId, playReservation.user_id),
            eq(savedGames.status, 'active'),
            lte(savedGames.startDate, playReservation.date),
            gte(savedGames.endDate, playReservation.date),
          ),
        )

      if (!savedGame) return

      await tx.insert(savedGameAttendances).values({
        savedGameId: savedGame.id,
        playReservationId: playReservation.id,
        attendedOn: playReservation.date,
      })

      await tx
        .update(savedGames)
        .set({ attendanceCount: savedGame.attendanceCount + 1 })
        .where(eq(savedGames.id, savedGame.id))
    })
  } catch (err) {
    // 23505 (unique_violation on play_reservation_id) means this reservation
    // already recorded attendance — idempotent no-op, matches prior behavior.
    // The counter increment above is skipped too since it's in the same
    // transaction, which rolls back entirely on any error.
    if (getPgErrorCode(err) !== '23505') serviceError('Internal server error', 500)
  }
}
