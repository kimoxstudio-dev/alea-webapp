import type { User } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth/auth'
import { createHash, randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDatabaseNow } from '@/lib/server/shared/database-time'
import { serviceError } from '@/lib/server/shared/service-error'
import { getAdminDb, getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { activationTokens, profiles } from '@/lib/db/schema'
import {
  createAuthUser,
  deleteAuthUser,
  updateAuthUserById,
} from '@/lib/auth/session'
import { activationServerSchema, recoveryServerSchema, registerServerSchema } from '@/lib/validations/auth'

/**
 * bcryptjs cost factor — matches `scripts/seed.ts`'s `bcrypt.hash(password, 10)`
 * so seeded and activated/recovered accounts hash with the same cost.
 */
const PASSWORD_HASH_COST = 10

/**
 * Writes the new password's bcrypt hash (and, for activation, the
 * active-status fields) to `profiles.password_hash` on the Drizzle/Neon
 * seam (`getDrizzleAdminDb()` — see `lib/db/index.ts`).
 *
 * This is NOT redundant with `updateAuthUserById()` above/below: that call
 * only changes the password on the legacy Supabase Auth (GoTrue) seam
 * (`getAdminDb()` / `NEXT_PUBLIC_SUPABASE_URL`), a physically different
 * database from the one `POSTGRES_URL` points at (see `lib/db/index.ts`).
 * Resolves `true` only when the hash is durably persisted — not merely when
 * no exception was thrown. Drizzle's `.update()` over node-postgres does NOT throw when the
 * `WHERE` clause matches zero rows (e.g. no Neon row exists yet for this
 * `profileId` during the transition); it just
 * resolves with nothing updated. `.returning({ id: profiles.id })` lets us
 * distinguish "updated one row" from "matched nothing", following the same
 * pattern other Drizzle-backed services in `lib/server/` already use
 * (e.g. `rooms-service.ts`'s `updateRoom()`). Treating a zero-row match as
 * success would silently leave the account "activated" with no usable
 * credential — exactly the class of bug this fix exists to close.
 *
 * For activation, this single Drizzle update persists both the password hash
 * and active-status fields. Callers roll back the single-use token when it
 * fails, so Neon never exposes an active profile without its credential.
 */
async function persistDrizzlePasswordHash(
  profileId: string,
  passwordHash: string,
  fields: { isActive?: boolean; activeFrom?: Date; pswChanged: Date },
): Promise<boolean> {
  try {
    const drizzleAdmin = getDrizzleAdminDb()
    const [row] = await drizzleAdmin
      .update(profiles)
      .set({
        passwordHash,
        ...(fields.isActive !== undefined ? { isActive: fields.isActive } : {}),
        ...(fields.activeFrom !== undefined ? { activeFrom: fields.activeFrom } : {}),
        pswChanged: fields.pswChanged,
      })
      .where(eq(profiles.id, profileId))
      .returning({ id: profiles.id })
    // No matching Neon row → nothing was actually persisted, even though
    // no error was thrown. Treat exactly like a failed write.
    return row !== undefined
  } catch {
    // Connection error, missing POSTGRES_URL, unexpected shape, etc. — never
    // leak internals; caller treats this the same as any other failed write.
    return false
  }
}

const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000

const DRIZZLE_PROFILE_COLUMNS = {
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

type DrizzleProfileRow = {
  id: string
  memberNumber: string
  fullName: string | null
  authEmail: string
  email: string | null
  phone: string | null
  role: 'member' | 'admin'
  isActive: boolean
  activeFrom: Date | null
  noShowCount: number
  blockedUntil: Date | null
  createdAt: Date
  updatedAt: Date
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

// Privilege check (role === 'admin') lives here in the service layer, not in
// route handlers (repo convention). activation_tokens is now locked down to
// service_role only at the RLS layer (no anon/authenticated policies remain —
// see Linear KIM-418), so this in-function check is the only
// authorization guard for admin-triggered activation/recovery link
// generation once RLS is removed as part of the Vercel/Postgres migration.
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

async function getPublicProfileById(id: string) {
  try {
    const db = getDrizzleDb()
    const [row] = await db
      .select(DRIZZLE_PROFILE_COLUMNS)
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1)
    return row ?? null
  } catch {
    serviceError('Internal server error', 500)
  }
}

async function getAuthCredentialProfileById(id: string) {
  try {
    const db = getDrizzleAdminDb()
    const [row] = await db
      .select(DRIZZLE_PROFILE_COLUMNS)
      .from(profiles)
      .where(eq(profiles.id, id))
      .limit(1)
    return row ?? null
  } catch {
    serviceError('Internal server error', 500)
  }
}

async function getAuthCredentialByMemberNumber(memberNumber: string) {
  try {
    const db = getDrizzleAdminDb()
    const [row] = await db
      .select(DRIZZLE_PROFILE_COLUMNS)
      .from(profiles)
      .where(eq(profiles.memberNumber, memberNumber))
      .limit(1)
    return row ?? null
  } catch {
    serviceError('Internal server error', 500)
  }
}

function toUser(profile: DrizzleProfileRow): User {
  return {
    id: profile.id,
    memberNumber: profile.memberNumber,
    fullName: profile.fullName ?? null,
    email: profile.email ?? null,
    phone: profile.phone ?? null,
    role: profile.role,
    isActive: profile.isActive,
    activeFrom: profile.activeFrom?.toISOString() ?? null,
    noShowCount: profile.noShowCount,
    blockedUntil: profile.blockedUntil?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  }
}

function hashActivationToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function createActivationToken() {
  return randomBytes(32).toString('hex')
}

function isActivationExpired(expiresAt: string | Date, currentTime: Date) {
  return new Date(expiresAt).getTime() <= currentTime.getTime()
}

async function getActivationTokenByHash(tokenHash: string) {
  try {
    const db = getDrizzleAdminDb()
    const [row] = await db
      .select()
      .from(activationTokens)
      .where(eq(activationTokens.tokenHash, tokenHash))
      .limit(1)
    return row ?? null
  } catch {
    serviceError('Internal server error', 500)
  }
}

async function rollbackActivationTokenClaim(id: string, claimedAt: Date): Promise<void> {
  try {
    const db = getDrizzleAdminDb()
    await db
      .update(activationTokens)
      .set({ usedAt: null })
      .where(and(
        eq(activationTokens.id, id),
        eq(activationTokens.usedAt, claimedAt),
      ))
  } catch {
    serviceError('Internal server error', 500)
  }
}

async function claimActivationToken(
  tokenHash: string,
  claimedAt: Date,
  errorMessage: string,
) {
  try {
    const db = getDrizzleAdminDb()
    const [row] = await db
      .update(activationTokens)
      .set({ usedAt: claimedAt })
      .where(and(
        eq(activationTokens.tokenHash, tokenHash),
        gt(activationTokens.expiresAt, claimedAt),
        isNull(activationTokens.usedAt),
      ))
      .returning()
    return row ?? null
  } catch {
    serviceError(errorMessage, 500)
  }
}

async function upsertActivationToken(values: {
  profileId: string
  tokenHash: string
  expiresAt: Date
  createdBy: string
  updatedAt: Date
}, errorMessage: string): Promise<void> {
  try {
    const db = getDrizzleAdminDb()
    await db
      .insert(activationTokens)
      .values({ ...values, usedAt: null })
      .onConflictDoUpdate({
        target: activationTokens.profileId,
        set: {
          tokenHash: values.tokenHash,
          expiresAt: values.expiresAt,
          createdBy: values.createdBy,
          usedAt: null,
          updatedAt: values.updatedAt,
        },
      })
  } catch {
    serviceError(errorMessage, 500)
  }
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

  const tokenHash = hashActivationToken(token)
  const activationToken = await getActivationTokenByHash(tokenHash)
  if (!activationToken) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }
  if (activationToken.usedAt) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getDatabaseNow(getDrizzleAdminDb())
  if (isActivationExpired(activationToken.expiresAt, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getAuthCredentialProfileById(activationToken.profileId)
  if (!profile || profile.isActive) {
    return { status: 'used', memberNumber: null, fullName: null }
  }

  return {
    status: 'valid',
    memberNumber: profile.memberNumber,
    fullName: profile.fullName ?? null,
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
  const profile = await getAuthCredentialProfileById(input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can be activated', 400)
  }
  if (profile.isActive) {
    serviceError('This member is already active', 400)
  }

  const token = createActivationToken()
  const databaseNow = await getDatabaseNow(getDrizzleAdminDb())
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)
  await upsertActivationToken({
    profileId: profile.id,
    tokenHash: hashActivationToken(token),
    expiresAt,
    createdBy: input.createdBy,
    updatedAt: databaseNow,
  }, 'Failed to create activation link')

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
  if (recoveryToken.usedAt) {
    return { status: 'used', memberNumber: null, fullName: null }
  }
  const databaseNow = await getDatabaseNow(getDrizzleAdminDb())
  if (isActivationExpired(recoveryToken.expiresAt, databaseNow)) {
    return { status: 'expired', memberNumber: null, fullName: null }
  }

  const profile = await getAuthCredentialProfileById(recoveryToken.profileId)
  if (!profile || !profile.isActive) {
    return { status: 'invalid', memberNumber: null, fullName: null }
  }

  return {
    status: 'valid',
    memberNumber: profile.memberNumber,
    fullName: profile.fullName ?? null,
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
  const profile = await getAuthCredentialProfileById(input.userId)

  if (!profile) {
    serviceError('User not found', 404)
  }
  if (profile.role !== 'member') {
    serviceError('Only member accounts can receive recovery links', 400)
  }
  if (!profile.isActive) {
    serviceError('This member must activate the account before using recovery', 400)
  }

  const token = createActivationToken()
  const databaseNow = await getDatabaseNow(getDrizzleAdminDb())
  const expiresAt = new Date(databaseNow.getTime() + ACTIVATION_WINDOW_MS)
  await upsertActivationToken({
    profileId: profile.id,
    tokenHash: hashActivationToken(token),
    expiresAt,
    createdBy: input.createdBy,
    updatedAt: databaseNow,
  }, 'Failed to create recovery link')

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
  const tokenHash = hashActivationToken(parsed.data.token)
  const existingToken = await getActivationTokenByHash(tokenHash)
  const databaseNow = existingToken ? await getDatabaseNow(getDrizzleAdminDb()) : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expiresAt, databaseNow)) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (existingToken.usedAt) {
    serviceError('Activation link has already been used', 400)
  }

  const profile = await getAuthCredentialProfileById(existingToken.profileId)
  if (!profile) {
    serviceError('Activation link is invalid or has expired', 400)
  }
  if (profile.isActive) {
    serviceError('Activation link has already been used', 400)
  }

  const activatedAt = await getDatabaseNow(getDrizzleAdminDb())
  const claimedToken = await claimActivationToken(
    tokenHash,
    activatedAt,
    'Failed to activate account',
  )

  if (!claimedToken) {
    const latestToken = await getActivationTokenByHash(tokenHash)
    const latestDatabaseNow = latestToken ? await getDatabaseNow(getDrizzleAdminDb()) : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expiresAt, latestDatabaseNow)) {
      serviceError('Activation link is invalid or has expired', 400)
    }
    if (latestToken.usedAt) {
      serviceError('Activation link has already been used', 400)
    }

    serviceError('Activation link is invalid or has expired', 400)
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, PASSWORD_HASH_COST)

  const { error: updateAuthError } = await updateAuthUserById(admin, profile.id, {
    password: parsed.data.password,
    email_confirm: true,
  })
  if (updateAuthError) {
    await rollbackActivationTokenClaim(claimedToken.id, activatedAt)
    serviceError('Failed to activate account', 500)
  }

  // KIM-433 Codex-review fix — see `persistDrizzlePasswordHash()` doc comment.
  // This single Neon write persists both active state and credential. Failure
  // rolls back the token claim, avoiding an active account with no usable hash.
  const drizzleWriteOk = await persistDrizzlePasswordHash(profile.id, passwordHash, {
    isActive: true,
    activeFrom: activatedAt,
    pswChanged: activatedAt,
  })
  if (!drizzleWriteOk) {
    await rollbackActivationTokenClaim(claimedToken.id, activatedAt)
    serviceError('Failed to activate account', 500)
  }

  const updatedProfile = await getPublicProfileById(profile.id)
  if (!updatedProfile) {
    serviceError('Failed to activate account', 500)
  }

  return {
    authEmail: profile.authEmail,
    user: toUser(updatedProfile),
  }
}

export async function recoverAccount(input: { token: unknown; password: unknown }) {
  const parsed = recoveryServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid recovery link', 400)
  }

  const admin = getAdminDb()
  const tokenHash = hashActivationToken(parsed.data.token)
  const existingToken = await getActivationTokenByHash(tokenHash)
  const databaseNow = existingToken ? await getDatabaseNow(getDrizzleAdminDb()) : null
  if (!existingToken || !databaseNow || isActivationExpired(existingToken.expiresAt, databaseNow)) {
    serviceError('Recovery link is invalid or has expired', 400)
  }
  if (existingToken.usedAt) {
    serviceError('Recovery link has already been used', 400)
  }

  const profile = await getAuthCredentialProfileById(existingToken.profileId)
  if (!profile || !profile.isActive) {
    serviceError('Recovery link is invalid or has expired', 400)
  }

  const recoveredAt = await getDatabaseNow(getDrizzleAdminDb())
  const claimedToken = await claimActivationToken(
    tokenHash,
    recoveredAt,
    'Failed to recover account',
  )

  if (!claimedToken) {
    const latestToken = await getActivationTokenByHash(tokenHash)
    const latestDatabaseNow = latestToken ? await getDatabaseNow(getDrizzleAdminDb()) : null
    if (!latestToken || !latestDatabaseNow || isActivationExpired(latestToken.expiresAt, latestDatabaseNow)) {
      serviceError('Recovery link is invalid or has expired', 400)
    }
    if (latestToken.usedAt) {
      serviceError('Recovery link has already been used', 400)
    }

    serviceError('Recovery link is invalid or has expired', 400)
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, PASSWORD_HASH_COST)

  const { error: updateAuthError } = await updateAuthUserById(admin, profile.id, {
    password: parsed.data.password,
    email_confirm: true,
  })
  if (updateAuthError) {
    await rollbackActivationTokenClaim(claimedToken.id, recoveredAt)
    serviceError('Failed to recover account', 500)
  }

  // KIM-433 Codex-review fix — see `persistDrizzlePasswordHash()` doc comment.
  // `isActive: true` is reasserted (not flipped — `profile.isActive` was
  // already required above) as defense-in-depth against profile-state drift.
  const drizzleWriteOk = await persistDrizzlePasswordHash(profile.id, passwordHash, {
    isActive: true,
    pswChanged: recoveredAt,
  })
  if (!drizzleWriteOk) {
    await rollbackActivationTokenClaim(claimedToken.id, recoveredAt)
    serviceError('Failed to recover account', 500)
  }

  const updatedProfile = await getPublicProfileById(profile.id)
  if (!updatedProfile) {
    serviceError('Failed to recover account', 500)
  }

  return {
    authEmail: profile.authEmail,
    user: toUser(updatedProfile),
  }
}

export async function login(
  _input: { identifier?: unknown; password?: unknown },
): Promise<User> {
  serviceError('Interactive login is handled by Clerk', 410)
}

export async function register(
  input: unknown,
  _sessionClient?: AuthClient,
): Promise<User> {
  const parsed = registerServerSchema.safeParse(input)
  if (!parsed.success) {
    serviceError('Invalid registration details', 400)
  }

  const { memberNumber, password } = parsed.data

  // Supabase Auth remains transitional until Clerk cutover. Domain profile
  // persistence below is Drizzle/Neon-only.
  const adminClient = getAdminDb()
  const drizzleAdmin = getDrizzleAdminDb()

  // Check whether the member number is already taken by an existing profile.
  // Generic message to avoid user enumeration (do not confirm whether the number exists).
  const existing = await getAuthCredentialByMemberNumber(memberNumber)
  if (existing) {
    serviceError('Invalid registration details', 400)
  }

  // Derive a deterministic internal email from the member number so Supabase Auth
  // can work with email/password credentials without exposing real emails.
  const email = `${memberNumber}@members.alea.internal`

  const registeredAt = await getDatabaseNow(drizzleAdmin)
  const passwordHash = await bcrypt.hash(password, PASSWORD_HASH_COST)

  // Create the Supabase Auth user. Neon has no Auth trigger-backed profile row,
  // so the Drizzle insert below is the first persistence of domain identity.
  const { data: authData, error: authError } = await createAuthUser(adminClient, {
    email,
    password,
    email_confirm: true,
  })

  if (authError || !authData.user) {
    serviceError('Failed to create account', 500)
  }

  const userId = authData.user.id

  let profileData: DrizzleProfileRow | undefined
  try {
    ;[profileData] = await drizzleAdmin
      .insert(profiles)
      .values({
        id: userId,
        memberNumber,
        authEmail: email,
        email,
        role: 'member',
        isActive: true,
        activeFrom: registeredAt,
        pswChanged: registeredAt,
        passwordHash,
      })
      .returning(DRIZZLE_PROFILE_COLUMNS)
  } catch (profileError) {
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

  return toUser(profileData)
}

export async function getCurrentUser(
  session: SessionUser | null,
): Promise<User> {
  if (!session) {
    serviceError('Unauthorized', 401)
  }

  const profile = await getPublicProfileById(session.id)
  if (!profile) {
    serviceError('Unauthorized', 401)
  }

  return toUser(profile)
}

export async function logout() {
  serviceError('Interactive logout is handled by Clerk', 410)
}

/**
 * @param _client Unused — kept only so existing call sites (and the
 * exported name itself) don't need to change. Auth.js's `signOut()` reads
 * the session cookie from the ambient request context (`next/headers`)
 * rather than through an injected client, unlike the Supabase Auth client
 * this replaces.
 */
export async function logoutWithClient(_client?: AuthClient) {
  serviceError('Interactive logout is handled by Clerk', 410)
}
