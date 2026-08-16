// @vitest-environment node
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'

/**
 * Regression test for seed-dev.mjs ensureAdminClerkIdentity() — verifies that
 * when a Clerk identity already exists, the password is synced via PATCH instead
 * of being silently skipped (issue observed in pre-fix behavior where an existing
 * identity prevented password updates on re-run).
 */

const CLERK_API_BASE = 'https://api.clerk.com/v1'
const TEST_ADMIN_MEMBER_NUMBER = '900000'
const TEST_USERNAME = `alea-${TEST_ADMIN_MEMBER_NUMBER}`
const TEST_PASSWORD = 'test-password-123'

describe('seed-dev.mjs regression: ensureAdminClerkIdentity password sync', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    // Set required env vars before any tests run
    process.env.CLERK_SECRET_KEY = 'sk_test_example_key_for_testing'
    fetchSpy = vi.spyOn(global, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    delete process.env.CLERK_SECRET_KEY
  })

  it('should PATCH password when Clerk identity already exists', async () => {
    // Simulate existing Clerk user
    const existingUserId = 'clerk-user-123'

    // Mock the GET request to list users (returns existing identity)
    const getResponse = new Response(
      JSON.stringify([{ id: existingUserId, username: TEST_USERNAME }]),
      { status: 200, statusText: 'OK' }
    )

    // Mock the PATCH request to update password
    const patchResponse = new Response(
      JSON.stringify({ id: existingUserId, username: TEST_USERNAME, password_enabled: true }),
      { status: 200, statusText: 'OK' }
    )

    // Set up fetch spy to respond appropriately
    fetchSpy
      .mockResolvedValueOnce(getResponse) // First call: GET /users?username=...
      .mockResolvedValueOnce(patchResponse) // Second call: PATCH /users/{id}

    // Import and call the function
    const { ensureAdminClerkIdentity } = await import('../../scripts/seed-dev.mjs')
    const result = await ensureAdminClerkIdentity(TEST_PASSWORD)

    // CRITICAL ASSERTION: Verify PATCH was called (regression guard)
    // This is the fix — the pre-fix behavior would skip the PATCH entirely
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const patchCall = fetchSpy.mock.calls[1]
    expect(patchCall[0]).toBe(`${CLERK_API_BASE}/users/${existingUserId}`)
    expect(patchCall[1]?.method).toBe('PATCH')
    expect(patchCall[1]?.body).toContain('"password"')
    expect(patchCall[1]?.body).toContain(TEST_PASSWORD)
    expect(patchCall[1]?.body).toContain('"skip_password_checks":false')

    // Result should indicate identity was not created (already existed)
    expect(result).toEqual({ created: false, username: TEST_USERNAME })
  })

  it('should POST new user when Clerk identity does not exist', async () => {
    // Mock the GET request to list users (returns empty)
    const getResponse = new Response(JSON.stringify([]), {
      status: 200,
      statusText: 'OK',
    })

    // Mock the POST request to create user
    const postResponse = new Response(
      JSON.stringify({
        id: 'new-clerk-user-456',
        username: TEST_USERNAME,
        password_enabled: true,
      }),
      { status: 201, statusText: 'Created' }
    )

    fetchSpy
      .mockResolvedValueOnce(getResponse) // First call: GET /users?username=...
      .mockResolvedValueOnce(postResponse) // Second call: POST /users

    const { ensureAdminClerkIdentity } = await import('../../scripts/seed-dev.mjs')
    const result = await ensureAdminClerkIdentity(TEST_PASSWORD)

    // Verify POST was called to create new user
    expect(fetchSpy).toHaveBeenCalledTimes(2)

    const postCall = fetchSpy.mock.calls[1]
    expect(postCall[0]).toBe(`${CLERK_API_BASE}/users`)
    expect(postCall[1]?.method).toBe('POST')
    expect(postCall[1]?.body).toContain('"username"')
    expect(postCall[1]?.body).toContain(TEST_USERNAME)
    expect(postCall[1]?.body).toContain('"password"')
    expect(postCall[1]?.body).toContain(TEST_PASSWORD)

    // Result should indicate identity was created
    expect(result).toEqual({ created: true, username: TEST_USERNAME })
  })

  it('should throw if PATCH fails when updating existing identity', async () => {
    const existingUserId = 'clerk-user-789'

    // Mock successful GET
    const getResponse = new Response(
      JSON.stringify([{ id: existingUserId, username: TEST_USERNAME }]),
      { status: 200 }
    )

    // Mock failed PATCH
    const patchErrorResponse = new Response(
      JSON.stringify({ error: 'Invalid password' }),
      { status: 400, statusText: 'Bad Request' }
    )

    fetchSpy
      .mockResolvedValueOnce(getResponse)
      .mockResolvedValueOnce(patchErrorResponse)

    const { ensureAdminClerkIdentity } = await import('../../scripts/seed-dev.mjs')

    await expect(ensureAdminClerkIdentity(TEST_PASSWORD)).rejects.toThrow(
      /Failed to update password for Clerk identity/
    )
  })

  it('should throw if POST fails when creating new identity', async () => {
    // Mock successful GET (no existing users)
    const getResponse = new Response(JSON.stringify([]), { status: 200 })

    // Mock failed POST
    const postErrorResponse = new Response(
      JSON.stringify({ error: 'Username already exists' }),
      { status: 422, statusText: 'Unprocessable Entity' }
    )

    fetchSpy
      .mockResolvedValueOnce(getResponse)
      .mockResolvedValueOnce(postErrorResponse)

    const { ensureAdminClerkIdentity } = await import('../../scripts/seed-dev.mjs')

    await expect(ensureAdminClerkIdentity(TEST_PASSWORD)).rejects.toThrow(
      /Failed to create Clerk identity/
    )
  })

  it('should throw if initial Clerk query fails', async () => {
    // Mock failed GET
    const getErrorResponse = new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      statusText: 'Unauthorized',
    })

    fetchSpy.mockResolvedValueOnce(getErrorResponse)

    const { ensureAdminClerkIdentity } = await import('../../scripts/seed-dev.mjs')

    await expect(ensureAdminClerkIdentity(TEST_PASSWORD)).rejects.toThrow(
      /Failed to query Clerk for existing admin identity/
    )

    // Should not proceed to PATCH/POST if initial query fails
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
