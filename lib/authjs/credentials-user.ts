import 'server-only'
import bcrypt from 'bcryptjs'
import { eq } from 'drizzle-orm'
import { getDrizzleDb } from '@/lib/db'
import { profiles } from '@/lib/db/schema'

export interface AuthJsUser {
  id: string
  email: string
  name?: string | null
  role: 'member' | 'admin'
  isActive: boolean
}

/**
 * Looks up a user by `profiles.auth_email` (via the Drizzle/Neon seam,
 * `getDrizzleDb()` — see `lib/db/index.ts`) and verifies the supplied
 * password against `profiles.password_hash`.
 *
 * Keyed on `auth_email` — not `profiles.email` — because every caller
 * (`login()`, `activateAccount()`, `recoverAccount()` in
 * `lib/server/auth/auth-service.ts`) resolves a profile first and then
 * signs in using that profile's `auth_email` (falling back to `email` only
 * if `auth_email` were ever absent, which the `NOT NULL` constraint on that
 * column prevents in practice). `auth_email` also carries a DB-level unique
 * index (`profiles_auth_email_key`), unlike `email`, which has none — so a
 * lookup here can only ever match the single profile whose `auth_email` was
 * passed in, closing off the cross-profile identity-drift that querying by
 * the non-unique `email` column previously allowed (KIM-433 follow-up fix).
 *
 * `password_hash` is expected to be bcryptjs-compatible. During the
 * transitional Auth.js runtime it is populated by the Neon seed/account
 * lifecycle paths; KIM-451 replaces this runtime with Clerk.
 *
 * This is defensive scaffolding: the schema column exists, but the data
 * behind it does not yet. Any failure — connection error, no matching row,
 * a `null` password_hash, an inactive (`is_active: false`) profile, or a
 * wrong password — resolves to `null` uniformly so callers can never infer
 * whether a given email exists (or whether it exists but is suspended).
 * Failing authentication here, at the point of credential verification —
 * rather than relying solely on `getSessionUser()`'s downstream
 * `is_active` re-check (`lib/server/auth/auth.ts`) — means the Credentials
 * provider never issues a session token for a suspended profile in the
 * first place.
 *
 * This route is also gated 404-by-default behind `AUTH_JS_ENABLED` (see
 * app/api/authjs/[...nextauth]/route.ts). KIM-451 removes this transitional
 * runtime in favor of Clerk.
 */
export async function verifyCredentials(
  authEmail: string,
  password: string
): Promise<AuthJsUser | null> {
  try {
    const db = getDrizzleDb()
    const [row] = await db
      .select({
        id: profiles.id,
        email: profiles.email,
        fullName: profiles.fullName,
        passwordHash: profiles.passwordHash,
        role: profiles.role,
        isActive: profiles.isActive,
      })
      .from(profiles)
      .where(eq(profiles.authEmail, authEmail))
      .limit(1)

    if (!row || !row.isActive || !row.passwordHash) {
      return null
    }

    const passwordMatches = await bcrypt.compare(password, row.passwordHash)

    if (!passwordMatches) {
      return null
    }

    return {
      id: row.id,
      email: row.email ?? authEmail,
      name: row.fullName,
      role: row.role,
      isActive: row.isActive,
    }
  } catch {
    // Connection may fail, table shape may be unexpected, etc. Never leak
    // internals — treat every failure as "no such user" from the caller's
    // perspective.
    return null
  }
}
