// @vitest-environment node
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

describe('lib/db/client — Neon raw-SQL connection helper', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('exports a tagged-template sql function when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost/db'

    // Mock @neondatabase/serverless neon() export
    vi.doMock('@neondatabase/serverless', () => ({
      neon: vi.fn((url: string) => {
        return vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => ({
          rows: [],
        }))
      }),
    }))

    const { sql } = await import('@/lib/db/client')

    // Verify sql is a function (tagged template)
    expect(typeof sql).toBe('function')

    // Verify it can be called as a tagged template
    const result = await sql`SELECT 1`
    expect(result).toBeDefined()
  })

  it('throws an error when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL

    // Mock @neondatabase/serverless
    vi.doMock('@neondatabase/serverless', () => ({
      neon: vi.fn(),
    }))

    // Importing should throw immediately due to the guard at module level
    await expect(async () => {
      await import('@/lib/db/client')
    }).rejects.toThrow('DATABASE_URL is not set')
  })

  it('throws an error with helpful message when DATABASE_URL is empty string', async () => {
    process.env.DATABASE_URL = ''

    // Mock @neondatabase/serverless
    vi.doMock('@neondatabase/serverless', () => ({
      neon: vi.fn(),
    }))

    // Importing should throw immediately due to the guard at module level
    await expect(async () => {
      await import('@/lib/db/client')
    }).rejects.toThrow('DATABASE_URL is not set')
  })

  it('passes the DATABASE_URL to the neon driver', async () => {
    const testUrl = 'postgresql://neon-user:neon-pass@test-host/test-db'
    process.env.DATABASE_URL = testUrl

    let capturedUrl: string | undefined

    vi.doMock('@neondatabase/serverless', () => ({
      neon: vi.fn((url: string) => {
        capturedUrl = url
        return vi.fn(async () => ({ rows: [] }))
      }),
    }))

    await import('@/lib/db/client')

    expect(capturedUrl).toBe(testUrl)
  })

  it('exports only the sql function (no wrapper, no query builder)', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost/db'

    vi.doMock('@neondatabase/serverless', () => ({
      neon: vi.fn((url: string) => vi.fn(async () => ({ rows: [] }))),
    }))

    const module = await import('@/lib/db/client')

    // Should only export 'sql', nothing else
    expect(Object.keys(module)).toEqual(['sql'])
  })
})
