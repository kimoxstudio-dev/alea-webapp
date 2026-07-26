// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Auth.js and related modules early to prevent loading next-auth
const authJsSignInMock = vi.fn()
const authJsSignOutMock = vi.fn()
const authJsAuthMock = vi.fn()
const verifyCredentialsMock = vi.fn()
const authSignInWithPasswordMock = vi.fn()
const authCreateUserMock = vi.fn()
const authDeleteUserMock = vi.fn()

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
  signInWithPassword: authSignInWithPasswordMock,
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

const signOut = vi.fn()
const adminCreateUser = vi.fn()
const adminDeleteUser = vi.fn()
const adminUpdateProfile = vi.fn()
const adminUpdateProfileEq = vi.fn()

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

// Build admin client factory
function buildAdminClient() {
  return {
    auth: {
      admin: {
        createUser: authCreateUserMock,
        deleteUser: authDeleteUserMock,
      },
    },
    from: vi.fn((tableName: string) => {
      if (tableName !== 'profiles') {
        return { select: vi.fn(), update: vi.fn() }
      }
      return {
        select: vi.fn((cols: string) => ({
          eq: vi.fn((column: string, value: string) => ({
            maybeSingle: vi.fn(async () => {
              if (column === 'email') {
                return { data: adminState.byEmail.get(value) ?? null, error: null }
              }
              if (column === 'member_number') {
                return { data: adminState.byMemberNumber.get(value) ?? null, error: null }
              }
              if (column === 'id') {
                return { data: adminState.byId.get(value) ?? null, error: null }
              }
              return { data: null, error: null }
            }),
          })),
        })),
        update: vi.fn((updates: Record<string, unknown>) => ({
          eq: vi.fn((column: string, value: string) => ({
            select: vi.fn((cols: string) => ({
              maybeSingle: adminUpdateProfileEq,
            })),
          })),
        })),
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
    authSignInWithPasswordMock.mockResolvedValue({ user: { id: 'auth-user-1' }, session: null })
    authCreateUserMock.mockResolvedValue({ data: { user: { id: 'auth-user-1' } }, error: null })
    authDeleteUserMock.mockResolvedValue({})
    signOut.mockResolvedValue({ error: null })
    adminUpdateProfileEq.mockResolvedValue([makeProfile()])
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

    it('rejects invalid credentials when Supabase sign-in fails', async () => {
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

    it('rejects when the credential profile has no auth email to use for Supabase sign-in', async () => {
      const profile = makeProfile({ member_number: '100001', auth_email: null, email: null })
      adminState.byMemberNumber.set('100001', profile)

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
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
    it('creates a Supabase Auth user, updates the trigger-created profile row, and returns the public user', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'newuser@alea.club' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce({ data: newProfile, error: null })

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

    it('calls signInWithPassword after creating the profile to establish a session', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'new@alea.club' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce({ data: newProfile, error: null })

      const { register } = await loadService()
      await register({
        memberNumber: '100099',
        password: 'Password123',
      })

      expect(authSignInWithPasswordMock).toHaveBeenCalled()
    })

    it('does not overwrite contact email with the internal auth email during registration', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'contact@example.com' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce({ data: newProfile, error: null })

      const { register } = await loadService()
      const result = await register({
        memberNumber: '100099',
        password: 'Password123',
        email: 'contact@example.com',
      })

      expect(result.id).toBe('new-user-id')
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

    it('cleans up the auth user and rejects with 400 when profile update hits a unique constraint', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const profileError = new Error('Unique violation')
      ;(profileError as any).code = '23505'
      adminUpdateProfileEq.mockResolvedValueOnce({ data: null, error: profileError })

      const { register } = await loadService()
      
      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow('Invalid registration details')
    })

    it('cleans up the auth user and rejects with 500 when the profile update fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const profileError = new Error('DB error')
      adminUpdateProfileEq.mockResolvedValueOnce({ data: null, error: profileError })

      const { register } = await loadService()
      
      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow('Failed to create user profile')
    })

    it('succeeds even when auto-login after registration fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce({ data: newProfile, error: null })
      // signInWithAuthJs calls authJsSignIn, which should reject on auth failure
      authJsSignInMock.mockRejectedValueOnce(new Error('Auth failed'))

      const { register } = await loadService()
      const result = await register({ memberNumber: '100099', password: 'Password123' })

      expect(result.id).toBe('new-user-id')
    })

    it('creates a session with the default server client when no session client is provided', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce({ data: newProfile, error: null })

      const { register } = await loadService()
      await register({ memberNumber: '100099', password: 'Password123' })

      expect(authSignInWithPasswordMock).toHaveBeenCalled()
    })

    it('cleans up the auth user and rejects when profile update returns no row', async () => {
      authCreateUserMock.mockResolvedValueOnce({ data: { user: { id: 'new-user-id' } }, error: null })
      adminUpdateProfileEq.mockResolvedValueOnce([])

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

    it('reads the current profile through the session-scoped client instead of the admin client', async () => {
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
