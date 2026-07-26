// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Auth.js and related modules early to prevent loading next-auth
const authJsSignInMock = vi.fn()
const authJsSignOutMock = vi.fn()
const authSignInWithPasswordMock = vi.fn()
const authCreateUserMock = vi.fn()
const authDeleteUserMock = vi.fn()
const authUpdateUserMock = vi.fn()

vi.mock('@/lib/authjs/auth', () => ({
  auth: vi.fn(),
  signIn: authJsSignInMock,
  signOut: authJsSignOutMock,
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
  updateAuthUserById: authUpdateUserMock,
}))

vi.mock('@/lib/db', () => ({
  getAdminDb: vi.fn(),
  getDb: vi.fn(),
  getDrizzleDb: vi.fn(),
}))

type ProfileRow = {
  id: string
  member_number: string
  email: string
  role: 'member' | 'admin'
  is_active: boolean
  created_at: string
  updated_at: string
}

const adminState = {
  byEmail: new Map<string, ProfileRow>(),
  byMemberNumber: new Map<string, ProfileRow>(),
  byId: new Map<string, ProfileRow>(),
}

const signInWithPassword = vi.fn()
const signOut = vi.fn()
const sessionScopedProfileMaybeSingle = vi.fn()
const adminCreateUser = vi.fn()
const adminDeleteUser = vi.fn()
const adminUpdateProfileSelectMaybeSingle = vi.fn()
const adminUpdateProfileEq = vi.fn()
const adminUpdateProfile = vi.fn()

function makeProfile(overrides?: Partial<ProfileRow>): ProfileRow {
  return {
    id: 'user-1',
    member_number: '100001',
    email: 'admin@alea.club',
    role: 'admin',
    is_active: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      signInWithPassword,
      signOut,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn((column: string, value: string) => ({
          maybeSingle: vi.fn(async () => {
            sessionScopedProfileMaybeSingle(column, value)
            if (column === 'id') {
              return { data: adminState.byId.get(value) ?? null, error: null }
            }
            return { data: null, error: null }
          }),
        })),
      })),
    })),
  })),
  createSupabaseServerAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        createUser: adminCreateUser,
        deleteUser: adminDeleteUser,
      },
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
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
      update: vi.fn((updates: Record<string, unknown>) => {
        adminUpdateProfile(updates)
        return {
          eq: adminUpdateProfileEq,
        }
      }),
    })),
  })),
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
    authJsSignInMock.mockResolvedValue(undefined)
    authJsSignOutMock.mockResolvedValue(undefined)
    authSignInWithPasswordMock.mockResolvedValue({ user: { id: 'auth-user-1' }, session: { user: { id: 'auth-user-1' } } })
    authCreateUserMock.mockResolvedValue({ user: { id: 'auth-user-1' } })
    authDeleteUserMock.mockResolvedValue({})
    authUpdateUserMock.mockResolvedValue({ user: { id: 'auth-user-1' } })
    signInWithPassword.mockClear()
    signOut.mockClear()
    sessionScopedProfileMaybeSingle.mockClear()
    adminCreateUser.mockClear()
    adminDeleteUser.mockClear()
    adminUpdateProfileSelectMaybeSingle.mockClear()
    adminUpdateProfileEq.mockClear()
    adminUpdateProfile.mockClear()
    adminUpdateProfileEq.mockResolvedValue([makeProfile()])
  })

  describe('login', () => {
    it('returns the public user for a valid member number / password pair', async () => {
      const profile = makeProfile({ id: 'user-1', member_number: '100001' })
      adminState.byMemberNumber.set('100001', { ...profile, email: 'admin@alea.club', auth_email: 'admin@alea.club' } as any)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: true })
      authSignInWithPasswordMock.mockResolvedValueOnce({ user: { id: 'user-1' }, session: null })

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
      const profile = makeProfile({ member_number: '100001', email: 'admin@alea.club' })
      adminState.byMemberNumber.set('100001', { ...profile } as any)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: true })
      authSignInWithPasswordMock.mockResolvedValueOnce({ user: { id: 'user-1' } })

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
      adminState.byMemberNumber.set('100001', { ...profile } as any)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: false, error: 'Invalid credentials' })

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'wrongpassword' })).rejects.toThrow()
    })

    it('rejects a suspended user (is_active: false) with a 401 ServiceError before signing in', async () => {
      const profile = makeProfile({ member_number: '100001', is_active: false })
      adminState.byMemberNumber.set('100001', { ...profile } as any)

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
    })

    it('rejects when the credential profile has no auth email to use for Supabase sign-in', async () => {
      const profile = makeProfile({ member_number: '100001', email: null })
      adminState.byMemberNumber.set('100001', { ...profile } as any)

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
    })

    it('rejects when Supabase signs in a different user id than the resolved profile', async () => {
      const profile = makeProfile({ member_number: '100001' })
      adminState.byMemberNumber.set('100001', { ...profile } as any)
      adminState.byId.set('user-1', profile)
      adminState.byEmail.set('admin@alea.club', profile)
      authJsSignInMock.mockResolvedValueOnce({ ok: true })
      authSignInWithPasswordMock.mockResolvedValueOnce({ user: { id: 'different-user' } })

      const { login } = await loadService()

      await expect(login({ identifier: '100001', password: 'password123' })).rejects.toThrow()
    })
  })

  describe('register', () => {
    it('creates a Supabase Auth user, updates the trigger-created profile row, and returns the public user', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'newuser@alea.club' } })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'newuser@alea.club' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce([newProfile])

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
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'new@alea.club' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce([newProfile])

      const { register } = await loadService()
      await register({
        memberNumber: '100099',
        password: 'Password123',
      })

      expect(authSignInWithPasswordMock).toHaveBeenCalled()
    })

    it('does not overwrite contact email with the internal auth email during registration', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099', email: 'contact@example.com' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce([newProfile])

      const { register } = await loadService()
      const result = await register({
        memberNumber: '100099',
        password: 'Password123',
        email: 'contact@example.com',
      })

      expect(result.email).toMatch(/contact@example.com|undefined/)
    })

    it('rejects with 400 when the member number is already taken', async () => {
      const existing = makeProfile({ member_number: '100001' })
      adminState.byMemberNumber.set('100001', existing as any)

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
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      adminUpdateProfileEq.mockRejectedValueOnce({ code: '23505' })

      const { register } = await loadService()

      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow()
      expect(authDeleteUserMock).toHaveBeenCalled()
    })

    it('cleans up the auth user and rejects with 500 when the profile update fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      adminUpdateProfileEq.mockRejectedValueOnce(new Error('DB error'))

      const { register } = await loadService()

      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow()
      expect(authDeleteUserMock).toHaveBeenCalled()
    })

    it('succeeds even when auto-login after registration fails', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce([newProfile])
      authSignInWithPasswordMock.mockRejectedValueOnce(new Error('Auth failed'))

      const { register } = await loadService()
      const result = await register({ memberNumber: '100099', password: 'Password123' })

      expect(result.id).toBe('new-user-id')
    })

    it('creates a session with the default server client when no session client is provided', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      const newProfile = makeProfile({ id: 'new-user-id', member_number: '100099' })
      adminState.byId.set('new-user-id', newProfile)
      adminUpdateProfileEq.mockResolvedValueOnce([newProfile])

      const { register } = await loadService()
      await register({ memberNumber: '100099', password: 'Password123' })

      expect(authSignInWithPasswordMock).toHaveBeenCalled()
    })

    it('cleans up the auth user and rejects when profile update returns no row', async () => {
      authCreateUserMock.mockResolvedValueOnce({ user: { id: 'new-user-id', email: 'new@alea.club' } })
      adminUpdateProfileEq.mockResolvedValueOnce([])

      const { register } = await loadService()

      await expect(register({ memberNumber: '100099', password: 'Password123' })).rejects.toThrow()
      expect(authDeleteUserMock).toHaveBeenCalled()
    })
  })

  describe('getCurrentUser', () => {
    it('rejects when no session is present', async () => {
      const { getCurrentUser } = await loadService()

      await expect(getCurrentUser(undefined)).rejects.toThrow()
    })

    it('rejects when the session user profile is missing', async () => {
      const { getCurrentUser } = await loadService()

      await expect(getCurrentUser({ id: 'unknown-user', role: 'member' })).rejects.toThrow()
    })

    it('reads the current profile through the session-scoped client instead of the admin client', async () => {
      const profile = makeProfile()
      adminState.byId.set('user-1', profile)
      sessionScopedProfileMaybeSingle.mockResolvedValueOnce(profile)

      const { getCurrentUser } = await loadService()
      const result = await getCurrentUser({ id: 'user-1', role: 'admin' })

      expect(result.id).toBe('user-1')
      expect(sessionScopedProfileMaybeSingle).toHaveBeenCalled()
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
      signOut.mockRejectedValueOnce(new Error('Signout failed'))

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
