// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlMock } from '../helpers/sql-mock'

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({
  sql: sqlMock.sql,
}))

async function loadModule() {
  return import('@/lib/server/database-time')
}

describe('database-time', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  it('returns the database timestamp from a raw SQL now query', async () => {
    sqlMock.addHandler({
      name: 'SELECT now()',
      verb: 'select',
      match: (stmt) => stmt.isNowSelect && stmt.table === null && stmt.text === 'select now() as now',
      respond: () => [{ now: '2026-04-15T16:00:00.000Z' }],
    })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).resolves.toEqual(new Date('2026-04-15T16:00:00.000Z'))
  })

  it.each([
    { label: 'empty rows', rows: [] },
    { label: 'invalid timestamp', rows: [{ now: 'not-a-date' }] },
  ])('throws when SQL returns $label', async ({ rows }) => {
    sqlMock.addHandler({
      name: 'SELECT now()',
      verb: 'select',
      match: (stmt) => stmt.isNowSelect && stmt.text === 'select now() as now',
      respond: () => rows,
    })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('maps SQL failures to an internal service error', async () => {
    sqlMock.addHandler({
      name: 'failing SELECT now()',
      verb: 'select',
      match: (stmt) => stmt.isNowSelect && stmt.text === 'select now() as now',
      respond: () => {
        throw new Error('database unavailable')
      },
    })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })
})
