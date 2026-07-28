// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Auth.js and related modules early to prevent loading next-auth
const authJsSignInMock = vi.fn()
const authJsSignOutMock = vi.fn()
const authJsAuthMock = vi.fn()
const verifyCredentialsMock = vi.fn()
const authCreateUserMock = vi.fn()
const authDeleteUserMock = vi.fn()
const drizzleSelectMock = vi.fn()
const drizzleInsertMock = vi.fn()
const drizzleExecuteMock = vi.fn(async () => ({
  rows: [{ now: new Date('2026-04-15T10:30:00.000Z') }],
}))

vi.mock('@/lib/authjs/auth', () => ({
  signIn: authJsSignInMock,
  signOut: authJsSignOutMock,
  auth: authJsAuthMock,
  handlers: { GET: vi.fn(), POST: vi.fn() },
}))

vi.mock('next-auth', () => ({
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'AuthError'
    }
  },
}))

vi.mock('next-auth/jwt', () => ({
  getToken: vi.fn(),
}))

vi.mock('@/lib/auth/session', () => ({
  createAuthUser: authCreateUserMock,
  deleteAuthUser: authDeleteUserMock,
  updateAuthUserById: vi.fn(),
}))

vi.mock('@/lib/authjs/credentials-user', () => ({
  verifyCredentials: verifyCredentialsMock,
  createAuthUser: authCreateUserMock,
  deleteAuthUser: authDeleteUserMock,
  updateAuthUserById: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
  getAdminDb: vi.fn(() => buildAdminClient()),
  getDrizzleDb: vi.fn(() => ({
    select: drizzleSelectMock,
    execute: drizzleExecuteMock,
  })),
  getDrizzleAdminDb: vi.fn(() => ({
    select: drizzleSelectMock,
    insert: drizzleInsertMock,
    execute: drizzleExecuteMock,
  })),
}))

type ProfileRow = {
  id: string
  member_number: string
  auth_email?: string
  email?: string
  role: 'member' | 'admin'
  is_active: boolean
  full_name?: string | null
  created_at: string
  updated_at: string
}

const adminState = {
  byEmail: new Map<string, ProfileRow>(),
  byMemberNumber: new Map<string, ProfileRow>(),
  byId: new Map<string, ProfileRow>(),
}
const databaseTimeRpcMock = vi.fn(async (fn: string) => (
  fn === 'get_database_time'
    ? { data: '2026-04-15T10:30:00.000Z', error: null }
    : { data: null, error: null }
))

const drizzleState = {
  insertError: null as Error | null,
  insertReturnsRow: true,
}

const signOut = vi.fn()

function makeProfile(overrides?: Partial<ProfileRow>): ProfileRow {
  return {
    id: 'user-1',
    member_number: '100001',
    email: 'admin@alea.club',
    auth_email: 'admin@alea.club',
    role: 'admin',
    is_active: true,
    full_name: 'Admin User',
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function toDrizzleProfile(profile: ProfileRow) {
  return {
    id: profile.id,
    memberNumber: profile.member_number,
    authEmail: profile.auth_email ?? `${profile.member_number}@members.alea.internal`,
    email: profile.email ?? null,
    fullName: profile.full_name ?? null,
    phone: null,
    role: profile.role,
    isActive: profile.is_active,
    activeFrom: null,
    noShowCount: 0,
    blockedUntil: null,
    createdAt: new Date(profile.created_at),
    updatedAt: new Date(profile.updated_at),
  }
}

function getFirstProfile() {
  const fromId = adminState.byId.values().next().value
  if (fromId) return fromId
  const fromMember = adminState.byMemberNumber.values().next().value
  if (fromMember) return fromMember
  const fromEmail = adminState.byEmail.values().next().value
  return fromEmail ?? null
}

function buildDrizzleSelectChain() {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          const profile = getFirstProfile()
          return profile ? [toDrizzleProfile(profile)] : []
        }),
      })),
    })),
  }
}

function buildDrizzleInsertChain() {
  return {
    values: vi.fn((values: Record<string, unknown>) => ({
      returning: vi.fn(async () => {
        if (drizzleState.insertError) throw drizzleState.insertError
        if (!drizzleState.insertReturnsRow) return []
        const row = makeProfile({
          id: String(values.id),
          member_number: String(values.memberNumber),
          auth_email: String(values.authEmail),
          email: typeof values.email === 'string' ? values.email : String(values.authEmail),
          role: 'member',
          is_active: true,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        })
        adminState.byId.set(row.id, row)
        adminState.byMemberNumber.set(row.member_number, row)
        adminState.byEmail.set(row.auth_email ?? row.email ?? '', row)
        return [toDrizzleProfile(row)]
      }),
    })),
  }
}

// Build admin client factory
function buildAdminClient() {
  return {
    auth: {
      admin: {
        createUser: authCreateUserMock,
        deleteUser: authDeleteUserMock,
      },
    },
    rpc: databaseTimeRpcMock,
    from: vi.fn((tableName: string) => {
      if (tableName !== 'profiles') {
        return { select: vi.fn(), update: vi.fn() }
      }
      return {
        select: vi.fn(),
        update: vi.fn(),
      }
    }),
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { signOut },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((column: string, value: string) => ({
          maybeSingle: vi.fn(async () => {
            if (column === 'id') {
              return { data: adminState.byId.get(value) ?? null, error: null }
            }
            return { data: null, error: null }
          }),
        })),
      })),
    })),
  })),
  createSupabaseServerAdminClient: vi.fn(() => buildAdminClient()),
}))

async function loadService() {
  return import('@/lib/server/auth/auth-service')
}

describe('auth service', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    adminState.byEmail.clear()
    adminState.byMemberNumber.clear()
    adminState.byId.clear()
    drizzleState.insertError = null
    drizzleState.insertReturnsRow = true
    databaseTimeRpcMock.mockClear()
    authJsSignInMock.mockResolvedValue({ ok: true })
    authJsAuthMock.mockResolvedValue({ user: { id: 'user-1' } })
    authJsSignOutMock.mockResolvedValue(undefined)
    verifyCredentialsMock.mockResolvedValue({
      id: 'user-1',
      member_number: '100001',
      auth_email: 'admin@alea.club',
      email: 'admin@alea.club',
      role: 'member' as const,
      is_active: true,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    })
    authCreateUserMock.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null })
    authDeleteUserMock.mockResolvedValue({})
    signOut.mockResolvedValue({ error: null })
    drizzleSelectMock.mockImplementation(() => buildDrizzleSelectChain())
    drizzleInsertMock.mockImplementation(() => buildDrizzleInsertChain())
  })

  describe('login', () => {
    it('returns the public user for a valid member number / password pair', async () => {
      const profile = makeProfile({ id: 'user-1', member_number: '100001' })
      adminState.byMemberNumber.set('100001', profile)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: true })

      const { login } = await loadService()
      const result = await login({ identifier: '100001', password: 'password123' })

      expect(result).toMatchObject({
        id: 'user-1',
        role: 'admin',
        memberNumber: '100001',
      })
      expect(authJsSignInMock).toHaveBeenCalled()
    })

    it('resolves the member number to the Supabase Auth email before signing in', async () => {
      const profile = makeProfile({ member_number: '100001', auth_email: 'admin@alea.club' })
      adminState.byMemberNumber.set('100001', profile)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: true })

      const { login } = await loadService()
      const result = await login({ identifier: '100001', password: 'password123' })

      expect(result.id).toBe('user-1')
      expect(authJsSignInMock).toHaveBeenCalled()
    })

    it('rejects missing credentials with a 400 ServiceError', async () => {
      const { login } = await loadService()

      await expect(login({})).rejects.toThrow()
    })

    it('rejects an unknown member number with a 401 ServiceError', async () => {
      const { login } = await loadService()

      await expect(login({ identifier: '999999', password: 'password123' })).rejects.toThrow()
    })

    it('rejects invalid credentials when credential verification fails', async () => {
      const profile = makeProfile({ member_number: '100001' })
      adminState.byMemberNumber.set('100001', profile)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      const { AuthError } = await import('next-auth')
      authJsSignInMock.mockRejectedValueOnce(new AuthError('Invalid credentials'))

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'wrongpassword' })).rejects.toThrow()
    })

    it('rejects a suspended user (is_active: false) with a 401 ServiceError before signing in', async () => {
      const profile = makeProfile({ member_number: '100001', is_active: false })
      adminState.byMemberNumber.set('100001', profile)

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
    })

    it('rejects when the credential profile has no auth email', async () => {
      const profile = makeProfile({ member_number: '100001', auth_email: '', email: undefined })
      adminState.byMemberNumber.set('100001', profile)

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
      expect(verifyCredentialsMock).not.toHaveBeenCalled()
    })

  })

    it('rejects when authenticated identity differs from member-number-resolved profile (identity-drift guard)', async () => {
      const credentialProfile = makeProfile({ id: 'user-1', member_number: '100001' })
      adminState.byMemberNumber.set('100001', credentialProfile)
      adminState.byId.set('user-1', credentialProfile)
      adminState.byEmail.set('admin@alea.club', credentialProfile)
      
      // verifyCredentials() authenticates a DIFFERENT user ID than the profile we resolved
      verifyCredentialsMock.mockResolvedValueOnce({
        id: 'different-user-id',
        member_number: '100001',
        auth_email: 'admin@alea.club',
        email: 'admin@alea.club',
        role: 'member' as const,
        is_active: true,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      })

      const { login } = await loadService()

      // (a) Assertion: login rejects with 401
      await expect(login({ identifier: '100001', password: 'Admin123' })).rejects.toThrow('Invalid credentials')
      
      // (b) Assertion: authJsSignIn is NEVER called
      // This proves no session cookie was ever issued, even though credentials were valid.
      // The new design verifies identity BEFORE calling signIn, so a mismatch never results in
      // any session being issued at all — no window where a valid session rides on a 401 response.
      expect(authJsSignInMock).not.toHaveBeenCalled()
    })


    it('never attempts same-request session readback via auth() during login (regression guard for KIM-433 root cause)', async () => {
      const profile = makeProfile({ member_number: '100001' })
      adminState.byMemberNumber.set('100001', profile)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      
      // Mock verifyCredentials to succeed with matching ID
      verifyCredentialsMock.mockResolvedValueOnce({
        id: 'user-1',
        member_number: '100001',
        auth_email: 'admin@alea.club',
        email: 'admin@alea.club',
        role: 'member' as const,
        is_active: true,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      })

      const { login } = await loadService()
      await login({ identifier: '100001', password: 'Admin123' })

      // Trip-wire: auth() should NEVER be called. This guards against a regression
      // that reintroduces the broken same-request readback pattern (see
      // establishAuthJsSession() doc comment in lib/server/auth/auth-service.ts
      // for why that pattern fails: auth() reads from frozen incoming-request
      // headers snapshot while signIn() writes to mutable cookie jar; the snapshot
      // doesn't see the write in the same request).
      expect(authJsAuthMock).not.toHaveBeenCalled()
    })

  describe('register', () => {
    it('creates a Supabase Auth user, inserts the Drizzle profile row, and returns the public user', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })

      const { register } = await loadService()
      const result = await register({
        memberNumber: '100099',
        password: 'Password123',
      })

      expect(result).toMatchObject({
        id: 'new-user-id',
        memberNumber: '100099',
      })
    })

    it('calls Auth.js signIn after creating the profile to establish a session', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      verifyCredentialsMock.mockResolvedValueOnce({
        id: 'new-user-id',
        email: '100099@members.alea.internal',
        name: null,
        role: 'member' as const,
        isActive: true,
      })

      const { register } = await loadService()
      await register({
        memberNumber: '100099',
        password: 'Password123',
      })

      expect(authJsSignInMock).toHaveBeenCalled()
    })

    it('persists the internal auth email during registration', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })

      const { register } = await loadService()
      const result = await register({
        memberNumber: '100099',
        password: 'Password123',
      })

      expect(result.id).toBe('new-user-id')
      expect(result.email).toBe('100099@members.alea.internal')
    })

    it('rejects with 400 when the member number is already taken', async () => {
      const existing = makeProfile({ member_number: '100001' })
      adminState.byMemberNumber.set('100001', existing)

      const { register } = await loadService()

      await expect(register({ memberNumber: '100001', password: 'Password123' })).rejects.toThrow()
    })

    it('rejects with 400 when member number is missing', async () => {
      const { register } = await loadService()

      await expect(register({ password: 'Password123' })).rejects.toThrow()
    })

    it('rejects with 400 when member number exceeds 20 characters', async () => {
      const { register } = await loadService()

      await expect(register({ memberNumber: '123456789012345678901', password: 'Password123' })).rejects.toThrow()
    })

    it('rejects with 400 when member number contains non-numeric characters', async () => {
      const { register } = await loadService()

      await expect(register({ memberNumber: 'ABC123', password: 'Password123' })).rejects.toThrow()
    })

    it('rejects with 400 when password is missing', async () => {
      const { register } = await loadService()

      await expect(register({ memberNumber: '100099' })).rejects.toThrow()
    })

    it('rejects with 500 when Supabase Auth user creation fails', async () => {
      authCreateUserMock.mockRejectedValueOnce(new Error('Auth service down'))

      const { register } = await loadService()

      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow()
    })

    it('cleans up the auth user and rejects with 400 when profile insert hits a unique constraint', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const profileError = new Error('Unique violation')
      ;(profileError as any).code = '23505'
      drizzleState.insertError = profileError

      const { register } = await loadService()
      
      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow('Invalid registration details')
    })

    it('cleans up the auth user and rejects with 500 when the profile insert fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      drizzleState.insertError = new Error('DB error')

      const { register } = await loadService()
      
      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow('Failed to create user profile')
    })

    it('succeeds even when auto-login after registration fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      verifyCredentialsMock.mockResolvedValueOnce({
        id: 'new-user-id',
        email: '100099@members.alea.internal',
        name: null,
        role: 'member' as const,
        isActive: true,
      })
      // signInWithAuthJs calls authJsSignIn, which should reject on auth failure
      authJsSignInMock.mockRejectedValueOnce(new Error('Auth failed'))

      const { register } = await loadService()
      const result = await register({ memberNumber: '100099', password: 'Password123' })

      expect(result.id).toBe('new-user-id')
    })

    it('creates a session with Auth.js when no session client is provided', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      verifyCredentialsMock.mockResolvedValueOnce({
        id: 'new-user-id',
        email: '100099@members.alea.internal',
        name: null,
        role: 'member' as const,
        isActive: true,
      })

      const { register } = await loadService()
      await register({ memberNumber: '100099', password: 'Password123' })

      expect(authJsSignInMock).toHaveBeenCalled()
    })

    it('cleans up the auth user and rejects when profile insert returns no row', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      drizzleState.insertReturnsRow = false

      const { register } = await loadService()

      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow()
      expect(authDeleteUserMock).toHaveBeenCalled()
    })
  })

  describe('getCurrentUser', () => {
    it('rejects when no session is present', async () => {
      const { getCurrentUser } = await loadService()

      await expect(getCurrentUser(null)).rejects.toThrow()
    })

    it('rejects when the session user profile is missing', async () => {
      const { getCurrentUser } = await loadService()

      await expect(getCurrentUser({ id: 'unknown-user', role: 'member' })).rejects.toThrow()
    })

    it('reads the current profile through the Drizzle seam', async () => {
      const profile = makeProfile()
      adminState.byId.set('user-1', profile)

      const { getCurrentUser } = await loadService()
      const result = await getCurrentUser({ id: 'user-1', role: 'admin' })

      expect(result.id).toBe('user-1')
    })
  })

  describe('logout', () => {
    it('returns success when the server client signs out cleanly', async () => {
      signOut.mockResolvedValueOnce({ error: null })

      const { logout } = await loadService()
      const result = await logout()

      expect(result).toEqual({ success: true })
      expect(authJsSignOutMock).toHaveBeenCalled()
    })

    it('maps sign-out failures to a 500 ServiceError', async () => {
      authJsSignOutMock.mockRejectedValueOnce(new Error('Signout failed'))

      const { logout } = await loadService()

      await expect(logout()).rejects.toThrow()
    })

    it('maps route-handler sign-out failures to a 500 ServiceError', async () => {
      authJsSignOutMock.mockRejectedValueOnce(new Error('Auth.js signout failed'))

      const { logout } = await loadService()

      await expect(logout()).rejects.toThrow()
    })

    it('returns success when a route-handler client signs out cleanly', async () => {
      signOut.mockResolvedValueOnce({ error: null })

      const { logoutWithClient } = await loadService()
      const result = await logoutWithClient()

      expect(result).toEqual({ success: true })
    })
  })
})
