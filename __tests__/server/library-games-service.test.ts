// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createSqlMock,
  hasExactOrderBy,
  hasExactSelectColumns,
  neonDbError,
  whereColumnHasOperator,
  whereConditionCount,
} from '../helpers/sql-mock'

/**
 * LIBRARY GAMES SERVICE TEST COVERAGE (Neon raw SQL — #306)
 *
 * Rewritten off the old Supabase-client mocks to the raw-SQL Neon
 * implementation in lib/server/library-games-service.ts (#306), following
 * the shared sql-mock pattern established by equipment-service.test.ts (#305)
 * and events-service.test.ts (#303).
 *
 * Key scenarios tested:
 * - listLibraryGames: public read, active-only, ordered by sort_order/title
 * - listAdminLibraryGames: admin-only, returns active + inactive rows
 * - createLibraryGame/updateLibraryGame/deleteLibraryGame: admin-only CRUD
 * - Non-admin session gets 403 Forbidden before any DB call on every admin op
 * - Validate-before-write: invalid input never reaches the DB
 * - weight validation: accepts 0–5 inclusive (including falsy-zero), rejects
 *   5.1, -1, NaN, non-number/non-string
 * - categoryEn bilingual-fallback resolution (auto-copy vs deliberate edit)
 * - mapWriteError: 23514/22P02/23502 -> 400, everything else -> 500
 */

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/library-games-service')
}

const adminSession = { id: 'admin-1', role: 'admin' as const }
const memberSession = { id: 'member-1', role: 'member' as const }

const gameRow = {
  id: 'game-1',
  title: 'Catan',
  category_es: 'Estrategia',
  category_en: 'Strategy',
  players: '3-4',
  play_time: '90m',
  weight: 2.5,
  sort_order: 1,
  img_url: null as string | null,
}

const adminGameRow = { ...gameRow, active: true }

const mappedGame = {
  id: 'game-1',
  title: 'Catan',
  categoryEs: 'Estrategia',
  categoryEn: 'Strategy',
  players: '3-4',
  playTime: '90m',
  weight: 2.5,
  sortOrder: 1,
  imgUrl: null,
}

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

function addPublicListHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT active library games',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'library_games' &&
      hasExactSelectColumns(stmt, 'id, title, category_es, category_en, players, play_time, weight, sort_order, img_url') &&
      whereColumnHasOperator(stmt, 'active', '=') &&
      whereConditionCount(stmt) === 1 &&
      hasExactOrderBy(stmt, 'sort_order asc, title asc'),
    respond,
  })
}

function addAdminListHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT all library games (admin)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'library_games' &&
      stmt.whereClause === null &&
      hasExactSelectColumns(stmt, 'id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url') &&
      hasExactOrderBy(stmt, 'sort_order asc, title asc'),
    respond,
  })
}

function addInsertHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'INSERT library_games returning row',
    verb: 'insert',
    match: (stmt) => stmt.table === 'library_games' && stmt.returning,
    respond: (stmt) => respond(stmt.values),
  })
}

function addCurrentRowHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT current library_games row by id (updateLibraryGame)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'library_games' &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1 &&
      hasExactSelectColumns(stmt, 'id, title, category_es, category_en, players, play_time, weight, sort_order, active, img_url'),
    respond,
  })
}

function addUpdateHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE library_games by id returning row',
    verb: 'update',
    match: (stmt) =>
      stmt.table === 'library_games' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1,
    respond: (stmt) => respond(stmt.values),
  })
}

function addDeleteHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'DELETE library_games by id returning id',
    verb: 'delete',
    match: (stmt) =>
      stmt.table === 'library_games' &&
      stmt.returning &&
      whereColumnHasOperator(stmt, 'id', '=') &&
      whereConditionCount(stmt) === 1,
    respond,
  })
}

const validCreateBody = {
  title: 'Catan',
  categoryEs: 'Estrategia',
  categoryEn: 'Strategy',
  players: '3-4',
  playTime: '90m',
  weight: 2.5,
  sortOrder: 1,
  active: true,
  imageUrl: '',
}

describe('library-games-service (Neon raw SQL)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  describe('listLibraryGames', () => {
    it('maps active rows ordered by sort_order then title', async () => {
      addPublicListHandler(() => [gameRow, { ...gameRow, id: 'game-2', title: 'Azul', sort_order: 2 }])

      const { listLibraryGames } = await loadService()
      await expect(listLibraryGames()).resolves.toEqual([
        mappedGame,
        { ...mappedGame, id: 'game-2', title: 'Azul', sortOrder: 2 },
      ])
    })

    it('maps a database failure to 500', async () => {
      addPublicListHandler(() => { throw new Error('connection reset') })

      const { listLibraryGames } = await loadService()
      await expect(listLibraryGames()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('normalizes the weight column to a number', async () => {
      addPublicListHandler(() => [{ ...gameRow, weight: '2.5' }])

      const { listLibraryGames } = await loadService()
      const [game] = await listLibraryGames()
      expect(game.weight).toBe(2.5)
    })
  })

  describe('listAdminLibraryGames', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { listAdminLibraryGames } = await loadService()
      await expect(listAdminLibraryGames(memberSession)).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('returns active and inactive rows for an admin session', async () => {
      addAdminListHandler(() => [adminGameRow, { ...adminGameRow, id: 'game-2', active: false }])

      const { listAdminLibraryGames } = await loadService()
      await expect(listAdminLibraryGames(adminSession)).resolves.toEqual([
        { ...mappedGame, active: true },
        { ...mappedGame, id: 'game-2', active: false },
      ])
    })

    it('maps a database failure to 500', async () => {
      addAdminListHandler(() => { throw new Error('connection reset') })

      const { listAdminLibraryGames } = await loadService()
      await expect(listAdminLibraryGames(adminSession)).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('createLibraryGame', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(memberSession, validCreateBody)).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it.each([
      ['title', { ...validCreateBody, title: '  ' }],
      ['categoryEs', { ...validCreateBody, categoryEs: '' }],
      ['players', { ...validCreateBody, players: '' }],
      ['playTime', { ...validCreateBody, playTime: '' }],
    ])('rejects a missing/blank %s before any DB call', async (_field, body) => {
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, body)).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('rejects a non-string title (type guard)', async () => {
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, { ...validCreateBody, title: ['Catan'] })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    describe('weight validation', () => {
      it.each([0, 2.5, 5])('accepts %s (0-5 inclusive, including falsy-zero)', async (weight) => {
        addInsertHandler(() => [{ ...adminGameRow, weight }])
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, weight })).resolves.toMatchObject({ weight })
      })

      it.each([5.1, -1, NaN, null, {}, []])('rejects %s before any DB call', async (weight) => {
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, weight })).rejects.toMatchObject({ statusCode: 400 })
        expect(sqlMock.sql).not.toHaveBeenCalled()
      })

      it('accepts a numeric string', async () => {
        addInsertHandler(() => [{ ...adminGameRow, weight: 3 }])
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, weight: '3' })).resolves.toMatchObject({ weight: 3 })
      })
    })

    describe('categoryEn bilingual fallback', () => {
      it('uses the provided categoryEn verbatim when non-empty', async () => {
        addInsertHandler((values) => [{ ...adminGameRow, category_en: values[2] }])
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, categoryEn: 'Strategy Games' })).resolves.toMatchObject({
          categoryEn: 'Strategy Games',
        })
      })

      it('auto-copies categoryEs when categoryEn is provided but blank', async () => {
        addInsertHandler((values) => [{ ...adminGameRow, category_en: values[2] }])
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, categoryEn: '  ' })).resolves.toMatchObject({
          categoryEn: 'Estrategia',
        })
      })

      it('auto-copies categoryEs when categoryEn is omitted entirely (create has no current row)', async () => {
        const { categoryEn: _omit, ...bodyWithoutEn } = validCreateBody
        addInsertHandler((values) => [{ ...adminGameRow, category_en: values[2] }])
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, bodyWithoutEn)).resolves.toMatchObject({
          categoryEn: 'Estrategia',
        })
      })

      it('rejects a non-string, non-null categoryEn', async () => {
        const { createLibraryGame } = await loadService()
        await expect(createLibraryGame(adminSession, { ...validCreateBody, categoryEn: 42 })).rejects.toMatchObject({ statusCode: 400 })
        expect(sqlMock.sql).not.toHaveBeenCalled()
      })
    })

    it('rejects an invalid imageUrl before any DB call', async () => {
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, { ...validCreateBody, imageUrl: 'javascript:alert(1)' })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('defaults active to true and sortOrder to 0 when omitted', async () => {
      const { active: _a, sortOrder: _s, ...bodyWithoutDefaults } = validCreateBody
      addInsertHandler((values) => [{ ...adminGameRow, active: values[7], sort_order: values[6] }])
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, bodyWithoutDefaults)).resolves.toMatchObject({ active: true, sortOrder: 0 })
    })

    it('inserts normalized values and maps the returned row', async () => {
      addInsertHandler(() => [adminGameRow])
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, validCreateBody)).resolves.toEqual({ ...mappedGame, active: true })
    })

    it('maps a 23502/22P02/23514 write failure to 400', async () => {
      addInsertHandler(() => { throw neonDbError('23502', 'null value in column "title" violates not-null constraint') })
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 400 })
    })

    it('maps a generic database failure to 500', async () => {
      addInsertHandler(() => { throw new Error('connection reset') })
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing RETURNING row to 500', async () => {
      addInsertHandler(() => [])
      const { createLibraryGame } = await loadService()
      await expect(createLibraryGame(adminSession, validCreateBody)).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('updateLibraryGame', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(memberSession, 'game-1', { title: 'New' })).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('maps a current-row lookup failure to 500', async () => {
      addCurrentRowHandler(() => { throw new Error('connection reset') })
      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'New' })).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing current row to 404 before validating the body', async () => {
      addCurrentRowHandler(() => [])
      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'missing', { title: '' })).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects a blank title (explicit empty overwrite)', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: '  ' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('falls back to the current row for every omitted field', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      addUpdateHandler(() => [adminGameRow])

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', {})).resolves.toEqual({ ...mappedGame, active: true })
    })

    describe('categoryEn resolution when omitted from the update body', () => {
      it('preserves a deliberately-edited current.en that differs from the OLD categoryEs', async () => {
        addCurrentRowHandler(() => [{ ...adminGameRow, category_es: 'Estrategia', category_en: 'Custom English' }])
        addUpdateHandler((values) => [{ ...adminGameRow, category_es: values[1], category_en: values[2] }])

        const { updateLibraryGame } = await loadService()
        await expect(updateLibraryGame(adminSession, 'game-1', { categoryEs: 'Nueva Estrategia' })).resolves.toMatchObject({
          categoryEs: 'Nueva Estrategia',
          categoryEn: 'Custom English',
        })
      })

      it('auto-copies the NEW categoryEs when current.en equals the OLD categoryEs', async () => {
        addCurrentRowHandler(() => [{ ...adminGameRow, category_es: 'Estrategia', category_en: 'Estrategia' }])
        addUpdateHandler((values) => [{ ...adminGameRow, category_es: values[1], category_en: values[2] }])

        const { updateLibraryGame } = await loadService()
        await expect(updateLibraryGame(adminSession, 'game-1', { categoryEs: 'Nueva Estrategia' })).resolves.toMatchObject({
          categoryEs: 'Nueva Estrategia',
          categoryEn: 'Nueva Estrategia',
        })
      })
    })

    it('falls back to the current weight when omitted', async () => {
      addCurrentRowHandler(() => [{ ...adminGameRow, weight: 4 }])
      addUpdateHandler((values) => [{ ...adminGameRow, weight: values[5] }])

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'Renamed' })).resolves.toMatchObject({ weight: 4 })
    })

    it('rejects an out-of-range weight override', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { weight: 5.1 })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('updates and maps the returned row', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      addUpdateHandler(() => [{ ...adminGameRow, title: 'Renamed' }])

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'Renamed' })).resolves.toMatchObject({ title: 'Renamed' })
    })

    it('maps a 23502/22P02/23514 write failure to 400', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      addUpdateHandler(() => { throw neonDbError('22P02', 'invalid input syntax') })

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'Renamed' })).rejects.toMatchObject({ statusCode: 400 })
    })

    it('maps a generic update failure to 500', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      addUpdateHandler(() => { throw new Error('connection reset') })

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'Renamed' })).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing RETURNING row on update to 404', async () => {
      addCurrentRowHandler(() => [adminGameRow])
      addUpdateHandler(() => [])

      const { updateLibraryGame } = await loadService()
      await expect(updateLibraryGame(adminSession, 'game-1', { title: 'Renamed' })).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('deleteLibraryGame', () => {
    it('rejects a non-admin session with 403 before any DB call', async () => {
      const { deleteLibraryGame } = await loadService()
      await expect(deleteLibraryGame(memberSession, 'game-1')).rejects.toMatchObject({ statusCode: 403 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('deletes a matching row', async () => {
      addDeleteHandler(() => [{ id: 'game-1' }])
      const { deleteLibraryGame } = await loadService()
      await expect(deleteLibraryGame(adminSession, 'game-1')).resolves.toBeUndefined()
    })

    it('maps a database failure to 500', async () => {
      addDeleteHandler(() => { throw new Error('connection reset') })
      const { deleteLibraryGame } = await loadService()
      await expect(deleteLibraryGame(adminSession, 'game-1')).rejects.toMatchObject({ statusCode: 500 })
    })

    it('maps a missing row to 404', async () => {
      addDeleteHandler(() => [])
      const { deleteLibraryGame } = await loadService()
      await expect(deleteLibraryGame(adminSession, 'missing')).rejects.toMatchObject({ statusCode: 404 })
    })
  })
})
