import { asc, count, eq, ilike, or, type SQL } from 'drizzle-orm'
import type { MemberImportIssue, MemberImportResult, MemberImportRow, PaginatedResponse, User } from '@/lib/types'
import { getDrizzleAdminDb } from '@/lib/db'
import { profiles } from '@/lib/db/schema'
import { createSupabaseServerAdminClient } from '@/lib/supabase/server'
import { createAuthUser, deleteAuthUser, updateAuthUserById } from '@/lib/auth/session'
import { serviceError } from '@/lib/server/shared/service-error'
import { memberNumberSchema } from '@/lib/validations/auth'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/users/profile-mappers'
import type { SessionUser } from '@/lib/server/auth/auth'
import {
  type MemberImportOptionalColumnPresence,
  MEMBER_IMPORT_PREVIEW_LIMIT,
  parseMemberImportCsv,
  normalizeMemberImportSource,
  pushImportIssue,
} from '@/lib/server/users/member-import'

// Privilege checks (role === 'admin') live here in the service layer, not in
// route handlers (repo convention). Neon/Drizzle has no RLS, so this
// in-function check is the only authorization guard for these mutations —
// mirrors the profiles_admin_insert/update/delete RLS policies (is_admin())
// this service used to rely on. Member self-service profile reads/updates
// are handled by a separate, non-admin surface (lib/server/auth/auth*.ts)
// and are not affected here — every function below requires an admin
// session and reads/writes across all members, so `assertMemberRowsScoped()`
// (member-row defense-in-depth, see lib/server/shared/data-scoping.ts) does
// not apply to this file: there is no member-scoped "fetch my own rows" path
// here for it to guard.
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
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

/** Column set returned to callers — mirrors `PublicProfileRow` (never selects `passwordHash`/`pswChanged`). */
const PROFILE_COLUMNS = {
  id: profiles.id,
  memberNumber: profiles.memberNumber,
  fullName: profiles.fullName,
  authEmail: profiles.authEmail,
  email: profiles.email,
  phone: profiles.phone,
  role: profiles.role,
  isActive: profiles.isActive,
  activeFrom: profiles.activeFrom,
  noShowCount: profiles.noShowCount,
  blockedUntil: profiles.blockedUntil,
  createdAt: profiles.createdAt,
  updatedAt: profiles.updatedAt,
} as const

type ProfileUpdate = Partial<typeof profiles.$inferInsert>

function normalizePage(page: number) {
  return Math.max(1, Math.floor(Number(page)) || 1)
}

function normalizeLimit(limit: number) {
  return Math.min(100, Math.max(1, Math.floor(Number(limit)) || 20))
}

function sanitizeSearchTerm(search: string) {
  return search.replace(/[^a-zA-Z0-9@._\s-]/g, '')
}

function escapeLikeWildcards(term: string) {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function sanitizeOptionalUpdateValue(value: unknown) {
  if (value === null) return null
  const trimmed = String(value).trim()
  return trimmed.length > 0 ? trimmed : null
}

function assertNullableStringField(value: unknown, fieldName: string) {
  if (value !== null && typeof value !== 'string') {
    serviceError(`${fieldName} must be a string or null`, 400)
  }
}

function createInternalAuthEmail(memberNumber: string) {
  return `${memberNumber}@members.alea.internal`
}

async function importMembersFromNormalizedRows(input: {
  totalRows: number
  normalizedRows: MemberImportRow[]
  issues: MemberImportIssue[]
  optionalColumnPresence: MemberImportOptionalColumnPresence
}): Promise<MemberImportResult> {
  const { totalRows, normalizedRows } = input
  const issues = [...input.issues]
  const auditedRows: MemberImportRow[] = []
  const db = getDrizzleAdminDb()
  const concurrencyLimit = 10

  async function processImportRow(row: MemberImportRow) {
    let existing: PublicProfileRow | undefined
    try {
      ;[existing] = await db
        .select(PROFILE_COLUMNS)
        .from(profiles)
        .where(eq(profiles.memberNumber, row.memberNumber))
        .limit(1)
    } catch {
      return {
        created: 0,
        updated: 0,
        normalizedRow: null,
        issue: { rowNumber: row.rowNumber, memberNumber: row.memberNumber, code: 'read_existing_failed' as const },
      }
    }

    if (existing) {
      const resolvedEmail = row.email ?? createInternalAuthEmail(row.memberNumber)
      const updatePayload: ProfileUpdate = {
        fullName: row.fullName,
      }
      const normalizedRow: MemberImportRow = { ...row }

      if (input.optionalColumnPresence.email) {
        updatePayload.email = resolvedEmail
        normalizedRow.email = resolvedEmail
      } else {
        normalizedRow.email = existing.email ?? null
      }
      if (input.optionalColumnPresence.phone) {
        updatePayload.phone = row.phone
      } else {
        normalizedRow.phone = existing.phone ?? null
      }

      try {
        await db.update(profiles).set({ ...updatePayload, updatedAt: new Date() }).where(eq(profiles.id, existing.id))
      } catch {
        return {
          created: 0,
          updated: 0,
          normalizedRow: null,
          issue: { rowNumber: row.rowNumber, memberNumber: row.memberNumber, code: 'update_existing_failed' as const },
        }
      }

      return {
        created: 0,
        updated: 1,
        normalizedRow,
        issue: null,
      }
    }

    const authEmail = createInternalAuthEmail(row.memberNumber)
    const contactEmail = row.email ?? authEmail
    const temporaryPassword = `Temp${crypto.randomUUID().replace(/-/g, '')}Aa1`
    // Member provisioning still goes through Supabase Auth's admin API
    // (createAuthUser/deleteAuthUser) — that's a separate seam
    // (lib/auth/session, Supabase Auth) from `lib/db` (Postgres/profiles),
    // and is out of scope for this migration. Only the `profiles` table
    // access below moves to Drizzle.
    const authAdmin = createSupabaseServerAdminClient()
    const { data: authData, error: createAuthError } = await createAuthUser(authAdmin, {
      email: authEmail,
      password: temporaryPassword,
      email_confirm: true,
    })

    if (createAuthError || !authData.user) {
      return {
        created: 0,
        updated: 0,
        normalizedRow: null,
        issue: { rowNumber: row.rowNumber, memberNumber: row.memberNumber, code: 'create_auth_failed' as const },
      }
    }

    let persistedProfile: { id: string } | undefined
    try {
      // Under the legacy Supabase setup, a DB trigger auto-created the
      // matching `profiles` row whenever an `auth.users` row was created, so
      // this step only had to UPDATE it. Neon/Drizzle has no such trigger
      // (see lib/db/schema/profiles.ts), so the `profiles` row must be
      // explicitly INSERTed here, keyed by the new auth user's id, or
      // nothing is ever persisted for brand-new members.
      ;[persistedProfile] = await db
        .insert(profiles)
        .values({
          id: authData.user.id,
          memberNumber: row.memberNumber,
          fullName: row.fullName,
          authEmail,
          email: contactEmail,
          phone: row.phone,
          role: 'member',
          isActive: false,
          activeFrom: null,
          pswChanged: null,
        })
        .returning({ id: profiles.id })
    } catch {
      persistedProfile = undefined
    }

    if (!persistedProfile) {
      await deleteAuthUser(authAdmin, authData.user.id)
      return {
        created: 0,
        updated: 0,
        normalizedRow: null,
        issue: { rowNumber: row.rowNumber, memberNumber: row.memberNumber, code: 'persist_import_failed' as const },
      }
    }

    return {
      created: 1,
      updated: 0,
      normalizedRow: {
        ...row,
        email: contactEmail,
      },
      issue: null,
    }
  }

  let createdCount = 0
  let updatedCount = 0

  for (let index = 0; index < normalizedRows.length; index += concurrencyLimit) {
    const batch = normalizedRows.slice(index, index + concurrencyLimit)
    const results = await Promise.all(batch.map((row) => processImportRow(row)))

    for (const result of results) {
      createdCount += result.created
      updatedCount += result.updated
      if (result.normalizedRow) {
        auditedRows.push(result.normalizedRow)
      }
      if (result.issue) {
        pushImportIssue(issues, result.issue)
      }
    }
  }

  return {
    totalRows,
    createdCount,
    updatedCount,
    skippedCount: issues.length,
    normalizedRows: auditedRows.slice(0, MEMBER_IMPORT_PREVIEW_LIMIT),
    issues,
  }
}

export async function importMembersFromCsv(session: SessionUser, input: string): Promise<MemberImportResult> {
  requireAdminSession(session)
  const parsed = parseMemberImportCsv(input)
  return importMembersFromNormalizedRows(parsed)
}

export async function importMembersFromSource(
  session: SessionUser,
  input: {
    fileName: string
    contentType?: string | null
    bytes: Uint8Array
  },
): Promise<MemberImportResult> {
  requireAdminSession(session)
  const normalized = await normalizeMemberImportSource(input)
  return importMembersFromNormalizedRows(normalized)
}

export async function listPaginatedUsers(
  session: SessionUser,
  input: {
    page: number
    limit: number
    search?: string
  },
): Promise<PaginatedResponse<User>> {
  requireAdminSession(session)
  const page = normalizePage(input.page)
  const limit = normalizeLimit(input.limit)
  const search = input.search?.trim() ?? ''
  const db = getDrizzleAdminDb()

  let whereClause: SQL | undefined
  if (search) {
    const sanitized = sanitizeSearchTerm(search)
    if (sanitized) {
      const pattern = `%${escapeLikeWildcards(sanitized)}%`
      whereClause = or(
        ilike(profiles.memberNumber, pattern),
        ilike(profiles.fullName, pattern),
        ilike(profiles.email, pattern),
      )
    }
  }

  const [rows, countRows] = await runQuery(
    Promise.all([
      db
        .select(PROFILE_COLUMNS)
        .from(profiles)
        .where(whereClause)
        .orderBy(asc(profiles.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(profiles).where(whereClause),
    ]),
  )

  const total = countRows[0]?.value ?? 0
  return {
    data: rows.map(toPublicUser),
    total,
    page,
    limit,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  }
}

export async function updateUser(
  session: SessionUser,
  id: string,
  body: { memberNumber?: unknown; fullName?: unknown; email?: unknown; phone?: unknown; role?: unknown; is_active?: unknown }
) {
  requireAdminSession(session)
  const updates: ProfileUpdate = {}
  let nextMemberNumber: string | null = null
  if (body.memberNumber !== undefined) {
    const parsed = memberNumberSchema.safeParse(String(body.memberNumber))
    if (!parsed.success) {
      serviceError('Invalid member number format', 400)
    }
    updates.memberNumber = parsed.data
    nextMemberNumber = parsed.data
  }
  if (body.fullName !== undefined) {
    const fullName = String(body.fullName).trim()
    if (!fullName) {
      serviceError('Full name is required', 400)
    }
    updates.fullName = fullName
  }
  if (body.email !== undefined) {
    assertNullableStringField(body.email, 'Email')
    updates.email = sanitizeOptionalUpdateValue(body.email)
  }
  if (body.phone !== undefined) {
    assertNullableStringField(body.phone, 'Phone')
    updates.phone = sanitizeOptionalUpdateValue(body.phone)
  }
  if (body.role === 'admin' || body.role === 'member') updates.role = body.role
  if (typeof body.is_active === 'boolean') updates.isActive = body.is_active

  if (Object.keys(updates).length === 0) {
    serviceError('No updatable fields provided', 400)
  }

  const db = getDrizzleAdminDb()
  let existingProfile: PublicProfileRow | undefined
  try {
    ;[existingProfile] = await db.select(PROFILE_COLUMNS).from(profiles).where(eq(profiles.id, id)).limit(1)
  } catch {
    serviceError('Internal server error', 500)
  }
  if (!existingProfile) {
    serviceError('User not found', 404)
  }

  const existingInternalAuthEmail = createInternalAuthEmail(existingProfile.memberNumber)
  if (
    nextMemberNumber !== null
    && nextMemberNumber !== existingProfile.memberNumber
    && existingProfile.authEmail === existingInternalAuthEmail
  ) {
    updates.authEmail = createInternalAuthEmail(nextMemberNumber)
  }

  const previousMemberNumber = existingProfile.memberNumber
  const previousAuthEmail = existingProfile.authEmail
  updates.updatedAt = new Date()
  let data: PublicProfileRow | undefined
  try {
    ;[data] = await db.update(profiles).set(updates).where(eq(profiles.id, id)).returning(PROFILE_COLUMNS)
  } catch {
    serviceError('Internal server error', 500)
  }
  if (!data) {
    serviceError('User not found', 404)
  }

  if (typeof updates.authEmail === 'string') {
    // Auth credential alignment is a Supabase Auth admin-API call, a
    // different seam from `lib/db` — see the note in
    // importMembersFromNormalizedRows above.
    const authAdmin = createSupabaseServerAdminClient()
    const { error: authUpdateError } = await updateAuthUserById(authAdmin, id, { email: updates.authEmail })

    if (authUpdateError) {
      try {
        await db
          .update(profiles)
          .set({
            memberNumber: previousMemberNumber,
            authEmail: previousAuthEmail,
            updatedAt: new Date(),
          })
          .where(eq(profiles.id, id))
      } catch {
        // Best-effort rollback of the member_number/auth_email pair — proceed
        // to the 500 below regardless of whether the rollback itself
        // succeeded, same as the previous (unchecked) Supabase-era behavior.
      }
      serviceError('Failed to keep auth credentials aligned', 500)
    }
  }

  return toPublicUser(data)
}

export async function resetNoShows(session: SessionUser, id: string) {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db
      .update(profiles)
      .set({ noShowCount: 0, blockedUntil: null, updatedAt: new Date() })
      .where(eq(profiles.id, id))
      .returning({ id: profiles.id }),
  )
  if (!row) serviceError('User not found', 404)
}

export async function unblockUser(session: SessionUser, id: string) {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db
      .update(profiles)
      .set({ blockedUntil: null, updatedAt: new Date() })
      .where(eq(profiles.id, id))
      .returning({ id: profiles.id }),
  )
  if (!row) serviceError('User not found', 404)
}

export async function deleteUser(session: SessionUser, id: string) {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()
  let existing: { id: string } | undefined
  try {
    ;[existing] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, id)).limit(1)
  } catch {
    serviceError('Internal server error', 500)
  }
  if (!existing) {
    serviceError('User not found', 404)
  }

  // Deleting the Supabase Auth user is a separate seam (lib/auth/session,
  // Supabase Auth admin API) from `lib/db` (Postgres/profiles) — see the
  // note in importMembersFromNormalizedRows above. It is out of scope for
  // this migration; only the existence check above moved to Drizzle.
  const authAdmin = createSupabaseServerAdminClient()
  const { error: deleteError } = await deleteAuthUser(authAdmin, id)
  if (deleteError) {
    serviceError('Internal server error', 500)
  }
}
