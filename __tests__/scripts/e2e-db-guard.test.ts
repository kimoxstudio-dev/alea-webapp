// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression test for qa/e2e/db.mjs's DATABASE_URL host allowlist (#312).
 *
 * The allowlist's entire security property is *ordering*: the host check
 * must run, and reject, before `neon(databaseUrl)` is ever called — that is
 * what stops a mismatched (e.g. accidentally production) DATABASE_URL from
 * ever reaching a real connection. `node --check` only verifies syntax, so
 * nothing catches a future edit that moves `export const sql = neon(...)`
 * above the guard, or deletes the guard outright. This test pins that order
 * directly: on a host mismatch, `neon` must never have been called.
 *
 * Never connects to a real database — @neondatabase/serverless is mocked.
 */

const NEON_MOCK = vi.fn(() => vi.fn())

vi.mock('@neondatabase/serverless', () => ({
  neon: NEON_MOCK,
}))

// db.mjs imports env.mjs for its dotenv.config() side effect. Mock dotenv
// as a no-op so the test's own process.env stubs are what env.mjs sees,
// regardless of whether a real .env.e2e.local exists on disk.
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
}))

const DEV_HOST = 'ep-dev-branch.eu-central-1.aws.neon.tech'
const DEV_URL = `postgres://neondb_owner:test-password@${DEV_HOST}/neondb`

describe('qa/e2e/db.mjs — DATABASE_URL host allowlist', () => {
  beforeEach(() => {
    vi.resetModules()
    NEON_MOCK.mockClear()
    delete process.env.DATABASE_URL
    delete process.env.E2E_DATABASE_HOST
    process.exitCode = undefined
  })

  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.E2E_DATABASE_HOST
    process.exitCode = undefined
  })

  it('rejects on a host mismatch and never calls neon()', async () => {
    process.env.DATABASE_URL = DEV_URL
    process.env.E2E_DATABASE_HOST = 'ep-some-other-branch.eu-central-1.aws.neon.tech'

    await expect(import('../../qa/e2e/db.mjs')).rejects.toThrow(/does not match/)
    expect(NEON_MOCK).not.toHaveBeenCalled()
  })

  it('rejects a host that is prefixed onto the allowed host (kills an endsWith() mutant)', async () => {
    process.env.DATABASE_URL = `postgres://neondb_owner:test-password@evil-${DEV_HOST}/neondb`
    process.env.E2E_DATABASE_HOST = DEV_HOST

    await expect(import('../../qa/e2e/db.mjs')).rejects.toThrow(/does not match/)
    expect(NEON_MOCK).not.toHaveBeenCalled()
  })

  it('rejects a host that is suffixed onto the allowed host (kills a startsWith()/includes() mutant)', async () => {
    process.env.DATABASE_URL = `postgres://neondb_owner:test-password@${DEV_HOST}.evil.tld/neondb`
    process.env.E2E_DATABASE_HOST = DEV_HOST

    await expect(import('../../qa/e2e/db.mjs')).rejects.toThrow(/does not match/)
    expect(NEON_MOCK).not.toHaveBeenCalled()
  })

  it('connects when the host matches', async () => {
    process.env.DATABASE_URL = DEV_URL
    process.env.E2E_DATABASE_HOST = DEV_HOST

    const mod = await import('../../qa/e2e/db.mjs')

    expect(typeof mod.sql).toBe('function')
    expect(NEON_MOCK).toHaveBeenCalledTimes(1)
    expect(NEON_MOCK).toHaveBeenCalledWith(DEV_URL)
  })

  it('rejects a non-parseable DATABASE_URL without leaking it in the error', async () => {
    const badUrl = 'postgres//neondb_owner:npg_SUPERSECRET@ep-x.neon.tech/db'
    process.env.DATABASE_URL = badUrl
    process.env.E2E_DATABASE_HOST = DEV_HOST

    let caught: unknown
    try {
      await import('../../qa/e2e/db.mjs')
    } catch (error) {
      caught = error
    }

    expect(String(caught)).toMatch(/not a parseable connection-string URL/)
    expect(String(caught)).not.toContain('npg_SUPERSECRET')
    expect(String(caught)).not.toContain(badUrl)
    expect(NEON_MOCK).not.toHaveBeenCalled()
  })
})

describe('qa/e2e/db.mjs — tryDelete', () => {
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  beforeEach(() => {
    vi.resetModules()
    NEON_MOCK.mockClear()
    consoleErrorSpy.mockClear()
    process.env.DATABASE_URL = DEV_URL
    process.env.E2E_DATABASE_HOST = DEV_HOST
    process.exitCode = undefined
  })

  afterEach(() => {
    delete process.env.DATABASE_URL
    delete process.env.E2E_DATABASE_HOST
    process.exitCode = undefined
  })

  it('swallows a failing DELETE, logs it, and sets process.exitCode to 1', async () => {
    const rejectingSql = vi.fn(() => Promise.reject(new Error('ON DELETE RESTRICT violation')))
    NEON_MOCK.mockImplementationOnce(() => rejectingSql)

    const { tryDelete } = await import('../../qa/e2e/db.mjs')

    await expect(tryDelete`DELETE FROM equipment WHERE id = ${'some-id'}`).resolves.toBeUndefined()

    expect(rejectingSql).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    expect(consoleErrorSpy.mock.calls[0][0]).toContain('ON DELETE RESTRICT violation')
    expect(process.exitCode).toBe(1)
  })

  it('leaves process.exitCode untouched when the DELETE succeeds', async () => {
    const succeedingSql = vi.fn(() => Promise.resolve([]))
    NEON_MOCK.mockImplementationOnce(() => succeedingSql)

    const { tryDelete } = await import('../../qa/e2e/db.mjs')

    await tryDelete`DELETE FROM equipment WHERE id = ${'some-id'}`

    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(process.exitCode).toBeUndefined()
  })
})
