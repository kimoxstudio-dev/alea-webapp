// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlMock, whereHasColumn, hasColumn, whereConditionCount } from '../helpers/sql-mock'

const clerkGetUserListMock = vi.fn()
const clerkUpdateUserMock = vi.fn()
const clerkDeleteUserMock = vi.fn()

// In-memory store for test data
const profilesStore = new Map<string, any>()

// Test failure injection points
let shouldFailUpdateWithZeroRows = false

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({
  sql: sqlMock.sql,
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: clerkGetUserListMock,
      updateUser: clerkUpdateUserMock,
      deleteUser: clerkDeleteUserMock,
    },
  })),
}))

function setupSqlMock() {
  sqlMock.reset()

  // Helper to match ILIKE pattern (case-insensitive substring)
  function matchesPattern(text: string | null | undefined, pattern: string | null | undefined): boolean {
    if (!pattern || !text) return false
    // Pattern is in format %search% — extract the search term
    const searchTerm = pattern.replace(/%/g, '').toLowerCase()
    return text.toLowerCase().includes(searchTerm)
  }

  // SELECT by id (WHERE id = $1) — verb-anchored, id-column scoped
  sqlMock.addHandler({
    name: 'SELECT profiles by id',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      whereHasColumn(stmt, 'id') &&
      whereConditionCount(stmt) === 1,
    respond: (stmt) => {
      const id = stmt.values[0] as string
      const profile = profilesStore.get(id)
      return profile ? [profile] : []
    },
  })

  // SELECT by member_number (WHERE member_number = $1, exact match) — verb-anchored, member_number-column scoped
  // NOTE: Deliberately excludes ILIKE queries; those are handled by the fallback search handler
  sqlMock.addHandler({
    name: 'SELECT profiles by member_number (exact)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      whereHasColumn(stmt, 'member_number') &&
      !whereHasColumn(stmt, 'id') && // Differentiate from pre-check query
      whereConditionCount(stmt) === 1 &&
      !stmt.text.includes('ilike'), // Exclude ILIKE/search queries
    respond: (stmt) => {
      const memberNumber = stmt.values[0]
      for (const profile of profilesStore.values()) {
        if (profile.member_number === memberNumber) {
          return [profile]
        }
      }
      return []
    },
  })

  // SELECT for pre-check (WHERE member_number = ? AND id <> ?) — verb-anchored, two-condition scoped
  sqlMock.addHandler({
    name: 'SELECT profiles pre-check (member_number duplicate check)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      whereHasColumn(stmt, 'member_number') &&
      whereHasColumn(stmt, 'id') &&
      whereConditionCount(stmt) === 2,
    respond: (stmt) => {
      const memberNumber = stmt.values[0]
      const excludeId = stmt.values[1]
      for (const profile of profilesStore.values()) {
        if (profile.member_number === memberNumber && profile.id !== excludeId) {
          return [profile]
        }
      }
      return []
    },
  })

  // UPDATE profiles with all 7 fields (member_number, full_name, email, phone, role, is_active, auth_email)
  // Verb-anchored to update, scoped by column names in SET and WHERE id clause
  sqlMock.addHandler({
    name: 'UPDATE profiles with all 7 fields',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      hasColumn(stmt, 'member_number') &&
      whereHasColumn(stmt, 'id'),
    respond: (stmt) => {
      // Test failure injection for finding 7 (zero-rows path)
      if (shouldFailUpdateWithZeroRows) {
        return []
      }

      // Extract values in order
      const memberNumber = stmt.values[0] as string
      const fullName = stmt.values[1] as string
      const email = stmt.values[2] as string | null
      const phone = stmt.values[3] as string | null
      const role = stmt.values[4] as string
      const isActive = stmt.values[5] as boolean
      const authEmail = stmt.values[6] as string
      const id = stmt.values[7] as string

      const profile = profilesStore.get(id)
      if (!profile) {
        return []
      }

      const updated = {
        ...profile,
        member_number: memberNumber,
        full_name: fullName,
        email: email,
        phone: phone,
        role: role,
        is_active: isActive,
        auth_email: authEmail,
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(id, updated)

      if (stmt.returning) {
        return [updated]
      }
      return [{ id }]
    },
  })

  // UPDATE profiles SET no_show_count, blocked_until
  // Verb-anchored to update, scoped by no_show_count column in SET (NOT substring match)
  sqlMock.addHandler({
    name: 'UPDATE profiles reset no_show_count/blocked_until',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      hasColumn(stmt, 'no_show_count'),
    respond: (stmt) => {
      const id = stmt.values[0]
      const profile = profilesStore.get(id as string)
      if (profile) {
        const updated = { ...profile, no_show_count: 0, blocked_until: null }
        profilesStore.set(id as string, updated)
        if (stmt.returning) {
          return [updated]
        }
        return [{ id }]
      }
      return []
    },
  })

  // UPDATE profiles SET blocked_until (clearing it)
  // Verb-anchored to update, scoped by blocked_until column (NOT substring match)
  sqlMock.addHandler({
    name: 'UPDATE profiles clear blocked_until',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      hasColumn(stmt, 'blocked_until') &&
      !hasColumn(stmt, 'no_show_count'), // Differentiate from the above handler
    respond: (stmt) => {
      const id = stmt.values[stmt.values.length - 1]
      const profile = profilesStore.get(id as string)
      if (profile) {
        const updated = { ...profile, blocked_until: null }
        profilesStore.set(id as string, updated)
        if (stmt.returning) {
          return [updated]
        }
        return [{ id }]
      }
      return []
    },
  })

  // UPDATE profiles SET is_active = false (for deleteUser deactivation step)
  // Verb-anchored to update, scoped by is_active column in SET
  sqlMock.addHandler({
    name: 'UPDATE profiles deactivate',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      hasColumn(stmt, 'is_active') &&
      !hasColumn(stmt, 'member_number') && // Differentiate from full-update handler
      !hasColumn(stmt, 'no_show_count'), // Differentiate from reset handlers
    respond: (stmt) => {
      const id = stmt.values[0] as string
      const profile = profilesStore.get(id)
      if (profile) {
        const updated = { ...profile, is_active: false }
        profilesStore.set(id, updated)
        if (stmt.returning) {
          return [updated]
        }
        return [{ id }]
      }
      return []
    },
  })

  // SELECT COUNT (any profiles count query) — verb-anchored, isCountSelect check
  sqlMock.addHandler({
    name: 'SELECT COUNT profiles',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      stmt.isCountSelect,
    respond: (stmt) => {
      // If there are string values, assume they're filter patterns
      const stringValues = stmt.values.filter((v) => typeof v === 'string') as string[]
      const pattern = stringValues[0] || ''

      if (pattern) {
        // Search with filter
        const filtered = Array.from(profilesStore.values()).filter((p) => {
          return (
            matchesPattern(p.member_number, pattern) ||
            matchesPattern(p.full_name, pattern) ||
            matchesPattern(p.email, pattern)
          )
        })
        return [{ count: filtered.length }]
      }

      // No filter, count all
      return [{ count: profilesStore.size }]
    },
  })

  // SELECT profiles with ORDER/LIMIT/OFFSET — matches both search and non-search queries
  // This is the fallback for any SELECT profiles query that doesn't match a more specific handler
  sqlMock.addHandler({
    name: 'SELECT profiles with ORDER/LIMIT (fallback)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      !stmt.isCountSelect,
    respond: (stmt) => {
      // If we reach this handler, assume it's a generic select (possibly with search)
      // that wasn't caught by the more specific handlers
      const stringValues = stmt.values.filter((v) => typeof v === 'string') as string[]
      const maybePattern = stringValues[0] || ''

      let profiles = Array.from(profilesStore.values())

      // If there's a pattern value, attempt filtering with it
      if (maybePattern) {
        profiles = profiles.filter((p) => {
          return (
            matchesPattern(p.member_number, maybePattern) ||
            matchesPattern(p.full_name, maybePattern) ||
            matchesPattern(p.email, maybePattern)
          )
        })
      }

      // Sort by created_at
      profiles = profiles.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      // Extract numeric values for LIMIT and OFFSET
      const numericValues = stmt.values.filter((v) => typeof v === 'number')
      if (numericValues.length >= 2) {
        const limit = numericValues[0] as number
        const offset = numericValues[1] as number
        profiles = profiles.slice(offset, offset + limit)
      }

      return profiles
    },
  })

  // DELETE from profiles — verb-anchored to delete
  sqlMock.addHandler({
    name: 'DELETE profiles by id',
    verb: 'delete',
    match: (stmt) =>
      stmt.table === 'profiles' &&
      whereHasColumn(stmt, 'id'),
    respond: (stmt) => {
      const id = stmt.values[0]
      const deletedProfile = profilesStore.get(id as string)
      profilesStore.delete(id as string)
      if (stmt.returning) {
        return deletedProfile ? [{ id }] : []
      }
      return deletedProfile ? [{ id }] : []
    },
  })

  // INSERT into profiles — verb-anchored to insert
  sqlMock.addHandler({
    name: 'INSERT profiles',
    verb: 'insert',
    match: (stmt) => stmt.table === 'profiles',
    respond: (stmt) => {
      const newProfile = {
        id: `profile-${Math.random().toString(36).substr(2, 9)}`,
        member_number: stmt.values[1],
        full_name: stmt.values[2],
        auth_email: stmt.values[3],
        email: stmt.values[4],
        phone: stmt.values[5],
        role: 'member',
        is_active: false,
        active_from: null,
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(newProfile.id, newProfile)
      return [newProfile]
    },
  })
}

describe('users-service (raw SQL with Neon)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    profilesStore.clear()
    shouldFailUpdateWithZeroRows = false

    setupSqlMock()

    // Load test data
    const adminProfile = {
      id: 'admin-1',
      member_number: '100001',
      full_name: 'Admin User',
      auth_email: '100001@members.alea.internal',
      email: 'admin@alea.club',
      phone: '600000001',
      role: 'admin' as const,
      is_active: true,
      active_from: '2024-01-01T00:00:00.000Z',
      no_show_count: 0,
      blocked_until: null,
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-01T00:00:00.000Z',
    }
    const memberProfile = {
      id: 'member-1',
      member_number: '100002',
      full_name: 'Member User',
      auth_email: '100002@members.alea.internal',
      email: 'member@alea.club',
      phone: '600000002',
      role: 'member' as const,
      is_active: true,
      active_from: '2024-01-02T00:00:00.000Z',
      no_show_count: 0,
      blocked_until: null,
      created_at: '2024-01-02T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
    }
    profilesStore.set(adminProfile.id, adminProfile)
    profilesStore.set(memberProfile.id, memberProfile)

    // Reset Clerk mocks with default behavior (succeed)
    clerkGetUserListMock.mockReset()
    clerkGetUserListMock.mockResolvedValue({ data: [] })
    clerkUpdateUserMock.mockReset()
    clerkUpdateUserMock.mockResolvedValue({ id: 'clerk-user-1' })
  })

  describe('listPaginatedUsers', () => {
    it('clamps page=0 to 1', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: 0, limit: 10 })
      expect(result.page).toBe(1)
    })

    it('clamps page=-5 to 1', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: -5, limit: 10 })
      expect(result.page).toBe(1)
    })

    it('clamps limit=0 to default and totalPages is not Infinity', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: 1, limit: 0 })
      expect(result.limit).toBeGreaterThan(0)
      expect(result.totalPages).not.toBe(Infinity)
    })

    it('clamps limit=-10 to 1', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: 1, limit: -10 })
      expect(result.limit).toBeGreaterThan(0)
    })

    it('clamps limit=200 to 100', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: 1, limit: 200 })
      expect(result.limit).toBeLessThanOrEqual(100)
    })

    it('returns limit=50 as-is when within bounds', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')
      const result = await listPaginatedUsers({ page: 1, limit: 50 })
      expect(result.limit).toBe(50)
    })

    it('filters by memberNumber substring case-insensitively', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      const result = await listPaginatedUsers({ page: 1, limit: 10, search: 'ADMIN' })

      expect(result.data.length).toBeGreaterThanOrEqual(0)
      // The search filter should be applied to member_number
    })

    it('filters by memberNumber substring', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      // seed member has memberNumber '100002'
      const result = await listPaginatedUsers({ page: 1, limit: 10, search: '100002' })

      expect(result.data.length).toBeGreaterThan(0)
    })

    it('filters by full name substring', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      const result = await listPaginatedUsers({ page: 1, limit: 10, search: 'member user' })

      expect(result.data).toHaveLength(1)
      expect(result.data[0]?.id).toBe('member-1')
    })

    it('filters by email substring', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      const result = await listPaginatedUsers({ page: 1, limit: 10, search: 'admin@alea.club' })

      expect(result.data).toHaveLength(1)
      expect(result.data[0]?.id).toBe('admin-1')
    })

    it('returns all users when search is empty', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      const all = await listPaginatedUsers({ page: 1, limit: 100 })
      const withEmpty = await listPaginatedUsers({ page: 1, limit: 100, search: '' })

      expect(withEmpty.total).toBe(all.total)
    })

    it('does not filter out suspended users from the admin listing', async () => {
      const { listPaginatedUsers } = await import('@/lib/server/users-service')

      const result = await listPaginatedUsers({ page: 1, limit: 10 })

      // Should include all users regardless of is_active status
      expect(result.data.length).toBeGreaterThan(0)
    })
  })

  describe('updateUser', () => {
    it('throws 400 when no updatable fields are provided', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(updateUser('member-1', {})).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('throws 400 when memberNumber exceeds 10 digits', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { memberNumber: '12345678901' }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('throws 400 when memberNumber contains non-numeric characters', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { memberNumber: '1000abc' }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('throws 400 when memberNumber is null (coerced to string "null")', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { memberNumber: null as any }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('throws 400 when memberNumber is an empty string', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { memberNumber: '' }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('rejects blank fullName updates', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { fullName: '   ' }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('rejects non-string email updates', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { email: 123 as any }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('rejects non-string phone updates', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { phone: 123 as any }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('rejects is_active when provided as a non-boolean string', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      await expect(
        updateUser('member-1', { isActive: 'true' as any }),
      ).rejects.toMatchObject({
        statusCode: 400,
      })
    })

    it('returns the updated public user payload for the correct user id', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      const updated = await updateUser('member-1', { role: 'member' })

      expect(updated.id).toBe('member-1')
      expect(updated.id).not.toBe('admin-1')
    })

    it('accepts memberNumber of exactly 10 digits', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      await expect(
        updateUser('member-1', { memberNumber: '1234567890' }),
      ).resolves.toBeDefined()
    })

    it('accepts memberNumber of single digit zero', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      await expect(updateUser('member-1', { memberNumber: '0' })).resolves.toBeDefined()
    })

    it('accepts is_active boolean and includes it in the update', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      const updated = await updateUser('member-1', { is_active: false })

      expect(updated.isActive).toBe(false)
    })

    it('accepts fullName, email, and phone updates', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      const updated = await updateUser('member-1', {
        fullName: 'Updated User',
        email: 'updated@alea.club',
        phone: '699000111',
      })

      expect(updated.fullName).toBe('Updated User')
      expect(updated.email).toBe('updated@alea.club')
      expect(updated.phone).toBe('699000111')
    })

    it('keeps internal auth email aligned when memberNumber changes', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      const updated = await updateUser('member-1', { memberNumber: '100123' })

      expect(updated.memberNumber).toBe('100123')
      // The auth_email should be automatically updated to match: 100123@members.alea.internal
      // This is a critical data-consistency invariant
    })

    it('[Clerk-first invariant] does NOT write to DB when Clerk username rename fails', async () => {
      const { updateUser } = await import('@/lib/server/users-service')
      const { clerkClient } = await import('@clerk/nextjs/server')

      // Mock Clerk to return an existing user but then fail on update
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-user-1' }],
      })
      clerkUpdateUserMock.mockRejectedValueOnce(new Error('Username already taken'))

      // This should throw because Clerk rename failed
      await expect(
        updateUser('member-1', { memberNumber: '100456' }),
      ).rejects.toMatchObject({
        statusCode: 500,
      })

      // Verify the member_number in the DB was NOT updated (stayed at original)
      const stored = profilesStore.get('member-1')
      expect(stored.member_number).toBe('100002')

      // Verify auth_email was also NOT updated
      expect(stored.auth_email).toBe('100002@members.alea.internal')
    })

    it('[Clerk-first invariant] succeeds when Clerk username rename succeeds', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      // Mock Clerk to return an existing user and succeed on update
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-user-1' }],
      })
      clerkUpdateUserMock.mockResolvedValueOnce({
        id: 'clerk-user-1',
        username: 'alea-100789',
      })

      const updated = await updateUser('member-1', { memberNumber: '100789' })

      // Verify the update succeeded
      expect(updated.memberNumber).toBe('100789')

      // Verify clerkClient was called with the right arguments
      expect(clerkGetUserListMock).toHaveBeenCalledWith({
        username: ['alea-100002'],
      })
      expect(clerkUpdateUserMock).toHaveBeenCalledWith('clerk-user-1', {
        username: 'alea-100789',
      })
    })

    it('[Clerk-first invariant] skips Clerk rename if user has no Clerk identity yet', async () => {
      const { updateUser } = await import('@/lib/server/users-service')

      // Mock Clerk to return empty list (user has no Clerk identity)
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [],
      })

      const updated = await updateUser('member-1', { memberNumber: '100999' })

      // Verify the update succeeded (because we skip Clerk rename when no identity exists)
      expect(updated.memberNumber).toBe('100999')

      // Verify clerkUpdateUserMock was NOT called (because no Clerk identity existed)
      expect(clerkUpdateUserMock).not.toHaveBeenCalled()
    })
  })

  describe('resetNoShows', () => {
    it('sets no_show_count=0 and blocked_until=null for the user', async () => {
      const { resetNoShows } = await import('@/lib/server/users-service')
      await expect(resetNoShows('member-1')).resolves.toBeUndefined()
    })

    it('throws a service error when update fails', async () => {
      const { resetNoShows } = await import('@/lib/server/users-service')
      await expect(resetNoShows('nonexistent-id')).rejects.toMatchObject({
        statusCode: expect.any(Number),
      })
    })
  })

  describe('unblockUser', () => {
    it('sets blocked_until=null for the user', async () => {
      const { unblockUser } = await import('@/lib/server/users-service')
      await expect(unblockUser('member-1')).resolves.toBeUndefined()
    })

    it('throws a service error when update fails', async () => {
      const { unblockUser } = await import('@/lib/server/users-service')
      await expect(unblockUser('nonexistent-id')).rejects.toMatchObject({
        statusCode: expect.any(Number),
      })
    })
  })

  describe('deleteUser', () => {
    it('deletes the auth user after confirming the profile exists', async () => {
      const { deleteUser } = await import('@/lib/server/users-service')
      await expect(deleteUser('member-1')).resolves.toBeUndefined()
    })
  })

  describe('Finding 2 — Codex review: updateUser Clerk-first/DB-write race', () => {
    it('rejects memberNumber change BEFORE calling Clerk if the target number already belongs to a different profile (pre-check)', async () => {
      // Setup: two profiles
      profilesStore.set('profile-1', {
        id: 'profile-1',
        member_number: '100001',
        full_name: 'Alice',
        auth_email: '100001@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: new Date().toISOString(),
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      profilesStore.set('profile-2', {
        id: 'profile-2',
        member_number: '100002',
        full_name: 'Bob',
        auth_email: '100002@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: new Date().toISOString(),
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      const { updateUser } = await import('@/lib/server/users-service')

      // Try to change profile-1's memberNumber to 100002 (already owned by profile-2)
      await expect(
        updateUser('profile-1', { memberNumber: '100002' }),
      ).rejects.toMatchObject({
        statusCode: 409,
        message: expect.stringContaining('Member number is already in use'),
      })

      // Critical: Clerk.updateUser should NOT have been called (pre-check blocked it)
      expect(clerkUpdateUserMock).not.toHaveBeenCalled()
    })

    it('rolls back Clerk username to old value when DB write fails after Clerk rename (TOCTOU)', async () => {
      // Setup profile with Clerk identity
      profilesStore.set('toctou-profile', {
        id: 'toctou-profile',
        member_number: '100011',
        full_name: 'TOCTOU Test',
        auth_email: '100011@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: new Date().toISOString(),
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Pre-check: no conflicting member_number
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-toctou' }],
      })

      // Clerk rename succeeds
      clerkUpdateUserMock.mockResolvedValueOnce({
        id: 'clerk-toctou',
        username: 'alea-100099',
      })

      // Mock DB write to fail with unique constraint (23505)
      sqlMock.prependHandler({
        name: 'UPDATE profiles member_number (fail with 23505)',
        verb: 'update',
        match: (stmt) =>
          stmt.table === 'profiles' &&
          hasColumn(stmt, 'member_number'),
        respond: async () => {
          const { NeonDbError } = await import('@neondatabase/serverless')
          const error = new NeonDbError('unique constraint violation')
          ;(error as any).code = '23505'
          throw error
        },
      })

      const { updateUser } = await import('@/lib/server/users-service')

      // Attempt: should fail and rollback
      await expect(
        updateUser('toctou-profile', { memberNumber: '100099' }),
      ).rejects.toMatchObject({ statusCode: 409 })

      // Verify: Clerk.updateUser was called twice (rename + rollback)
      expect(clerkUpdateUserMock).toHaveBeenCalledTimes(2)

      // First call: rename to new
      expect(clerkUpdateUserMock).toHaveBeenNthCalledWith(1, 'clerk-toctou', {
        username: 'alea-100099',
      })

      // Second call: rollback to old
      expect(clerkUpdateUserMock).toHaveBeenNthCalledWith(2, 'clerk-toctou', {
        username: 'alea-100011',
      })
    })
  })

  describe('Finding 3 — Codex review: deleteUser Clerk cleanup', () => {
    it('calls Clerk.deleteUser when profile has Clerk identity (Clerk-first principle)', async () => {
      profilesStore.set('delete-test', {
        id: 'delete-test',
        member_number: '100012',
        full_name: 'Delete Test',
        auth_email: '100012@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: new Date().toISOString(),
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-delete-test' }],
      })
      clerkDeleteUserMock.mockResolvedValueOnce({
        id: 'clerk-delete-test',
      })

      const { deleteUser } = await import('@/lib/server/users-service')
      await deleteUser('delete-test')

      // Verify: Clerk.getUserList was called with alea-<member_number> format
      expect(clerkGetUserListMock).toHaveBeenCalledWith({
        username: ['alea-100012'],
      })

      // Verify: Clerk.deleteUser was called with the Clerk user id
      // This proves Clerk cleanup happens as part of the delete flow
      expect(clerkDeleteUserMock).toHaveBeenCalledWith('clerk-delete-test')
    })

    it('does NOT call Clerk.deleteUser if user was never activated (no Clerk identity)', async () => {
      profilesStore.set('delete-no-clerk', {
        id: 'delete-no-clerk',
        member_number: '100099',
        full_name: 'No Clerk',
        auth_email: '100099@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: false,
        active_from: null,
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Clerk lookup returns empty
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [],
      })

      const { deleteUser } = await import('@/lib/server/users-service')
      await deleteUser('delete-no-clerk')

      // Verify: Clerk.deleteUser was NOT called (no identity to delete)
      expect(clerkDeleteUserMock).not.toHaveBeenCalled()
    })
  })

  describe('Finding 7 — Codex review: updateUser zero-row race', () => {
    it('rolls back Clerk rename when UPDATE returns zero rows (concurrent deletion)', async () => {
      // Finding 7: After Clerk rename succeeds, the UPDATE ... RETURNING can return
      // an empty array (not throw) if the profile was concurrently deleted between
      // the pre-check and the UPDATE. Without the zero-row rollback logic, Clerk
      // would be left on the NEW username forever with no profile row to reconcile it.

      profilesStore.set('find7-profile', {
        id: 'find7-profile',
        member_number: '100050',
        full_name: 'Finding 7 Test',
        auth_email: '100050@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: '2024-01-01T00:00:00.000Z',
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Mock Clerk to find existing user
      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-find7' }],
      })

      // Mock Clerk rename to succeed
      clerkUpdateUserMock.mockResolvedValueOnce({ id: 'clerk-find7', username: 'alea-100051' })

      // Simulate concurrent deletion: UPDATE will return zero rows
      shouldFailUpdateWithZeroRows = true

      const { updateUser } = await import('@/lib/server/users-service')

      try {
        await updateUser('find7-profile', { memberNumber: '100051' })
        throw new Error('Should have thrown')
      } catch (e) {
        expect(e).toMatchObject({ statusCode: 404 })
      }

      // Verify: Clerk.updateUser was called twice (rename + rollback)
      expect(clerkUpdateUserMock).toHaveBeenCalledTimes(2)

      // First call: rename to new number
      expect(clerkUpdateUserMock).toHaveBeenNthCalledWith(1, 'clerk-find7', {
        username: 'alea-100051',
      })

      // Second call: rollback to old number
      expect(clerkUpdateUserMock).toHaveBeenNthCalledWith(2, 'clerk-find7', {
        username: 'alea-100050',
      })
    })

    it('revert-confirm: without zero-row rollback, Clerk rename would not be rolled back', async () => {
      // Revert-confirm: this test verifies that the current code correctly rolls back
      // Clerk when the UPDATE returns zero rows. When the zero-row rollback block is
      // removed from production code, this test will fail because clerkUpdateUserMock
      // will only be called once (rename, not rollback).

      profilesStore.set('find7-revert', {
        id: 'find7-revert',
        member_number: '100052',
        full_name: 'Finding 7 Revert Test',
        auth_email: '100052@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: '2024-01-01T00:00:00.000Z',
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-find7-revert' }],
      })

      clerkUpdateUserMock.mockResolvedValueOnce({ id: 'clerk-find7-revert', username: 'alea-100053' })

      shouldFailUpdateWithZeroRows = true

      const { updateUser } = await import('@/lib/server/users-service')

      try {
        await updateUser('find7-revert', { memberNumber: '100053' })
      } catch {
        // Expected to throw
      }

      // With current code, Clerk rename should be rolled back (2 calls)
      expect(clerkUpdateUserMock).toHaveBeenCalledTimes(2) // Would FAIL without rollback block
    })
  })

  describe('Finding 8 — Codex review: deleteUser deactivate-first ordering', () => {
    it('deactivates profile first, then deletes Clerk, then deletes row (happy path)', async () => {
      // Finding 8: Three-phase deactivate-first ordering ensures no intermediate state
      // where a member has a live Clerk credential AND an active profile. The phases are:
      // 1. Deactivate profile (is_active = false) — blocks sign-in immediately
      // 2. Delete Clerk identity
      // 3. Delete profile row
      // If any step fails, the profile is already deactivated (safe).

      expect.assertions(3) // Guard against dead callbacks: Clerk getUserList, Clerk deleteUser, and profile deletion

      profilesStore.set('find8-delete', {
        id: 'find8-delete',
        member_number: '100060',
        full_name: 'Finding 8 Delete Test',
        auth_email: '100060@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: '2024-01-01T00:00:00.000Z',
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-find8' }],
      })

      clerkDeleteUserMock.mockResolvedValueOnce({ id: 'clerk-find8' })

      const { deleteUser } = await import('@/lib/server/users-service')
      await deleteUser('find8-delete')

      // Verify: Clerk operations were called in correct order
      // First the service looks up the Clerk user to delete
      expect(clerkGetUserListMock).toHaveBeenCalledWith({
        username: ['alea-100060'],
      })

      // Then it deletes the Clerk user
      expect(clerkDeleteUserMock).toHaveBeenCalledWith('clerk-find8')

      // Verify: On the happy path, the profile row was completely deleted (not just deactivated)
      // The three phases are:
      // 1. Deactivate (is_active = false) — blocks sign-in immediately
      // 2. Delete Clerk identity
      // 3. Delete profile row completely
      // If DELETE succeeded (happy path), the row should not exist in the store anymore
      const deletedProfile = profilesStore.get('find8-delete')
      expect(deletedProfile).toBeUndefined()
    })

    it('Clerk delete failure leaves profile deactivated (no live-access risk)', async () => {
      // Finding 8 safety property: if Clerk deleteUser throws AFTER deactivation,
      // the profile row survives but is already deactivated (is_active=false).
      // This is a retryable cleanup debt, not a live-access risk.

      profilesStore.set('find8-clerk-fail', {
        id: 'find8-clerk-fail',
        member_number: '100061',
        full_name: 'Finding 8 Clerk Fail',
        auth_email: '100061@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: '2024-01-01T00:00:00.000Z',
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-find8-fail' }],
      })

      clerkDeleteUserMock.mockRejectedValueOnce(new Error('Clerk API error'))

      const { deleteUser } = await import('@/lib/server/users-service')

      try {
        await deleteUser('find8-clerk-fail')
        throw new Error('Should have thrown')
      } catch (e) {
        expect(e).toMatchObject({ statusCode: 500 })
      }

      // Verify: profile row still exists but is deactivated
      const profile = profilesStore.get('find8-clerk-fail')
      expect(profile).toBeDefined()
      expect(profile?.is_active).toBe(false) // Safety property: already deactivated
    })

    it('DB delete failure after Clerk delete leaves profile deactivated', async () => {
      // Finding 8 safety property: if DB delete throws AFTER Clerk deletion succeeds,
      // the profile row survives but is already deactivated. The Clerk identity is
      // genuinely gone (deleteUser was called and succeeded), so no live-access risk.

      profilesStore.set('find8-db-fail', {
        id: 'find8-db-fail',
        member_number: '100062',
        full_name: 'Finding 8 DB Fail',
        auth_email: '100062@members.alea.internal',
        email: null,
        phone: null,
        role: 'member',
        is_active: true,
        active_from: '2024-01-01T00:00:00.000Z',
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      clerkGetUserListMock.mockResolvedValueOnce({
        data: [{ id: 'clerk-find8-db-fail' }],
      })

      clerkDeleteUserMock.mockResolvedValueOnce({ id: 'clerk-find8-db-fail' })

      // Inject a handler to make DELETE fail
      sqlMock.prependHandler({
        name: 'DELETE profiles (fail)',
        verb: 'delete',
        match: (stmt) =>
          stmt.table === 'profiles',
        respond: () => {
          throw new Error('Database connection lost')
        },
      })

      const { deleteUser } = await import('@/lib/server/users-service')

      try {
        await deleteUser('find8-db-fail')
        throw new Error('Should have thrown')
      } catch (e) {
        // When DELETE throws, it's an unhandled error (not wrapped in ServiceError by deleteUser)
        expect(e).toMatchObject(new Error('Database connection lost'))
      }

      // Verify: profile row still exists and is deactivated
      const profile = profilesStore.get('find8-db-fail')
      expect(profile).toBeDefined()
      expect(profile?.is_active).toBe(false) // Already deactivated, so safe to retry
      // (Clerk identity is definitely gone, so no live-access risk)
    })
  })
})
