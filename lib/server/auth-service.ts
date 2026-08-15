import type { User } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth'
import { createHash, randomBytes } from 'node:crypto'
import { serviceError } from '@/lib/server/service-error'
import { createSupabaseServerAdminClient, createSupabaseServerClient } from '@/lib/supabase/server'
import type { Tables } from '@/lib/supabase/types'
import { activationServerSchema, recoveryServerSchema, registerServerSchema } from '@/lib/validations/auth'
import { type PublicProfileRow, toPublicUser } from '@/lib/server/profile-mappers'
import { sql } from '@/lib/db/client'

type AuthCredentialRow = Pick<Tables<'profiles'>, 'id' | 'member_number' | 'auth_email' | 'email' | 'full_name' | 'phone' | 'role' | 'is_active' | 'active_from' | 'no_show_count' | 'blocked_until' | 'created_at' | 'updated_at'>
const PUBLIC_PROFILE_COLUMNS = 'id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at' as const

// Auth-only columns: auth_email is used to resolve Supabase Auth credentials for sign-in/activation.
// email is optional contact email; it is not part of the public user model (issue #39) but IS included for admin-facing user data.
const AUTH_CREDENTIAL_COLUMNS = 'id, member_number, auth_email, email, full_name, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at' as const

type PublicProfileLookupColumn = 'id' | 'member_number'
type AuthCredentialLookupColumn = 'id' | 'member_number' | 'email'
type PublicProfileMaybeSingleResult = Promise<{
  data: PublicProfileRow | null
  error: unknown
}>
type AuthCredentialMaybeSingleResult = Promise<{
  data: AuthCredentialRow | null
  error: unknown
}>
type PublicProfilesTableClient = {
  select: (columns: typeof PUBLIC_PROFILE_COLUMNS) => {
    eq: (column: PublicProfileLookupColumn, value: string) => {
      maybeSingle: () => PublicProfileMaybeSingleResult
    }
  }
}
type AuthCredentialTableClient = {
  select: (columns: typeof AUTH_CREDENTIAL_COLUMNS) => {
    eq: (column: AuthCredentialLookupColumn, value: string) => {
      maybeSingle: () => AuthCredentialMaybeSingleResult
    }
  }
}
type ProfileLookupClient = {
  from: (table: 'profiles') => unknown
}

type AuthClient = {
  auth: {
    signInWithPassword: (credentials: { email: string; password: string }) => Promise<{
      data: { user: { id: string } | null }
      error: { message: string } | null
    }>
    signOut: () => Promise<{ error: { message: string } | null }>
  }
}


function getProfilesTable(client: ProfileLookupClient) {
  return client.from('profiles') as PublicProfilesTableClient
}

function getAuthCredentialTable(client: ProfileLookupClient) {
  return client.from('profiles') as AuthCredentialTableClient
}

async function getPublicProfileBy(
  client: ProfileLookupClient,
  column: PublicProfileLookupColumn,
  value: string,
) {
  const { data, error } = await getProfilesTable(client)
    .select(PUBLIC_PROFILE_COLUMNS)
    .eq(column, value)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return data
}

async function getAuthCredentialProfileBy(
  client: ProfileLookupClient,
  column: AuthCredentialLookupColumn,
  value: string,
) {
  const { data, error } = await getAuthCredentialTable(client)
    .select(AUTH_CREDENTIAL_COLUMNS)
    .eq(column, value)
    .maybeSingle()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return data
}

async function getAuthCredentialByMemberNumber(memberNumber: string) {
  const admin = createSupabaseServerAdminClient()
  return getAuthCredentialProfileBy(admin, 'member_number', memberNumber)
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
 * Activates a member account (#299).
 *
 * NOTE — credential-setting was dropped, not redesigned: the pre-Clerk
 * version of this function called Supabase Auth's `admin.updateUserById()`
 * to set the member's password here. Clerk now owns credentials entirely, so
 * there is nothing left for this function to set a password on — activating
 * an account here only flips `profiles.is_active`/`active_from`. The
 * `{ token, password }` request shape is UNCHANGED (still validated via
 * `activationServerSchema`, defined in `lib/validations/auth.ts`, out of
 * this ticket's scope) purely so the existing route handler and frontend
 * form keep compiling — `password` is accepted but intentionally unused.
 * `psw_changed` is still stamped as an audit timestamp ("account was
 * activated/recovered at X"), even though it no longer reflects an actual
 * credential change. Whether the activation UX should still collect a
 * password at all is a product/UX question for a follow-up ticket, not
 * something resolved here — see this task's handoff message.
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
    const latestDatabaseNow = latestToken ? await getNeonDatabaseNow() : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expires_at, latestDatabaseNow)) {
      serviceError('Activation link is invalid or has expired', 400)
    }
    if (latestToken.used_at) {
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

  return {
    authEmail: profile.auth_email ?? profile.email ?? '',
    user: toPublicUser(updatedProfile),
  }
}

/**
 * Recovers ("resets") a member account (#299).
 *
 * Same credential-setting removal as `activateAccount()` above — see its
 * doc comment. Recovering only re-stamps `profiles.psw_changed`; it no
 * longer sets any password anywhere, since Clerk owns credentials now. The
 * `{ token, password }` request shape is unchanged for the same
 * compatibility reason.
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
    const latestDatabaseNow = latestToken ? await getNeonDatabaseNow() : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expires_at, latestDatabaseNow)) {
      serviceError('Recovery link is invalid or has expired', 400)
    }
    if (latestToken.used_at) {
      serviceError('Recovery link has already been used', 400)
    }

    serviceError('Recovery link is invalid or has expired', 400)
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

  return {
    authEmail: profile.auth_email,
    user: toPublicUser(updatedProfile),
  }
}

function createPendingMemberNumber() {
  // 3-char prefix + 16 hex chars = 19 chars, fits the varchar(20) column.
  return `PND${randomBytes(8).toString('hex')}`
}

type ClerkProfileMatchRow = {
  id: string
  role: 'member' | 'admin'
  is_active: boolean
}

/**
 * Maps a Clerk identity to the member domain model (#299).
 *
 * Replaces the old Supabase `on_auth_user_created` trigger, which fired on
 * every new `auth.users` row and inserted a placeholder `profiles` row for
 * `register()`/CSV-import to fill in. Neon has no such trigger, so this is
 * explicit app-layer logic, called from `lib/server/auth.ts` on every
 * request that carries a Clerk session.
 *
 * Correlation strategy: EMAIL match against `profiles.email` /
 * `profiles.auth_email` (case-insensitive). There is no `clerk_user_id`
 * column on `profiles` — per `lib/db/schema/003_profiles.sql`'s own doc
 * comment, syncing a Clerk identity to `profiles.id` is explicitly called
 * out as "an app-layer concern... not a schema change", which this
 * implements. This also lets an admin-imported member (`users-service.ts`
 * CSV import, no Clerk account yet) transparently "become" the same profile
 * the first time they sign up in Clerk with the same email — mirroring the
 * old import -> activation-link linkage.
 *
 * Every request re-resolves this lookup (no persisted FK), which is an
 * accepted cost of not adding a schema column, per the same doc comment.
 *
 * SECURITY-RELEVANT UNRESOLVED GAP (flagged prominently in this task's
 * handoff — do not change this default without a product/architecture
 * decision): a brand-new email with no matching profile gets a fresh
 * `profiles` row created here, but it is deliberately created
 * `is_active = false` — i.e. self-service Clerk sign-up NEVER grants a
 * working session by itself, matching the old CSV-import default. There is
 * currently NO path to flip that row to active: the old path was the
 * admin-generated activation link, which used to *set a password*
 * (meaningless now that Clerk owns credentials — see `activateAccount()`).
 * Until a follow-up ticket redefines what "activation" means post-Clerk (an
 * admin dashboard toggle? repurposing the activation link as a pure
 * "approve" action with no password step, which is what `activateAccount()`
 * already does today after this change?), any brand-new Clerk sign-up is
 * permanently stuck pending, with no self-serve or documented admin path to
 * flip it — this needs explicit product sign-off before shipping the
 * corresponding Clerk sign-in UI (out of scope here; see `app/[locale]/sign-in`).
 */
export async function resolveOrCreateProfileForClerkUser(input: {
  clerkUserId: string
  email: string
  fullName: string | null
}): Promise<SessionUser | null> {
  const normalizedEmail = input.email.trim().toLowerCase()
  if (!normalizedEmail) {
    return null
  }

  const existingRows = await sql`
    SELECT id, role, is_active
    FROM profiles
    WHERE lower(email) = ${normalizedEmail} OR lower(auth_email) = ${normalizedEmail}
    LIMIT 1
  ` as ClerkProfileMatchRow[]
  const existing = existingRows[0]

  if (existing) {
    if (!existing.is_active) {
      return null
    }
    return { id: existing.id, role: existing.role }
  }

  try {
    await sql`
      INSERT INTO profiles (id, member_number, email, auth_email, full_name, role, is_active)
      VALUES (gen_random_uuid(), ${createPendingMemberNumber()}, ${normalizedEmail}, ${normalizedEmail}, ${input.fullName}, 'member', false)
    `
  } catch {
    // Concurrent first-login race on the same email (auth_email is UNIQUE) —
    // another request already created the row. Fall through to re-query.
  }

  // Whether created just now or by a concurrent request, the row is
  // is_active = false either way: never return a session for a brand-new
  // profile (see the unresolved-gap note above).
  return null
}

/**
 * UNMIGRATED — still Supabase-backed (#299 scope resolution).
 *
 * `login`, `register`, `getCurrentUser`, `logout`, `logoutWithClient` below
 * are left exactly as they were before this migration. This was a deliberate
 * choice, not an oversight — see the handoff message for task #299 for the
 * full reasoning. Summary:
 *
 * - `login()`/`logoutWithClient()` are still called live, today, by
 *   `app/api/auth/login/route.ts` and `app/api/auth/logout/route.ts`, and
 *   `getCurrentUser()` by `app/api/auth/me/route.ts` and
 *   `app/[locale]/login/page.tsx` — none of these are orphaned or dead code;
 *   the legacy member-number + password flow is the ONLY working sign-in
 *   path today, since `app/[locale]/sign-in` is still intentionally disabled
 *   pending a follow-up ticket (see #297's `middleware.ts` comment).
 * - They are, however, now DISCONNECTED from `lib/server/auth.ts`'s session
 *   gate: `requireAuth()`/`getSessionFromServerCookies()` resolve sessions
 *   via Clerk + Neon (see `resolveOrCreateProfileForClerkUser()` above), not
 *   via the Supabase Auth session `login()` produces. A user who
 *   successfully calls `login()` today gets a 200 response and a Supabase
 *   session cookie, but every protected route/page gated by
 *   `requireAuth`/`requireAdmin` will still treat them as unauthenticated,
 *   since no Clerk session exists for them. `getCurrentUser()` has the same
 *   problem in the other direction: given a Clerk-resolved `SessionUser`
 *   (whose `id` is a Neon `profiles.id`), it looks that id up against
 *   Supabase's own (now-unrelated, pre-cutover) `profiles` table and will
 *   typically find nothing.
 * - Migrating these functions to Clerk/Neon was judged out of this ticket's
 *   safe, backend-only scope: doing so coherently requires either
 *   redesigning member sign-in around Clerk's own credential UI (frontend
 *   work, `app/`, out of scope) or inventing a password-based Clerk
 *   Backend-API integration (a new architectural surface, not implied by the
 *   issue text). Rewriting or deleting them here without that design
 *   decision risked silently breaking the only currently-working sign-in
 *   path in this environment.
 *
 * Net effect: right now, in this environment, nobody can complete an
 * end-to-end authenticated session through either flow (`login()` produces a
 * session `requireAuth` won't accept; Clerk sign-in is disabled at the page
 * level). This is flagged as the top item in the handoff message.
 */
export async function login(
  input: { identifier?: unknown; password?: unknown },
  client?: AuthClient,
): Promise<User> {
  const identifier = String(input.identifier ?? '').trim()
  const password = String(input.password ?? '')

  if (!identifier || !password) {
    serviceError('Identifier and password are required', 400)
  }

  // Resolve the auth credential profile by member number (email login not supported).
  const credentialProfile = await getAuthCredentialByMemberNumber(identifier)

  if (!credentialProfile) {
    serviceError('Invalid credentials', 401)
  }

  const authEmail = credentialProfile.auth_email ?? credentialProfile.email

  if (!authEmail) {
    // Profile has no email set — cannot authenticate via Supabase Auth.
    serviceError('Invalid credentials', 401)
  }

  if (credentialProfile.is_active === false) {
    // Suspended users cannot sign in.
    serviceError('Invalid credentials', 401)
  }

  const supabase = client ?? await createSupabaseServerClient()
  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail,
    password,
  })

  if (error || !data.user) {
    serviceError('Invalid credentials', 401)
  }

  if (data.user.id !== credentialProfile.id) {
    // Guard against profile/auth drift: the authenticated Supabase user must match
    // the profile resolved by member number.
    serviceError('Invalid credentials', 401)
  }

  return toPublicUser(credentialProfile)
}

export async function register(
  input: unknown,
  sessionClient?: AuthClient,
): Promise<User> {
  const parsed = registerServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid registration details', 400)
  }

  const { memberNumber, password } = parsed.data

  // Use the full admin client (ReturnType<typeof createSupabaseServerAdminClient>) so
  // both auth.admin and .from('profiles') are available without unsafe casts.
  const adminClient = createSupabaseServerAdminClient()

  // Check whether the member number is already taken by an existing profile.
  // Generic message to avoid user enumeration (do not confirm whether the number exists).
  const existing = await getAuthCredentialProfileBy(adminClient, 'member_number', memberNumber)
  if (existing) {
    serviceError('Invalid registration details', 400)
  }

  // Derive a deterministic internal email from the member number so Supabase Auth
  // can work with email/password credentials without exposing real emails.
  const email = `${memberNumber}@members.alea.internal`

  // Create the Supabase Auth user. The on_auth_user_created trigger will immediately
  // INSERT a profiles row with a placeholder member_number.
  const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    serviceError('Failed to create account', 500)
  }

  const userId = authData.user.id

  // UPDATE the trigger-created profile row with the real values.
  // We use update() instead of insert() because the on_auth_user_created trigger
  // already inserted a row for this user id with a placeholder member_number.
  const { data: profileData, error: profileError } = await adminClient
    .from('profiles')
    .update({ member_number: memberNumber, auth_email: email, role: 'member', is_active: true })
    .eq('id', userId)
    .select(PUBLIC_PROFILE_COLUMNS)
    .maybeSingle()

  if (profileError) {
    // Unique constraint violation on member_number — concurrent registration with the
    // same member number; clean up the orphaned auth user.
    if ((profileError as { code?: string }).code === '23505') {
      await adminClient.auth.admin.deleteUser(userId)
      serviceError('Invalid registration details', 400)
    }
    await adminClient.auth.admin.deleteUser(userId)
    serviceError('Failed to create user profile', 500)
  }

  if (!profileData) {
    await adminClient.auth.admin.deleteUser(userId)
    serviceError('Failed to create user profile', 500)
  }

  // Sign the user in to establish a session. Registration succeeded regardless of
  // whether auto-login works — the user can always log in manually.
  const supabase = sessionClient ?? await createSupabaseServerClient()
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError) {
    // Non-fatal: profile was created successfully. User can log in separately.
  }

  return toPublicUser(profileData)
}

async function getSessionScopedProfile(id: string, client?: ProfileLookupClient) {
  const supabase = client ?? await createSupabaseServerClient()
  return getPublicProfileBy(supabase, 'id', id)
}

export async function getCurrentUser(
  session: SessionUser | null,
  client?: ProfileLookupClient,
): Promise<User> {
  if (!session) {
    serviceError('Unauthorized', 401)
  }

  const profile = await getSessionScopedProfile(session.id, client)
  if (!profile) {
    serviceError('Unauthorized', 401)
  }

  return toPublicUser(profile)
}

export async function logout() {
  const supabase = await createSupabaseServerClient()
  const { error } = await supabase.auth.signOut()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return { success: true }
}

export async function logoutWithClient(client: AuthClient) {
  const { error } = await client.auth.signOut()

  if (error) {
    serviceError('Internal server error', 500)
  }

  return { success: true }
}
