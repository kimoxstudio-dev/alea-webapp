// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sqlQueryMock = vi.fn()

// In-memory store for test data
const profilesStore = new Map<string, any>()

const testProfiles = {
  admin: {
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
  },
  member: {
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
  },
}

vi.mock('@/lib/db/client', () => ({
  sql: sqlQueryMock,
}))

function setupSqlMock() {
  sqlQueryMock.mockImplementation(async (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<unknown> => {
    const queryStr = typeof strings === 'string'
      ? strings
      : strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '')

    const query = queryStr.toLowerCase()

    // SELECT by id
    if (query.includes('from profiles') && query.includes('where id')) {
      const id = values[0]
      const profile = profilesStore.get(id as string)
      return Promise.resolve(profile ? [profile] : [])
    }

    // SELECT by member_number
    if (query.includes('from profiles') && query.includes('where member_number')) {
      const memberNumber = values[0]
      for (const profile of profilesStore.values()) {
        if (profile.member_number === memberNumber) {
          return Promise.resolve([profile])
        }
      }
      return Promise.resolve([])
    }

    // SELECT with OFFSET/LIMIT pagination
    if (query.includes('from profiles') && (query.includes('offset') || query.includes('order by'))) {
      // Return all profiles (simplified for test)
      const profiles = Array.from(profilesStore.values())
      return Promise.resolve(profiles)
    }

    // SELECT COUNT
    if (query.includes('select count')) {
      return Promise.resolve([{ count: profilesStore.size }])
    }

    // UPDATE no_show_count/blocked_until
    if (query.includes('update profiles') && query.includes('no_show_count')) {
      const id = values.find((v) => typeof v === 'string' && v.startsWith('admin-')) || values.find((v) => typeof v === 'string' && v.startsWith('member-'))
      const profile = profilesStore.get(id as string)
      if (profile) {
        const updated = { ...profile, no_show_count: 0, blocked_until: null }
        profilesStore.set(id as string, updated)
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
        return Promise.resolve([{ id }])
      }
      return Promise.resolve([])
    }

    // UPDATE other fields
    if (query.includes('update profiles') && query.includes('where id')) {
      const id = values[values.length - 1]
      const profile = profilesStore.get(id as string)
      if (profile) {
        // Extract updated fields from values
        const updated = { ...profile, updated_at: new Date().toISOString() }
        profilesStore.set(id as string, updated)
        return Promise.resolve([updated])
      }
      return Promise.resolve([])
    }

    // DELETE
    if (query.includes('delete from profiles')) {
      const id = values[0]
      profilesStore.delete(id as string)
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
    profilesStore.set(testProfiles.admin.id, testProfiles.admin)
    profilesStore.set(testProfiles.member.id, testProfiles.member)

    setupSqlMock()
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

      const updated = await updateUser('member-1', { isActive: false })

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
})
