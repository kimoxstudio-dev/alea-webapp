// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

/**
 * Tests for scripts/apply-neon-schema.mjs's checksum-ledger drift detection
 * (#328). Before commit 9d41e8e, `main()` ran unconditionally as a side
 * effect of importing the module — every test here would have executed a
 * real `process.exit()` and (with a real DATABASE_URL present) issued live
 * queries against the actual Neon dev database. `main` is now guarded
 * behind an `import.meta.url === file://process.argv[1]` check (mirroring
 * scripts/seed-dev.mjs) and exported, so tests call it directly with full
 * control over its dependencies.
 *
 * `scripts/apply-neon-schema.mjs`'s `sql` client is neon()'s `.query(text,
 * params)` / `.transaction(fn)` API — not the tagged-template style used by
 * lib/db/client.ts (and __tests__/helpers/sql-mock.ts). createFakeSql below
 * is a small, purpose-built dispatcher for that shape. It follows the same
 * "no silent fallback" rule as sql-mock.ts: any query text that doesn't
 * match a registered handler throws instead of returning something empty,
 * so a mis-anchored handler or unexpectedly-shaped query fails loudly.
 */

class ProcessExitError extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`process.exit(${code})`)
  }
}

interface QueryCall {
  text: string
  params: unknown[]
}

interface FakeSqlOptions {
  /** Rows returned for the pg_namespace unexpected-schema preflight check. Defaults to none. */
  unexpectedSchemas?: Array<{ nspname: string }>
  /** Rows returned for the pg_tables listing (tables currently present in "public"). Defaults to none (fresh DB). */
  publicTables?: Array<{ tablename: string }>
  /** Table names (from publicTables) that should report has_rows = true when preflight-checked. Defaults to none. */
  nonEmptyTables?: string[]
  /** Rows returned when loading the schema_migrations ledger. Defaults to empty (no prior runs). */
  ledgerRows?: Array<{ filename: string; checksum: string }>
}

function createFakeSql(options: FakeSqlOptions = {}) {
  const queryCalls: QueryCall[] = []
  const txnQueryCalls: QueryCall[] = []

  function respond(text: string): unknown {
    if (text.includes('pg_namespace')) {
      return options.unexpectedSchemas ?? []
    }
    if (text.includes('pg_tables')) {
      return options.publicTables ?? []
    }
    if (text.includes('has_rows')) {
      const match = /FROM "([^"]+)" LIMIT/.exec(text)
      const tableName = match?.[1] ?? ''
      const isNonEmpty = (options.nonEmptyTables ?? []).includes(tableName)
      return [{ has_rows: isNonEmpty }]
    }
    if (text.includes('CREATE TABLE IF NOT EXISTS "schema_migrations"')) {
      return []
    }
    if (text.includes('SELECT "filename", "checksum" FROM "schema_migrations"')) {
      return options.ledgerRows ?? []
    }
    if (text.includes('INSERT INTO "schema_migrations"')) {
      return []
    }
    // Statements applied from a schema file (arbitrary DDL from the test's
    // fake .sql content) — accept, since main() never inspects their return
    // value, only awaits them. Anything not shaped like DDL still throws
    // below, so an unexpected query is never silently absorbed.
    if (/^(CREATE|ALTER|DROP)\s/i.test(text.trim())) {
      return []
    }
    throw new Error(`fake-sql: no handler matched query: "${text}"`)
  }

  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    queryCalls.push({ text, params })
    return respond(text)
  })

  const transaction = vi.fn(async (fn: (txn: { query: Mock }) => Promise<unknown>[]) => {
    const txnQuery = vi.fn(async (text: string, params: unknown[] = []) => {
      txnQueryCalls.push({ text, params })
      return respond(text)
    })
    const results = fn({ query: txnQuery })
    return Promise.all(results)
  })

  return { query, transaction, queryCalls, txnQueryCalls }
}

type FakeSql = ReturnType<typeof createFakeSql>

/** Registers node:fs mocks for a given filename -> raw .sql content map. `.env.local` is always reported absent, so loadEnvLocal() never touches the real filesystem. */
function mockSchemaFiles(files: Record<string, string>) {
  vi.doMock('node:fs', () => ({
    readFileSync: vi.fn((path: string) => {
      const filename = path.split('/').pop() ?? ''
      if (filename in files) return files[filename]
      throw new Error(`fake-fs: unexpected readFileSync(${path})`)
    }),
    readdirSync: vi.fn(() => Object.keys(files)),
    existsSync: vi.fn(() => false),
  }))
}

describe('scripts/apply-neon-schema.mjs — checksum-ledger drift detection (#328)', () => {
  const originalEnv = { ...process.env }
  let exitSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let neonMock: Mock

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    process.env.DATABASE_URL = 'postgresql://fake-user:fake-pass@fake-host/fake-db'

    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ProcessExitError(code)
    }) as never)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    neonMock = vi.fn()
    vi.doMock('@neondatabase/serverless', () => ({ neon: neonMock }))
  })

  afterEach(() => {
    exitSpy.mockRestore()
    consoleErrorSpy.mockRestore()
    consoleLogSpy.mockRestore()
    process.env = { ...originalEnv }
    vi.doUnmock('node:fs')
    vi.doUnmock('@neondatabase/serverless')
  })

  describe('computeChecksum', () => {
    it('produces a stable SHA-256 hex digest for given input', async () => {
      mockSchemaFiles({})
      const { computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')

      // Known SHA-256 test vector for "hello".
      expect(computeChecksum('hello')).toBe(
        '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      )
      expect(computeChecksum('hello')).toBe(computeChecksum('hello'))
    })

    it('produces a different digest for different input', async () => {
      mockSchemaFiles({})
      const { computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')

      expect(computeChecksum('hello')).not.toBe(computeChecksum('hello world'))
      // Single-character difference must still change the digest.
      expect(computeChecksum('CREATE TABLE "a"')).not.toBe(computeChecksum('CREATE TABLE "b"'))
    })
  })

  describe('main() — DATABASE_URL guard (pre-existing behavior, still importable safely)', () => {
    it('exits with a non-zero code when DATABASE_URL is not set', async () => {
      delete process.env.DATABASE_URL
      mockSchemaFiles({})
      neonMock.mockReturnValue(createFakeSql())

      const { main } = await import('../../scripts/apply-neon-schema.mjs')

      await expect(main()).rejects.toThrow(ProcessExitError)
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(neonMock).not.toHaveBeenCalled()
    })
  })

  describe('main() — new file classification', () => {
    it('applies a new file (no ledger row) and inserts a ledger row recording its checksum', async () => {
      const fileContent = 'CREATE TABLE IF NOT EXISTS "widgets" (\n  id int\n);'
      mockSchemaFiles({ '001_widgets.sql': fileContent })

      const fakeSql = createFakeSql({ publicTables: [], ledgerRows: [] })
      neonMock.mockReturnValue(fakeSql)

      const { main, computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')
      await main()

      expect(exitSpy).not.toHaveBeenCalled()
      expect(fakeSql.transaction).toHaveBeenCalledTimes(1)

      const statementCall = fakeSql.txnQueryCalls.find((c) =>
        c.text.includes('CREATE TABLE IF NOT EXISTS "widgets"'),
      )
      expect(statementCall).toBeDefined()

      const ledgerInsertCall = fakeSql.txnQueryCalls.find((c) =>
        c.text.includes('INSERT INTO "schema_migrations"'),
      )
      expect(ledgerInsertCall).toBeDefined()
      expect(ledgerInsertCall?.params).toEqual(['001_widgets.sql', computeChecksum(fileContent)])
    })

    it('applies only the files with no ledger row when mixed with already-unchanged files', async () => {
      const unchangedContent = 'CREATE TABLE IF NOT EXISTS "widgets" (\n  id int\n);'
      const newContent = 'CREATE TABLE IF NOT EXISTS "gadgets" (\n  id int\n);'
      mockSchemaFiles({
        '001_widgets.sql': unchangedContent,
        '002_gadgets.sql': newContent,
      })

      const { main, computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')
      // The ledger row's checksum must genuinely match the "unchanged"
      // file's content, so compute it via the real exported function first.
      const fakeSqlWithLedger = createFakeSql({
        publicTables: [{ tablename: 'widgets' }, { tablename: 'schema_migrations' }],
        ledgerRows: [{ filename: '001_widgets.sql', checksum: computeChecksum(unchangedContent) }],
      })
      neonMock.mockReturnValue(fakeSqlWithLedger)

      await main()

      expect(exitSpy).not.toHaveBeenCalled()
      expect(fakeSqlWithLedger.transaction).toHaveBeenCalledTimes(1)

      const widgetsStatement = fakeSqlWithLedger.txnQueryCalls.find((c) =>
        c.text.includes('CREATE TABLE IF NOT EXISTS "widgets"'),
      )
      const gadgetsStatement = fakeSqlWithLedger.txnQueryCalls.find((c) =>
        c.text.includes('CREATE TABLE IF NOT EXISTS "gadgets"'),
      )
      expect(widgetsStatement).toBeUndefined()
      expect(gadgetsStatement).toBeDefined()

      const ledgerInserts = fakeSqlWithLedger.txnQueryCalls.filter((c) =>
        c.text.includes('INSERT INTO "schema_migrations"'),
      )
      expect(ledgerInserts).toHaveLength(1)
      expect(ledgerInserts[0]?.params).toEqual(['002_gadgets.sql', computeChecksum(newContent)])
    })
  })

  describe('main() — unchanged file classification (verified no-op)', () => {
    it('skips an unchanged file whose checksum matches the ledger, without re-applying and without error', async () => {
      const fileContent = 'CREATE TABLE IF NOT EXISTS "widgets" (\n  id int\n);'
      mockSchemaFiles({ '001_widgets.sql': fileContent })

      const { computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')
      const checksum = computeChecksum(fileContent)

      const fakeSql = createFakeSql({
        publicTables: [{ tablename: 'widgets' }, { tablename: 'schema_migrations' }],
        ledgerRows: [{ filename: '001_widgets.sql', checksum }],
      })
      neonMock.mockReturnValue(fakeSql)

      const { main } = await import('../../scripts/apply-neon-schema.mjs')
      await main()

      expect(exitSpy).not.toHaveBeenCalled()
      expect(fakeSql.transaction).not.toHaveBeenCalled()
      expect(consoleErrorSpy).not.toHaveBeenCalled()
    })
  })

  describe('main() — drifted file classification (core #328 fix)', () => {
    it('aborts loudly with a non-zero exit when a ledgered file\'s checksum no longer matches', async () => {
      const currentContent =
        'CREATE TABLE IF NOT EXISTS "widgets" (\n  id int,\n  extra_column int\n);'
      mockSchemaFiles({ '001_widgets.sql': currentContent })

      const { computeChecksum } = await import('../../scripts/apply-neon-schema.mjs')
      const currentChecksum = computeChecksum(currentContent)
      const staleChecksum = 'a'.repeat(64)
      expect(staleChecksum).not.toBe(currentChecksum)

      const fakeSql = createFakeSql({
        publicTables: [{ tablename: 'widgets' }, { tablename: 'schema_migrations' }],
        ledgerRows: [{ filename: '001_widgets.sql', checksum: staleChecksum }],
      })
      neonMock.mockReturnValue(fakeSql)

      const { main } = await import('../../scripts/apply-neon-schema.mjs')

      await expect(main()).rejects.toThrow(ProcessExitError)
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(fakeSql.transaction).not.toHaveBeenCalled()

      const errorCall = consoleErrorSpy.mock.calls.find((args) =>
        String(args[0]).includes('Schema drift detected'),
      )
      expect(errorCall).toBeDefined()
      const errorMessage = String(errorCall?.[0])
      expect(errorMessage).toContain('001_widgets.sql')
      expect(errorMessage).toContain(staleChecksum)
      expect(errorMessage).toContain(currentChecksum)
    })

    it('aborts before applying any statements at all when at least one file has drifted, even if other files are new', async () => {
      const driftedContent =
        'CREATE TABLE IF NOT EXISTS "widgets" (\n  id int,\n  extra_column int\n);'
      const newContent = 'CREATE TABLE IF NOT EXISTS "gadgets" (\n  id int\n);'
      mockSchemaFiles({
        '001_widgets.sql': driftedContent,
        '002_gadgets.sql': newContent,
      })

      const staleChecksum = 'b'.repeat(64)
      const fakeSql = createFakeSql({
        publicTables: [{ tablename: 'widgets' }, { tablename: 'schema_migrations' }],
        ledgerRows: [{ filename: '001_widgets.sql', checksum: staleChecksum }],
      })
      neonMock.mockReturnValue(fakeSql)

      const { main } = await import('../../scripts/apply-neon-schema.mjs')

      await expect(main()).rejects.toThrow(ProcessExitError)
      expect(exitSpy).toHaveBeenCalledWith(1)
      // The new file (gadgets) must never be applied either — classification
      // happens for every file before any statements execute.
      expect(fakeSql.transaction).not.toHaveBeenCalled()
    })
  })

  describe('main() — preflight check (assertDatabaseIsCleanOrOwned) and the ledger table exemption', () => {
    it('does not row-count-check the ledger table itself, even though it is an expected table', async () => {
      mockSchemaFiles({}) // no schema files — isolates the exemption from unrelated table logic

      const fakeSql = createFakeSql({
        publicTables: [{ tablename: 'schema_migrations' }],
        ledgerRows: [],
      })
      neonMock.mockReturnValue(fakeSql)

      const { main } = await import('../../scripts/apply-neon-schema.mjs')
      await main()

      expect(exitSpy).not.toHaveBeenCalled()
      const hasRowsQueries = fakeSql.queryCalls.filter((c) => c.text.includes('has_rows'))
      expect(hasRowsQueries).toHaveLength(0)
    })

    it('still fails preflight for a genuinely unexpected pre-existing table (not silently exempted along with the ledger)', async () => {
      mockSchemaFiles({})

      const fakeSql = createFakeSql({
        publicTables: [{ tablename: 'schema_migrations' }, { tablename: 'some_leftover_table' }],
        ledgerRows: [],
      })
      neonMock.mockReturnValue(fakeSql)

      const { main } = await import('../../scripts/apply-neon-schema.mjs')

      await expect(main()).rejects.toThrow(ProcessExitError)
      expect(exitSpy).toHaveBeenCalledWith(1)
      const errorCall = consoleErrorSpy.mock.calls.find((args) =>
        String(args[0]).includes('pre-existing table(s) not defined'),
      )
      expect(errorCall).toBeDefined()
      expect(String(errorCall?.[0])).toContain('some_leftover_table')
    })
  })
})
