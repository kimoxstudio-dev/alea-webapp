// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { whereColumnHasOperator, whereColumnHasNullCheck } from '../helpers/sql-mock'
import { isNoShowExpired } from '@/lib/server/reservation-no-show'

// vi.hoisted runs before the vi.mock factories below (which themselves run
// before any import, including the static `isNoShowExpired` import above) —
// this is what lets that import stay a plain static import instead of the
// resetModules()+dynamic-import() pattern the DB-touching tests below need
// (there, each test registers its own sql-mock handlers and reloads the
// module fresh; isNoShowExpired is a pure function with no mocked deps, so
// it doesn't need that).
const { sqlMock, getDatabaseNowMock } = await vi.hoisted(async () => {
  const { createSqlMock } = await import('../helpers/sql-mock')
  return {
    sqlMock: createSqlMock(),
    getDatabaseNowMock: vi.fn(async () => new Date('2026-06-19T14:59:00.001Z')),
  }
})

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
    respond: (stmt) => {
      // Pins the `date::text` cast as the actual contract (not
      // defended-against in application code): the Neon driver parses an
      // uncast `date` column as a JS Date, not a string, and would crash
      // isNoShowExpired's zonedDateTimeToUtc call. Dropping the cast must
      // fail a test, not silently keep passing.
      expect(stmt.selectColumns).toContain('date::text')
      return rows
    },
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
    respond: (stmt) => {
      // Pins the SET clause: the WHERE-based match above alone can't tell
      // `SET status = 'no_show'` apart from `SET status = 'cancelled'`.
      expect(stmt.text).toContain(`set status = 'no_show'`)
      return respond(stmt.values[0] as string[])
    },
  })
}

describe('reservation no-show lazy evaluation', () => {
  describe('isNoShowExpired', () => {
    const longSlot = {
      date: '2026-06-19',
      start_time: '16:00:00',
      end_time: '18:00:00',
    }

    it('marks a reservation as expired when now exceeds the deadline (59-minute no-show threshold)', () => {
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.000Z'))).toBe(false)
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.001Z'))).toBe(true)
    })

    it('caps the deadline at the reservation end for short slots', () => {
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
      // No update handler registered: an UPDATE call for a non-expired row
      // would throw via the mock's "no handler matched" guard — but that
      // throw is caught non-fatally by production code (returns 0), so it
      // alone would not fail this test. The call-count assertion below is
      // what actually proves no UPDATE was issued.

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('stays non-fatal if a row somehow arrives with a non-string date (defense in depth, not the primary contract)', async () => {
      // The `date::text` cast (pinned by registerSelectHandler above) is the
      // real contract — production no longer normalizes a Date-shaped `date`
      // field. This only proves the try/catch around the filter step still
      // catches a stray isNoShowExpired throw and returns 0, rather than
      // rejecting and breaking every caller's page-load path.
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      sqlMock.addHandler({
        name: 'select returns a Date-shaped date column',
        verb: 'select',
        match: (stmt) => stmt.table === 'reservations',
        respond: () => [makeRow({ id: 'bad-shape-1', date: new Date('2026-06-19T00:00:00.000Z') as unknown as string })],
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('returns the count of rows actually updated (RETURNING id), not the number of expired candidates', async () => {
      // The UPDATE's WHERE re-guards status='pending' AND activated_at IS
      // NULL, so a candidate that was concurrently activated between the
      // SELECT and the UPDATE (TOCTOU) is excluded from RETURNING even
      // though it was in expiredIds. The count must reflect that, not the
      // candidate list.
      registerSelectHandler([makeRow({ id: 'concurrently-activated-1' })])
      registerUpdateHandler(() => [])

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
