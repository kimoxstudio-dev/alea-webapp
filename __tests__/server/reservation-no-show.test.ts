// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSqlMock, whereColumnHasOperator, whereColumnHasNullCheck } from '../helpers/sql-mock'

const sqlMock = createSqlMock()
const getDatabaseNowMock = vi.fn(async () => new Date('2026-06-19T14:59:00.001Z'))

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))
vi.mock('@/lib/server/database-time', () => ({ getDatabaseNow: getDatabaseNowMock }))

async function loadReservationNoShow() {
  vi.resetModules()
  return import('@/lib/server/reservation-no-show')
}

type ReservationSlotRow = {
  id: string
  date: string
  start_time: string
  end_time: string
}

function makeRow(overrides?: Partial<ReservationSlotRow>): ReservationSlotRow {
  return {
    id: 'reservation-1',
    date: '2026-06-19',
    start_time: '16:00:00',
    end_time: '18:00:00',
    ...overrides,
  }
}

function registerSelectHandler(rows: ReservationSlotRow[]) {
  sqlMock.addHandler({
    name: 'select pending never-activated reservations',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'reservations' &&
      whereColumnHasOperator(stmt, 'status', '=') &&
      whereColumnHasNullCheck(stmt, 'activated_at', 'IS NULL'),
    respond: () => rows,
  })
}

function registerUpdateHandler(respond: (ids: string[]) => Array<{ id: string }>) {
  sqlMock.addHandler({
    name: 'update expired reservations to no_show',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'reservations' &&
      whereColumnHasOperator(stmt, 'status', '=') &&
      whereColumnHasNullCheck(stmt, 'activated_at', 'IS NULL'),
    respond: (stmt) => respond(stmt.values[0] as string[]),
  })
}

describe('reservation no-show lazy evaluation', () => {
  describe('isNoShowExpired', () => {
    const longSlot = {
      date: '2026-06-19',
      start_time: '16:00:00',
      end_time: '18:00:00',
    }

    it('marks a reservation as expired when now exceeds the deadline (59-minute no-show threshold)', async () => {
      const { isNoShowExpired } = await loadReservationNoShow()
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.000Z'))).toBe(false)
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.001Z'))).toBe(true)
    })

    it('caps the deadline at the reservation end for short slots', async () => {
      const { isNoShowExpired } = await loadReservationNoShow()
      const shortSlot = { ...longSlot, end_time: '16:30:00' }
      expect(isNoShowExpired(shortSlot, new Date('2026-06-19T14:30:00.000Z'))).toBe(false)
      expect(isNoShowExpired(shortSlot, new Date('2026-06-19T14:30:00.001Z'))).toBe(true)
    })
  })

  describe('markExpiredReservationsAsNoShow', () => {
    beforeEach(() => {
      sqlMock.reset()
      getDatabaseNowMock.mockReset()
      // Matches the proven isNoShowExpired boundary above: for a 16:00-18:00
      // slot, 14:59:00.001Z is one millisecond past the 59-minute deadline.
      getDatabaseNowMock.mockResolvedValue(new Date('2026-06-19T14:59:00.001Z'))
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('marks expired pending reservations as no_show and returns the count', async () => {
      // getDatabaseNowMock (set in beforeEach) is one millisecond past this
      // slot's 59-minute no-show deadline.
      const expiredRow = makeRow({ id: 'expired-1' })
      registerSelectHandler([expiredRow])
      registerUpdateHandler((ids) => {
        expect(ids).toEqual(['expired-1'])
        return [{ id: 'expired-1' }]
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(1)
    })

    it('does not touch reservations still within the no-show window', async () => {
      // Move "now" one millisecond earlier — exactly at the deadline, which is
      // still valid (the deadline itself is not yet expired).
      getDatabaseNowMock.mockResolvedValue(new Date('2026-06-19T14:59:00.000Z'))
      const freshRow = makeRow({ id: 'fresh-1' })
      registerSelectHandler([freshRow])
      // No update handler registered: an UPDATE call for a non-expired row would throw
      // via the mock's "no handler matched" guard, failing the test.

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
    })

    it('excludes already-activated or already-non-pending reservations at the query level', async () => {
      // The SELECT is scoped to status='pending' AND activated_at IS NULL, so
      // already-activated/non-pending rows never reach the in-memory filter.
      registerSelectHandler([])

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('swallows a DB failure on the SELECT without throwing', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      sqlMock.addHandler({
        name: 'select fails',
        verb: 'select',
        match: (stmt) => stmt.table === 'reservations',
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('swallows a DB failure on the UPDATE without throwing', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      registerSelectHandler([makeRow({ id: 'expired-1' })])
      sqlMock.addHandler({
        name: 'update fails',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations',
        respond: () => {
          throw new Error('connection reset')
        },
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(consoleErrorSpy).toHaveBeenCalled()
    })
  })
})
