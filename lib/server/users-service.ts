import type { MemberImportIssue, MemberImportResult, MemberImportRow, PaginatedResponse, User } from '@/lib/types'
import { serviceError } from '@/lib/server/service-error'
import { memberNumberSchema } from '@/lib/validations/auth'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/profile-mappers'
import { sql } from '@/lib/db/client'
import {
  type MemberImportOptionalColumnPresence,
  MEMBER_IMPORT_PREVIEW_LIMIT,
  parseMemberImportCsv,
  normalizeMemberImportSource,
  pushImportIssue,
} from '@/lib/server/member-import'

/**
 * Raw-SQL Neon port of the admin user-lifecycle service (#299).
 *
 * Admin-only role gating for every exported function here still happens at
 * the route layer (`app/api/users/**`, via `requireAdmin()` in
 * `lib/server/auth.ts`) exactly as before this migration — these functions
 * do not additionally call `lib/server/authz.ts`'s `requireAdminRole()`
 * themselves. Threading a `SessionUser` through would require changing the
 * exported signatures here AND their call sites in `app/api/users/**`,
 * which is outside this ticket's backend-only scope (`app/` is off limits —
 * see this task's hard constraints). Flagged explicitly in the handoff
 * message as a small, well-scoped follow-up. There are no member-scoped
 * reads in this file (everything here is admin-lifecycle, operating across
 * all members by design), so `assertMemberRowsScopedSql()` does not apply.
 *
 * Credential/identity-provider coupling was also removed, not replaced:
 * the pre-migration version of this file created/deleted a Supabase Auth
 * user alongside each profile row, and kept `auth_email` in sync with
 * Supabase Auth on `updateUser()`. Clerk now owns credentials; there is no
 * per-member identity-provider account to create/sync/delete here anymore.
 * `auth_email` remains plain data on the `profiles` row (still used as one
 * of the two correlation keys in `resolveProfileForClerkUser()`, see
 * `lib/server/auth-service.ts`). As of #299 pass 2, that lookup is
 * read-only — this file (admin CSV import, etc.) is the ONLY place a
 * `profiles` row is ever created; no self-service path creates one.
 */

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

async function getProfileById(id: string): Promise<PublicProfileRow | null> {
  const rows = await sql`
    SELECT id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
    FROM profiles
    WHERE id = ${id}
    LIMIT 1
  ` as PublicProfileRow[]
  return rows[0] ?? null
}

async function getProfileByMemberNumber(memberNumber: string): Promise<PublicProfileRow | null> {
  const rows = await sql`
    SELECT id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
    FROM profiles
    WHERE member_number = ${memberNumber}
    LIMIT 1
  ` as PublicProfileRow[]
  return rows[0] ?? null
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
  const concurrencyLimit = 10

  async function processImportRow(row: MemberImportRow) {
    let existing: PublicProfileRow | null
    try {
      existing = await getProfileByMemberNumber(row.memberNumber)
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
      const nextFullName = row.fullName
      const nextEmail = input.optionalColumnPresence.email ? resolvedEmail : existing.email
      const nextPhone = input.optionalColumnPresence.phone ? row.phone : existing.phone
      const normalizedRow: MemberImportRow = {
        ...row,
        email: input.optionalColumnPresence.email ? resolvedEmail : (existing.email ?? null),
        phone: input.optionalColumnPresence.phone ? row.phone : (existing.phone ?? null),
      }

      try {
        await sql`
          UPDATE profiles
          SET full_name = ${nextFullName}, email = ${nextEmail}, phone = ${nextPhone}
          WHERE id = ${existing.id}
        `
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

    try {
      await sql`
        INSERT INTO profiles (id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, psw_changed)
        VALUES (gen_random_uuid(), ${row.memberNumber}, ${row.fullName}, ${authEmail}, ${contactEmail}, ${row.phone}, 'member', false, NULL, NULL)
      `
    } catch {
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

export async function importMembersFromCsv(input: string): Promise<MemberImportResult> {
  const parsed = parseMemberImportCsv(input)
  return importMembersFromNormalizedRows(parsed)
}

export async function importMembersFromSource(input: {
  fileName: string
  contentType?: string | null
  bytes: Uint8Array
}): Promise<MemberImportResult> {
  const normalized = await normalizeMemberImportSource(input)
  return importMembersFromNormalizedRows(normalized)
}

export async function listPaginatedUsers(input: {
  page: number
  limit: number
  search?: string
}): Promise<PaginatedResponse<User>> {
  const page = normalizePage(input.page)
  const limit = normalizeLimit(input.limit)
  const search = input.search?.trim() ?? ''
  const offset = (page - 1) * limit

  let pattern: string | null = null
  if (search) {
    const sanitized = sanitizeSearchTerm(search)
    if (sanitized) {
      pattern = `%${escapeLikeWildcards(sanitized)}%`
    }
  }

  let total: number
  let rows: PublicProfileRow[]

  if (pattern) {
    const countRows = await sql`
      SELECT COUNT(*)::int AS count
      FROM profiles
      WHERE member_number ILIKE ${pattern} OR full_name ILIKE ${pattern} OR email ILIKE ${pattern}
    ` as { count: number }[]
    total = countRows[0]?.count ?? 0

    rows = await sql`
      SELECT id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
      FROM profiles
      WHERE member_number ILIKE ${pattern} OR full_name ILIKE ${pattern} OR email ILIKE ${pattern}
      ORDER BY created_at ASC
      LIMIT ${limit} OFFSET ${offset}
    ` as PublicProfileRow[]
  } else {
    const countRows = await sql`SELECT COUNT(*)::int AS count FROM profiles` as { count: number }[]
    total = countRows[0]?.count ?? 0

    rows = await sql`
      SELECT id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
      FROM profiles
      ORDER BY created_at ASC
      LIMIT ${limit} OFFSET ${offset}
    ` as PublicProfileRow[]
  }

  return {
    data: rows.map(toPublicUser),
    total,
    page,
    limit,
    totalPages: total === 0 ? 0 : Math.ceil(total / limit),
  }
}

export async function updateUser(
  id: string,
  body: { memberNumber?: unknown; fullName?: unknown; email?: unknown; phone?: unknown; role?: unknown; is_active?: unknown }
) {
  let nextMemberNumberInput: string | undefined
  let nextFullNameInput: string | undefined
  let emailProvided = false
  let nextEmailInput: string | null = null
  let phoneProvided = false
  let nextPhoneInput: string | null = null
  let nextRoleInput: 'admin' | 'member' | undefined
  let nextIsActiveInput: boolean | undefined

  if (body.memberNumber !== undefined) {
    const parsed = memberNumberSchema.safeParse(String(body.memberNumber))
    if (!parsed.success) {
      serviceError('Invalid member number format', 400)
    }
    nextMemberNumberInput = parsed.data
  }
  if (body.fullName !== undefined) {
    const fullName = String(body.fullName).trim()
    if (!fullName) {
      serviceError('Full name is required', 400)
    }
    nextFullNameInput = fullName
  }
  if (body.email !== undefined) {
    assertNullableStringField(body.email, 'Email')
    emailProvided = true
    nextEmailInput = sanitizeOptionalUpdateValue(body.email)
  }
  if (body.phone !== undefined) {
    assertNullableStringField(body.phone, 'Phone')
    phoneProvided = true
    nextPhoneInput = sanitizeOptionalUpdateValue(body.phone)
  }
  if (body.role === 'admin' || body.role === 'member') nextRoleInput = body.role
  if (typeof body.is_active === 'boolean') nextIsActiveInput = body.is_active

  if (
    nextMemberNumberInput === undefined
    && nextFullNameInput === undefined
    && !emailProvided
    && !phoneProvided
    && nextRoleInput === undefined
    && nextIsActiveInput === undefined
  ) {
    serviceError('No updatable fields provided', 400)
  }

  const existingProfile = await getProfileById(id)
  if (!existingProfile) {
    serviceError('User not found', 404)
  }

  const nextMemberNumber = nextMemberNumberInput ?? existingProfile.member_number
  const nextFullName = nextFullNameInput ?? existingProfile.full_name
  const nextEmail = emailProvided ? nextEmailInput : existingProfile.email
  const nextPhone = phoneProvided ? nextPhoneInput : existingProfile.phone
  const nextRole = nextRoleInput ?? existingProfile.role
  const nextIsActive = nextIsActiveInput ?? existingProfile.is_active

  const existingInternalAuthEmail = createInternalAuthEmail(existingProfile.member_number)
  let nextAuthEmail = existingProfile.auth_email
  if (
    nextMemberNumberInput !== undefined
    && nextMemberNumberInput !== existingProfile.member_number
    && existingProfile.auth_email === existingInternalAuthEmail
  ) {
    nextAuthEmail = createInternalAuthEmail(nextMemberNumberInput)
  }

  let updatedRows: PublicProfileRow[]
  try {
    updatedRows = await sql`
      UPDATE profiles
      SET member_number = ${nextMemberNumber},
          full_name = ${nextFullName},
          email = ${nextEmail},
          phone = ${nextPhone},
          role = ${nextRole},
          is_active = ${nextIsActive},
          auth_email = ${nextAuthEmail}
      WHERE id = ${id}
      RETURNING id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
    ` as PublicProfileRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const data = updatedRows[0]
  if (!data) {
    serviceError('User not found', 404)
  }

  return toPublicUser(data)
}

export async function resetNoShows(id: string) {
  const rows = await sql`
    UPDATE profiles
    SET no_show_count = 0, blocked_until = NULL
    WHERE id = ${id}
    RETURNING id
  ` as { id: string }[]

  if (!rows[0]) {
    serviceError('User not found', 404)
  }
}

export async function unblockUser(id: string) {
  const rows = await sql`
    UPDATE profiles
    SET blocked_until = NULL
    WHERE id = ${id}
    RETURNING id
  ` as { id: string }[]

  if (!rows[0]) {
    serviceError('User not found', 404)
  }
}

export async function deleteUser(id: string) {
  // ON DELETE CASCADE on activation_tokens.profile_id (lib/db/schema/013_activation_tokens.sql)
  // removes any pending activation/recovery token for this profile automatically.
  const rows = await sql`
    DELETE FROM profiles
    WHERE id = ${id}
    RETURNING id
  ` as { id: string }[]

  if (!rows[0]) {
    serviceError('User not found', 404)
  }
}
