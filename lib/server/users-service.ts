import type { MemberImportIssue, MemberImportResult, MemberImportRow, PaginatedResponse, User } from '@/lib/types'
import { serviceError } from '@/lib/server/service-error'
import { memberNumberSchema } from '@/lib/validations/auth'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/profile-mappers'
import { sql } from '@/lib/db/client'
import { clerkClient } from '@clerk/nextjs/server'
import { NeonDbError } from '@neondatabase/serverless'
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
 * `auth_email`/`email` remain plain contact-info columns on the `profiles`
 * row — as of #299 pass 3, `resolveProfileForClerkUser()`
 * (`lib/server/auth-service.ts`) correlates a Clerk identity to a profile
 * by USERNAME (`alea-<member_number>`), never by email; neither column is
 * read there anymore. This file (admin CSV import, etc.) remains the ONLY
 * place a `profiles` row is ever created; no self-service path creates one.
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

const CLERK_USERNAME_PREFIX = 'alea-'

/**
 * Builds the Clerk username for a member number. Mirrors
 * `toClerkUsername()` in `lib/server/auth-service.ts` (not exported from
 * there, so duplicated locally per this file's established pattern of
 * standalone helpers — see `createInternalAuthEmail()` above).
 */
function toClerkUsername(memberNumber: string): string {
  return `${CLERK_USERNAME_PREFIX}${memberNumber}`
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

  const memberNumberIsChanging = nextMemberNumberInput !== undefined
    && nextMemberNumberInput !== existingProfile.member_number

  // Clerk-first, DB-second when member_number changes (production lockout
  // defect fix — #299). Sign-in identity resolution keys off the Clerk
  // USERNAME `alea-<member_number>` (see `resolveProfileForClerkUser()` in
  // `lib/server/auth-service.ts`), not off any id persisted on `profiles`.
  // If the DATABASE were updated first and the Clerk rename below then
  // failed for any reason (network blip, Clerk outage, username already
  // taken, etc.), the two systems would go out of sync: the DB row would
  // carry the NEW member_number while the Clerk account would still answer
  // to the OLD username — so login resolution would find no matching
  // profile and the member would be locked out of their own account.
  // Doing the Clerk rename FIRST and gating the DB write on its success
  // means that on ANY failure mid-operation, both sides stay consistent on
  // the OLD member_number and the member can still sign in. DO NOT reorder
  // this to write the database first — that reproduces the lockout bug.
  //
  // That "Clerk-first" ordering has its own mirror failure mode (#299 Codex
  // review finding 2): Clerk can rename successfully and the SQL write below
  // can still fail (e.g. a `member_number` unique-constraint collision) —
  // that would leave Clerk on the NEW username while `profiles` still has
  // the OLD one, locking the member out via the same identity-resolution
  // path this comment just described. Two mitigations, both required:
  //   1. A pre-check below rejects the whole operation up front (no Clerk
  //      call at all) if `nextMemberNumberInput` already belongs to a
  //      different profile row.
  //   2. Because that pre-check can't close a TOCTOU race against a
  //      concurrent update claiming the same number, `renamedClerkUserId` is
  //      tracked so the DB-write catch block below can roll Clerk back to
  //      the OLD username if the write still fails despite the pre-check.
  let renamedClerkUserId: string | null = null

  if (memberNumberIsChanging) {
    const conflictingRows = await sql`
      SELECT id FROM profiles WHERE member_number = ${nextMemberNumberInput} AND id <> ${id} LIMIT 1
    ` as { id: string }[]
    if (conflictingRows[0]) {
      serviceError('Member number is already in use', 409)
    }

    const client = await clerkClient()
    let existingClerkUser: { id: string } | undefined
    try {
      const { data } = await client.users.getUserList({
        username: [toClerkUsername(existingProfile.member_number)],
      })
      existingClerkUser = data[0]
    } catch {
      serviceError('Internal server error', 500)
    }

    // A member who has never activated their account has no Clerk identity
    // yet — there is nothing to rename, so it's safe to proceed straight to
    // the database write in that case.
    if (existingClerkUser) {
      try {
        await client.users.updateUser(existingClerkUser.id, {
          username: toClerkUsername(nextMemberNumberInput as string),
        })
        renamedClerkUserId = existingClerkUser.id
      } catch {
        serviceError('Failed to update account credentials', 500)
      }
    }
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
  } catch (err) {
    // TOCTOU (#299 Codex review finding 2): the pre-check above passed, but
    // a concurrent update could still have claimed `nextMemberNumberInput`
    // between that check and this write. If Clerk was already renamed to
    // the new username, roll it back to the OLD one so Clerk and the
    // (unchanged) `profiles` row stay consistent and the member isn't
    // locked out of their existing credentials.
    if (renamedClerkUserId) {
      try {
        const client = await clerkClient()
        await client.users.updateUser(renamedClerkUserId, {
          username: toClerkUsername(existingProfile.member_number),
        })
      } catch (rollbackErr) {
        // Do NOT swallow this — the rollback failing means Clerk is left on
        // the NEW username while `profiles` still has the OLD member_number,
        // an inconsistent state that needs manual intervention. Log it
        // server-side; only a generic message goes to the client below.
        console.error(
          '[users-service] Clerk username rollback failed after DB write failure — Clerk/DB are now inconsistent for profile',
          id,
          rollbackErr,
        )
      }
    }

    if (err instanceof NeonDbError && err.code === '23505') {
      serviceError('Member number is already in use', 409)
    }
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
