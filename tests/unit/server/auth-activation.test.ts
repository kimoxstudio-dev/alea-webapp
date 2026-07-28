// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Auth.js early to prevent loading next-auth
vi.mock('@/lib/authjs/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
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

// State for controlling Drizzle seam behavior
const drizzleHashWriteState = { zeroRows: false }

vi.mock('@/lib/db', async () => {
  const actual = await vi.importActual<typeof import('@/lib/db')>('@/lib/db')
  const { getTableName } = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
  const buildDrizzleProfile = (profile: ProfileRow) => ({
    id: profile.id,
    memberNumber: profile.member_number,
    authEmail: profile.auth_email,
    email: profile.email,
    fullName: profile.full_name,
    phone: profile.phone,
    role: profile.role,
    isActive: profile.is_active,
    activeFrom: profile.active_from ? new Date(profile.active_from) : null,
    noShowCount: profile.no_show_count,
    blockedUntil: profile.blocked_until ? new Date(profile.blocked_until) : null,
    createdAt: new Date(profile.created_at),
    updatedAt: new Date(profile.updated_at),
  })
  const buildDrizzleToken = (token: ActivationTokenRow) => ({
    id: token.id,
    profileId: token.profile_id,
    tokenHash: token.token_hash,
    expiresAt: new Date(token.expires_at),
    usedAt: token.used_at ? new Date(token.used_at) : null,
    createdBy: token.created_by,
    createdAt: new Date(token.created_at),
    updatedAt: new Date(token.updated_at),
  })
  const selectMock = vi.fn(() => ({
    from: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (getTableName(table as never) === 'activation_tokens') {
            const token = activationTokensByHash.values().next().value
            return token ? [buildDrizzleToken(token)] : []
          }
          const profile = profilesById.values().next().value
          return profile ? [buildDrizzleProfile(profile)] : []
        }),
      })),
    })),
  }))
  const drizzleUpdateMock = vi.fn((table: unknown) => ({
    set: vi.fn((updates: Record<string, unknown>) => ({
      where: vi.fn(() => {
        if (getTableName(table as never) === 'activation_tokens') {
          const execute = async () => {
            if (claimTokenErrorState.value && updates.usedAt instanceof Date) {
              throw claimTokenErrorState.value
            }
            const existing = activationTokensById.values().next().value
            if (!existing) return []
            if (claimMissMutatorState.value && updates.usedAt instanceof Date) {
              claimMissMutatorState.value(existing.token_hash)
              return []
            }
            if (
              updates.usedAt instanceof Date &&
              (existing.used_at !== null || new Date(existing.expires_at) <= updates.usedAt)
            ) {
              return []
            }
            const next = {
              ...existing,
              used_at: updates.usedAt instanceof Date
                ? updates.usedAt.toISOString()
                : (updates.usedAt === null ? null : existing.used_at),
              updated_at: '2026-04-15T11:00:00.000Z',
            }
            activationTokensById.set(next.id, next)
            activationTokensByProfileId.set(next.profile_id, next)
            activationTokensByHash.set(next.token_hash, next)
            return [buildDrizzleToken(next)]
          }
          return {
            returning: vi.fn(execute),
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              execute().then(resolve, reject),
          }
        }
        return {
          returning: vi.fn(async () => {
          const existing = profilesById.get('member-1')
          if (!existing) return []
          const next = {
            ...existing,
            is_active: typeof updates.isActive === 'boolean' ? updates.isActive : existing.is_active,
            active_from: updates.activeFrom instanceof Date ? updates.activeFrom.toISOString() : existing.active_from,
            psw_changed: updates.pswChanged instanceof Date ? updates.pswChanged.toISOString() : existing.psw_changed,
            updated_at: '2026-04-15T11:00:00.000Z',
          }
          profilesById.set(next.id, next)
          profilesByMemberNumber.set(next.member_number, next)
          return drizzleHashWriteState.zeroRows ? [] : [{ id: next.id }]
          }),
        }
      }),
    })),
  }))
  const insertMock = vi.fn((table: unknown) => ({
    values: vi.fn((values: Record<string, unknown>) => ({
      onConflictDoUpdate: vi.fn((config: { set: Record<string, unknown> }) => ({
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const execute = async () => {
            if (getTableName(table as never) !== 'activation_tokens') return []
            activationTokenUpsertMock(values)
            const existing = activationTokensByProfileId.get(String(values.profileId))
            if (existing) activationTokensByHash.delete(existing.token_hash)
            const next: ActivationTokenRow = {
              id: existing?.id ?? 'token-new',
              profile_id: String(values.profileId),
              token_hash: String(values.tokenHash),
              expires_at: (values.expiresAt as Date).toISOString(),
              used_at: null,
              created_by: String(values.createdBy),
              created_at: existing?.created_at ?? '2026-04-15T10:00:00.000Z',
              updated_at: (config.set.updatedAt as Date).toISOString(),
            }
            activationTokensById.set(next.id, next)
            activationTokensByProfileId.set(next.profile_id, next)
            activationTokensByHash.set(next.token_hash, next)
            return []
          }
          return execute().then(resolve, reject)
        },
      })),
    })),
  }))
  const sharedDrizzleDb = {
    select: selectMock,
    update: drizzleUpdateMock,
    insert: insertMock,
    execute: vi.fn(async () => ({ rows: [{ now: new Date('2026-04-15T10:30:00.000Z') }] })),
  }
  return {
    ...actual,
    getDrizzleDb: vi.fn(() => sharedDrizzleDb),
    getDrizzleAdminDb: vi.fn(() => sharedDrizzleDb),
  }
})

import { createHash } from 'node:crypto'


type SessionUser = { id: string; role: 'admin' | 'member'; email?: string }

function createAdminSession(): SessionUser {
  return { id: 'admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'member-1', role: 'member', email: 'member@example.com' }
}

type ProfileRow = {
  id: string
  member_number: string
  auth_email: string
  email: string | null
  full_name: string | null
  phone: string | null
  role: 'member' | 'admin'
  is_active: boolean
  active_from: string | null
  psw_changed: string | null
  no_show_count: number
  blocked_until: string | null
  created_at: string
  updated_at: string
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

const profilesById = new Map<string, ProfileRow>()
const profilesByMemberNumber = new Map<string, ProfileRow>()
const activationTokensById = new Map<string, ActivationTokenRow>()
const activationTokensByProfileId = new Map<string, ActivationTokenRow>()
const activationTokensByHash = new Map<string, ActivationTokenRow>()

const updateUserByIdMock = vi.fn()
const activationTokenUpsertMock = vi.fn()
const claimTokenErrorState = { value: null as { message: string } | null }
const claimMissMutatorState = { value: null as ((tokenHash: string) => void) | null }
function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function seedProfile(overrides?: Partial<ProfileRow>): ProfileRow {
  return {
    id: 'member-1',
    member_number: '100020',
    auth_email: '100020@members.alea.internal',
    email: '100020@members.alea.internal',
    full_name: 'Member 20',
    phone: null,
    role: 'member',
    is_active: false,
    active_from: null,
    psw_changed: null,
    no_show_count: 0,
    blocked_until: null,
    created_at: '2026-04-10T00:00:00.000Z',
    updated_at: '2026-04-10T00:00:00.000Z',
    ...overrides,
  }
}

function seedActivationToken(overrides?: Partial<ActivationTokenRow>): ActivationTokenRow {
  const token = {
    id: 'token-1',
    profile_id: 'member-1',
    token_hash: hashToken('plain-token'),
    expires_at: '2099-04-16T10:00:00.000Z',
    used_at: null,
    created_by: 'admin-1',
    created_at: '2026-04-15T10:00:00.000Z',
    updated_at: '2026-04-15T10:00:00.000Z',
    ...overrides,
  }
  activationTokensById.set(token.id, token)
  activationTokensByProfileId.set(token.profile_id, token)
  activationTokensByHash.set(token.token_hash, token)
  return token
}

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: {
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn(() => {
      throw new Error('Legacy Supabase DB seam must not be used')
    }),
  })),
  createSupabaseServerAdminClient: vi.fn(() => ({
    auth: {
      admin: {
        updateUserById: updateUserByIdMock,
      },
    },
    rpc: vi.fn(() => {
      throw new Error('Legacy Supabase DB time seam must not be used')
    }),
    from: vi.fn(() => {
      throw new Error('Legacy Supabase DB seam must not be used')
    }),
  })),
}))

async function loadService() {
  return import('@/lib/server/auth/auth-service')
}

describe('auth activation helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    profilesById.clear()
    profilesByMemberNumber.clear()
    activationTokensById.clear()
    activationTokensByProfileId.clear()
    activationTokensByHash.clear()
    updateUserByIdMock.mockResolvedValue({ error: null })
    activationTokenUpsertMock.mockClear()
    claimTokenErrorState.value = null
    claimMissMutatorState.value = null
    drizzleHashWriteState.zeroRows = false

    const profile = seedProfile()
    profilesById.set(profile.id, profile)
    profilesByMemberNumber.set(profile.member_number, profile)
  })

  it('returns valid activation state for a fresh token', async () => {
    seedActivationToken()
    const { getActivationLinkState } = await loadService()

    await expect(getActivationLinkState('plain-token')).resolves.toEqual({
      status: 'valid',
      memberNumber: '100020',
      fullName: 'Member 20',
    })
  })

  it('returns expired state for an expired token', async () => {
    seedActivationToken({ expires_at: '2020-04-16T10:00:00.000Z' })
    const { getActivationLinkState } = await loadService()

    await expect(getActivationLinkState('plain-token')).resolves.toEqual({
      status: 'expired',
      memberNumber: null,
      fullName: null,
    })
  })

  it('generates a fresh activation link and replaces any previous token', async () => {
    seedActivationToken({ id: 'token-old', token_hash: hashToken('old-token') })
    const { generateActivationLink } = await loadService()

    const result = await generateActivationLink({
      userId: 'member-1',
      locale: 'es',
      baseUrl: 'http://localhost:3000',
      createdBy: 'admin-1',
      session: { id: 'admin-1', role: 'admin' },
    })

    expect(result.activationLink).toContain('http://localhost:3000/es/activate?token=')
    expect(result.activationLink).not.toContain('old-token')
    expect(activationTokensByProfileId.get('member-1')?.token_hash).not.toBe(hashToken('old-token'))
  })

  it('clears used_at when regenerating an already consumed activation link', async () => {
    seedActivationToken({
      id: 'token-old',
      token_hash: hashToken('old-token'),
      used_at: '2026-04-15T10:30:00.000Z',
    })
    const { generateActivationLink } = await loadService()

    await generateActivationLink({
      userId: 'member-1',
      locale: 'es',
      baseUrl: 'http://localhost:3000',
      createdBy: 'admin-1',
      session: { id: 'admin-1', role: 'admin' },
    })

    expect(activationTokenUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      usedAt: null,
    }))
    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeNull()
  })

  it('activates account, updates password, profile state, and marks token used', async () => {
    seedActivationToken()
    const { activateAccount } = await loadService()

    const result = await activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })

    expect(updateUserByIdMock).toHaveBeenCalledWith('member-1', {
      password: 'Password123',
      email_confirm: true,
    })
    expect(result).toMatchObject({
      authEmail: '100020@members.alea.internal',
      user: {
        memberNumber: '100020',
        isActive: true,
      },
    })
    expect(profilesById.get('member-1')?.active_from).toBeTruthy()
    expect(profilesById.get('member-1')?.psw_changed).toBeTruthy()
    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeTruthy()
  })

  it('rolls token usage back when auth password update fails', async () => {
    seedActivationToken()
    updateUserByIdMock.mockResolvedValueOnce({ error: { message: 'boom' } })
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Failed to activate account',
      statusCode: 500,
    })

    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeNull()
  })

  it('fails with 500 when token claim update errors', async () => {
    seedActivationToken()
    claimTokenErrorState.value = { message: 'claim failed' }
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Failed to activate account',
      statusCode: 500,
    })
  })

  it('fails with already used when another request consumes the token before claim', async () => {
    seedActivationToken()
    claimMissMutatorState.value = (tokenHash) => {
      const existing = activationTokensByHash.get(tokenHash)
      if (!existing) return
      const next = { ...existing, used_at: '2026-04-15T10:31:00.000Z' }
      activationTokensById.set(next.id, next)
      activationTokensByProfileId.set(next.profile_id, next)
      activationTokensByHash.set(next.token_hash, next)
    }
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Activation link has already been used',
      statusCode: 400,
    })
  })

  it('does not burn a recovery token when posted to activation flow', async () => {
    profilesById.set('member-1', seedProfile({ is_active: true, active_from: '2026-04-10T00:00:00.000Z' }))
    profilesByMemberNumber.set('100020', profilesById.get('member-1')!)
    seedActivationToken()
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Activation link has already been used',
      statusCode: 400,
    })

    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeNull()
  })

  it('rolls token usage back when the Drizzle profile row disappears before password persistence', async () => {
    seedActivationToken()
    updateUserByIdMock.mockImplementationOnce(async () => {
      profilesById.delete('member-1')
      profilesByMemberNumber.delete('100020')
      return { error: null }
    })
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Failed to activate account',
      statusCode: 500,
    })

    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeNull()
  })

  it('treats zero-row Drizzle password hash update as a failed write and rolls back token', async () => {
    seedActivationToken()
    drizzleHashWriteState.zeroRows = true
    const { activateAccount } = await loadService()

    await expect(activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })).rejects.toMatchObject({
      message: 'Failed to activate account',
      statusCode: 500,
    })

    expect(activationTokensByProfileId.get('member-1')?.used_at).toBeNull()
  })

  it('activation succeeds and writes password hash to Drizzle seam', async () => {
    seedActivationToken()
    const { activateAccount } = await loadService()
    const { getDrizzleAdminDb } = await import('@/lib/db')

    const result = await activateAccount({
      token: 'plain-token',
      password: 'Password123',
    })

    expect(result).toMatchObject({
      authEmail: '100020@members.alea.internal',
      user: {
        memberNumber: '100020',
        isActive: true,
      },
    })

    expect(vi.mocked(getDrizzleAdminDb)).toHaveBeenCalled()
    const mockDb = vi.mocked(getDrizzleAdminDb).mock.results[0].value
    expect(mockDb.update).toHaveBeenCalled()
  })


describe('Member-role session denial for generateActivationLink', () => {
  it('generateActivationLink throws 403 when session role is member', async () => {
    const { generateActivationLink } = await loadService()
    const memberSession = createMemberSession()

    await expect(generateActivationLink({
      session: memberSession,
      memberNumber: '100020',
    })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 403,
    })
  })
})
})
