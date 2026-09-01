import 'server-only'
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import type { AdminPartner, Partner } from '@/lib/types'
import { serviceError } from '@/lib/server/service-error'
import type { SessionUser } from '@/lib/server/auth'
import { validateOptionalUrl } from '@/lib/validations/url'

/**
 * Raw-SQL Neon port of the partners service (#307), matching the established
 * style from `library-games-service.ts` (#306), `equipment-service.ts`
 * (#305) and `events-service.ts` (#303).
 *
 * `public.partners` (see `lib/db/schema/016_partners.sql` and the legacy
 * `supabase/migrations/20260704000002_oir204_partners_table.sql`) carries no
 * `CREATE TRIGGER`, no CHECK constraint, and no other table implicitly
 * referencing it — it is a standalone table with no DB-side business logic
 * to port into the app layer. The `23514`/`22P02`/`23502` Postgres error
 * mapping below is retained defensively (NOT NULL / type-cast failures
 * still surface as `23502`/`22P02`), even though there is currently no CHECK
 * constraint that would raise `23514`.
 */

type PartnerRow = {
  id: string
  name: string
  img_url: string
  link_url: string | null
  desc_es: string | null
  desc_en: string | null
  sort_order: number
  active: boolean
}

function toPartner(row: Omit<PartnerRow, 'active'>): Partner {
  return {
    id: row.id,
    name: row.name,
    imageUrl: row.img_url,
    linkUrl: row.link_url,
    descriptionEs: row.desc_es,
    descriptionEn: row.desc_en,
    sortOrder: row.sort_order,
  }
}

function toAdminPartner(row: PartnerRow): AdminPartner {
  return { ...toPartner(row), active: row.active }
}

/**
 * Public read of active partners (colaboradores) for the landing page,
 * ordered the same way the board arranges them in the dashboard.
 * `partners` has no RLS in Neon (that's a Supabase-only concept), so the
 * "active"-only visibility that the old "partners_select_active" RLS policy
 * enforced is now an explicit `WHERE active = true` here.
 */
export async function listPartners(): Promise<Partner[]> {
  let rows: Array<Omit<PartnerRow, 'active'>>
  try {
    rows = await sql`
      SELECT id, name, img_url, link_url, desc_es, desc_en, sort_order
      FROM partners
      WHERE active = true
      ORDER BY sort_order ASC, name ASC
    ` as Array<Omit<PartnerRow, 'active'>>
  } catch {
    return serviceError('Internal server error', 500)
  }

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
  img_url: string
  link_url: string | null
  desc_es: string | null
  desc_en: string | null
  sort_order: number
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
    ? requireImageUrl(body.imageUrl, current?.img_url ?? null)
    : requireImageUrl(current?.img_url, current?.img_url ?? null)

  const linkUrl = body.linkUrl !== undefined ? validateOptionalUrl(body.linkUrl, 'linkUrl') : (current?.link_url ?? null)
  const descEs = body.descriptionEs !== undefined ? optionalString(body.descriptionEs, 'descriptionEs') : (current?.desc_es ?? null)
  const descEn = resolveBilingualEnFallback(
    'descriptionEn',
    descEs,
    body.descriptionEn,
    body.descriptionEn !== undefined,
    current ? { es: current.desc_es, en: current.desc_en } : null,
  )

  const sortOrder = body.sortOrder !== undefined
    ? (optionalInteger(body.sortOrder, 'sortOrder') ?? 0)
    : (current?.sort_order ?? 0)

  const active = body.active !== undefined ? parseBooleanFlag(body.active) : (current?.active ?? true)

  return {
    name,
    img_url: imgUrl,
    link_url: linkUrl,
    desc_es: descEs,
    desc_en: descEn,
    sort_order: sortOrder,
    active,
  }
}

function mapWriteError(error: unknown): never {
  if (
    error instanceof NeonDbError &&
    (error.code === '23514' || error.code === '22P02' || error.code === '23502')
  ) {
    serviceError('Invalid partner data', 400)
  }
  serviceError('Internal server error', 500)
}

/** Admin read of every partner (active + inactive), ordered by sort_order. */
export async function listAdminPartners(session: SessionUser): Promise<AdminPartner[]> {
  requireAdminSession(session)

  let rows: PartnerRow[]
  try {
    rows = await sql`
      SELECT id, name, img_url, link_url, desc_es, desc_en, sort_order, active
      FROM partners
      ORDER BY sort_order ASC, name ASC
    ` as PartnerRow[]
  } catch {
    return serviceError('Internal server error', 500)
  }

  return rows.map((row) => toAdminPartner(row))
}

export async function createPartner(session: SessionUser, body: PartnerInput): Promise<AdminPartner> {
  requireAdminSession(session)

  // Validate EVERYTHING — fields and the URL allowlist — before any DB write.
  const fields = resolvePartnerFields(body, null)

  let rows: PartnerRow[]
  try {
    rows = await sql`
      INSERT INTO partners (name, img_url, link_url, desc_es, desc_en, sort_order, active)
      VALUES (
        ${fields.name},
        ${fields.img_url},
        ${fields.link_url},
        ${fields.desc_es},
        ${fields.desc_en},
        ${fields.sort_order},
        ${fields.active}
      )
      RETURNING id, name, img_url, link_url, desc_es, desc_en, sort_order, active
    ` as PartnerRow[]
  } catch (error) {
    mapWriteError(error)
  }

  const partner = rows[0]
  if (!partner) return serviceError('Internal server error', 500)

  return toAdminPartner(partner)
}

export async function updatePartner(session: SessionUser, id: string, body: PartnerInput): Promise<AdminPartner> {
  requireAdminSession(session)

  let currentRows: PartnerRow[]
  try {
    currentRows = await sql`
      SELECT id, name, img_url, link_url, desc_es, desc_en, sort_order, active
      FROM partners
      WHERE id = ${id}
    ` as PartnerRow[]
  } catch {
    return serviceError('Internal server error', 500)
  }
  const current = currentRows[0] ?? null
  if (!current) return serviceError('Partner not found', 404)

  // Validate EVERYTHING before the UPDATE below.
  const fields = resolvePartnerFields(body, current)

  let rows: PartnerRow[]
  try {
    rows = await sql`
      UPDATE partners
      SET
        name = ${fields.name},
        img_url = ${fields.img_url},
        link_url = ${fields.link_url},
        desc_es = ${fields.desc_es},
        desc_en = ${fields.desc_en},
        sort_order = ${fields.sort_order},
        active = ${fields.active},
        updated_at = now()
      WHERE id = ${id}
      RETURNING id, name, img_url, link_url, desc_es, desc_en, sort_order, active
    ` as PartnerRow[]
  } catch (error) {
    mapWriteError(error)
  }

  const partner = rows[0]
  if (!partner) return serviceError('Partner not found', 404)

  return toAdminPartner(partner)
}

export async function deletePartner(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  let rows: Array<{ id: string }>
  try {
    rows = await sql`
      DELETE FROM partners
      WHERE id = ${id}
      RETURNING id
    ` as Array<{ id: string }>
  } catch {
    return serviceError('Internal server error', 500)
  }

  if (!rows[0]) serviceError('Partner not found', 404)
}
