import 'server-only'
import { asc, eq } from 'drizzle-orm'
import type { AdminPartner, Partner } from '@/lib/types'
import { getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { partners } from '@/lib/db/schema'
import { serviceError } from '@/lib/server/shared/service-error'
import type { SessionUser } from '@/lib/server/auth/auth'
import { validateOptionalUrl } from '@/lib/validations/url'

type PartnerRow = typeof partners.$inferSelect

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

function toPartner(row: Pick<PartnerRow, 'id' | 'name' | 'imgUrl' | 'linkUrl' | 'descEs' | 'descEn' | 'sortOrder'>): Partner {
  return {
    id: row.id,
    name: row.name,
    imageUrl: row.imgUrl,
    linkUrl: row.linkUrl,
    descriptionEs: row.descEs,
    descriptionEn: row.descEn,
    sortOrder: row.sortOrder,
  }
}

function toAdminPartner(row: PartnerRow): AdminPartner {
  return { ...toPartner(row), active: row.active }
}

/**
 * Public read of active partners (colaboradores) for the landing page,
 * ordered the same way the board arranges them in the dashboard.
 *
 * KIM-434 (F3c) PR2 note: this now reads via the Drizzle/Neon seam
 * (`getDrizzleDb()`). Neon has no RLS, so unlike the legacy Supabase path
 * this used to take, the "public read" scoping (RLS's "partners_select_active"
 * policy previously restricted anon/authenticated visibility to active rows)
 * is now enforced here, in the service layer, via the explicit
 * `eq(partners.active, true)` filter below.
 */
export async function listPartners(): Promise<Partner[]> {
  const db = getDrizzleDb()
  const rows = await runQuery(
    db
      .select()
      .from(partners)
      .where(eq(partners.active, true))
      .orderBy(asc(partners.sortOrder), asc(partners.name)),
  )

  return rows.map((row) => toPartner(row))
}

// ---------------------------------------------------------------------------
// Admin CRUD (OIR-204)
//
// Privilege checks (role === 'admin') live here in the service layer, not in
// the route handlers, so every entry point is protected regardless of how
// it's invoked. img_url/link_url are validated with the shared http(s)-only
// allowlist (lib/validations/url.ts) before any DB write — same rule as the
// OIR-203 club events service.
// ---------------------------------------------------------------------------

export interface PartnerInput {
  name?: unknown
  imageUrl?: unknown
  linkUrl?: unknown
  descriptionEs?: unknown
  descriptionEn?: unknown
  sortOrder?: unknown
  active?: unknown
}

function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

function requireNonEmptyString(value: unknown, field: string): string {
  const str = typeof value === 'string' ? value.trim() : ''
  if (!str) serviceError(`${field} is required`, 400)
  return str
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') serviceError(`${field} must be a string`, 400)
  const str = value.trim()
  return str === '' ? null : str
}

/** img_url is required (NOT NULL) — unlike optionalString, empty is rejected. */
function requireImageUrl(value: unknown, current: string | null): string {
  const url = validateOptionalUrl(value, 'imageUrl') ?? (typeof current === 'string' ? current : null)
  if (!url) serviceError('imageUrl is required', 400)
  return url
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
 * OIR-206: English copy is optional — when descriptionEn is absent/empty,
 * fall back to the paired descriptionEs value so the landing still renders
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
 */
function resolveBilingualEnFallback(
  field: string,
  esValue: string | null,
  rawEn: unknown,
  enProvided: boolean,
  current: { es: string | null; en: string | null } | null,
): string | null {
  if (enProvided) {
    // Finding 5 (mirrors optionalString): a non-string, non-null value (an
    // array, object, number…) must be rejected rather than silently treated
    // as "absent" and falling back to the ES value.
    if (rawEn !== null && typeof rawEn !== 'string') {
      serviceError(`${field} must be a string`, 400)
    }
    const trimmed = typeof rawEn === 'string' ? rawEn.trim() : ''
    return trimmed !== '' ? trimmed : esValue
  }
  if (!current) return esValue
  const wasAutoCopied = current.en === current.es
  return wasAutoCopied ? esValue : current.en
}

interface PartnerFieldSet {
  name: string
  imgUrl: string
  linkUrl: string | null
  descEs: string | null
  descEn: string | null
  sortOrder: number
  active: boolean
}

/**
 * Resolve the full field set for a create/update, falling back to the
 * current row's values for anything omitted from the payload. `current` is
 * null for creates, where every field not provided by the caller falls back
 * to empty/required validation instead. Validation (including the URL
 * allowlist) happens here, before any DB write.
 */
function resolvePartnerFields(body: PartnerInput, current: PartnerRow | null): PartnerFieldSet {
  const name = body.name !== undefined
    ? requireNonEmptyString(body.name, 'name')
    : requireNonEmptyString(current?.name, 'name')

  const imgUrl = body.imageUrl !== undefined
    ? requireImageUrl(body.imageUrl, current?.imgUrl ?? null)
    : requireImageUrl(current?.imgUrl, current?.imgUrl ?? null)

  const linkUrl = body.linkUrl !== undefined ? validateOptionalUrl(body.linkUrl, 'linkUrl') : (current?.linkUrl ?? null)
  const descEs = body.descriptionEs !== undefined ? optionalString(body.descriptionEs, 'descriptionEs') : (current?.descEs ?? null)
  const descEn = resolveBilingualEnFallback(
    'descriptionEn',
    descEs,
    body.descriptionEn,
    body.descriptionEn !== undefined,
    current ? { es: current.descEs, en: current.descEn } : null,
  )

  const sortOrder = body.sortOrder !== undefined
    ? (optionalInteger(body.sortOrder, 'sortOrder') ?? 0)
    : (current?.sortOrder ?? 0)

  const active = body.active !== undefined ? parseBooleanFlag(body.active) : (current?.active ?? true)

  return {
    name,
    imgUrl,
    linkUrl,
    descEs,
    descEn,
    sortOrder,
    active,
  }
}

/** Admin read of every partner (active + inactive), ordered by sort_order. */
export async function listAdminPartners(session: SessionUser): Promise<AdminPartner[]> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const rows = await runQuery(
    db.select().from(partners).orderBy(asc(partners.sortOrder), asc(partners.name)),
  )

  return rows.map((row) => toAdminPartner(row))
}

export async function createPartner(session: SessionUser, body: PartnerInput): Promise<AdminPartner> {
  requireAdminSession(session)

  // Validate EVERYTHING — fields and the URL allowlist — before any DB write.
  const fields = resolvePartnerFields(body, null)

  const db = getDrizzleAdminDb()
  let row: PartnerRow | undefined
  try {
    ;[row] = await db.insert(partners).values(fields).returning()
  } catch (err) {
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid partner data', 400)
    }
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Internal server error', 500)

  return toAdminPartner(row)
}

export async function updatePartner(session: SessionUser, id: string, body: PartnerInput): Promise<AdminPartner> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [current] = await runQuery(db.select().from(partners).where(eq(partners.id, id)))

  if (!current) serviceError('Partner not found', 404)

  // Validate EVERYTHING before the UPDATE below.
  const fields = resolvePartnerFields(body, current)

  let row: PartnerRow | undefined
  try {
    ;[row] = await db.update(partners).set(fields).where(eq(partners.id, id)).returning()
  } catch (err) {
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid partner data', 400)
    }
    serviceError('Internal server error', 500)
  }
  if (!row) serviceError('Partner not found', 404)

  return toAdminPartner(row)
}

export async function deletePartner(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db.delete(partners).where(eq(partners.id, id)).returning({ id: partners.id }),
  )

  if (!row) serviceError('Partner not found', 404)
}
