/**
 * tests/unit/seed-guard.test.ts — verify seed script guard logic
 *
 * Proves the dev seed script's guard (in scripts/seed.ts) fires BEFORE any
 * database connection is attempted. This is critical for safety since the
 * script would otherwise seed fixtures into a wrong database.
 *
 * Rather than re-implementing guard logic inline, this test spawns the real
 * `pnpm db:seed` process with controlled environment variables and an invalid
 * POSTGRES_URL. For the "deny" cases (production, missing/wrong
 * DEV_SEED_CONFIRM), the guard rejects and the process exits with code 1,
 * outputting the guard's rejection message. For the "allowed" case, the guard
 * passes but the subprocess fails trying to connect to the garbage URL,
 * proving the guard ran first and the process got past it.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

describe('seed script guard logic', () => {
  const DEV_SEED_CONFIRM_VALUE = 'YES_SEED_NEON_DEV_DB'
  const INVALID_POSTGRES_URL = 'postgres://invalid:invalid@localhost:1/nonexistent'

  /**
   * Spawn the real seed script as a subprocess with controlled environment.
   * Returns { exitCode, stderr, stdout, success }.
   */
  function runSeedProcess(env: Record<string, string | undefined>): {
    exitCode: number
    stderr: string
    stdout: string
    success: boolean
  } {
    try {
      const stdout = execFileSync('pnpm', ['db:seed'], {
        cwd: path.resolve(__dirname, '../../'),
        env: { ...process.env, ...env },
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return { exitCode: 0, stdout, stderr: '', success: true }
    } catch (error: any) {
      const exitCode = error.status ?? 1
      const stderr = error.stderr?.toString() ?? ''
      const stdout = error.stdout?.toString() ?? ''
      return { exitCode, stderr, stdout, success: false }
    }
  }

  it('should allow seed when NODE_ENV is development and DEV_SEED_CONFIRM is correct', () => {
    const result = runSeedProcess({
      NODE_ENV: 'development',
      DEV_SEED_CONFIRM: DEV_SEED_CONFIRM_VALUE,
      POSTGRES_URL: INVALID_POSTGRES_URL,
      POSTGRES_URL_NON_POOLING: undefined,
    })

    // Subprocess should fail due to invalid DB, but NOT due to the guard.
    // The guard should have passed, so we expect a DB-related error,
    // not a guard rejection message.
    expect(result.exitCode).toBe(1)

    // Assert the guard rejection message is NOT present.
    // If the guard fired, we'd see "[seed] Refusing to run: NODE_ENV=production"
    // or "[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM"
    expect(result.stderr).not.toMatch(/\[seed\] Refusing to run/)

    // The failure should be DB-related (passed guard, failed on DB connection/query).
    // This proves the guard ran and the process got PAST it to the seeding phase.
    expect(result.stderr).toMatch(/\[seed\] failed|Failed query|Connection refused|getaddrinfo ENOTFOUND|ECONNREFUSED/)
  })

  it('should refuse seed when NODE_ENV is production', () => {
    const result = runSeedProcess({
      NODE_ENV: 'production',
      DEV_SEED_CONFIRM: DEV_SEED_CONFIRM_VALUE,
      POSTGRES_URL: INVALID_POSTGRES_URL,
      POSTGRES_URL_NON_POOLING: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/NODE_ENV=production/)
    expect(result.stderr).toMatch(/\[seed\] Refusing to run/)
  })

  it('should refuse seed when DEV_SEED_CONFIRM is missing', () => {
    const result = runSeedProcess({
      NODE_ENV: 'development',
      DEV_SEED_CONFIRM: undefined,
      POSTGRES_URL: INVALID_POSTGRES_URL,
      POSTGRES_URL_NON_POOLING: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/missing or incorrect DEV_SEED_CONFIRM/)
    expect(result.stderr).toMatch(/\[seed\] Refusing to run/)
  })

  it('should refuse seed when DEV_SEED_CONFIRM has wrong value', () => {
    const result = runSeedProcess({
      NODE_ENV: 'development',
      DEV_SEED_CONFIRM: 'wrong_value',
      POSTGRES_URL: INVALID_POSTGRES_URL,
      POSTGRES_URL_NON_POOLING: undefined,
    })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toMatch(/missing or incorrect DEV_SEED_CONFIRM/)
    expect(result.stderr).toMatch(/\[seed\] Refusing to run/)
  })
})
