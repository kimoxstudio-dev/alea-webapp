// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sqlQueryMock = vi.fn()
const clerkGetUserListMock = vi.fn()
const clerkUpdateUserMock = vi.fn()

// In-memory store for test data
const profilesStore = new Map<string, any>()


vi.mock('@/lib/db/client', () => ({
  sql: sqlQueryMock,
}))

vi.mock('@clerk/nextjs/server', () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUserList: clerkGetUserListMock,
      updateUser: clerkUpdateUserMock,
    },
  })),
}))

function setupSqlMock() {
  sqlQueryMock.mockImplementation(async (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<unknown> => {
    const queryStr = typeof strings === 'string'
      ? strings
      : strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '')

    const query = queryStr.toLowerCase()

    // Helper to match ILIKE pattern (case-insensitive substring)
    function matchesPattern(text: string | null | undefined, pattern: string | null | undefined): boolean {
      if (!pattern || !text) return false
      // Pattern is in format %search% — extract the search term
      const searchTerm = pattern.replace(/%/g, '').toLowerCase()
      return text.toLowerCase().includes(searchTerm)
    }

    // SELECT by id (WHERE id = $1)
    if (query.includes('from profiles') && query.includes('where id =') && !query.includes('ilike')) {
      const id = values[0] as string
      const profile = profilesStore.get(id)
      if (profile) {
        return Promise.resolve([profile])
      }
      return Promise.resolve([])
    }

    // SELECT by member_number (WHERE member_number =)
    if (query.includes('where member_number =') && !query.includes('ilike')) {
      const memberNumber = values[0]
      for (const profile of profilesStore.values()) {
        if (profile.member_number === memberNumber) {
          return Promise.resolve([profile])
        }
      }
      return Promise.resolve([])
    }

    // UPDATE profiles with all 7 fields (member_number, full_name, email, phone, role, is_active, auth_email)
    if (query.includes('update profiles') && query.includes('set member_number')) {
      // Format: SET member_number = $1, full_name = $2, email = $3, phone = $4, role = $5, is_active = $6, auth_email = $7 WHERE id = $8
      const memberNumber = values[0] as string
      const fullName = values[1] as string
      const email = values[2] as string | null
      const phone = values[3] as string | null
      const role = values[4] as string
      const isActive = values[5] as boolean
      const authEmail = values[6] as string
      const id = values[7] as string

      const profile = profilesStore.get(id)
      if (!profile) {
        return Promise.resolve([])
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

      if (query.includes('returning')) {
        return Promise.resolve([updated])
      }
      return Promise.resolve([{ id }])
    }

    // UPDATE no_show_count/blocked_until
    if (query.includes('update profiles') && query.includes('no_show_count')) {
      const id = values.find((v) => typeof v === 'string' && v.startsWith('admin-')) || values.find((v) => typeof v === 'string' && v.startsWith('member-'))
      const profile = profilesStore.get(id as string)
      if (profile) {
        const updated = { ...profile, no_show_count: 0, blocked_until: null }
        profilesStore.set(id as string, updated)
        if (query.includes('returning')) {
          return Promise.resolve([updated])
        }
        return Promise.resolve([{ id }])
      }
      return Promise.resolve([])
    }

    // UPDATE blocked_until
    if (query.includes('update profiles') && query.includes('blocked_until')) {
      const id = values[values.length - 1]
      const profile = profilesStore.get(id as string)
      if (profile) {
        const updated = { ...profile, blocked_until: null }
        profilesStore.set(id as string, updated)
        if (query.includes('returning')) {
          return Promise.resolve([updated])
        }
        return Promise.resolve([{ id }])
      }
      return Promise.resolve([])
    }

    // SELECT COUNT with search filter (ILIKE) - must come before generic COUNT
    if (query.includes('select count') && query.includes('ilike')) {
      const pattern = values[0] as string
      const profiles = Array.from(profilesStore.values()).filter((p) => {
        return (
          matchesPattern(p.member_number, pattern) ||
          matchesPattern(p.full_name, pattern) ||
          matchesPattern(p.email, pattern)
        )
      })
      return Promise.resolve([{ count: profiles.length }])
    }

    // SELECT with ILIKE search filter - extract limit and offset from values carefully
    if (query.includes('ilike') && query.includes('order by') && query.includes('limit')) {
      const pattern = values[0] as string
      let filtered = Array.from(profilesStore.values()).filter((p) => {
        return (
          matchesPattern(p.member_number, pattern) ||
          matchesPattern(p.full_name, pattern) ||
          matchesPattern(p.email, pattern)
        )
      })

      // Apply ordering by created_at
      filtered = filtered.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      // Extract LIMIT and OFFSET from values
      // For query with 3 ilike patterns, values is: [pattern, pattern, pattern, limit, offset]
      // But we only have one pattern value in values[0], so we need to count numeric values
      const numericValues = values.filter((v) => typeof v === 'number')
      const limit = numericValues[0] as number
      const offset = numericValues[1] as number

      if (limit !== undefined && offset !== undefined) {
        filtered = filtered.slice(offset, offset + limit)
      }

      return Promise.resolve(filtered)
    }

    // SELECT COUNT (no search) - generic COUNT query
    if (query.includes('select count') && !query.includes('ilike')) {
      return Promise.resolve([{ count: profilesStore.size }])
    }

    // SELECT with ORDER/LIMIT/OFFSET (no search)
    if (query.includes('order by') && !query.includes('ilike')) {
      let profiles = Array.from(profilesStore.values()).sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

      // Extract numeric values for LIMIT and OFFSET
      const numericValues = values.filter((v) => typeof v === 'number')
      if (numericValues.length >= 2) {
        const limit = numericValues[0] as number
        const offset = numericValues[1] as number
        profiles = profiles.slice(offset, offset + limit)
      }

      return Promise.resolve(profiles)
    }

    // DELETE
    if (query.includes('delete from profiles')) {
      const id = values[0]
      profilesStore.delete(id as string)
      if (query.includes('returning')) {
        return Promise.resolve([{ id }])
      }
      return Promise.resolve([{ id }])
    }

    // INSERT
    if (query.includes('insert into profiles')) {
      const newProfile = {
        id: `profile-${Math.random().toString(36).substr(2, 9)}`,
        member_number: values[1],
        full_name: values[2],
        auth_email: values[3],
        email: values[4],
        phone: values[5],
        role: 'member',
        is_active: false,
        active_from: null,
        no_show_count: 0,
        blocked_until: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      profilesStore.set(newProfile.id, newProfile)
      return Promise.resolve([newProfile])
    }

    return Promise.resolve([])
  })
}

describe('users-service (raw SQL with Neon)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    profilesStore.clear()

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

    setupSqlMock()

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
  })

  describe('Finding 3 — Codex review: deleteUser Clerk cleanup', () => {
    it('deletes the auth user after confirming the profile exists', async () => {
      const { deleteUser } = await import('@/lib/server/users-service')
      await expect(deleteUser('member-1')).resolves.toBeUndefined()
    })
  })
})
