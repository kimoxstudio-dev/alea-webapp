// @vitest-environment node
/**
 * Spec for the shared Drizzle mock infrastructure (KIM-443).
 *
 * `tests/unit/mocks/drizzle-mock.ts` is test infrastructure that four migration
 * lanes (KIM-438/439/440/441) build on, so its own behaviour needs to be pinned
 * down here rather than discovered lane by lane.
 *
 * The scenarios below are organised around the acceptance criteria of KIM-443:
 *
 *   AC1  state-driven      — results follow the store, never the call order
 *   AC2  stateful writes   — create-then-read / update-then-read in one test
 *   AC3  insert vs update  — distinguished at execution time, concurrently
 *   AC4  concurrency       — correct under interleaved flows (the KIM-440 case)
 *   AC5  chained joins     — innerJoin/leftJoin + offset + execute
 *   AC6  guardrails        — unsupported constructs throw instead of lying
 *
 * There is no database here: no pglite, no embedded or containerised Postgres,
 * no SQL engine and no connection. Conditions are evaluated against plain JS
 * objects held in a `Map`.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { and, asc, count, desc, eq, gt, gte, ilike, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'

import { profiles } from '@/lib/db/schema/profiles'
import { reservations } from '@/lib/db/schema/reservations'
import { rooms } from '@/lib/db/schema/rooms'
import { savedGames } from '@/lib/db/schema/saved-games'
import { tables } from '@/lib/db/schema/tables'
import {
  createStatefulDrizzleDb,
  executeMock,
  failNextQuery,
  getQueryLog,
  getRows,
  resetDb,
  seed,
  seedTable,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * A fresh handle each time, deliberately. Every handle shares the same store,
 * which is what makes `getDrizzleDb()` and `getDrizzleAdminDb()` agree inside a
 * single test — and it means no test may rely on handle identity.
 */
const db = () => createStatefulDrizzleDb()

beforeEach(() => {
  resetDb()
  executeMock.mockReset()
})

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — state-driven: the store answers, not the call sequence
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1 state-driven resolution', () => {
  it('answers each query from its own table regardless of the order queries are issued', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M1', fullName: 'Ann', role: 'member', isActive: true },
        { id: 'p2', memberNumber: 'M2', fullName: 'Bob', role: 'admin', isActive: false },
      ],
      rooms: [{ id: 'r1', name: 'Main' }],
      tables: [{ id: 't1', roomId: 'r1', name: 'Table 1' }],
    })

    // Issue the three queries in one order...
    const forward = [
      await db().select().from(profiles).where(eq(profiles.id, 'p2')),
      await db().select().from(rooms),
      await db().select().from(tables),
    ]

    // ...and again in the exact opposite order. A sequence-driven mock would
    // hand back the wrong table's rows here; a state-driven one cannot.
    const reversed = [
      await db().select().from(tables),
      await db().select().from(rooms),
      await db().select().from(profiles).where(eq(profiles.id, 'p2')),
    ]

    expect(forward[0]).toHaveLength(1)
    expect(forward[0][0].fullName).toBe('Bob')
    expect(forward[1][0].name).toBe('Main')
    expect(forward[2][0].name).toBe('Table 1')

    expect(reversed[0]).toEqual(forward[2])
    expect(reversed[1]).toEqual(forward[1])
    expect(reversed[2]).toEqual(forward[0])
  })

  it('resolves builders at await time, so awaiting them out of construction order is still correct', async () => {
    seed({
      profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Ann' }],
      rooms: [{ id: 'r1', name: 'Main' }],
      tables: [{ id: 't1', roomId: 'r1', name: 'Table 1' }],
    })

    // Build three queries up front without awaiting any of them.
    const profileQuery = db().select({ name: profiles.fullName }).from(profiles)
    const roomQuery = db().select({ name: rooms.name }).from(rooms)
    const tableQuery = db().select({ name: tables.name }).from(tables)

    // Await them in reverse construction order.
    const tableRows = await tableQuery
    const roomRows = await roomQuery
    const profileRows = await profileQuery

    expect(tableRows).toEqual([{ name: 'Table 1' }])
    expect(roomRows).toEqual([{ name: 'Main' }])
    expect(profileRows).toEqual([{ name: 'Ann' }])
  })

  it('evaluates and/or/not, comparison, inArray, isNull and ilike against the seeded rows', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M1', fullName: 'Ann', role: 'member', noShowCount: 3, blockedUntil: null },
        { id: 'p2', memberNumber: 'M2', fullName: 'Bob', role: 'member', noShowCount: 0, blockedUntil: '2026-09-01' },
        { id: 'p3', memberNumber: 'M3', fullName: 'annabel', role: 'admin', noShowCount: 7, blockedUntil: null },
      ],
    })

    const where = (condition: unknown) => db().select().from(profiles).where(condition)

    expect(await where(inArray(profiles.id, ['p1', 'p3']))).toHaveLength(2)
    expect(await where(gte(profiles.noShowCount, 3))).toHaveLength(2)
    expect(await where(lte(profiles.noShowCount, 0))).toHaveLength(1)
    expect(await where(ne(profiles.id, 'p1'))).toHaveLength(2)
    expect(await where(isNull(profiles.blockedUntil))).toHaveLength(2)
    expect(await where(ilike(profiles.fullName, '%ANN%'))).toHaveLength(2)
    expect(await where(and(gte(profiles.noShowCount, 3), isNull(profiles.blockedUntil)))).toHaveLength(2)
    expect(await where(or(eq(profiles.id, 'p1'), eq(profiles.id, 'p2')))).toHaveLength(2)
    expect(await where(sql`not ${eq(profiles.role, 'admin')}`)).toHaveLength(2)
    expect(await where(sql`${profiles.noShowCount} between ${2} and ${9}`)).toHaveLength(2)

    // A column-to-column comparison reads both sides from the same row.
    expect(await where(eq(profiles.id, profiles.memberNumber))).toHaveLength(0)
  })

  it('treats an absent condition as no filter and an empty inArray as no match', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M1' },
        { id: 'p2', memberNumber: 'M2' },
        { id: 'p3', memberNumber: 'M3' },
      ],
    })

    // `and()` over an empty condition list collapses to `undefined` in Drizzle —
    // services rely on that to build optional filters, so it must not filter.
    expect(await db().select().from(profiles).where(and())).toHaveLength(3)
    expect(await db().select().from(profiles).where(undefined)).toHaveLength(3)
    expect(await db().select().from(profiles)).toHaveLength(3)

    // An empty IN list matches nothing, rather than everything.
    expect(await db().select().from(profiles).where(inArray(profiles.id, []))).toHaveLength(0)
  })

  it('compares PostgreSQL time strings by value across HH:MM and HH:MM:SS shapes', async () => {
    seed({
      reservations: [
        { id: 'before', endTime: '13:59:59' },
        { id: 'equal-short', endTime: '14:00' },
        { id: 'equal-long', endTime: '14:00:00' },
        { id: 'after', endTime: '14:00:01' },
      ],
    })

    await expect(db().select().from(reservations).where(eq(reservations.endTime, '14:00')))
      .resolves.toHaveLength(2)
    await expect(db().select().from(reservations).where(gt(reservations.endTime, '14:00')))
      .resolves.toEqual([expect.objectContaining({ id: 'after' })])
    await expect(db().select().from(reservations).where(lt(reservations.endTime, '14:00')))
      .resolves.toEqual([expect.objectContaining({ id: 'before' })])

    seed({ profiles: [{ id: 'text-value', memberNumber: '14:00:00' }] })
    await expect(db().select().from(profiles).where(eq(profiles.memberNumber, '14:00')))
      .resolves.toEqual([])
  })

  it('applies projection, ordering, limit/offset and aggregates', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M3', fullName: 'C', role: 'member', createdAt: '2026-03-01T00:00:00Z' },
        { id: 'p2', memberNumber: 'M1', fullName: 'A', role: 'member', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'p3', memberNumber: 'M2', fullName: 'B', role: 'admin', createdAt: '2026-02-01T00:00:00Z' },
      ],
    })

    const page = await db()
      .select({ id: profiles.id, name: profiles.fullName })
      .from(profiles)
      .orderBy(asc(profiles.createdAt))
      .limit(2)
      .offset(1)
    expect(page).toEqual([
      { id: 'p3', name: 'B' },
      { id: 'p1', name: 'C' },
    ])

    const descending = await db().select({ id: profiles.id }).from(profiles).orderBy(desc(profiles.fullName))
    expect(descending.map((row) => row.id)).toEqual(['p1', 'p3', 'p2'])

    const [total] = await db().select({ value: count() }).from(profiles)
    expect(total).toEqual({ value: 3 })

    const grouped = await db().select({ role: profiles.role, total: count() }).from(profiles).groupBy(profiles.role)
    expect(grouped).toEqual([
      { role: 'member', total: 2 },
      { role: 'admin', total: 1 },
    ])

    const [empty] = await db().select({ value: count() }).from(profiles).where(eq(profiles.id, 'missing'))
    expect(empty).toEqual({ value: 0 })
  })

  it('addresses a table by snake_case name, camelCase name or table object, and reads either row key', async () => {
    // Seeded under a camelCase key with snake_case row keys...
    seed({ savedGames: [{ id: 's1', table_id: 't1', user_id: 'u1' }] })

    // ...queried through the Drizzle table object, whose name is `saved_games`.
    const [row] = await db().select().from(savedGames).where(eq(savedGames.userId, 'u1'))
    expect(row.tableId).toBe('t1')

    // All three spellings address the same store entry.
    expect(getRows('saved_games')).toHaveLength(1)
    expect(getRows('savedGames')).toHaveLength(1)
    expect(getRows(savedGames)).toHaveLength(1)

    seedTable(savedGames, [])
    expect(getRows('saved_games')).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — stateful writes: a write is visible to a later read in the same test
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2 stateful writes', () => {
  it('makes an inserted row readable by a subsequent select (create-then-read)', async () => {
    seed({ profiles: [] })

    const [created] = await db()
      .insert(profiles)
      .values({ id: 'p9', memberNumber: 'M9', fullName: 'New', authEmail: 'new@example.com', role: 'member' })
      .returning({ id: profiles.id, fullName: profiles.fullName })

    expect(created).toEqual({ id: 'p9', fullName: 'New' })

    const read = await db().select().from(profiles).where(eq(profiles.id, 'p9'))
    expect(read).toHaveLength(1)
    expect(read[0].memberNumber).toBe('M9')
    expect(getRows('profiles')).toHaveLength(1)
  })

  it('makes an updated value readable by a subsequent select (update-then-read)', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Old', noShowCount: 4 }] })

    const updated = await db()
      .update(profiles)
      .set({ fullName: 'Renamed', noShowCount: 0 })
      .where(eq(profiles.id, 'p1'))
      .returning({ id: profiles.id })
    expect(updated).toEqual([{ id: 'p1' }])

    const [row] = await db().select().from(profiles).where(eq(profiles.id, 'p1'))
    expect(row.fullName).toBe('Renamed')
    expect(row.noShowCount).toBe(0)
  })

  it('persists an update that is awaited without .returning()', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Old' }] })

    // The "update existing member" import path awaits `.where(...)` directly.
    await db().update(profiles).set({ fullName: 'Fire and forget' }).where(eq(profiles.id, 'p1'))

    expect(getRows('profiles')[0].fullName).toBe('Fire and forget')
  })

  it('removes deleted rows from subsequent reads (delete-then-read)', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M1' },
        { id: 'p2', memberNumber: 'M2' },
      ],
    })

    const deleted = await db().delete(profiles).where(eq(profiles.id, 'p1')).returning({ id: profiles.id })
    expect(deleted).toEqual([{ id: 'p1' }])

    const remaining = await db().select({ id: profiles.id }).from(profiles)
    expect(remaining).toEqual([{ id: 'p2' }])
  })

  it('inserts multiple rows in one statement and fills schema defaults', async () => {
    seed({ saved_games: [] })

    const created = await db()
      .insert(savedGames)
      .values([
        { tableId: 't1', userId: 'u1', startDate: '2026-08-01', endDate: '2026-08-02' },
        { tableId: 't2', userId: 'u2', startDate: '2026-08-03', endDate: '2026-08-04' },
      ])
      .returning()

    expect(created).toHaveLength(2)
    expect(getRows(savedGames)).toHaveLength(2)

    // `.defaultRandom()`, `.default('active')` and `.default(0)` are honoured, so
    // services that rely on DB-side defaults do not read `undefined`.
    for (const row of created) {
      expect(typeof row.id).toBe('string')
      expect(row.status).toBe('active')
      expect(row.attendanceCount).toBe(0)
    }
  })

  it('returns an empty array from a write that does not ask for .returning()', async () => {
    seed({ profiles: [] })

    const result = await db().insert(profiles).values({ id: 'p1', memberNumber: 'M1', authEmail: 'a@example.com' })

    expect(result).toEqual([])
    // The write still happened — only the RETURNING projection was skipped.
    expect(getRows('profiles')).toHaveLength(1)
  })

  it('rolls the store back when a transaction callback throws', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Keep' }] })

    await expect(
      db().transaction(async (tx) => {
        await tx.update(profiles).set({ fullName: 'Dirty' }).where(eq(profiles.id, 'p1'))
        await tx.insert(profiles).values({ id: 'p2', memberNumber: 'M2', authEmail: 'b@example.com' })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    expect(getRows('profiles')).toHaveLength(1)
    expect(getRows('profiles')[0].fullName).toBe('Keep')
  })

  it('keeps writes made by a transaction that completes successfully', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Keep' }] })

    const result = await db().transaction(async (tx) => {
      await tx.update(profiles).set({ fullName: 'Committed' }).where(eq(profiles.id, 'p1'))
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(getRows('profiles')[0].fullName).toBe('Committed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — INSERT of a new row vs UPDATE of an existing one
// ─────────────────────────────────────────────────────────────────────────────

describe('AC3 insert vs update distinction', () => {
  it('distinguishes insert from update when both hit the same builder concurrently', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Existing' }] })

    // Two upserts issued together against the same table: one collides with a
    // stored row (=> UPDATE), one does not (=> INSERT). The decision is made
    // against the store at execution time, not from the call order.
    const [collided, fresh] = await Promise.all([
      db()
        .insert(profiles)
        .values({ id: 'ignored', memberNumber: 'M1', fullName: 'Updated by upsert' })
        .onConflictDoUpdate({ target: profiles.memberNumber, set: { fullName: 'Updated by upsert' } })
        .returning({ id: profiles.id, fullName: profiles.fullName }),
      db()
        .insert(profiles)
        .values({ id: 'p2', memberNumber: 'M2', fullName: 'Brand new' })
        .onConflictDoUpdate({ target: profiles.memberNumber, set: { fullName: 'must not apply' } })
        .returning({ id: profiles.id, fullName: profiles.fullName }),
    ])

    // The colliding upsert mutated the stored row — it kept `p1`, not `ignored`.
    expect(collided).toEqual([{ id: 'p1', fullName: 'Updated by upsert' }])
    // The non-colliding upsert created a genuinely new row.
    expect(fresh).toEqual([{ id: 'p2', fullName: 'Brand new' }])

    expect(getRows('profiles')).toHaveLength(2)
    expect(getRows('profiles').map((row) => row.id).sort()).toEqual(['p1', 'p2'])
  })

  it('leaves the existing row untouched for onConflictDoNothing and inserts when there is no conflict', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Existing' }] })

    await db()
      .insert(profiles)
      .values({ id: 'p1-dup', memberNumber: 'M1', fullName: 'Should be dropped' })
      .onConflictDoNothing({ target: profiles.memberNumber })

    expect(getRows('profiles')).toHaveLength(1)
    expect(getRows('profiles')[0].fullName).toBe('Existing')

    await db()
      .insert(profiles)
      .values({ id: 'p2', memberNumber: 'M2', fullName: 'Brand new' })
      .onConflictDoNothing({ target: profiles.memberNumber })

    expect(getRows('profiles')).toHaveLength(2)
  })

  it('never creates a row from an UPDATE whose where-clause matches nothing', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })

    const result = await db()
      .update(profiles)
      .set({ fullName: 'X' })
      .where(eq(profiles.id, 'does-not-exist'))
      .returning()

    expect(result).toEqual([])
    expect(getRows('profiles')).toHaveLength(1)
    expect(getRows('profiles')[0].fullName).toBeUndefined()
  })

  it('records inserts and updates as distinct operations in the query log', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })

    await db().insert(profiles).values({ id: 'p2', memberNumber: 'M2', authEmail: 'b@example.com' })
    await db().update(profiles).set({ fullName: 'Renamed' }).where(eq(profiles.id, 'p1'))
    await db().select().from(profiles)
    await db().delete(profiles).where(eq(profiles.id, 'p2'))

    expect(getQueryLog()).toEqual([
      { op: 'insert', table: 'profiles', rowCount: 1 },
      { op: 'update', table: 'profiles', rowCount: 1 },
      { op: 'select', table: 'profiles', rowCount: 2 },
      { op: 'delete', table: 'profiles', rowCount: 1 },
    ])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — concurrency: the criterion that broke KIM-440 (importMembersFromCsv)
// ─────────────────────────────────────────────────────────────────────────────

describe('AC4 concurrent and interleaved calls', () => {
  it('keeps 10 concurrent read-then-write flows from stealing each other results', async () => {
    // Mirrors `importMembersFromCsv` with `concurrencyLimit = 10`: every flow
    // looks its member up, then either updates or inserts. Under a
    // sequence-driven mock the Nth read gets the Nth queued response and the
    // whole batch is wrong; here each read is answered from the store.
    seed({
      profiles: Array.from({ length: 5 }, (_, index) => ({
        id: `p${index}`,
        memberNumber: `M${index}`,
        fullName: `Existing ${index}`,
      })),
    })

    const inputs = Array.from({ length: 10 }, (_, index) => ({
      memberNumber: `M${index}`,
      fullName: `Imported ${index}`,
    }))

    const results = await Promise.all(
      inputs.map(async (input) => {
        const handle = db()
        const [existing] = await handle
          .select({ id: profiles.id, memberNumber: profiles.memberNumber })
          .from(profiles)
          .where(eq(profiles.memberNumber, input.memberNumber))
          .limit(1)

        if (existing) {
          await handle.update(profiles).set({ fullName: input.fullName }).where(eq(profiles.id, existing.id))
          return { memberNumber: input.memberNumber, outcome: 'updated' as const }
        }

        await handle.insert(profiles).values({
          id: `new-${input.memberNumber}`,
          memberNumber: input.memberNumber,
          fullName: input.fullName,
          authEmail: `${input.memberNumber}@example.com`,
        })
        return { memberNumber: input.memberNumber, outcome: 'created' as const }
      }),
    )

    // The five seeded members were updated; the five unknown ones were created.
    expect(results.filter((result) => result.outcome === 'updated').map((r) => r.memberNumber)).toEqual([
      'M0',
      'M1',
      'M2',
      'M3',
      'M4',
    ])
    expect(results.filter((result) => result.outcome === 'created').map((r) => r.memberNumber)).toEqual([
      'M5',
      'M6',
      'M7',
      'M8',
      'M9',
    ])

    // Every flow wrote its own row and only its own row.
    const stored = getRows('profiles')
    expect(stored).toHaveLength(10)
    for (let index = 0; index < 10; index += 1) {
      const row = stored.find((candidate) => candidate.memberNumber === `M${index}`)
      expect(row?.fullName).toBe(`Imported ${index}`)
    }
  })

  it('answers interleaved queries against three tables without cross-contamination', async () => {
    seed({
      profiles: [
        { id: 'p1', memberNumber: 'M1', fullName: 'Ann' },
        { id: 'p2', memberNumber: 'M2', fullName: 'Bob' },
      ],
      rooms: [{ id: 'r1', name: 'Main' }],
      tables: [
        { id: 't1', roomId: 'r1', name: 'Table 1' },
        { id: 't2', roomId: 'r1', name: 'Table 2' },
        { id: 't3', roomId: 'r1', name: 'Table 3' },
      ],
    })

    const [profileRows, roomRows, tableRows, singleProfile] = await Promise.all([
      db().select({ name: profiles.fullName }).from(profiles).orderBy(asc(profiles.memberNumber)),
      db().select({ name: rooms.name }).from(rooms),
      db().select({ name: tables.name }).from(tables).orderBy(asc(tables.name)),
      db().select({ name: profiles.fullName }).from(profiles).where(eq(profiles.id, 'p2')),
    ])

    expect(profileRows).toEqual([{ name: 'Ann' }, { name: 'Bob' }])
    expect(roomRows).toEqual([{ name: 'Main' }])
    expect(tableRows).toEqual([{ name: 'Table 1' }, { name: 'Table 2' }, { name: 'Table 3' }])
    expect(singleProfile).toEqual([{ name: 'Bob' }])
  })

  it('lets concurrent writes on different tables both land', async () => {
    seed({ profiles: [], rooms: [] })

    await Promise.all([
      db().insert(profiles).values({ id: 'p1', memberNumber: 'M1', authEmail: 'a@example.com' }),
      db().insert(rooms).values({ id: 'r1', name: 'Main' }),
      db().insert(profiles).values({ id: 'p2', memberNumber: 'M2', authEmail: 'b@example.com' }),
    ])

    expect(getRows('profiles')).toHaveLength(2)
    expect(getRows('rooms')).toHaveLength(1)
  })

  it('serialises concurrent updates to the same row so the last write wins', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Original', noShowCount: 0 }] })

    await Promise.all([
      db().update(profiles).set({ fullName: 'First' }).where(eq(profiles.id, 'p1')),
      db().update(profiles).set({ noShowCount: 5 }).where(eq(profiles.id, 'p1')),
      db().update(profiles).set({ fullName: 'Last' }).where(eq(profiles.id, 'p1')),
    ])

    const [row] = await db().select().from(profiles).where(eq(profiles.id, 'p1'))
    // Each update touched only the columns it set — they do not clobber each other.
    expect(row.fullName).toBe('Last')
    expect(row.noShowCount).toBe(5)
  })

  it('makes a write visible to a read issued after it, even with other queries interleaved', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Before' }], rooms: [{ id: 'r1', name: 'Main' }] })

    await db().select().from(rooms)
    await db().update(profiles).set({ fullName: 'After' }).where(eq(profiles.id, 'p1'))
    await db().select().from(rooms)

    const [row] = await db().select().from(profiles).where(eq(profiles.id, 'p1'))
    expect(row.fullName).toBe('After')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC4b — order-independence: the SAME operation set under DIFFERENT arrival
// orders must produce the SAME outcome.
//
// The AC4 block above fires one `Promise.all` and checks the result. That
// proves the flows do not contaminate each other on that particular run; it
// does not prove the outcome is a function of the operations rather than of
// the schedule. `importMembersFromCsv` runs at `concurrencyLimit = 10`, so
// there is no call order to design against — the same ten flows may arrive in
// any order and must still land the same way. These tests re-run one fixed
// operation set under materially different interleavings and compare.
//
// Two things keep them from being vacuous:
//
//   1. Flows yield *between* their read and their write. Awaiting a
//      `Promise.all` over builders that each run to completion in one turn
//      interleaves nothing; the schedules below place some writes between
//      other flows' reads, which is where cross-contamination would show.
//   2. Arrival orders are fixed permutations, never `Math.random()`, so a
//      failure reproduces on the next run instead of flaking.
// ─────────────────────────────────────────────────────────────────────────────

/** Yield `count` microtask turns, so concurrent flows can be pulled apart. */
const yieldTicks = async (count: number): Promise<void> => {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

/** Fixed arrival orders — hardcoded permutations, deliberately not random. */
const TEN_FLOW_ORDERS: ReadonlyArray<readonly [string, readonly number[]]> = [
  ['forward', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
  ['reversed', [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]],
  ['shuffled', [3, 7, 0, 9, 4, 1, 8, 2, 6, 5]],
]

/**
 * Turn an arrival order into a per-flow schedule.
 *
 * The flow scheduled first reads first but waits longest before writing, so
 * writes land *between* later flows' reads rather than after all of them. Reads
 * fall on ticks 0, 3, 6 … and the first flow's write on tick ~20 — i.e. some
 * reads genuinely observe other flows' completed writes, which is the only
 * arrangement in which cross-contamination could be detected.
 */
const scheduleFor = (order: readonly number[], flowIndex: number) => {
  const slot = order.indexOf(flowIndex)
  return { beforeRead: slot * 3, betweenReadAndWrite: (order.length - slot) * 2 }
}

/** Compare stores as multisets: row *order* is not something Postgres promises. */
const byId = (rows: MockRowLike[]): MockRowLike[] =>
  [...rows].sort((left, right) => String(left.id).localeCompare(String(right.id)))

type MockRowLike = Record<string, unknown>

describe('AC4b order-independence across arrival orders', () => {
  it('produces an identical store and identical per-flow results under forward, reversed and shuffled arrival orders', async () => {
    // Modelled on `importMembersFromCsv`: ten flows look their member up and
    // then write it. Five members exist (the write updates them); five do not
    // (the UPDATE must affect zero rows and create nothing, exactly as in
    // Postgres). The operation set is identical in all three runs — only the
    // order the flows arrive in changes.
    const runBatch = async (order: readonly number[]) => {
      resetDb()
      seed({
        profiles: Array.from({ length: 5 }, (_, index) => ({
          id: `p${index}`,
          memberNumber: `M${index}`,
          fullName: `Existing ${index}`,
          noShowCount: 0,
        })),
      })

      const results = await Promise.all(
        Array.from({ length: 10 }, async (_, flowIndex) => {
          const { beforeRead, betweenReadAndWrite } = scheduleFor(order, flowIndex)
          const handle = db()

          await yieldTicks(beforeRead)
          const [existing] = await handle
            .select({ id: profiles.id })
            .from(profiles)
            .where(eq(profiles.memberNumber, `M${flowIndex}`))
            .limit(1)

          await yieldTicks(betweenReadAndWrite)
          const written = await handle
            .update(profiles)
            .set({ fullName: `Imported ${flowIndex}`, noShowCount: flowIndex })
            .where(eq(profiles.memberNumber, `M${flowIndex}`))
            .returning({ id: profiles.id, fullName: profiles.fullName })

          return { flowIndex, foundId: existing?.id ?? null, written }
        }),
      )

      return { results, stored: getRows('profiles'), log: getQueryLog() }
    }

    const batches: Array<Awaited<ReturnType<typeof runBatch>>> = []
    for (const [, order] of TEN_FLOW_ORDERS) batches.push(await runBatch(order))
    const [forward, reversed, shuffled] = batches

    // Anti-vacuity guard. If the three schedules collapsed to the same
    // interleaving, "identical outcome" would be trivially true and this whole
    // test would assert nothing. The query log is the observable arrival order.
    const signature = (batch: (typeof batches)[number]) =>
      batch.log.map((entry) => `${entry.op}:${entry.rowCount}`).join('|')
    expect(signature(forward)).not.toEqual(signature(reversed))
    expect(signature(forward)).not.toEqual(signature(shuffled))

    // Each flow read its own member and wrote its own member.
    expect(forward.results.map((result) => result.foundId)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'p4',
      null,
      null,
      null,
      null,
      null,
    ])
    for (const result of forward.results) {
      expect(result.written).toEqual(
        result.foundId === null ? [] : [{ id: result.foundId, fullName: `Imported ${result.flowIndex}` }],
      )
    }

    // The five UPDATEs that matched nothing created nothing.
    expect(forward.stored).toHaveLength(5)
    for (let index = 0; index < 5; index += 1) {
      const row = forward.stored.find((candidate) => candidate.memberNumber === `M${index}`)
      expect(row?.fullName).toBe(`Imported ${index}`)
      expect(row?.noShowCount).toBe(index)
    }

    // The criterion itself: same operations, different arrival orders, same
    // outcome — both the returned results and the resulting store.
    expect(reversed.results).toEqual(forward.results)
    expect(shuffled.results).toEqual(forward.results)
    expect(byId(reversed.stored)).toEqual(byId(forward.stored))
    expect(byId(shuffled.stored)).toEqual(byId(forward.stored))
  })

  it('resolves a write against the store at await time, not against a snapshot taken when the builder was constructed', async () => {
    seed({
      profiles: Array.from({ length: 4 }, (_, index) => ({
        id: `p${index}`,
        memberNumber: `M${index}`,
        fullName: `Existing ${index}`,
      })),
    })

    // Build every update up front, before any of them runs. AC1 covers the
    // read-side of this; the write side is a different failure mode — a helper
    // that captured its matching rows at construction time would still be
    // holding a row set that no longer reflects the store.
    const builders = Array.from({ length: 4 }, (_, index) =>
      db()
        .update(profiles)
        .set({ fullName: `Renamed ${index}` })
        .where(eq(profiles.memberNumber, `M${index}`))
        .returning({ id: profiles.id, fullName: profiles.fullName }),
    )

    // Change the store after construction but before a single builder is awaited.
    await db().delete(profiles).where(eq(profiles.memberNumber, 'M2'))
    await db().insert(profiles).values({ id: 'p9', memberNumber: 'M9', authEmail: 'm9@example.com' })

    // Await them in reverse construction order for good measure.
    const awaited: unknown[] = []
    for (let index = builders.length - 1; index >= 0; index -= 1) awaited[index] = await builders[index]

    expect(awaited[0]).toEqual([{ id: 'p0', fullName: 'Renamed 0' }])
    expect(awaited[1]).toEqual([{ id: 'p1', fullName: 'Renamed 1' }])
    // M2 was deleted after this builder was constructed, so it now matches
    // nothing — a construction-time snapshot would still have found and
    // "updated" a row that is no longer in the store.
    expect(awaited[2]).toEqual([])
    expect(awaited[3]).toEqual([{ id: 'p3', fullName: 'Renamed 3' }])

    // The deleted row was not resurrected and the late insert was untouched.
    expect(getRows('profiles').map((row) => row.id).sort()).toEqual(['p0', 'p1', 'p3', 'p9'])
    expect(getRows('profiles').find((row) => row.id === 'p9')?.fullName).toBeNull()
  })

  it('produces an identical multi-table outcome for a mixed insert/update/delete workload under different arrival orders', async () => {
    // Nine flows spanning three tables and all three write operations. The
    // existing AC4 coverage runs concurrent writes on different tables once;
    // this re-runs the same nine under three schedules and compares the whole
    // three-table store.
    const orders: ReadonlyArray<readonly number[]> = [
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
      [8, 7, 6, 5, 4, 3, 2, 1, 0],
      [4, 0, 7, 2, 8, 5, 1, 6, 3],
    ]

    const runBatch = async (order: readonly number[]) => {
      resetDb()
      seed({
        profiles: [
          { id: 'p1', memberNumber: 'M1', fullName: 'Ann' },
          { id: 'p2', memberNumber: 'M2', fullName: 'Bob' },
        ],
        rooms: [
          { id: 'r1', name: 'Main' },
          { id: 'r2', name: 'Side' },
        ],
        tables: [
          { id: 't1', roomId: 'r1', name: 'Table 1' },
          { id: 't2', roomId: 'r2', name: 'Table 2' },
        ],
      })

      const flows: Array<() => Promise<unknown>> = [
        () => db().insert(profiles).values({ id: 'p3', memberNumber: 'M3', authEmail: 'm3@example.com' }),
        () => db().insert(rooms).values({ id: 'r3', name: 'Annex' }),
        () => db().insert(tables).values({ id: 't3', roomId: 'r1', name: 'Table 3' }),
        () => db().update(profiles).set({ fullName: 'Ann Updated' }).where(eq(profiles.id, 'p1')),
        () => db().update(rooms).set({ name: 'Main Updated' }).where(eq(rooms.id, 'r1')),
        () => db().update(tables).set({ name: 'Table 1 Updated' }).where(eq(tables.id, 't1')),
        () => db().delete(profiles).where(eq(profiles.id, 'p2')),
        () => db().delete(rooms).where(eq(rooms.id, 'r2')),
        () => db().delete(tables).where(eq(tables.id, 't2')),
      ]

      await Promise.all(
        flows.map(async (flow, flowIndex) => {
          await yieldTicks(order.indexOf(flowIndex) * 2)
          await flow()
        }),
      )

      // `createdAt` / `updatedAt` are `defaultNow()` columns: they carry the
      // wall clock at insert time, so they differ between two batches by
      // however many milliseconds elapsed — exactly as `now()` would across two
      // real transactions. Comparing them across batches would measure the
      // clock, not the mock, so every Date-valued column is dropped here and
      // their presence is asserted separately below.
      const clockColumns = (row: MockRowLike) =>
        Object.keys(row)
          .filter((key) => row[key] instanceof Date)
          .sort()

      const withoutClock = (rows: MockRowLike[]) =>
        byId(rows).map((row) =>
          Object.fromEntries(Object.entries(row).filter(([, value]) => !(value instanceof Date))),
        )

      return {
        profiles: withoutClock(getRows('profiles')),
        rooms: withoutClock(getRows('rooms')),
        tables: withoutClock(getRows('tables')),
        // The inserted room proves the dropped columns were actually populated.
        insertedRoomClockColumns: byId(getRows('rooms'))
          .filter((row) => row.id === 'r3')
          .map(clockColumns),
      }
    }

    const batches: Array<Awaited<ReturnType<typeof runBatch>>> = []
    for (const order of orders) batches.push(await runBatch(order))
    const [baseline] = batches

    expect(baseline.profiles.map((row) => row.id)).toEqual(['p1', 'p3'])
    expect(baseline.profiles.find((row) => row.id === 'p1')?.fullName).toBe('Ann Updated')
    expect(baseline.rooms.map((row) => row.id)).toEqual(['r1', 'r3'])
    expect(baseline.rooms.find((row) => row.id === 'r1')?.name).toBe('Main Updated')
    expect(baseline.tables.map((row) => row.id)).toEqual(['t1', 't3'])
    expect(baseline.tables.find((row) => row.id === 't1')?.name).toBe('Table 1 Updated')
    // The excluded columns were still populated by the insert in every batch.
    for (const batch of batches) expect(batch.insertedRoomClockColumns).toEqual([['createdAt']])

    for (const batch of batches.slice(1)) expect(batch).toEqual(baseline)
  })

  it('never lets an interleaved read observe a half-applied multi-column write', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'gen-0', phone: 'gen-0', email: 'gen-0' }] })

    // Six writers each bump three columns to the same generation marker; twelve
    // readers interleave between them. A write that became visible column by
    // column would let a reader see a mixed generation — the read-side of the
    // cross-contamination criterion, which the AC4 block only checks per row.
    const observed: Array<[unknown, unknown, unknown]> = []

    await Promise.all([
      ...Array.from({ length: 6 }, async (_, index) => {
        await yieldTicks(index * 2 + 1)
        await db()
          .update(profiles)
          .set({ fullName: `gen-${index + 1}`, phone: `gen-${index + 1}`, email: `gen-${index + 1}` })
          .where(eq(profiles.id, 'p1'))
      }),
      ...Array.from({ length: 12 }, async (_, index) => {
        await yieldTicks(index)
        const [row] = await db()
          .select({ fullName: profiles.fullName, phone: profiles.phone, email: profiles.email })
          .from(profiles)
          .where(eq(profiles.id, 'p1'))
        observed.push([row.fullName, row.phone, row.email])
      }),
    ])

    expect(observed).toHaveLength(12)
    for (const [fullName, phone, email] of observed) {
      expect(phone).toBe(fullName)
      expect(email).toBe(fullName)
    }

    // Anti-vacuity: the readers really did straddle the writers rather than all
    // landing before or after them.
    expect(new Set(observed.map(([fullName]) => fullName)).size).toBeGreaterThan(1)

    const [final] = await db().select().from(profiles)
    expect(final.fullName).toBe('gen-6')
    expect(getRows('profiles')).toHaveLength(1)
  })

  it('resolves concurrent writes to the same column of the same row deterministically for a given schedule', async () => {
    // AC4 already covers concurrent updates that set *different* columns. Same
    // column, same row is genuinely schedule-dependent — in Postgres too — so
    // the criterion here is that a given schedule always yields the same value
    // and the store is never corrupted, not that all schedules agree.
    const runOnce = async (order: readonly number[]) => {
      resetDb()
      seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Original', noShowCount: 7 }] })

      await Promise.all(
        order.map(async (writerIndex, slot) => {
          await yieldTicks(slot * 2)
          await db().update(profiles).set({ fullName: `Writer ${writerIndex}` }).where(eq(profiles.id, 'p1'))
        }),
      )

      return getRows('profiles')
    }

    const forward = await runOnce([0, 1, 2, 3, 4])
    const forwardAgain = await runOnce([0, 1, 2, 3, 4])
    const reversed = await runOnce([4, 3, 2, 1, 0])

    // Repeating a schedule repeats the outcome exactly.
    expect(forwardAgain).toEqual(forward)

    // Last write wins, and "last" follows the schedule rather than the order
    // the writers were declared in.
    expect(forward).toHaveLength(1)
    expect(forward[0].fullName).toBe('Writer 4')
    expect(reversed).toHaveLength(1)
    expect(reversed[0].fullName).toBe('Writer 0')

    // Five concurrent writers left one row, and columns nobody set are intact.
    expect(forward[0].id).toBe('p1')
    expect(forward[0].noShowCount).toBe(7)
    expect(reversed[0].noShowCount).toBe(7)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — chained joins
// ─────────────────────────────────────────────────────────────────────────────

describe('AC5 chained joins', () => {
  it('resolves innerJoin().innerJoin() with a projected selection', async () => {
    seed({
      saved_games: [
        { id: 's1', tableId: 't1', userId: 'u1', startDate: '2026-08-01', endDate: '2026-08-10', status: 'active' },
        { id: 's2', tableId: 't2', userId: 'u2', startDate: '2026-08-02', endDate: '2026-08-11', status: 'active' },
        { id: 's3', tableId: 'missing', userId: 'u3', startDate: '2026-08-03', endDate: '2026-08-12', status: 'active' },
      ],
      tables: [
        { id: 't1', roomId: 'room1', name: 'Table 1' },
        { id: 't2', roomId: 'room2', name: 'Table 2' },
      ],
      rooms: [
        { id: 'room1', name: 'Main' },
        { id: 'room2', name: 'Side' },
      ],
    })

    const joined = await db()
      .select({
        id: savedGames.id,
        userId: savedGames.userId,
        tableName: tables.name,
        roomName: rooms.name,
      })
      .from(savedGames)
      .innerJoin(tables, eq(savedGames.tableId, tables.id))
      .innerJoin(rooms, eq(tables.roomId, rooms.id))
      .where(eq(savedGames.userId, 'u1'))
      .orderBy(asc(savedGames.startDate))

    expect(joined).toEqual([{ id: 's1', userId: 'u1', tableName: 'Table 1', roomName: 'Main' }])

    // The row whose tableId matches nothing is dropped by the inner join.
    const all = await db()
      .select({ id: savedGames.id })
      .from(savedGames)
      .innerJoin(tables, eq(savedGames.tableId, tables.id))
      .innerJoin(rooms, eq(tables.roomId, rooms.id))
      .orderBy(asc(savedGames.startDate))
    expect(all.map((row) => row.id)).toEqual(['s1', 's2'])
  })

  it('keeps unmatched rows with null columns across chained leftJoins', async () => {
    seed({
      reservations: [
        { id: 'res1', userId: 'u1', tableId: 't1', date: '2026-08-01', startTime: '10:00', status: 'confirmed' },
        { id: 'res2', userId: 'ghost', tableId: 'none', date: '2026-08-01', startTime: '09:00', status: 'confirmed' },
      ],
      profiles: [{ id: 'u1', memberNumber: 'M1', fullName: 'Ann' }],
      tables: [{ id: 't1', roomId: 'room1', name: 'Table 1' }],
      rooms: [{ id: 'room1', name: 'Main' }],
    })

    const rows = await db()
      .select({
        id: reservations.id,
        memberName: profiles.fullName,
        tableName: tables.name,
        roomName: rooms.name,
      })
      .from(reservations)
      .leftJoin(profiles, eq(reservations.userId, profiles.id))
      .leftJoin(tables, eq(reservations.tableId, tables.id))
      .leftJoin(rooms, eq(tables.roomId, rooms.id))
      .orderBy(asc(reservations.date), asc(reservations.startTime))

    expect(rows).toEqual([
      { id: 'res2', memberName: null, tableName: null, roomName: null },
      { id: 'res1', memberName: 'Ann', tableName: 'Table 1', roomName: 'Main' },
    ])
  })

  it('combines innerJoin, leftJoin, where, orderBy, limit, offset and execute() in one chain', async () => {
    seed({
      saved_games: [
        { id: 's1', tableId: 't1', userId: 'u1', startDate: '2026-08-01', endDate: '2026-08-10', status: 'active' },
        { id: 's2', tableId: 't2', userId: 'u2', startDate: '2026-08-02', endDate: '2026-08-11', status: 'active' },
        { id: 's3', tableId: 't3', userId: 'u3', startDate: '2026-08-03', endDate: '2026-08-12', status: 'active' },
        { id: 's4', tableId: 't4', userId: 'u4', startDate: '2026-08-04', endDate: '2026-08-13', status: 'cancelled' },
      ],
      tables: [
        { id: 't1', roomId: 'room1', name: 'Table 1' },
        { id: 't2', roomId: 'room1', name: 'Table 2' },
        // t3 points at a room that does not exist — the leftJoin must keep it.
        { id: 't3', roomId: 'orphan', name: 'Table 3' },
        { id: 't4', roomId: 'room1', name: 'Table 4' },
      ],
      rooms: [{ id: 'room1', name: 'Main' }],
    })

    const rows = await db()
      .select({ id: savedGames.id, tableName: tables.name, roomName: rooms.name })
      .from(savedGames)
      .innerJoin(tables, eq(savedGames.tableId, tables.id))
      .leftJoin(rooms, eq(tables.roomId, rooms.id))
      .where(eq(savedGames.status, 'active'))
      .orderBy(asc(savedGames.startDate))
      .limit(2)
      .offset(1)
      .execute()

    // status filter drops s4; offset 1 drops s1; limit 2 keeps s2 and s3.
    expect(rows).toEqual([
      { id: 's2', tableName: 'Table 2', roomName: 'Main' },
      { id: 's3', tableName: 'Table 3', roomName: null },
    ])
  })

  it('returns table-keyed rows when a join is used without an explicit selection', async () => {
    seed({
      saved_games: [{ id: 's1', tableId: 't1', userId: 'u1', startDate: '2026-08-01', endDate: '2026-08-02' }],
      tables: [{ id: 't1', roomId: 'room1', name: 'Table 1' }],
    })

    const [row] = await db().select().from(savedGames).innerJoin(tables, eq(savedGames.tableId, tables.id))

    expect((row.saved_games as Record<string, unknown>).id).toBe('s1')
    expect((row.tables as Record<string, unknown>).name).toBe('Table 1')
  })

  it('deduplicates rows for selectDistinct over a join', async () => {
    seed({
      saved_games: [
        { id: 's1', tableId: 't1', userId: 'u1', startDate: '2026-08-01', endDate: '2026-08-02' },
        { id: 's2', tableId: 't1', userId: 'u2', startDate: '2026-08-03', endDate: '2026-08-04' },
      ],
      tables: [{ id: 't1', roomId: 'room1', name: 'Table 1' }],
    })

    const distinct = await db()
      .selectDistinct({ tableName: tables.name })
      .from(savedGames)
      .innerJoin(tables, eq(savedGames.tableId, tables.id))

    expect(distinct).toEqual([{ tableName: 'Table 1' }])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AC6 — guardrails: unsupported constructs throw instead of returning wrong rows
// ─────────────────────────────────────────────────────────────────────────────

describe('AC6 unsupported constructs throw', () => {
  beforeEach(() => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }], rooms: [{ id: 'r1', name: 'Main' }] })
  })

  it('rejects rightJoin and fullJoin instead of approximating them', () => {
    expect(() => db().select().from(profiles).rightJoin(rooms, eq(profiles.id, rooms.id))).toThrow(
      /\[drizzle-mock\] rightJoin\(\) is not supported/,
    )
    expect(() => db().select().from(profiles).fullJoin(rooms, eq(profiles.id, rooms.id))).toThrow(
      /\[drizzle-mock\] fullJoin\(\) is not supported/,
    )
  })

  it('rejects having()', () => {
    expect(() => db().select({ total: count() }).from(profiles).groupBy(profiles.role).having()).toThrow(
      /\[drizzle-mock\] having\(\) is not supported/,
    )
  })

  it('rejects groupBy over a non-column expression', () => {
    expect(() => db().select({ total: count() }).from(profiles).groupBy(sql`lower(${profiles.role})`)).toThrow(
      /\[drizzle-mock\] groupBy\(\) only supports plain columns/,
    )
  })

  it('rejects an EXISTS / subquery style condition rather than guessing at it', async () => {
    await expect(
      db()
        .select()
        .from(profiles)
        .where(sql`exists (select 1 from rooms where ${rooms.id} = ${profiles.id})`),
    ).rejects.toThrow(/\[drizzle-mock\]/)
  })

  it('rejects an unsupported SQL operator', async () => {
    await expect(
      db()
        .select()
        .from(profiles)
        .where(sql`${profiles.memberNumber} ~~ ${'M%'}`),
    ).rejects.toThrow(/\[drizzle-mock\] unsupported SQL operator/)
  })

  it('rejects an unsupported scalar expression in a projection', async () => {
    await expect(
      db()
        .select({ weird: sql<string>`jsonb_path_query(${profiles.id}, '$.a')` })
        .from(profiles),
    ).rejects.toThrow(/\[drizzle-mock\] unsupported SQL expression/)
  })

  it('rejects a condition referencing a table that is not part of the query', async () => {
    await expect(db().select().from(profiles).where(eq(rooms.id, 'r1'))).rejects.toThrow(
      /\[drizzle-mock\] condition references table "rooms"/,
    )
  })

  it('rejects a select that was awaited without .from()', async () => {
    await expect(db().select()).rejects.toThrow(/\[drizzle-mock\] select\(\) was awaited without \.from\(table\)/)
  })

  it('does not consult the store for raw db.execute() — it returns the configured executeMock value', async () => {
    // Arbitrary SQL cannot be evaluated without a SQL engine, so `execute()` is
    // explicitly a pass-through to `executeMock` rather than a store query. It
    // is recorded in the log so tests can still assert the call happened.
    executeMock.mockReturnValue({ rows: [{ total: 42 }], rowCount: 1 })

    const result = await db().execute(sql`select count(*) from profiles`)

    expect(result).toEqual({ rows: [{ total: 42 }], rowCount: 1 })
    expect(executeMock).toHaveBeenCalledTimes(1)
    expect(getQueryLog().filter((entry) => entry.op === 'execute')).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Error injection and store isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('error injection and store isolation', () => {
  it('fails exactly one matching query with failNextQuery', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })
    failNextQuery({ op: 'select', table: profiles })

    await expect(db().select().from(profiles)).rejects.toThrow('[drizzle-mock] injected query failure')
    await expect(db().select().from(profiles)).resolves.toHaveLength(1)
  })

  it('scopes an injected failure to the requested operation and table', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }], rooms: [{ id: 'r1', name: 'Main' }] })
    failNextQuery({ op: 'update', table: profiles, error: new Error('update exploded') })

    // A different table and a different operation are unaffected.
    await expect(db().select().from(profiles)).resolves.toHaveLength(1)
    await expect(db().update(rooms).set({ name: 'Renamed' }).where(eq(rooms.id, 'r1'))).resolves.toEqual([])

    await expect(db().update(profiles).set({ fullName: 'X' }).where(eq(profiles.id, 'p1'))).rejects.toThrow(
      'update exploded',
    )
    // The failed update did not write.
    expect(getRows('profiles')[0].fullName).toBeUndefined()
  })

  it('can fail a query more than once via times', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })
    failNextQuery({ op: 'select', table: profiles, times: 2 })

    await expect(db().select().from(profiles)).rejects.toThrow(/injected query failure/)
    await expect(db().select().from(profiles)).rejects.toThrow(/injected query failure/)
    await expect(db().select().from(profiles)).resolves.toHaveLength(1)
  })

  it('clears the store, the query log and pending failures on resetDb', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })
    failNextQuery({ op: 'select' })
    await db().select().from(rooms).catch(() => [])

    resetDb()

    expect(getRows('profiles')).toEqual([])
    expect(getQueryLog()).toEqual([])
    // The pending failure was dropped rather than leaking into the next test.
    await expect(db().select().from(profiles)).resolves.toEqual([])
  })

  it('returns snapshots from getRows, so mutating the result cannot corrupt the store', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Ann' }] })

    const snapshot = getRows('profiles')
    snapshot[0].fullName = 'Tampered'
    snapshot.push({ id: 'ghost' })

    const [row] = await db().select().from(profiles)
    expect(row.fullName).toBe('Ann')
    expect(getRows('profiles')).toHaveLength(1)
  })

  it('shares one store across every db handle, so admin and user handles agree', async () => {
    const userDb = createStatefulDrizzleDb()
    const adminDb = createStatefulDrizzleDb()

    await adminDb.insert(profiles).values({ id: 'p1', memberNumber: 'M1', authEmail: 'a@example.com' })

    // The write made through the admin handle is visible through the user handle.
    await expect(userDb.select().from(profiles)).resolves.toHaveLength(1)
  })

  it('treats an unseeded table as empty rather than throwing', async () => {
    await expect(db().select().from(profiles)).resolves.toEqual([])
    expect(getRows('profiles')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Error injection on raw db.execute()
//
// `QueryOp` advertises `'execute'` and `failNextQuery({ op: 'execute' })` is a
// documented spec, so the execute path must actually consume the injected
// failure. It once did not: the spec was accepted, queued, and then never
// matched, so `db.execute(sql\`...\`)` resolved through `executeMock` while the
// test believed it was exercising a raw-SQL error path — a silently passing
// error-path test. `reservations-service.ts` replaced the
// `mark_no_show_reservations` RPC with a raw `db.execute(sql\`...\`)`, which is
// exactly the call these tests protect.
// ─────────────────────────────────────────────────────────────────────────────

describe('error injection on raw db.execute()', () => {
  it('fails exactly one execute with failNextQuery({ op: execute }) and lets the next one through', async () => {
    executeMock.mockReturnValue({ rows: [], rowCount: 3 })
    failNextQuery({ op: 'execute' })

    await expect(db().execute(sql`update reservations set status = 'no_show'`)).rejects.toThrow(
      '[drizzle-mock] injected query failure',
    )
    // The failure is consumed, not sticky — the call after it behaves normally.
    await expect(db().execute(sql`update reservations set status = 'no_show'`)).resolves.toEqual({
      rows: [],
      rowCount: 3,
    })
  })

  it('rejects with the custom error supplied to failNextQuery', async () => {
    failNextQuery({ op: 'execute', error: new Error('no_show sweep exploded') })

    await expect(db().execute(sql`select 1`)).rejects.toThrow('no_show sweep exploded')
  })

  it('fails an execute more than once via times', async () => {
    failNextQuery({ op: 'execute', times: 2 })

    await expect(db().execute(sql`select 1`)).rejects.toThrow(/injected query failure/)
    await expect(db().execute(sql`select 1`)).rejects.toThrow(/injected query failure/)
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
  })

  it('lets an unfiltered failNextQuery() fail the next execute', async () => {
    failNextQuery()

    await expect(db().execute(sql`select 1`)).rejects.toThrow('[drizzle-mock] injected query failure')
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
  })

  it('does not leak between execute and the table-backed operations in either direction', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })

    // An execute-scoped failure must not be swallowed by any other operation…
    failNextQuery({ op: 'execute' })
    await expect(db().select().from(profiles)).resolves.toHaveLength(1)
    await expect(db().insert(profiles).values({ id: 'p2', memberNumber: 'M2' })).resolves.toEqual([])
    await expect(db().update(profiles).set({ fullName: 'X' }).where(eq(profiles.id, 'p1'))).resolves.toEqual([])
    // …it is still queued, and fires on the execute.
    await expect(db().execute(sql`select 1`)).rejects.toThrow(/injected query failure/)

    // And the reverse: a select-scoped failure must not be consumed by execute.
    failNextQuery({ op: 'select', table: profiles })
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
    await expect(db().select().from(profiles)).rejects.toThrow(/injected query failure/)
  })

  it('does not fire a table-scoped failure on execute, since raw SQL names no parsable table', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1' }] })
    failNextQuery({ table: profiles })

    // `execute` is matched on the empty table key, so a table-scoped spec with
    // no `op` deliberately passes it by and waits for the real profiles query.
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
    await expect(db().select().from(profiles)).rejects.toThrow(/injected query failure/)
  })

  it('rejects the never-matchable { op: execute, table } combination at call time, queueing nothing', async () => {
    expect(() => failNextQuery({ op: 'execute', table: profiles })).toThrow(/cannot be scoped by table/)

    // Nothing was queued by the rejected spec, so a later execute still resolves.
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
  })

  it('leaves a failed execute out of the query log and records a successful one', async () => {
    failNextQuery({ op: 'execute' })
    await expect(db().execute(sql`select 1`)).rejects.toThrow(/injected query failure/)

    // Consistent with select/insert/update/delete: the failure is thrown before
    // the log push, so a query that never ran is not reported as having run.
    expect(getQueryLog()).toEqual([])

    await db().execute(sql`select 1`)
    expect(getQueryLog()).toEqual([{ op: 'execute', table: '', rowCount: 0 }])
  })

  it('never reaches executeMock when the failure is consumed', async () => {
    executeMock.mockReturnValue({ rows: [{ swept: 1 }], rowCount: 1 })
    failNextQuery({ op: 'execute' })

    await expect(db().execute(sql`select 1`)).rejects.toThrow(/injected query failure/)
    expect(executeMock).not.toHaveBeenCalled()

    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [{ swept: 1 }], rowCount: 1 })
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces the failure as a rejected promise rather than a synchronous throw', async () => {
    failNextQuery({ op: 'execute' })

    // Every other operation rejects rather than throwing at call time; execute
    // must match, or `await expect(...).rejects` reads as a false negative.
    let pending: Promise<unknown> | undefined
    expect(() => {
      pending = db().execute(sql`select 1`)
    }).not.toThrow()
    await expect(pending).rejects.toThrow('[drizzle-mock] injected query failure')
  })

  it('returns the executeMock value when nothing is queued, and the documented default when it is unset', async () => {
    executeMock.mockReturnValue({ rows: [{ total: 7 }], rowCount: 1 })
    await expect(db().execute(sql`select count(*) from profiles`)).resolves.toEqual({
      rows: [{ total: 7 }],
      rowCount: 1,
    })

    executeMock.mockReset()
    await expect(db().execute(sql`select 1`)).resolves.toEqual({ rows: [], rowCount: 0 })
    expect(executeMock).toHaveBeenCalledTimes(1)
  })

  it('rolls a transaction back when the failing call is an execute inside it', async () => {
    seed({ profiles: [{ id: 'p1', memberNumber: 'M1', fullName: 'Keep' }] })
    failNextQuery({ op: 'execute' })

    await expect(
      db().transaction(async (tx) => {
        await tx.update(profiles).set({ fullName: 'Dirty' }).where(eq(profiles.id, 'p1'))
        await tx.execute(sql`update reservations set status = 'no_show'`)
        return 'unreachable'
      }),
    ).rejects.toThrow('[drizzle-mock] injected query failure')

    // The write made before the failing execute was rolled back with it.
    expect(getRows('profiles')[0].fullName).toBe('Keep')
  })
})
