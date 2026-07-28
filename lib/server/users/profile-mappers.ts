import 'server-only'
import type { User } from '@/lib/types'
import type { profiles } from '@/lib/db/schema'

/**
 * KIM-440 (F3c): `profiles` is now Drizzle/Neon-backed (see
 * `lib/server/users/users-service.ts`), so this mapper takes the Drizzle
 * inferred row shape (camelCase) instead of the legacy Supabase
 * `Tables<'profiles'>` (snake_case) row shape. Timestamp columns come back
 * as `Date` instances (Drizzle), not ISO strings (Supabase/PostgREST), so
 * this mapper is also responsible for the `Date -> string` conversion the
 * public `User` shape expects.
 */
type ProfileRow = typeof profiles.$inferSelect

export type PublicProfileRow = Pick<
  ProfileRow,
  | 'id'
  | 'memberNumber'
  | 'fullName'
  | 'authEmail'
  | 'email'
  | 'phone'
  | 'role'
  | 'isActive'
  | 'activeFrom'
  | 'noShowCount'
  | 'blockedUntil'
  | 'createdAt'
  | 'updatedAt'
>

export function toPublicUser(profile: PublicProfileRow): User {
  return {
    id: profile.id,
    memberNumber: profile.memberNumber,
    fullName: profile.fullName ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    role: profile.role,
    isActive: profile.isActive,
    activeFrom: profile.activeFrom ? profile.activeFrom.toISOString() : null,
    noShowCount: profile.noShowCount,
    blockedUntil: profile.blockedUntil ? profile.blockedUntil.toISOString() : null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}
