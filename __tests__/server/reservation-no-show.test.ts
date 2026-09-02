// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  whereColumnHasOperator,
  whereColumnHasNullCheck,
  type ParsedStatement,
} from '../helpers/sql-mock'
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

// Both handlers below record the matched statement instead of asserting on
// it inline. Production wraps every call to these handlers in its own
// non-fatal try/catch, so an `expect()` thrown from inside `respond` is
// swallowed there rather than failing the test — the pin would only bite
// indirectly (via a confused `result` assertion) or, in tests that already
// expect a 0 result, not at all. Recording the statement and asserting on it
// after `markExpiredReservationsAsNoShow()` returns — outside any try/catch —
// makes a broken pin fail directly and visibly.

function registerSelectHandler(rows: ReservationSlotRow[]): { getStmt: () => ParsedStatement | undefined } {
  let matchedStmt: ParsedStatement | undefined
  sqlMock.addHandler({
    name: 'select pending never-activated reservations',
    verb: 'select',
    match: (stmt) =>
      // Full-statement pin, not a piecemeal stack of column/WHERE/LIMIT
      // checks: those only close the specific gaps they name, and mutation
      // testing found two more they didn't — appending `ORDER BY id OFFSET
      // 50` (OFFSET isn't excluded from the WHERE-clause regex the way LIMIT
      // is, and ORDER BY re-hides everything after it from that regex too),
      // and joining in `profiles` (silently dropping any reservation with no
      // matching profile row). `parseStatement` already lowercases and
      // collapses whitespace on `stmt.text`, so this exact-text pin is safe
      // against reindentation/formatting differences in production, while
      // still catching anything appended, changed, or joined in.
      stmt.text ===
        "select id, date::text as date, start_time, end_time from reservations where status = 'pending' and activated_at is null",
    respond: (stmt) => {
      matchedStmt = stmt
      return rows
    },
  })
  return { getStmt: () => matchedStmt }
}

function registerUpdateHandler(respond: (ids: string[]) => Array<{ id: string }>): { getStmt: () => ParsedStatement | undefined } {
  let matchedStmt: ParsedStatement | undefined
  sqlMock.addHandler({
    name: 'update expired reservations to no_show',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'reservations' &&
      // Exact WHERE shape, not a substring check on each condition: a
      // substring check never verifies there's nothing ELSE in the clause.
      // Appending `... AND activated_at IS NULL OR true` to production's
      // WHERE still satisfies every individual `.includes()` check below it
      // used to have, and since Postgres binds AND tighter than OR, that
      // mutated clause becomes no WHERE at all — a table-wide `UPDATE
      // reservations SET status = 'no_show'`. Pinning the full normalized
      // clause catches that.
      stmt.whereClause === `id = any($1::uuid[]) and status = 'pending' and activated_at is null` &&
      whereColumnHasOperator(stmt, 'status', '=') &&
      whereColumnHasNullCheck(stmt, 'activated_at', 'IS NULL') &&
      // Pins RETURNING id: production's returned count comes entirely from
      // `updatedRows.length`, which depends on this clause. Without pinning
      // it, removing `RETURNING id` from production still satisfies every
      // other condition here and the mock would keep matching.
      stmt.text.includes('returning id'),
    respond: (stmt) => {
      matchedStmt = stmt
      return respond(stmt.values[0] as string[])
    },
  })
  return { getStmt: () => matchedStmt }
}

/** Pins the `date::text` cast: an uncast `date` column parses as a JS Date via the Neon driver, not a string, and would crash `isNoShowExpired`'s `zonedDateTimeToUtc` call. Call after `markExpiredReservationsAsNoShow()` returns, never inside a `respond` callback. */
function expectSelectCastDateToText(select: { getStmt: () => ParsedStatement | undefined }) {
  expect(select.getStmt()?.selectColumns).toContain('date::text')
}

/**
 * Pins the SET clause's start AND end: the WHERE-based match alone can't
 * tell `SET status = 'no_show'` apart from `SET status = 'cancelled'`, and a
 * prefix-only substring check (`toContain("set status = 'no_show'")`) can't
 * tell it apart from `SET status = 'no_show', activated_at = now()` — a
 * second assignment appended after it. That would stamp `activated_at` on
 * every no-show row, breaking the "pending and never activated" invariant
 * the rest of this module's WHERE re-guards depend on. Anchoring to
 * `... where` (the next clause) proves nothing else was appended to SET.
 * Call after `markExpiredReservationsAsNoShow()` returns, never inside a
 * `respond` callback.
 */
function expectUpdateSetsNoShowStatus(update: { getStmt: () => ParsedStatement | undefined }) {
  expect(update.getStmt()?.text).toContain(`set status = 'no_show' where`)
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
      const select = registerSelectHandler([expiredRow])
      const update = registerUpdateHandler((ids) => {
        expect(ids).toEqual(['expired-1'])
        return [{ id: 'expired-1' }]
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(1)
      expectSelectCastDateToText(select)
      expectUpdateSetsNoShowStatus(update)
    })

    it('only binds the expired row when the SELECT returns a mix of expired and fresh rows', async () => {
      // getDatabaseNowMock (set in beforeEach) is one millisecond past the
      // expired row's deadline. The fresh row's start_time is one minute
      // later (16:01 vs 16:00), which pushes its own deadline to 15:00:00Z —
      // one minute after "now" — so it stays inside the window at the exact
      // same "now" this suite already uses. This is the only test in the
      // file that feeds the SELECT more than one row, so it's the only one
      // that actually exercises the filter step (only expired candidates get
      // bound into the UPDATE) rather than a filter over a single-row list,
      // where "filter everything" and "filter correctly" produce the same
      // observable result.
      const expiredRow = makeRow({ id: 'expired-1' })
      const freshRow = makeRow({ id: 'fresh-1', start_time: '16:01:00' })
      const select = registerSelectHandler([expiredRow, freshRow])
      const update = registerUpdateHandler((ids) => {
        expect(ids).toEqual(['expired-1'])
        return [{ id: 'expired-1' }]
      })

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(1)
      expect(update.getStmt()?.values[0]).toEqual(['expired-1'])
      expectSelectCastDateToText(select)
      expectUpdateSetsNoShowStatus(update)
    })

    it('does not touch reservations still within the no-show window', async () => {
      // Move "now" one millisecond earlier — exactly at the deadline, which is
      // still valid (the deadline itself is not yet expired).
      getDatabaseNowMock.mockResolvedValue(new Date('2026-06-19T14:59:00.000Z'))
      const freshRow = makeRow({ id: 'fresh-1' })
      const select = registerSelectHandler([freshRow])
      // No update handler registered: an UPDATE call for a non-expired row
      // would throw via the mock's "no handler matched" guard — but that
      // throw is caught non-fatally by production code (returns 0), so it
      // alone would not fail this test. The call-count assertion below is
      // what actually proves no UPDATE was issued.

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
      expectSelectCastDateToText(select)
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
      const select = registerSelectHandler([makeRow({ id: 'concurrently-activated-1' })])
      const update = registerUpdateHandler(() => [])

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expectSelectCastDateToText(select)
      expectUpdateSetsNoShowStatus(update)
    })

    it('excludes already-activated or already-non-pending reservations at the query level', async () => {
      // The SELECT is scoped to status='pending' AND activated_at IS NULL, so
      // already-activated/non-pending rows never reach the in-memory filter.
      const select = registerSelectHandler([])

      const { markExpiredReservationsAsNoShow } = await loadReservationNoShow()
      const result = await markExpiredReservationsAsNoShow()

      expect(result).toBe(0)
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
      expectSelectCastDateToText(select)
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
