/**
 * Shared test data factories for auth and user service tests.
 * Exported for reuse across multiple test files to maintain consistent row shapes.
 */

export type ProfileRow = {
  id: string
  member_number: string
  full_name: string | null
  auth_email: string | null
  email: string | null
  phone: string | null
  role: 'admin' | 'member'
  is_active: boolean
  active_from: string | null
  no_show_count: number
  blocked_until: string | null
  created_at: string
  updated_at: string
}

/**
 * Factory for creating test profile rows with sensible defaults.
 * @param overrides Partial row properties to override defaults
 * @returns A complete ProfileRow with defaults applied
 */
export function createTestProfile(overrides?: Partial<ProfileRow>): ProfileRow {
  return {
    id: 'user-test',
    member_number: '100001',
    full_name: 'Test Member',
    auth_email: 'test@alea.club',
    email: 'contact@example.com',
    phone: '+1234567890',
    role: 'member',
    is_active: false,
    active_from: null,
    no_show_count: 0,
    blocked_until: null,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}
