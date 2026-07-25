import 'server-only'
import { asc, eq } from 'drizzle-orm'
import type { AdminLibraryGame, LibraryGame } from '@/lib/types'
import { getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { libraryGames } from '@/lib/db/schema'
import { serviceError } from '@/lib/server/shared/service-error'
import type { SessionUser } from '@/lib/server/auth/auth'
import { validateOptionalUrl } from '@/lib/validations/url'

type LibraryGameRow = typeof libraryGames.$inferSelect

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

function toLibraryGame(row: Pick<LibraryGameRow, 'id' | 'title' | 'categoryEs' | 'categoryEn' | 'players' | 'playTime' | 'weight' | 'sortOrder' | 'imgUrl'>): LibraryGame {
  return {
    id: row.id,
    title: row.title,
    categoryEs: row.categoryEs,
    categoryEn: row.categoryEn,
    players: row.players,
    playTime: row.playTime,
    weight: Number(row.weight),
    sortOrder: row.sortOrder,
    imgUrl: row.imgUrl,
  }
}

function toAdminLibraryGame(row: LibraryGameRow): AdminLibraryGame {
  return { ...toLibraryGame(row), active: row.active }
}

/**
 * Public read of active library games (ludoteca highlights) for the landing
 * page, ordered the same way the board arranges them in the dashboard.
 *
 * KIM-434 (F3c) PR3 note: this now reads via the Drizzle/Neon seam
 * (`getDrizzleDb()`). Neon has no RLS, so unlike the legacy Supabase path
 * this used to take, the "public read" scoping (RLS's
 * "library_games_select_active" policy previously restricted anon/
 * authenticated visibility to active rows) is now enforced here, in the
 * service layer, via the explicit `eq(libraryGames.active, true)` filter
 * below.
 */
export async function listLibraryGames(): Promise<LibraryGame[]> {
  const db = getDrizzleDb()
  const rows = await runQuery(
    db
      .select()
      .from(libraryGames)
      .where(eq(libraryGames.active, true))
      .orderBy(asc(libraryGames.sortOrder), asc(libraryGames.title)),
  )

  return rows.map((row) => toLibraryGame(row))
}

// ---------------------------------------------------------------------------
// Admin CRUD (OIR-205)
//
// Privilege checks (role === 'admin') live here in the service layer, not in
// the route handlers, so every entry point is protected regardless of how
// it's invoked — same pattern as the OIR-204 partners service.
// ---------------------------------------------------------------------------

export interface LibraryGameInput {
  title?: unknown
  categoryEs?: unknown
  categoryEn?: unknown
  players?: unknown
  playTime?: unknown
  weight?: unknown
  sortOrder?: unknown
  active?: unknown
  imageUrl?: unknown
}

function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

function requireNonEmptyString(value: unknown, field: string): string {
  const str = typeof value === 'string' ? value.trim() : ''
  if (!str) serviceError(`${field} is required`, 400)
  return str
}

function optionalInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(num)) serviceError(`${field} must be an integer`, 400)
  return num
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * OIR-206: English copy is optional — when categoryEn is absent/empty, fall
 * back to categoryEs (a NOT NULL column) so the landing still renders
 * content in the EN locale.
 *
 * Resolution rules (explicit, in priority order):
 * 1. `enProvided` and the trimmed value is non-empty → use it verbatim.
 * 2. `enProvided` and the trimmed value is empty → treat blanking as
 *    "re-enable auto-copy": return the (new) ES value.
 * 3. Not provided (`undefined`) → preserve `current.en` if it exists and
 *    differs from the OLD ES value (a deliberate edit); if `current.en`
 *    equals the OLD ES value (or there is no current row), auto-copy the
 *    new ES value.
 *
 * Rule 3's "identical EN === ES" auto-copy heuristic is safe because our
 * admin forms always resend every field: a deliberately identical EN is
 * resent explicitly on every update and is preserved by rule 1, so it never
 * falls into rule 3's heuristic path.
 *
 * `?? esValue` is a type-level safety net only — categoryEs is always a
 * non-empty string, so the fallback chain never actually resolves to null
 * here.
 */
function resolveBilingualEnFallback(
  field: string,
  esValue: string,
  rawEn: unknown,
  enProvided: boolean,
  current: { es: string | null; en: string | null } | null,
): string {
  if (enProvided) {
    // Finding 5 (mirrors optionalString elsewhere in the codebase): a
    // non-string, non-null value (an array, object, number…) must be
    // rejected rather than silently treated as "absent" and falling back to
    // the ES value.
    if (rawEn !== null && typeof rawEn !== 'string') {
      serviceError(`${field} must be a string`, 400)
    }
    const trimmed = typeof rawEn === 'string' ? rawEn.trim() : ''
    return trimmed !== '' ? trimmed : esValue
  }
  if (!current) return esValue
  const wasAutoCopied = current.en === current.es
  return (wasAutoCopied ? esValue : current.en) ?? esValue
}

/** weight is a numeric(2,1) column: required, must be a number in [0, 5]. */
function requireWeight(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (typeof value !== 'number' && typeof value !== 'string') serviceError('weight must be a number', 400)
  if (!Number.isFinite(num) || num < 0 || num > 5) serviceError('weight must be a number between 0 and 5', 400)
  // Drizzle's `numeric` column type maps to a string in JS (avoids float
  // precision loss); the DB still enforces numeric(2,1) on write.
  return String(num)
}

interface LibraryGameFieldSet {
  title: string
  categoryEs: string
  categoryEn: string
  players: string
  playTime: string
  weight: string
  sortOrder: number
  active: boolean
  imgUrl: string | null
}

/**
 * Resolve the full field set for a create/update, falling back to the
 * current row's values for anything omitted from the payload. `current` is
 * null for creates, where every field not provided by the caller falls back
 * to required-field validation instead. Validation happens here, before any
 * DB write.
 */
function resolveLibraryGameFields(body: LibraryGameInput, current: LibraryGameRow | null): LibraryGameFieldSet {
  const title = body.title !== undefined
    ? requireNonEmptyString(body.title, 'title')
    : requireNonEmptyString(current?.title, 'title')

  const categoryEs = body.categoryEs !== undefined
    ? requireNonEmptyString(body.categoryEs, 'categoryEs')
    : requireNonEmptyString(current?.categoryEs, 'categoryEs')

  const categoryEn = resolveBilingualEnFallback(
    'categoryEn',
    categoryEs,
    body.categoryEn,
    body.categoryEn !== undefined,
    current ? { es: current.categoryEs, en: current.categoryEn } : null,
  )

  const players = body.players !== undefined
    ? requireNonEmptyString(body.players, 'players')
    : requireNonEmptyString(current?.players, 'players')

  const playTime = body.playTime !== undefined
    ? requireNonEmptyString(body.playTime, 'playTime')
    : requireNonEmptyString(current?.playTime, 'playTime')

  const weight = body.weight !== undefined
    ? requireWeight(body.weight)
    : requireWeight(current?.weight)

  const sortOrder = body.sortOrder !== undefined
    ? (optionalInteger(body.sortOrder, 'sortOrder') ?? 0)
    : (current?.sortOrder ?? 0)

  const active = body.active !== undefined ? parseBooleanFlag(body.active) : (current?.active ?? true)

  const imgUrl = body.imageUrl !== undefined
    ? validateOptionalUrl(body.imageUrl, 'imageUrl')
    : (current?.imgUrl ?? null)

  return {
    title,
    categoryEs,
    categoryEn,
    players,
    playTime,
    weight,
    sortOrder,
    active,
    imgUrl,
  }
}

/** Admin read of every library game (active + inactive), ordered by sort_order. */
export async function listAdminLibraryGames(session: SessionUser): Promise<AdminLibraryGame[]> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db.select().from(libraryGames).orderBy(asc(libraryGames.sortOrder), asc(libraryGames.title)),
  )

  return rows.map((row) => toAdminLibraryGame(row))
}

export async function createLibraryGame(session: SessionUser, body: LibraryGameInput): Promise<AdminLibraryGame> {
  requireAdminSession(session)

  // Validate EVERYTHING before any DB write.
  const fields = resolveLibraryGameFields(body, null)

  const db = getDrizzleAdminDb()
  let row: LibraryGameRow | undefined
  try {
    ;[row] = await db.insert(libraryGames).values(fields).returning()
  } catch (err) {
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid library game data', 400)
    }
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Internal server error', 500)

  return toAdminLibraryGame(row)
}

export async function updateLibraryGame(session: SessionUser, id: string, body: LibraryGameInput): Promise<AdminLibraryGame> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [current] = await runQuery(db.select().from(libraryGames).where(eq(libraryGames.id, id)))

  if (!current) serviceError('Library game not found', 404)

  // Validate EVERYTHING before the UPDATE below.
  const fields = resolveLibraryGameFields(body, current)

  let row: LibraryGameRow | undefined
  try {
    ;[row] = await db.update(libraryGames).set(fields).where(eq(libraryGames.id, id)).returning()
  } catch (err) {
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid library game data', 400)
    }
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Library game not found', 404)

  return toAdminLibraryGame(row)
}

export async function deleteLibraryGame(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db.delete(libraryGames).where(eq(libraryGames.id, id)).returning({ id: libraryGames.id }),
  )

  if (!row) serviceError('Library game not found', 404)
}
