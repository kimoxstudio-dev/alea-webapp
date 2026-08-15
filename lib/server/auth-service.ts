import type { User } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth'
import { createHash, randomBytes } from 'node:crypto'
import { serviceError } from '@/lib/server/service-error'
import { getClerkSession, getClerkUser } from '@/lib/server/session'
import { clerkClient } from '@clerk/nextjs/server'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/profile-mappers'
import { sql } from '@/lib/db/client'

/**
 * Raw-SQL, Clerk-backed auth service (#299, pass 2).
 *
 * This file is now fully Supabase-free — pass 1 ported the activation/
 * recovery token machinery to Neon; this pass closes the gap flagged in
 * pass 1's handoff by migrating `getCurrentUser`/`logout` and by replacing
 * `login`/`register` (see their removal note near the bottom of this file).
 *
 * PRODUCT CONSTRAINT this entire file is built around (closed issue #206,
 * confirmed by reading it before writing any of this): this club has NO
 * open self-registration. Every member must already exist as a
 * `profiles` row (admin-imported, e.g. via `users-service.ts` CSV import)
 * before they can ever become active. A Clerk identity — sign-up or
 * sign-in — must NEVER by itself produce a usable/active profile. The only
 * way an inactive, pre-registered profile becomes active is
 * `activateAccount()` below, gated on an admin-issued, 24h, single-use
 * token AND a matching Clerk-verified email.
 */

function hashActivationToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function createActivationToken() {
  return randomBytes(32).toString('hex')
}

function isActivationExpired(expiresAt: string, currentTime: Date) {
  return new Date(expiresAt).getTime() <= currentTime.getTime()
}

/**
 * Neon-backed "database now" helper, local to this file (#299).
 *
 * `lib/server/database-time.ts` is Supabase-RPC-backed (`get_database_time`)
 * and is still relied on by several not-yet-migrated Supabase services
 * (reservations-service, tables-service, rooms-service,
 * reservation-no-show.ts) — it is intentionally left untouched. This is the
 * Neon-era equivalent, scoped to the raw-SQL functions in this file only.
 */
async function getNeonDatabaseNow(): Promise<Date> {
  const rows = await sql`SELECT now() AS now` as { now: string }[]
  const value = new Date(rows[0]?.now ?? '')
  if (isNaN(value.getTime())) {
    serviceError('Internal server error', 500)
  }
  return value
}

type ActivationTokenRow = {
  id: string
  profile_id: string
  token_hash: string
  expires_at: string
  used_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
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

async function getActivationTokenByHash(tokenHash: string): Promise<ActivationTokenRow | null> {
  const rows = await sql`
    SELECT id, profile_id, token_hash, expires_at, used_at, created_by, created_at, updated_at
    FROM activation_tokens
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  ` as ActivationTokenRow[]
  return rows[0] ?? null
}

const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000

export type ActivationLinkState =
  | { status: 'valid'; memberNumber: string; fullName: string | null }
  | { status: 'expired' | 'used' | 'invalid'; memberNumber: null; fullName: null }

export type RecoveryLinkState =
  | { status: 'valid'; memberNumber: string; fullName: string | null }
  | { status: 'expired' | 'used' | 'invalid'; memberNumber: null; fullName: null }

export async function getActivationLinkState(token: string): Promise<ActivationLinkState> {
  if (!token) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }

  const tokenHash = hashActivationToken(token)
  const activationToken = await getActivationTokenByHash(tokenHash)

  if (!activationToken) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }
  if (activationToken.used_at) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getNeonDatabaseNow()
  if (isActivationExpired(activationToken.expires_at, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getProfileById(activationToken.profile_id)
  if (!profile || profile.is_active) {
    return { status: 'used', memberNumber: null, fullName: null }
  }

  return {
    status: 'valid',
    memberNumber: profile.member_number,
    fullName: profile.full_name ?? null,
  }
}

export async function generateActivationLink(input: {
  userId: string
  locale: string
  baseUrl: string
  createdBy: string
}) {
  const profile = await getProfileById(input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can be activated', 400)
  }
  if (profile.is_active) {
    serviceError('This member is already active', 400)
  }

  const token = createActivationToken()
  const databaseNow = await getNeonDatabaseNow()
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)

  await sql`
    INSERT INTO activation_tokens (profile_id, token_hash, expires_at, created_by, used_at)
    VALUES (${profile.id}, ${hashActivationToken(token)}, ${expiresAt.toISOString()}, ${input.createdBy}, NULL)
    ON CONFLICT (profile_id) DO UPDATE SET
      token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      created_by = EXCLUDED.created_by,
      used_at = NULL,
      updated_at = now()
  `

  return {
    activationLink: `${input.baseUrl}/${input.locale}/activate?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export async function getRecoveryLinkState(token: string): Promise<RecoveryLinkState> {
  if (!token) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }

  const tokenHash = hashActivationToken(token)
  const recoveryToken = await getActivationTokenByHash(tokenHash)

  if (!recoveryToken) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }
  if (recoveryToken.used_at) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getNeonDatabaseNow()
  if (isActivationExpired(recoveryToken.expires_at, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getProfileById(recoveryToken.profile_id)
  if (!profile || !profile.is_active) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }

  return {
    status: 'valid',
    memberNumber: profile.member_number,
    fullName: profile.full_name ?? null,
  }
}

export async function generateRecoveryLink(input: {
  userId: string
  locale: string
  baseUrl: string
  createdBy: string
}) {
  const profile = await getProfileById(input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can receive recovery links', 400)
  }
  if (!profile.is_active) {
    serviceError('This member must activate the account before using recovery', 400)
  }

  const token = createActivationToken()
  const databaseNow = await getNeonDatabaseNow()
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)

  await sql`
    INSERT INTO activation_tokens (profile_id, token_hash, expires_at, created_by, used_at)
    VALUES (${profile.id}, ${hashActivationToken(token)}, ${expiresAt.toISOString()}, ${input.createdBy}, NULL)
    ON CONFLICT (profile_id) DO UPDATE SET
      token_hash = EXCLUDED.token_hash,
      expires_at = EXCLUDED.expires_at,
      created_by = EXCLUDED.created_by,
      used_at = NULL,
      updated_at = now()
  `

  return {
    recoveryLink: `${input.baseUrl}/${input.locale}/recover?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

async function getVerifiedClerkEmail(): Promise<{ userId: string; email: string } | null> {
  const clerkSession = await getClerkSession()
  if (!clerkSession) {
    return null
  }
  const clerkUser = await getClerkUser()
  const email = clerkUser?.primaryEmailAddress?.emailAddress?.trim().toLowerCase() ?? null
  if (!email) {
    return null
  }
  return { userId: clerkSession.userId, email }
}

/**
 * Claims an admin-issued activation link, activating a pre-registered
 * profile for the caller's already-authenticated Clerk identity (#299 pass
 * 2 — replaces the pre-Clerk `{ token, password }` version).
 *
 * Re-expresses every gate from closed issue #206 for Clerk:
 *   - Never creates a `profiles` row — only an already-existing,
 *     `is_active = false` row (admin pre-registered) can be activated.
 *   - Token must be valid, unexpired (24h — `ACTIVATION_WINDOW_MS`), and
 *     unused; claimed atomically below so two concurrent claims cannot both
 *     succeed.
 *   - NEW, Clerk-specific: the caller must already hold an authenticated
 *     Clerk session (i.e. must have completed Clerk sign-up/sign-in BEFORE
 *     calling this — the frontend must sequence that), and that session's
 *     verified email must case-insensitively match the target profile's
 *     `email` or `auth_email`. This is what stands in for "type the
 *     password the admin doesn't know" from the old flow: proof that the
 *     caller is the person the admin pre-registered, not just someone who
 *     obtained the token URL (e.g. a forwarded/leaked email). Without this
 *     check, any Clerk account could claim any valid token.
 *   - `password` is no longer part of the input — Clerk owns credentials;
 *     "set a new password" from #206 is now "sign up with Clerk", done
 *     before this call, not inside it.
 *
 * On success: `is_active = true`, `active_from`/`psw_changed` stamped, token
 * marked used. No session is minted here — the Clerk session already
 * exists, and the very next request will resolve a real one through
 * `resolveProfileForClerkUser()` (lib/server/auth.ts), since the profile is
 * now active and its email matches.
 */
export async function activateAccount(input: { token: unknown }) {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token) {
    serviceError('Invalid activation link', 400)
  }

  const clerkIdentity = await getVerifiedClerkEmail()
  if (!clerkIdentity) {
    serviceError('Sign in first, then open the activation link again', 401)
  }

  const tokenHash = hashActivationToken(token)
  const existingToken = await getActivationTokenByHash(tokenHash)

  const databaseNow = existingToken ? await getNeonDatabaseNow() : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expires_at, databaseNow)) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (existingToken.used_at) {
    serviceError('Activation link has already been used', 400)
  }

  const profile = await getProfileById(existingToken.profile_id)
  if (!profile) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (profile.is_active) {
    serviceError('Activation link has already been used', 400)
  }

  const profileEmail = profile.email?.trim().toLowerCase() ?? null
  const profileAuthEmail = profile.auth_email?.trim().toLowerCase() ?? null
  if (clerkIdentity.email !== profileEmail && clerkIdentity.email !== profileAuthEmail) {
    // Generic message — do not reveal which email the token is tied to.
    serviceError('This activation link does not match your signed-in account', 403)
  }

  const activatedAt = (await getNeonDatabaseNow()).toISOString()
  const claimedRows = await sql`
    UPDATE activation_tokens
    SET used_at = ${activatedAt}
    WHERE token_hash = ${tokenHash}
      AND expires_at > ${activatedAt}
      AND used_at IS NULL
    RETURNING id, profile_id, token_hash, expires_at, used_at, created_by, created_at, updated_at
  ` as ActivationTokenRow[]
  const claimedToken = claimedRows[0] ?? null

  if (!claimedToken) {
    const latestToken = await getActivationTokenByHash(tokenHash)
    if (latestToken?.used_at) {
      serviceError('Activation link has already been used', 400)
    }
    serviceError('Activation link is invalid or has expired', 400)
  }

  const updatedRows = await sql`
    UPDATE profiles
    SET is_active = true, active_from = ${activatedAt}, psw_changed = ${activatedAt}
    WHERE id = ${profile.id}
    RETURNING id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
  ` as PublicProfileRow[]
  const updatedProfile = updatedRows[0] ?? null

  if (!updatedProfile) {
    serviceError('Failed to activate account', 500)
  }

  return { user: toPublicUser(updatedProfile) }
}

/**
 * Claims an admin-issued recovery link to RE-LINK the caller's Clerk
 * identity/email onto an existing, already-ACTIVE profile (#299 pass 2 —
 * replaces the pre-Clerk `{ token, password }` version).
 *
 * DESIGN DECISION — mine, flagged for review at the same weight as
 * activateAccount()'s email-match gate above, since it changes what
 * "recovery" means: under Clerk, resetting a forgotten password is Clerk's
 * own native self-service flow and needs no token from us at all. The only
 * scenario left where an admin-issued single-use token still adds value is
 * a member who lost access to their original email/Clerk account entirely
 * and cannot use Clerk's own recovery — this function re-points an
 * already-active profile's `email`/`auth_email` at a NEW Clerk-verified
 * email. Confirm this is the intended product meaning of "recovery" before
 * shipping the corresponding UI — it is a genuine redesign of what this
 * mechanism does, not a mechanical port.
 *
 * Unlike activateAccount(), there is deliberately NO email-match check
 * here — re-linking to a brand-new email is the entire point, so the
 * admin-issued token itself is the sole proof of authorization (same trust
 * level the token already carried pre-Clerk). Requires an existing Clerk
 * session (sign up/in with the new email first — same sequencing as
 * activation). `is_active` must already be true; this is not a
 * first-activation path (see activateAccount() for that).
 */
export async function recoverAccount(input: { token: unknown }) {
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!token) {
    serviceError('Invalid recovery link', 400)
  }

  const clerkIdentity = await getVerifiedClerkEmail()
  if (!clerkIdentity) {
    serviceError('Sign in first, then open the recovery link again', 401)
  }

  const tokenHash = hashActivationToken(token)
  const existingToken = await getActivationTokenByHash(tokenHash)

  const databaseNow = existingToken ? await getNeonDatabaseNow() : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expires_at, databaseNow)) {
    serviceError('Recovery link is invalid or has expired', 400)
  }
  if (existingToken.used_at) {
    serviceError('Recovery link has already been used', 400)
  }

  const profile = await getProfileById(existingToken.profile_id)
  if (!profile || !profile.is_active) {
    serviceError('Recovery link is invalid or has expired', 400)
  }

  const recoveredAt = (await getNeonDatabaseNow()).toISOString()
  const claimedRows = await sql`
    UPDATE activation_tokens
    SET used_at = ${recoveredAt}
    WHERE token_hash = ${tokenHash}
      AND expires_at > ${recoveredAt}
      AND used_at IS NULL
    RETURNING id, profile_id, token_hash, expires_at, used_at, created_by, created_at, updated_at
  ` as ActivationTokenRow[]
  const claimedToken = claimedRows[0] ?? null

  if (!claimedToken) {
    const latestToken = await getActivationTokenByHash(tokenHash)
    if (latestToken?.used_at) {
      serviceError('Recovery link has already been used', 400)
    }
    serviceError('Recovery link is invalid or has expired', 400)
  }

  let updatedRows: PublicProfileRow[]
  try {
    updatedRows = await sql`
      UPDATE profiles
      SET email = ${clerkIdentity.email}, auth_email = ${clerkIdentity.email}, psw_changed = ${recoveredAt}
      WHERE id = ${profile.id}
      RETURNING id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
    ` as PublicProfileRow[]
  } catch {
    // auth_email is UNIQUE — the new Clerk email is already tied to a
    // different profile row.
    serviceError('This email is already associated with another account', 409)
  }
  const updatedProfile = updatedRows[0] ?? null

  if (!updatedProfile) {
    serviceError('Failed to recover account', 500)
  }

  return { user: toPublicUser(updatedProfile) }
}

type ClerkProfileMatchRow = {
  id: string
  role: 'member' | 'admin'
  is_active: boolean
}

/**
 * Maps an authenticated Clerk identity to the member domain model,
 * READ-ONLY (#299 pass 2 — renamed from `resolveOrCreateProfileForClerkUser`
 * in pass 1, which auto-created a pending `profiles` row for any unmatched
 * email; that behavior is REMOVED here per the explicit product constraint
 * confirmed by reading closed issue #206: this club has no open
 * self-registration. Only an admin-pre-registered `profiles` row (e.g. via
 * `users-service.ts` CSV import) may ever exist, and only
 * `activateAccount()` above — gated on an admin-issued token AND a matching
 * Clerk-verified email — may ever flip one to active.
 *
 * A Clerk identity with no matching pre-existing profile now resolves to
 * `null`, full stop: no row is created, no side effect happens at all. This
 * is the fix for the "brand-new signup gets permanently stuck" gap flagged
 * in pass 1's handoff — there is no longer a stuck row to begin with, since
 * none is ever created outside the admin-import + activation-token path.
 *
 * Correlation strategy (unchanged from pass 1): EMAIL match against
 * `profiles.email` / `profiles.auth_email` (case-insensitive). No schema
 * change — see `lib/db/schema/003_profiles.sql`'s doc comment.
 *
 * Called from `lib/server/auth.ts` on every request carrying a Clerk
 * session.
 */
export async function resolveProfileForClerkUser(input: {
  email: string
}): Promise<SessionUser | null> {
  const normalizedEmail = input.email.trim().toLowerCase()
  if (!normalizedEmail) {
    return null
  }

  const rows = await sql`
    SELECT id, role, is_active
    FROM profiles
    WHERE lower(email) = ${normalizedEmail} OR lower(auth_email) = ${normalizedEmail}
    LIMIT 1
  ` as ClerkProfileMatchRow[]
  const profile = rows[0]

  if (!profile || !profile.is_active) {
    return null
  }

  return { id: profile.id, role: profile.role }
}

/**
 * Returns the public User for a resolved session (#299 pass 2 — migrated
 * from a Supabase `.from('profiles')` lookup to raw SQL). Session shape is
 * unchanged (`SessionUser` from `lib/server/auth.ts`, Clerk-resolved since
 * pass 1) — this function only had to stop querying the wrong (Supabase)
 * database; nothing about its contract changed.
 */
export async function getCurrentUser(session: SessionUser | null): Promise<User> {
  if (!session) {
    serviceError('Unauthorized', 401)
  }

  const profile = await getProfileById(session.id)
  if (!profile) {
    serviceError('Unauthorized', 401)
  }

  return toPublicUser(profile)
}

/**
 * Ends the current session (#299 pass 2 — migrated from
 * `supabase.auth.signOut()` / `logoutWithClient()`).
 *
 * Clerk's own client-side SDK (`useClerk().signOut()` /
 * `<SignOutButton/>`) is what actually clears the browser's session
 * cookie — that must be wired by the frontend (out of scope here). This is
 * the server-side counterpart: it revokes the current Clerk session via the
 * Backend API (`clerkClient().sessions.revokeSession()`), so the session
 * token cannot be reused even if the client-side cookie clear is
 * skipped — the direct analog of the old `supabase.auth.signOut()` call
 * this replaces.
 *
 * `logoutWithClient()` is REMOVED, not kept as a deprecated alias: it
 * existed only to inject a test-double Supabase client; Clerk's `auth()`
 * reads from the request context directly, so there is nothing analogous
 * to inject, and no caller needs it once `logout()` takes no parameters.
 */
export async function logout() {
  const clerkSession = await getClerkSession()
  if (!clerkSession) {
    return { success: true }
  }

  try {
    const client = await clerkClient()
    await client.sessions.revokeSession(clerkSession.sessionId)
  } catch {
    serviceError('Internal server error', 500)
  }

  return { success: true }
}

/**
 * REMOVED (#299 pass 2): `login()` and `register()`.
 *
 * `register()` was already fully dead before this pass — confirmed by
 * reading both call sites: `app/api/auth/register/route.ts` already returns
 * a hardcoded `410 Gone` ("Self-registration is disabled...") without
 * calling this file at all, and `app/[locale]/register/page.tsx` already
 * unconditionally redirects to `/login`. Both were already disabled by
 * closed issue #206, well before this migration. There was no live code
 * path left to port — deleting it is not a design decision, just removing
 * confirmed-dead code.
 *
 * `login()` was still LIVE (route still called it) but is deleted here as a
 * deliberate design decision, not a dead-code removal: it verified a
 * member-number + password pair against a Supabase Auth session
 * (`signInWithPassword`). There is no data left anywhere for that check to
 * run against — `profiles` has no password column, and Clerk (not this
 * service) is now the only credential store. "Migrating" this function to
 * raw SQL is not possible even in principle: there is nothing in Neon to
 * check a password against. The Clerk-era replacement for "log in" is
 * Clerk's own hosted sign-in UI (`app/[locale]/sign-in`, currently
 * disabled — re-enabling it and wiring `app/api/auth/login/route.ts`
 * accordingly is the next, frontend-owned step; see this task's handoff).
 */
