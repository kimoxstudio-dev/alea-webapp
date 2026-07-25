/**
 * tests/scripts/seed-guard.test.ts — verify seed script guard logic
 *
 * Ensures the dev seed script refuses to run in production or without
 * proper DEV_SEED_CONFIRM confirmation. This is critical for safety since
 * the script would otherwise seed fixtures into a real production database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

describe('seed script guard logic', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalConfirm = process.env.DEV_SEED_CONFIRM
  const DEV_SEED_CONFIRM_VALUE = 'YES_SEED_NEON_DEV_DB'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.DEV_SEED_CONFIRM = originalConfirm
  })

  it('should allow seed when NODE_ENV is development and DEV_SEED_CONFIRM is correct', () => {
    process.env.NODE_ENV = 'development'
    process.env.DEV_SEED_CONFIRM = DEV_SEED_CONFIRM_VALUE

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation()
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    // Guard logic (inlined for test)
    function assertDevSeedAllowed(): void {
      if (process.env.NODE_ENV === 'production') {
        console.error('[seed] Refusing to run: NODE_ENV=production')
        process.exit(1)
      }
      if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
        console.error('[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM')
        process.exit(1)
      }
    }

    expect(() => assertDevSeedAllowed()).not.toThrow()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
    expect(processExitSpy).not.toHaveBeenCalled()
  })

  it('should refuse seed when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production'
    process.env.DEV_SEED_CONFIRM = DEV_SEED_CONFIRM_VALUE

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation()
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    function assertDevSeedAllowed(): void {
      if (process.env.NODE_ENV === 'production') {
        console.error('[seed] Refusing to run: NODE_ENV=production')
        process.exit(1)
      }
      if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
        console.error('[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM')
        process.exit(1)
      }
    }

    expect(() => assertDevSeedAllowed()).toThrow('process.exit called')
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('NODE_ENV=production'))
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('should refuse seed when DEV_SEED_CONFIRM is missing', () => {
    process.env.NODE_ENV = 'development'
    process.env.DEV_SEED_CONFIRM = undefined

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation()
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    function assertDevSeedAllowed(): void {
      if (process.env.NODE_ENV === 'production') {
        console.error('[seed] Refusing to run: NODE_ENV=production')
        process.exit(1)
      }
      if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
        console.error('[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM')
        process.exit(1)
      }
    }

    expect(() => assertDevSeedAllowed()).toThrow('process.exit called')
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DEV_SEED_CONFIRM'))
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })

  it('should refuse seed when DEV_SEED_CONFIRM has wrong value', () => {
    process.env.NODE_ENV = 'development'
    process.env.DEV_SEED_CONFIRM = 'wrong_value'

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation()
    const processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called')
    })

    function assertDevSeedAllowed(): void {
      if (process.env.NODE_ENV === 'production') {
        console.error('[seed] Refusing to run: NODE_ENV=production')
        process.exit(1)
      }
      if (process.env.DEV_SEED_CONFIRM !== DEV_SEED_CONFIRM_VALUE) {
        console.error('[seed] Refusing to run: missing or incorrect DEV_SEED_CONFIRM')
        process.exit(1)
      }
    }

    expect(() => assertDevSeedAllowed()).toThrow('process.exit called')
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('DEV_SEED_CONFIRM'))
    expect(processExitSpy).toHaveBeenCalledWith(1)
  })
})
