import type { User } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth'
import { createHash, randomBytes } from 'node:crypto'
import { serviceError } from '@/lib/server/service-error'
import { getClerkSession } from '@/lib/server/session'
import { clerkClient } from '@clerk/nextjs/server'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/profile-mappers'
import { sql } from '@/lib/db/client'
import { activationServerSchema, recoveryServerSchema } from '@/lib/validations/auth'

/**
 * Raw-SQL, Clerk-backed auth service (#299, pass 3).
 *
 * This file is now fully Supabase-free — pass 1 ported the activation/
 * recovery token machinery to Neon; pass 2 migrated `getCurrentUser`/
 * `logout` and replaced `login`/`register` (see their removal note near the
 * bottom of this file). This pass (3) corrects a wrong premise baked into
 * pass 2: identity is NOT email-based. Proven live against the real Clerk
 * dev instance (issue #267): a Clerk username of the form `alea-<member
 * number>` (e.g. `alea-100001`) can be created without any email attribute
 * (zero emails sent) and signed in with via `identifier=alea-100001`. The
 * `alea-` prefix exists purely because Clerk rejects all-numeric usernames
 * (`form_username_needs_non_number_char`) — it is internal plumbing only,
 * never shown to or typed by the member. There is NO email anywhere in the
 * identity model, no exceptions — `profiles.email`/`profiles.auth_email`
 * remain plain contact-info columns (used by `users-service.ts`), never
 * used to correlate a Clerk identity to a `profiles` row.
 *
 * PRODUCT CONSTRAINT this entire file is built around (closed issues #206,
 * #207): this club has NO open self-registration. Every member must
 * already exist as a `profiles` row (admin-imported, e.g. via
 * `users-service.ts` CSV import) before they can ever become active. A
 * Clerk identity must NEVER by itself produce a usable/active profile or a
 * usable Clerk credential. The only way an inactive, pre-registered profile
 * becomes active — and the only way its Clerk identity is ever created — is
 * `activateAccount()` below, gated on an admin-issued, 24h, single-use
 * token. There is no public self-service registration path, under any
 * circumstance.
 */

const CLERK_USERNAME_PREFIX = 'alea-'

/**
 * Builds the Clerk username for a member number. The `alea-` prefix is
 * internal plumbing only (Clerk rejects all-numeric usernames) — the member
 * never sees or types it.
 */
function toClerkUsername(memberNumber: string): string {
  return `${CLERK_USERNAME_PREFIX}${memberNumber}`
}

/**
 * Strips the `alea-` prefix from a Clerk username to recover the bare
 * member number. Returns `null` for any username that isn't shaped like one
 * this app issued (e.g. a stray Clerk identity created outside
 * `activateAccount()`).
 */
function memberNumberFromClerkUsername(username: string): string | null {
  if (!username.startsWith(CLERK_USERNAME_PREFIX)) {
    return null
  }
  const memberNumber = username.slice(CLERK_USERNAME_PREFIX.length)
  return memberNumber.length > 0 ? memberNumber : null
}

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
 * Restores a token that was already atomically claimed (`used_at` set) by
 * `activateAccount()`/`recoverAccount()`, but whose paired Clerk operation
 * then failed (#299 Codex review finding 1). Without this, a Clerk outage or
 * a rejected password after the claim permanently burns an otherwise-valid,
 * unexpired, admin-issued link even though the member was never actually
 * activated/recovered. Matched by id (not by hash/used_at) since the caller
 * already holds the exact row it just claimed.
 */
async function restoreClaimedToken(tokenId: string) {
  await sql`
    UPDATE activation_tokens
    SET used_at = NULL
    WHERE id = ${tokenId}
  `
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

/**
 * Claims an admin-issued activation link, creating the member's Clerk
 * identity and activating their pre-registered profile (#299 pass 3 —
 * replaces pass 2's email-match-gated version; re-derived from closed
 * issues #206/#207, which never mention email at all).
 *
 * Re-expresses every gate from #206/#207:
 *   - Never creates a `profiles` row — only an already-existing,
 *     `is_active = false` row (admin pre-registered) can be activated.
 *   - Token must be valid, unexpired (24h — `ACTIVATION_WINDOW_MS`), and
 *     unused; claimed atomically below (`UPDATE ... WHERE used_at IS NULL
 *     ... RETURNING`) so two concurrent claims cannot both succeed. This is
 *     the load-bearing security property: activation is impossible without
 *     a valid, unexpired, unused, admin-issued token — full stop.
 *   - `{ token, password }` is the request shape (`activationServerSchema`,
 *     `lib/validations/auth.ts`) — same shape as the pre-Clerk design.
 *     "Set a new password" from #206 happens right here: the member's Clerk
 *     identity does not exist yet (no self-service sign-up path exists), so
 *     this call both creates it AND sets its password in one step, via the
 *     Backend API (`users.createUser`).
 *   - The Clerk username is `alea-<member_number>` (`toClerkUsername()`).
 *     No email attribute is ever set — proven live against the real Clerk
 *     dev instance (issue #267) to create the identity with zero emails
 *     sent.
 *
 * On success: `is_active = true`, `active_from`/`psw_changed` stamped, token
 * marked used, Clerk identity created. No session is minted here — the very
 * next sign-in (`identifier=alea-<member_number>`) resolves a real one
 * through `resolveProfileForClerkUser()` (lib/server/auth.ts), since the
 * profile is now active.
 */
export async function activateAccount(input: { token: unknown; password: unknown }) {
  const parsed = activationServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid activation link', 400)
  }

  const tokenHash = hashActivationToken(parsed.data.token)
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

  // Token is now spent (single-use, claimed above) — create the Clerk
  // identity. No email attribute, ever.
  try {
    const client = await clerkClient()
    await client.users.createUser({
      username: toClerkUsername(profile.member_number),
      password: parsed.data.password,
    })
  } catch {
    // Clerk failure after the claim above (#299 Codex review finding 1): the
    // member was never actually activated, so the token must not stay
    // burned — restore it so the same admin-issued link can be retried.
    await restoreClaimedToken(claimedToken.id)
    serviceError('Failed to create account credentials', 500)
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
 * Claims an admin-issued recovery link, setting a NEW password on the
 * member's EXISTING Clerk identity (#299 pass 3 — replaces pass 2's
 * email-relink redesign, fully discarded per this task's instructions; not
 * a mechanical port of it).
 *
 * Re-derived directly from closed issues #206/#207, not carried forward
 * from pass 2: #207 states plainly that self-service "forgot password" is
 * replaced by an admin-mediated flow — "Allow administrators to generate a
 * password recovery link ... Force the user to set a new password through
 * that link ... Store the last password change timestamp in `psw_changed`."
 * Neither issue mentions email or a pre-existing Clerk session as part of
 * this flow. Accordingly, unlike activateAccount() there is no email
 * involved at all: the admin-issued, single-use, 24h token is the sole
 * proof of authorization (same token mechanics as activation — atomic
 * claim via `UPDATE ... WHERE used_at IS NULL ... RETURNING`), and it
 * updates the password on the Clerk identity that already exists from
 * activation — this is not identity creation. `is_active` must already be
 * true; this is not a first-activation path (see activateAccount() for
 * that). The Clerk identity is looked up by username (`alea-<member
 * number>`) since no Clerk user id is persisted on `profiles`.
 */
export async function recoverAccount(input: { token: unknown; password: unknown }) {
  const parsed = recoveryServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid recovery link', 400)
  }

  const tokenHash = hashActivationToken(parsed.data.token)
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

  // Token is now spent — find the existing Clerk identity by username (no
  // Clerk user id is persisted on `profiles`) and set its new password.
  //
  // Every failure branch below (#299 Codex review finding 1) restores the
  // just-claimed token before returning: the recovery never actually
  // succeeded, so burning the token permanently would strand the member on a
  // link an admin has to reissue for no reason.
  const client = await clerkClient()
  let clerkUser: { id: string } | undefined
  try {
    const { data } = await client.users.getUserList({ username: [toClerkUsername(profile.member_number)] })
    clerkUser = data[0]
  } catch {
    await restoreClaimedToken(claimedToken.id)
    serviceError('Internal server error', 500)
  }
  if (!clerkUser) {
    await restoreClaimedToken(claimedToken.id)
    serviceError('Internal server error', 500)
  }

  try {
    await client.users.updateUser(clerkUser.id, {
      password: parsed.data.password,
      signOutOfOtherSessions: true,
    })
  } catch {
    await restoreClaimedToken(claimedToken.id)
    serviceError('Failed to update account credentials', 500)
  }

  const updatedRows = await sql`
    UPDATE profiles
    SET psw_changed = ${recoveredAt}
    WHERE id = ${profile.id}
    RETURNING id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at
  ` as PublicProfileRow[]
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
 * READ-ONLY (#299 pass 3 — correlation strategy corrected from pass 2's
 * wrong premise that email would be the login identifier; that premise is
 * fully discarded, not adjusted).
 *
 * Never creates a `profiles` row — only an admin-pre-registered row (e.g.
 * via `users-service.ts` CSV import) may ever exist, and only
 * `activateAccount()` above — gated on an admin-issued token — may ever
 * flip one to active (and only there is a Clerk identity ever created). A
 * Clerk identity with no matching pre-existing, active profile resolves to
 * `null`, full stop: no row is created, no side effect happens at all.
 *
 * Correlation strategy (#299 pass 3): the Clerk USERNAME is `alea-<member
 * number>` (see `toClerkUsername()`/`memberNumberFromClerkUsername()`
 * above) — strip the `alea-` prefix to recover the bare member number, then
 * look up `profiles` by `member_number`. No email involved anywhere in this
 * lookup.
 *
 * Called from `lib/server/auth.ts` on every request carrying a Clerk
 * session.
 */
export async function resolveProfileForClerkUser(input: {
  username: string
}): Promise<SessionUser | null> {
  const memberNumber = memberNumberFromClerkUsername(input.username.trim())
  if (!memberNumber) {
    return null
  }

  const rows = await sql`
    SELECT id, role, is_active
    FROM profiles
    WHERE member_number = ${memberNumber}
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
