import 'server-only'
import { serviceError } from '@/lib/server/service-error'
import type { SessionUser } from '@/lib/server/auth'

/**
 * App-layer authorization seam (#298).
 *
 * Neon has no RLS, so every service migrated off Supabase must enforce
 * ownership/role checks explicitly in the service layer — never inline in
 * route handlers (see project convention in CLAUDE.md).
 *
 * This module is intentionally decoupled from any specific query builder or
 * response wrapper: it operates on plain row objects keyed by column name,
 * matching whatever shape `sql\`...\`` (lib/db/client.ts, Neon's
 * tagged-template driver) returns. `assertMemberRowsScoped()` in
 * `lib/server/data-scoping.ts` is a second, independently-live guard with the
 * same invariant (member/admin row isolation). `assertMemberRowsScoped()`
 * guards the actual member-scoped reads in `saved-games-service.ts` and
 * `reservations-service.ts`. `assertMemberRowsScopedSql()` here has no
 * production call sites as of this writing — `users-service.ts` is
 * admin-only (see its own header comment) and has no member-scoped reads to
 * guard. It is kept, generic and exported, as the intended defense-in-depth
 * seam for the next Neon service that does add a member-scoped read (per
 * the CLAUDE.md convention this module's header documents), and remains
 * covered by its own tests plus `member-row-scoping-contract.ts`.
 */

/** Minimal shape a raw-SQL row must have to be ownership-checkable. */
export type OwnedRow = { user_id: string | null | undefined }

/** True when `session` may act across users — i.e. an admin. */
export function isAdmin(session: SessionUser): boolean {
  return session.role === 'admin'
}

/**
 * Throws (403) unless `session` is an admin. Use for role-gated operations
 * that must never run as a member, regardless of ownership — e.g. an
 * admin-only mutation.
 */
export function requireAdminRole(session: SessionUser): void {
  if (!isAdmin(session)) {
    serviceError('Forbidden: admin role required', 403)
  }
}

/**
 * Throws (403) unless `session` owns `resourceOwnerId` or is an admin. Use
 * once a single row has already been fetched (e.g. a specific reservation
 * loaded by id), to verify the caller is allowed to read/mutate it.
 */
export function assertOwnsResource(
  session: SessionUser,
  resourceOwnerId: string | null | undefined,
): void {
  if (isAdmin(session)) return
  if (resourceOwnerId !== session.id) {
    serviceError('Forbidden: you do not own this resource', 403)
  }
}

/**
 * Defense-in-depth for member-scoped raw-SQL reads. The query SHOULD
 * already filter `WHERE user_id = ${session.id}`; this verifies the
 * invariant a second time, independent of the query, so a regression in the
 * filter cannot leak another member's rows. Admins are exempt (they
 * legitimately read across users).
 *
 * Generic over any row shape returned by `sql\`...\`` — unlike the
 * Supabase-era `assertMemberRowsScoped()`, this does not assume a fixed
 * client response wrapper, only that each row carries a `user_id` column.
 * Fails loudly (mirrors `assertMemberRowsScoped()`'s pattern) on any row
 * whose `user_id` does not match the session, including rows with a
 * missing/null `user_id` — a malformed row is never treated as "safe".
 */
export function assertMemberRowsScopedSql<T extends OwnedRow>(
  rows: readonly T[],
  session: SessionUser,
): readonly T[] {
  if (session.role !== 'admin' && rows.some((row) => row.user_id !== session.id)) {
    serviceError('Data isolation violation: member read returned foreign rows', 500)
  }
  return rows
}
