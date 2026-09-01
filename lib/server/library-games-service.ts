import 'server-only'
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import type { AdminLibraryGame, LibraryGame } from '@/lib/types'
import { serviceError } from '@/lib/server/service-error'
import type { SessionUser } from '@/lib/server/auth'
import { validateOptionalUrl } from '@/lib/validations/url'

/**
 * Raw-SQL Neon port of the library-games service (#306), matching the
 * established style from `equipment-service.ts` (#305), `events-service.ts`
 * (#303) and `reservations-service.ts` (#301).
 *
 * `public.library_games` (see `lib/db/schema/017_library_games.sql` and the
 * legacy `supabase/migrations/20260704000003_oir205_library_games_table.sql`
 * / `20260704000005_oir207_landing_media_bucket.sql`) carries no
 * `CREATE TRIGGER`, no CHECK constraint, and no other table implicitly
 * referencing it — it is a standalone table with no DB-side business logic
 * to port into the app layer (unlike #301's reservations, which had a
 * symmetric conflict check and a counter increment done implicitly by
 * Postgres). The `23514`/`22P02`/`23502` Postgres error mapping below is
 * retained defensively (NOT NULL / type-cast failures still surface as
 * `23502`/`22P02`), even though there is currently no CHECK constraint that
 * would raise `23514`.
 */

type LibraryGameRow = {
  id: string
  title: string
  category_es: string
  category_en: string
  players: string
  play_time: string
  weight: string | number
  sort_order: number
  active: boolean
  img_url: string | null
}

function toLibraryGame(row: Omit<LibraryGameRow, 'active'>): LibraryGame {
  return {
    id: row.id,
    title: row.title,
    categoryEs: row.category_es,
    categoryEn: row.category_en,
    players: row.players,
    playTime: row.play_time,
    weight: Number(row.weight),
    sortOrder: row.sort_order,
    imgUrl: row.img_url,
  }
}

function toAdminLibraryGame(row: LibraryGameRow): AdminLibraryGame {
  return { ...toLibraryGame(row), active: row.active }
}

/**
 * Public read of active library games (ludoteca highlights) for the landing
 * page, ordered the same way the board arranges them in the dashboard.
 * `library_games` has no RLS in Neon (that's a Supabase-only concept), so
 * the "active"-only visibility that the old "library_games_select_active"
 * RLS policy enforced is now an explicit `WHERE active = true` here.
 */
export async function listLibraryGames(): Promise<LibraryGame[]> {
  let rows: Array<Omit<LibraryGameRow, 'active'>>
  try {
    rows = await sql`
      SELECT id, title, category_es, category_en, players, play_time, weight, sort_order, img_url
      FROM library_games
      WHERE active = true
      ORDER BY sort_order ASC, title ASC
    ` as Array<Omit<LibraryGameRow, 'active'>>
  } catch {
    return serviceError('Internal server error', 500)
  }

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
function requireWeight(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (typeof value !== 'number' && typeof value !== 'string') serviceError('weight must be a number', 400)
  if (!Number.isFinite(num) || num < 0 || num > 5) serviceError('weight must be a number between 0 and 5', 400)
  return num
}

interface LibraryGameFieldSet {
  title: string
  category_es: string
  category_en: string
  players: string
  play_time: string
  weight: number
  sort_order: number
  active: boolean
  img_url: string | null
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
    : requireNonEmptyString(current?.category_es, 'categoryEs')

  const categoryEn = resolveBilingualEnFallback(
    'categoryEn',
    categoryEs,
    body.categoryEn,
    body.categoryEn !== undefined,
    current ? { es: current.category_es, en: current.category_en } : null,
  )

  const players = body.players !== undefined
    ? requireNonEmptyString(body.players, 'players')
    : requireNonEmptyString(current?.players, 'players')

  const playTime = body.playTime !== undefined
    ? requireNonEmptyString(body.playTime, 'playTime')
    : requireNonEmptyString(current?.play_time, 'playTime')

  const weight = body.weight !== undefined
    ? requireWeight(body.weight)
    : requireWeight(current?.weight)

  const sortOrder = body.sortOrder !== undefined
    ? (optionalInteger(body.sortOrder, 'sortOrder') ?? 0)
    : (current?.sort_order ?? 0)

  const active = body.active !== undefined ? parseBooleanFlag(body.active) : (current?.active ?? true)

  const imgUrl = body.imageUrl !== undefined
    ? validateOptionalUrl(body.imageUrl, 'imageUrl')
    : (current?.img_url ?? null)

  return {
    title,
    category_es: categoryEs,
    category_en: categoryEn,
    players,
    play_time: playTime,
    weight,
    sort_order: sortOrder,
    active,
    img_url: imgUrl,
  }
}

function mapWriteError(error: unknown): never {
  if (
    error instanceof NeonDbError &&
    (error.code === '23514' || error.code === '22P02' || error.code === '23502')
  ) {
    serviceError('Invalid library game data', 400)
  }
  serviceError('Internal server error', 500)
}

/** Admin read of every library game (active + inactive), ordered by sort_order. */
export async function listAdminLibraryGames(session: SessionUser): Promise<AdminLibraryGame[]> {
  requireAdminSession(session)

  let rows: LibraryGameRow[]
  try {
    rows = await sql`
      SELECT id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url
      FROM library_games
      ORDER BY sort_order ASC, title ASC
    ` as LibraryGameRow[]
  } catch {
    return serviceError('Internal server error', 500)
  }

  return rows.map((row) => toAdminLibraryGame(row))
}

export async function createLibraryGame(session: SessionUser, body: LibraryGameInput): Promise<AdminLibraryGame> {
  requireAdminSession(session)

  // Validate EVERYTHING before any DB write.
  const fields = resolveLibraryGameFields(body, null)

  let rows: LibraryGameRow[]
  try {
    rows = await sql`
      INSERT INTO library_games (title, category_es, category_en, players, play_time, weight, sort_order, active, img_url)
      VALUES (
        ${fields.title},
        ${fields.category_es},
        ${fields.category_en},
        ${fields.players},
        ${fields.play_time},
        ${fields.weight},
        ${fields.sort_order},
        ${fields.active},
        ${fields.img_url}
      )
      RETURNING id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url
    ` as LibraryGameRow[]
  } catch (error) {
    mapWriteError(error)
  }

  const game = rows[0]
  if (!game) return serviceError('Internal server error', 500)

  return toAdminLibraryGame(game)
}

export async function updateLibraryGame(session: SessionUser, id: string, body: LibraryGameInput): Promise<AdminLibraryGame> {
  requireAdminSession(session)

  let currentRows: LibraryGameRow[]
  try {
    currentRows = await sql`
      SELECT id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url
      FROM library_games
      WHERE id = ${id}
    ` as LibraryGameRow[]
  } catch {
    return serviceError('Internal server error', 500)
  }
  const current = currentRows[0] ?? null
  if (!current) return serviceError('Library game not found', 404)

  // Validate EVERYTHING before the UPDATE below.
  const fields = resolveLibraryGameFields(body, current)

  let rows: LibraryGameRow[]
  try {
    rows = await sql`
      UPDATE library_games
      SET
        title = ${fields.title},
        category_es = ${fields.category_es},
        category_en = ${fields.category_en},
        players = ${fields.players},
        play_time = ${fields.play_time},
        weight = ${fields.weight},
        sort_order = ${fields.sort_order},
        active = ${fields.active},
        img_url = ${fields.img_url},
        updated_at = now()
      WHERE id = ${id}
      RETURNING id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url
    ` as LibraryGameRow[]
  } catch (error) {
    mapWriteError(error)
  }

  const game = rows[0]
  if (!game) return serviceError('Library game not found', 404)

  return toAdminLibraryGame(game)
}

export async function deleteLibraryGame(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  let rows: Array<{ id: string }>
  try {
    rows = await sql`
      DELETE FROM library_games
      WHERE id = ${id}
      RETURNING id
    ` as Array<{ id: string }>
  } catch {
    return serviceError('Internal server error', 500)
  }

  if (!rows[0]) serviceError('Library game not found', 404)
}
