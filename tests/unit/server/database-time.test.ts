// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSql } from '@/tests/unit/mocks/drizzle-mock'

const executeMock = vi.fn()
const getDrizzleAdminDb = vi.fn(() => ({ execute: executeMock }))

vi.mock('@/lib/db', () => ({
  getDrizzleAdminDb,
}))

async function loadModule() {
  return import('@/lib/server/shared/database-time')
}

describe('database-time', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('uses the default Drizzle/Neon client and returns database time', async () => {
    executeMock.mockResolvedValue({ rows: [{ now: new Date('2026-04-15T16:00:00.123Z') }] })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).resolves.toEqual(new Date('2026-04-15T16:00:00.123Z'))
    expect(getDrizzleAdminDb).toHaveBeenCalledOnce()
    expect(executeMock).toHaveBeenCalledOnce()
    expect(renderSql(executeMock.mock.calls[0]![0])).toContain('select now() as now')
  })

  it('uses an explicitly supplied Drizzle client', async () => {
    const execute = vi.fn(async () => ({ rows: [{ now: '2026-04-15T16:00:00.000Z' }] }))

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow({ execute })).resolves.toEqual(new Date('2026-04-15T16:00:00.000Z'))
    expect(getDrizzleAdminDb).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledOnce()
  })

  it('throws when the database result has no timestamp', async () => {
    executeMock.mockResolvedValue({ rows: [] })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('throws when the database timestamp is invalid', async () => {
    executeMock.mockResolvedValue({ rows: [{ now: 'not-a-date' }] })

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('propagates Neon query failures without falling back to Supabase', async () => {
    const failure = new Error('Neon unavailable')
    executeMock.mockRejectedValue(failure)

    const { getDatabaseNow } = await loadModule()

    await expect(getDatabaseNow()).rejects.toBe(failure)
    expect(getDrizzleAdminDb).toHaveBeenCalledOnce()
    expect(executeMock).toHaveBeenCalledOnce()
  })
})
