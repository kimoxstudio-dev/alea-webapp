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
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import type { Tables } from '@/lib/supabase/types'

type SavedGameRow = Tables<'saved_games'>
type SavedGameJoinedRow = SavedGameRow & {
  table_name: string | null
  room_name: string | null
}

const SAVED_GAME_COLUMNS = 'id, table_id, user_id, start_date, end_date, status, attendance_count, renewed_from_id, created_at, updated_at'
// Same shape as SAVED_GAME_COLUMNS plus the table/room join used by
// `listSavedGamesForSession` — used to select back out of the `ins` CTE in
// create/renew so the response includes real roomName/tableName instead of
// nulls (RETURNING alone has no access to joined tables).
const SAVED_GAME_JOINED_COLUMNS = 'sg.id, sg.table_id, sg.user_id, sg.start_date, sg.end_date, sg.status, sg.attendance_count, sg.renewed_from_id, sg.created_at, sg.updated_at, t.name AS table_name, rooms.name AS room_name'

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

  // OIR-208: a block with a table_id only conflicts with that single table;
  // NULL (the pre-OIR-208 default) conflicts with every table of the room —
  // saved games only ever live on a single removable-top table.
  const hasConflict = blocks.some(
    (block) => block.table_id == null || block.table_id === tableId,
  )
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
  let rows: SavedGameJoinedRow[]
  try {
    rows = await sql`
      WITH ins AS (
        INSERT INTO saved_games (table_id, user_id, start_date, end_date)
        VALUES (${tableId}, ${session.id}, ${startDate}, ${endDate})
        RETURNING *
      )
      SELECT ${sql.unsafe(SAVED_GAME_JOINED_COLUMNS)}
      FROM ins sg
      LEFT JOIN tables t ON t.id = sg.table_id
      LEFT JOIN rooms ON rooms.id = t.room_id
    ` as SavedGameJoinedRow[]
  } catch (error) {
    if (isExclusionConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    if (error instanceof NeonDbError && error.code === '23514') serviceError(error.message, 400)
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  if (!data) serviceError('Internal server error', 500)
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

  let rows: SavedGameJoinedRow[]
  try {
    rows = await sql`
      WITH ins AS (
        INSERT INTO saved_games (table_id, user_id, start_date, end_date, renewed_from_id)
        VALUES (${current.table_id}, ${current.user_id}, ${startDate}, ${endDate}, ${current.id})
        RETURNING *
      )
      SELECT ${sql.unsafe(SAVED_GAME_JOINED_COLUMNS)}
      FROM ins sg
      LEFT JOIN tables t ON t.id = sg.table_id
      LEFT JOIN rooms ON rooms.id = t.room_id
    ` as SavedGameJoinedRow[]
  } catch (error) {
    if (isRenewedFromConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_ALREADY_RENEWED, 409)
    if (isExclusionConflict(error)) serviceError(ERROR_CODES.SAVED_GAME_CONFLICT, 409)
    serviceError('Internal server error', 500)
  }

  const data = rows[0]
  if (!data) serviceError('Internal server error', 500)
  return mapSavedGame(data, today)
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
    if (error instanceof NeonDbError && error.code === '23505') return
    serviceError('Internal server error', 500)
  }
}
