import type { User } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth/auth'
import { createHash, randomBytes } from 'node:crypto'
import { getDatabaseNow } from '@/lib/server/shared/database-time'
import { serviceError } from '@/lib/server/shared/service-error'
import { getAdminDb, getDb } from '@/lib/db'
import {
  createAuthUser,
  deleteAuthUser,
  signInWithPassword as authSignInWithPassword,
  signOut as authSignOut,
  updateAuthUserById,
} from '@/lib/auth/session'
import type { Tables, TablesInsert } from '@/lib/supabase/types'
import { activationServerSchema, recoveryServerSchema, registerServerSchema } from '@/lib/validations/auth'

type ActivationTokenRow = Tables<'activation_tokens'>
type AuthCredentialRow = Pick<Tables<'profiles'>, 'id' | 'member_number' | 'auth_email' | 'email' | 'full_name' | 'phone' | 'role' | 'is_active' | 'active_from' | 'no_show_count' | 'blocked_until' | 'created_at' | 'updated_at'>
/**
 * Local alias for the snake_case Supabase profile row shape this file still
 * reads (`lib/server/auth/*` is not part of the KIM-440 profiles migration —
 * see `lib/server/users/profile-mappers.ts`, which now maps the Drizzle
 * (camelCase) row shape used by the migrated `users-service.ts`). Same field
 * set as `AuthCredentialRow` above; kept as a distinct alias so call sites
 * below read by intent (public profile vs. auth-credential lookup).
 */
type PublicProfileRow = AuthCredentialRow
const PUBLIC_PROFILE_COLUMNS = 'id, member_number, full_name, auth_email, email, phone, role, is_active, active_from, no_show_count, blocked_until, created_at, updated_at' as const
const ACTIVATION_TOKEN_COLUMNS = 'id, profile_id, token_hash, expires_at, used_at, created_by, created_at, updated_at' as const
const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000

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
type ActivationTokenMaybeSingleResult = Promise<{
  data: ActivationTokenRow | null
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
type ActivationTokenTableClient = {
  select: (columns: typeof ACTIVATION_TOKEN_COLUMNS) => {
    eq: (column: 'profile_id' | 'token_hash', value: string) => {
      maybeSingle: () => ActivationTokenMaybeSingleResult
    }
  }
  insert: (values: TablesInsert<'activation_tokens'>) => Promise<{ error: unknown }>
  upsert: (
    values: TablesInsert<'activation_tokens'>,
    options: { onConflict: 'profile_id' },
  ) => Promise<{ error: unknown }>
  update: (values: Partial<Tables<'activation_tokens'>>) => {
    eq: (column: 'id' | 'token_hash', value: string) => {
      eq: (column: 'id', value: string) => Promise<{ error: unknown }>
      gt: (
        column: 'expires_at',
        value: string,
      ) => {
        is: (
          column: 'used_at',
          value: null,
        ) => {
          select: (columns: typeof ACTIVATION_TOKEN_COLUMNS) => {
            maybeSingle: () => ActivationTokenMaybeSingleResult
          }
        }
      }
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

function getActivationTokenTable(client: { from: (table: 'activation_tokens') => unknown }) {
  return client.from('activation_tokens') as ActivationTokenTableClient
}

// Privilege check (role === 'admin') lives here in the service layer, not in
// route handlers (repo convention). activation_tokens is now locked down to
// service_role only at the RLS layer (no anon/authenticated policies remain —
// see docs/RLS-SERVICE-LAYER-AUDIT.md), so this in-function check is the only
// authorization guard for admin-triggered activation/recovery link
// generation once RLS is removed as part of the Vercel/Postgres migration.
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
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
  const admin = getAdminDb()
  return getAuthCredentialProfileBy(admin, 'member_number', memberNumber)
}

/**
 * Local replacement for `lib/server/users/profile-mappers.ts`'s
 * `toPublicUser()`, which now maps the Drizzle (camelCase) `profiles` row
 * shape used by the migrated `users-service.ts`. This file still queries
 * `profiles` through the legacy Supabase seam (snake_case rows), so it maps
 * from that shape locally instead.
 */
function toUser(profile: PublicProfileRow): User {
  return {
    id: profile.id,
    memberNumber: profile.member_number,
    fullName: profile.full_name ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    role: profile.role,
    isActive: profile.is_active,
    activeFrom: profile.active_from ?? null,
    noShowCount: profile.no_show_count,
    blockedUntil: profile.blocked_until ?? null,
    createdAt: profile.created_at,
    updatedAt: profile.updated_at,
  }
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

async function getDatabaseNowIso(admin: unknown) {
  return (await getDatabaseNow(admin)).toISOString()
}

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

  const admin = getAdminDb()
  const activationTokens = getActivationTokenTable(admin)
  const tokenHash = hashActivationToken(token)
  const { data: activationToken, error: activationTokenError } = await activationTokens
    .select(ACTIVATION_TOKEN_COLUMNS)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (activationTokenError) {
    serviceError('Internal server error', 500)
  }
  if (!activationToken) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }
  if (activationToken.used_at) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getDatabaseNow(admin)
  if (isActivationExpired(activationToken.expires_at, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getAuthCredentialProfileBy(admin, 'id', activationToken.profile_id)
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
  session: SessionUser
  userId: string
  locale: string
  baseUrl: string
  createdBy: string
}) {
  requireAdminSession(input.session)
  const admin = getAdminDb()
  const profile = await getAuthCredentialProfileBy(admin, 'id', input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can be activated', 400)
  }
  if (profile.is_active) {
    serviceError('This member is already active', 400)
  }

  const activationTokens = getActivationTokenTable(admin)
  const token = createActivationToken()
  const databaseNow = await getDatabaseNow(admin)
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)
  const upsertResult = await activationTokens.upsert({
    profile_id: profile.id,
    token_hash: hashActivationToken(token),
    expires_at: expiresAt.toISOString(),
    created_by: input.createdBy,
    used_at: null,
  }, { onConflict: 'profile_id' })

  if (upsertResult.error) {
    serviceError('Failed to create activation link', 500)
  }

  return {
    activationLink: `${input.baseUrl}/${input.locale}/activate?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export async function getRecoveryLinkState(token: string): Promise<RecoveryLinkState> {
  if (!token) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }

  const admin = getAdminDb()
  const activationTokens = getActivationTokenTable(admin)
  const tokenHash = hashActivationToken(token)
  const { data: recoveryToken, error: recoveryTokenError } = await activationTokens
    .select(ACTIVATION_TOKEN_COLUMNS)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (recoveryTokenError) {
    serviceError('Internal server error', 500)
  }
  if (!recoveryToken) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }
  if (recoveryToken.used_at) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getDatabaseNow(admin)
  if (isActivationExpired(recoveryToken.expires_at, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getAuthCredentialProfileBy(admin, 'id', recoveryToken.profile_id)
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
  session: SessionUser
  userId: string
  locale: string
  baseUrl: string
  createdBy: string
}) {
  requireAdminSession(input.session)
  const admin = getAdminDb()
  const profile = await getAuthCredentialProfileBy(admin, 'id', input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can receive recovery links', 400)
  }
  if (!profile.is_active) {
    serviceError('This member must activate the account before using recovery', 400)
  }

  const activationTokens = getActivationTokenTable(admin)
  const token = createActivationToken()
  const databaseNow = await getDatabaseNow(admin)
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)
  const upsertResult = await activationTokens.upsert({
    profile_id: profile.id,
    token_hash: hashActivationToken(token),
    expires_at: expiresAt.toISOString(),
    created_by: input.createdBy,
    used_at: null,
  }, { onConflict: 'profile_id' })

  if (upsertResult.error) {
    serviceError('Failed to create recovery link', 500)
  }

  return {
    recoveryLink: `${input.baseUrl}/${input.locale}/recover?token=${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export async function activateAccount(input: { token: unknown; password: unknown }) {
  const parsed = activationServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid activation link', 400)
  }

  const admin = getAdminDb()
  const activationTokens = getActivationTokenTable(admin)
  const tokenHash = hashActivationToken(parsed.data.token)
  const { data: existingToken, error: activationTokenError } = await activationTokens
    .select(ACTIVATION_TOKEN_COLUMNS)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (activationTokenError) {
    serviceError('Internal server error', 500)
  }
  const databaseNow = existingToken ? await getDatabaseNow(admin) : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expires_at, databaseNow)) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (existingToken.used_at) {
    serviceError('Activation link has already been used', 400)
  }

  const profile = await getAuthCredentialProfileBy(admin, 'id', existingToken.profile_id)
  if (!profile) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (profile.is_active) {
    serviceError('Activation link has already been used', 400)
  }

  const activatedAt = await getDatabaseNowIso(admin)
  const { data: claimedToken, error: claimTokenError } = await activationTokens
    .update({ used_at: activatedAt })
    .eq('token_hash', tokenHash)
    .gt('expires_at', activatedAt)
    .is('used_at', null)
    .select(ACTIVATION_TOKEN_COLUMNS)
    .maybeSingle()

  if (claimTokenError) {
    serviceError('Failed to activate account', 500)
  }

  if (!claimedToken) {
    const { data: latestToken, error: latestTokenError } = await activationTokens
      .select(ACTIVATION_TOKEN_COLUMNS)
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (latestTokenError) {
      serviceError('Internal server error', 500)
    }
    const latestDatabaseNow = latestToken ? await getDatabaseNow(admin) : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expires_at, latestDatabaseNow)) {
      serviceError('Activation link is invalid or has expired', 400)
    }
    if (latestToken.used_at) {
      serviceError('Activation link has already been used', 400)
    }

    serviceError('Activation link is invalid or has expired', 400)
  }

  const { error: updateAuthError } = await updateAuthUserById(admin, profile.id, {
    password: parsed.data.password,
    email_confirm: true,
  })
  if (updateAuthError) {
    await activationTokens.update({ used_at: null }).eq('id', claimedToken.id)
    serviceError('Failed to activate account', 500)
  }

  const { data: updatedProfile, error: updatedProfileError } = await admin
    .from('profiles')
    .update({
      is_active: true,
      active_from: activatedAt,
      psw_changed: activatedAt,
    })
    .eq('id', profile.id)
    .select(PUBLIC_PROFILE_COLUMNS)
    .maybeSingle()

  if (updatedProfileError || !updatedProfile) {
    serviceError('Failed to activate account', 500)
  }

  return {
    authEmail: profile.auth_email ?? profile.email ?? '',
    user: toUser(updatedProfile),
  }
}

export async function recoverAccount(input: { token: unknown; password: unknown }) {
  const parsed = recoveryServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid recovery link', 400)
  }

  const admin = getAdminDb()
  const activationTokens = getActivationTokenTable(admin)
  const tokenHash = hashActivationToken(parsed.data.token)
  const { data: existingToken, error: recoveryTokenError } = await activationTokens
    .select(ACTIVATION_TOKEN_COLUMNS)
    .eq('token_hash', tokenHash)
    .maybeSingle()

  if (recoveryTokenError) {
    serviceError('Internal server error', 500)
  }
  const databaseNow = existingToken ? await getDatabaseNow(admin) : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expires_at, databaseNow)) {
    serviceError('Recovery link is invalid or has expired', 400)
  }
  if (existingToken.used_at) {
    serviceError('Recovery link has already been used', 400)
  }

  const profile = await getAuthCredentialProfileBy(admin, 'id', existingToken.profile_id)
  if (!profile || !profile.is_active) {
    serviceError('Recovery link is invalid or has expired', 400)
  }

  const recoveredAt = await getDatabaseNowIso(admin)
  const { data: claimedToken, error: claimTokenError } = await activationTokens
    .update({ used_at: recoveredAt })
    .eq('token_hash', tokenHash)
    .gt('expires_at', recoveredAt)
    .is('used_at', null)
    .select(ACTIVATION_TOKEN_COLUMNS)
    .maybeSingle()

  if (claimTokenError) {
    serviceError('Failed to recover account', 500)
  }

  if (!claimedToken) {
    const { data: latestToken, error: latestTokenError } = await activationTokens
      .select(ACTIVATION_TOKEN_COLUMNS)
      .eq('token_hash', tokenHash)
      .maybeSingle()

    if (latestTokenError) {
      serviceError('Internal server error', 500)
    }
    const latestDatabaseNow = latestToken ? await getDatabaseNow(admin) : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expires_at, latestDatabaseNow)) {
      serviceError('Recovery link is invalid or has expired', 400)
    }
    if (latestToken.used_at) {
      serviceError('Recovery link has already been used', 400)
    }

    serviceError('Recovery link is invalid or has expired', 400)
  }

  const { error: updateAuthError } = await updateAuthUserById(admin, profile.id, {
    password: parsed.data.password,
    email_confirm: true,
  })
  if (updateAuthError) {
    await activationTokens.update({ used_at: null }).eq('id', claimedToken.id)
    serviceError('Failed to recover account', 500)
  }

  const { data: updatedProfile, error: updatedProfileError } = await admin
    .from('profiles')
    .update({
      psw_changed: recoveredAt,
    })
    .eq('id', profile.id)
    .select(PUBLIC_PROFILE_COLUMNS)
    .maybeSingle()

  if (updatedProfileError || !updatedProfile) {
    serviceError('Failed to recover account', 500)
  }

  return {
    authEmail: profile.auth_email,
    user: toUser(updatedProfile),
  }
}

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

  const supabase = client ?? await getDb()
  const { data, error } = await authSignInWithPassword(supabase, {
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

  return toUser(credentialProfile)
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

  // Use the full admin client (ReturnType<typeof getAdminDb>) so
  // both auth.admin and .from('profiles') are available without unsafe casts.
  const adminClient = getAdminDb()

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
  const { data: authData, error: authError } = await createAuthUser(adminClient, {
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
      await deleteAuthUser(adminClient, userId)
      serviceError('Invalid registration details', 400)
    }
    await deleteAuthUser(adminClient, userId)
    serviceError('Failed to create user profile', 500)
  }

  if (!profileData) {
    await deleteAuthUser(adminClient, userId)
    serviceError('Failed to create user profile', 500)
  }

  // Sign the user in to establish a session. Registration succeeded regardless of
  // whether auto-login works — the user can always log in manually.
  const supabase = sessionClient ?? await getDb()
  const { error: signInError } = await authSignInWithPassword(supabase, { email, password })
  if (signInError) {
    // Non-fatal: profile was created successfully. User can log in separately.
  }

  return toUser(profileData)
}

async function getSessionScopedProfile(id: string, client?: ProfileLookupClient) {
  const supabase = client ?? await getDb()
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

  return toUser(profile)
}

export async function logout() {
  const supabase = await getDb()
  const { error } = await authSignOut(supabase)

  if (error) {
    serviceError('Internal server error', 500)
  }

  return { success: true }
}

export async function logoutWithClient(client: AuthClient) {
  const { error } = await authSignOut(client)

  if (error) {
    serviceError('Internal server error', 500)
  }

  return { success: true }
}
