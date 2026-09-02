// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SqlMock } from '../../helpers/sql-mock'

// vi.mock factories are hoisted above imports, so the mock instance itself
// must come from vi.hoisted — mirrors the pattern already used across the
// service test suites (see __tests__/server/reservation-no-show.test.ts).
// lib/db/transaction.ts imports `sql` from './client', which resolves to
// the same module as '@/lib/db/client' below — mocking the one alias covers
// both import spellings.
const sqlMock: SqlMock = await vi.hoisted(async () => {
  const { createSqlMock } = await import('../../helpers/sql-mock')
  return createSqlMock()
})

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadTransactionHelper() {
  vi.resetModules()
  return import('@/lib/db/transaction')
}

describe('lib/db/transaction — shared atomic-transaction helper (#350)', () => {
  beforeEach(() => {
    sqlMock.reset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('runTransaction', () => {
    it('batches every statement into a single sql.transaction call, in order', async () => {
      sqlMock.addHandler({
        name: 'insert row',
        verb: 'insert',
        match: () => true,
        respond: () => [{ id: 'inserted-1' }],
      })
      sqlMock.addHandler({
        name: 'delete row',
        verb: 'delete',
        match: () => true,
        respond: () => [{ id: 'deleted-1' }],
      })

      const { runTransaction } = await loadTransactionHelper()
      const { sql } = await import('@/lib/db/client')

      const insertStatement = sql`INSERT INTO foo (id) VALUES (${'a'}) RETURNING *`
      const deleteStatement = sql`DELETE FROM bar WHERE id = ${'b'} RETURNING id`

      const results = await runTransaction([insertStatement, deleteStatement])

      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      expect(sqlMock.transaction.mock.calls[0]?.[0]).toEqual([
        insertStatement,
        deleteStatement,
      ])
      expect(results).toEqual([[{ id: 'inserted-1' }], [{ id: 'deleted-1' }]])
    })

    it('rejects when one statement throws, via sql.transaction actually rejecting', async () => {
      sqlMock.addHandler({
        name: 'insert that succeeds',
        verb: 'insert',
        match: () => true,
        respond: () => [{ id: 'ok' }],
      })
      sqlMock.addHandler({
        name: 'update that fails',
        verb: 'update',
        match: () => true,
        respond: () => {
          throw new Error('simulated write failure')
        },
      })

      const { runTransaction } = await loadTransactionHelper()
      const { sql } = await import('@/lib/db/client')

      const insertStatement = sql`INSERT INTO foo (id) VALUES (${'a'}) RETURNING *`
      const updateStatement = sql`UPDATE foo SET id = ${'z'} WHERE id = ${'a'}`

      await expect(
        runTransaction([insertStatement, updateStatement]),
      ).rejects.toThrow('simulated write failure')

      // The sql-mock dispatches each `sql\`...\`` tagged-template call
      // eagerly, at statement-construction time — before runTransaction's
      // body even runs — so a passing `applied`-array check on individual
      // statement handlers can't prove runTransaction called sql.transaction
      // at all (it would pass even if runTransaction's body were replaced
      // with `throw new Error(...)` and never touched sql.transaction).
      // Pinning that sql.transaction itself was called, and that its call
      // actually rejected, is what makes this test fail if that happens.
      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      await expect(sqlMock.transaction.mock.results[0]?.value).rejects.toThrow(
        'simulated write failure',
      )
    })
  })

  describe('runAdvisoryLockedTransaction', () => {
    it('runs [lock, guardedStatement] with ReadCommitted isolation and returns only the guarded result', async () => {
      sqlMock.addHandler({
        name: 'advisory lock',
        verb: 'select',
        match: (stmt) => stmt.text.includes('pg_advisory_xact_lock'),
        respond: () => [{ pg_advisory_xact_lock: null }],
      })
      sqlMock.addHandler({
        name: 'guarded insert',
        verb: 'insert',
        match: () => true,
        respond: () => [{ id: 'guarded-row' }],
      })

      const { runAdvisoryLockedTransaction } = await loadTransactionHelper()
      const { sql } = await import('@/lib/db/client')

      const lockStatement = sql`SELECT pg_advisory_xact_lock(hashtext(${'table-1'}::uuid::text))`
      const guardedStatement = sql`INSERT INTO saved_games (table_id) VALUES (${'table-1'}) RETURNING *`

      const result = await runAdvisoryLockedTransaction<Array<{ id: string }>>(
        lockStatement,
        guardedStatement,
      )

      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      expect(sqlMock.transaction).toHaveBeenCalledWith(
        [lockStatement, guardedStatement],
        { isolationLevel: 'ReadCommitted' },
      )
      expect(result).toEqual([{ id: 'guarded-row' }])
    })

    it('propagates a rejection from the guarded statement instead of returning a partial result', async () => {
      sqlMock.addHandler({
        name: 'advisory lock',
        verb: 'select',
        match: (stmt) => stmt.text.includes('pg_advisory_xact_lock'),
        respond: () => [{ pg_advisory_xact_lock: null }],
      })
      sqlMock.addHandler({
        name: 'guarded insert that fails',
        verb: 'insert',
        match: () => true,
        respond: () => {
          throw new Error('conflict detected')
        },
      })

      const { runAdvisoryLockedTransaction } = await loadTransactionHelper()
      const { sql } = await import('@/lib/db/client')

      const lockStatement = sql`SELECT pg_advisory_xact_lock(hashtext(${'table-1'}::uuid::text))`
      const guardedStatement = sql`INSERT INTO saved_games (table_id) VALUES (${'table-1'}) RETURNING *`

      await expect(
        runAdvisoryLockedTransaction(lockStatement, guardedStatement),
      ).rejects.toThrow('conflict detected')

      // Same reasoning as runTransaction's rejection test above: the
      // sql-mock dispatches eagerly at statement-construction time, so
      // asserting only on the outer rejects.toThrow() can't distinguish
      // "runAdvisoryLockedTransaction called sql.transaction and it
      // rejected" from "runAdvisoryLockedTransaction never called
      // sql.transaction at all". Pinning the call and its actual result
      // closes that gap.
      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      await expect(sqlMock.transaction.mock.results[0]?.value).rejects.toThrow(
        'conflict detected',
      )
    })
  })
})
