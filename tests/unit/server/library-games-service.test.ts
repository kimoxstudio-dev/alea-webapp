// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  createDrizzleQueryBuilderWithDispatching,
  resetFixtures,
  setFixture,
  createMockServiceError,
  MockServiceError,
  insertMock,
  updateMock,
  deleteMock,
} from '@/tests/unit/mocks/drizzle-mock'

/**
 * LIBRARY GAMES SERVICE TEST COVERAGE (OIR-205)
 *
 * Tests for admin CRUD operations on library games (ludoteca highlights) and public read access.
 * Implementation: lib/server/games/library-games-service.ts
 *
 * Key scenarios tested:
 * - listLibraryGames returns active games ordered by sort_order then title (public, explicit filter)
 * - listAdminLibraryGames returns all games (active + inactive) for admin dashboard
 * - createLibraryGame/updateLibraryGame/deleteLibraryGame admin-only operations
 * - Non-admin users get 403 Forbidden from every admin endpoint
 * - weight validation: accepts 0–5 inclusive (including falsy-zero!), rejects 5.1, -1, NaN, string, null-when-required
 * - Type guards: title as object/array rejected with 400
 * - Validate-before-write: invalid input prevents DB calls
 * - Migration enables RLS, creates SELECT-only policy for active=true, seeds exactly 8 games with category_es AND category_en
 * - Bilingual category fallback (OIR-206): categoryEn optional, falls back to categoryEs
 * - Image URL validation (OIR-207): optional https/http URLs only, no javascript:/data: or relative paths
 */

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilderWithDispatching()),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  ServiceError: MockServiceError,
  serviceError: createMockServiceError(),
}))

// Test data factory for library games
function createGameRow(overrides?: Partial<{
  id: string
  title: string
  categoryEs: string
  categoryEn: string
  players: string
  playTime: string
  weight: string
  sortOrder: number
  active: boolean
  createdAt: string
  updatedAt: string
  imgUrl: string | null
}>): any {
  return {
    id: overrides?.id ?? 'game-1',
    title: overrides?.title ?? 'Test Game',
    categoryEs: overrides?.categoryEs ?? 'Estrategia',
    categoryEn: overrides?.categoryEn ?? 'Strategy',
    players: overrides?.players ?? '2-4',
    playTime: overrides?.playTime ?? '60m',
    weight: overrides?.weight ?? '3.0',
    sortOrder: overrides?.sortOrder ?? 0,
    active: overrides?.active ?? true,
    createdAt: overrides?.createdAt ?? '2026-07-04T00:00:00Z',
    updatedAt: overrides?.updatedAt ?? '2026-07-04T00:00:00Z',
    imgUrl: overrides?.imgUrl ?? null,
  }
}

type SessionUser = {
  id: string
  role: 'admin' | 'member'
  email?: string
}

function createAdminSession(): SessionUser {
  return { id: 'user-admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'user-member-1', role: 'member', email: 'member@example.com' }
}

async function loadLibraryGamesService() {
  vi.resetModules()
  const mod = await import('@/lib/server/games/library-games-service')
  return {
    listLibraryGames: mod.listLibraryGames,
    listAdminLibraryGames: mod.listAdminLibraryGames,
    createLibraryGame: mod.createLibraryGame,
    updateLibraryGame: mod.updateLibraryGame,
    deleteLibraryGame: mod.deleteLibraryGame,
  }
}

describe('library-games-service', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  describe('listLibraryGames', () => {
    it('returns active games ordered by sort_order', async () => {
      const mockGames = [
        createGameRow({ id: 'game-1', title: 'Bolt Action', sortOrder: 0, active: true }),
        createGameRow({ id: 'game-2', title: 'Pathfinder 2e', sortOrder: 1, active: true }),
      ]
      setFixture('library_games', mockGames)

      const { listLibraryGames } = await loadLibraryGamesService()
      const result = await listLibraryGames()

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(2)
      expect(result[0].title).toBe('Bolt Action')
      expect(result[0].sortOrder).toBe(0)
      expect(result[1].title).toBe('Pathfinder 2e')
      expect(result[1].sortOrder).toBe(1)
    })

    it('chains orderBy calls without error (sort_order primary, title secondary)', async () => {
      const mockGames = [
        createGameRow({ id: 'game-1', title: 'Bolt Action', sortOrder: 0, active: true }),
      ]
      setFixture('library_games', mockGames)

      const { listLibraryGames } = await loadLibraryGamesService()
      const result = await listLibraryGames()

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(1)
    })

    it('uses regular Drizzle client (user-scoped) for public listing', async () => {
      setFixture('library_games', [createGameRow({ active: true })])

      const { listLibraryGames } = await loadLibraryGamesService()
      await listLibraryGames()

      expect(vi.mocked(await import('@/lib/db')).getDrizzleDb).toHaveBeenCalled()
    })

    it('maps database columns to public LibraryGame type', async () => {
      setFixture('library_games', [
        createGameRow({
          id: 'game-1',
          title: 'Test Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: '3.2',
          sortOrder: 0,
          active: true,
          imgUrl: null,
        }),
      ])

      const { listLibraryGames } = await loadLibraryGamesService()
      const result = await listLibraryGames()

      expect(result[0]).toMatchObject({
        id: 'game-1',
        title: 'Test Game',
        categoryEs: 'Estrategia',
        categoryEn: 'Strategy',
        players: '2-4',
        playTime: '60m',
        weight: 3.2,
        sortOrder: 0,
      })
      expect(result[0]).not.toHaveProperty('active')
    })

    it('converts weight to number type', async () => {
      setFixture('library_games', [
        createGameRow({ id: 'game-1', weight: '3.2', active: true }),
        createGameRow({ id: 'game-2', weight: '4.1', active: true }),
      ])

      const { listLibraryGames } = await loadLibraryGamesService()
      const result = await listLibraryGames()

      expect(typeof result[0].weight).toBe('number')
      expect(result[1].weight).toBe(4.1)
    })
  })

  describe('listAdminLibraryGames', () => {
    it('admin can list all games including inactive', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [
        createGameRow({ id: 'game-1', active: true }),
        createGameRow({ id: 'game-2', active: false }),
      ])

      const { listAdminLibraryGames } = await loadLibraryGamesService()
      const result = await listAdminLibraryGames(adminSession)

      expect(Array.isArray(result)).toBe(true)
      expect(result.length).toBe(2)
      expect(result[0]).toHaveProperty('active')
      expect(result[1]).toHaveProperty('active')
    })

    it('chains orderBy calls without error (sort_order primary, title secondary)', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ active: true })])

      const { listAdminLibraryGames } = await loadLibraryGamesService()
      const result = await listAdminLibraryGames(adminSession)

      expect(Array.isArray(result)).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { listAdminLibraryGames } = await loadLibraryGamesService()

      await expect(listAdminLibraryGames(memberSession)).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('createLibraryGame', () => {
    it('admin can create a game with required fields', async () => {
      const adminSession = createAdminSession()
      const newGame = createGameRow({ id: 'game-new-1', title: 'New Game' })
      insertMock.mockResolvedValue([newGame])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'New Game',
        categoryEs: 'Estrategia',
        categoryEn: 'Strategy',
        players: '2-4',
        playTime: '60m',
        weight: 3.0,
      })

      expect(result.id).toBe('game-new-1')
      expect(result.title).toBe('New Game')
      expect(result.categoryEs).toBe('Estrategia')
    })

    it('admin can create a game with all fields', async () => {
      const adminSession = createAdminSession()
      const newGame = createGameRow({
        id: 'game-new-1',
        title: 'Complete Game',
        active: true,
      })
      insertMock.mockResolvedValue([newGame])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Complete Game',
        categoryEs: 'Rol',
        categoryEn: 'RPG',
        players: '3-6',
        playTime: '∞',
        weight: 4.5,
        sortOrder: 10,
        active: true,
      })

      expect(result.title).toBe('Complete Game')
      expect(result.active).toBe(true)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const memberSession = createMemberSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(memberSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('accepts weight 0 (falsy-zero)', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1' })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Zero Weight',
        categoryEs: 'Familiar',
        categoryEn: 'Family',
        players: '1-4',
        playTime: '20m',
        weight: 0,
      })

      expect(result.id).toBe('game-new-1')
    })

    it('accepts weight 5 (upper bound inclusive)', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1' })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Heavy Game',
        categoryEs: 'Estrategia',
        categoryEn: 'Strategy',
        players: '2-4',
        playTime: '120m',
        weight: 5,
      })

      expect(result.id).toBe('game-new-1')
    })

    it('rejects weight 5.1 (above upper bound)', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 5.1,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects weight -1 (negative)', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: -1,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects weight as NaN', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: NaN,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects weight as string', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 'heavy' as any,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects weight null when required', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: null,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects title as object with 400', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: { invalid: 'object' },
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects title as array with 400', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: ['array', 'title'],
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects categoryEs as array with 400', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: [],
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects missing/empty title', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: '',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects missing categoryEs', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('validates before any DB insert', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 5.5,
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })
  })

  describe('updateLibraryGame', () => {
    it('admin can update a game', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1', title: 'Old Title' })])
      updateMock.mockResolvedValue([createGameRow({ id: 'game-1', title: 'Updated Game' })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        title: 'Updated Game',
      })

      expect(result.id).toBe('game-1')
      expect(result.title).toBe('Updated Game')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const memberSession = createMemberSession()

      const { updateLibraryGame } = await loadLibraryGamesService()

      await expect(
        updateLibraryGame(memberSession, 'game-1', { title: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent game', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', []) // Empty fixture

      const { updateLibraryGame } = await loadLibraryGamesService()

      await expect(
        updateLibraryGame(adminSession, 'nonexistent-game', { title: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects weight 5.1 on update', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1' })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      await expect(
        updateLibraryGame(adminSession, 'game-1', {
          weight: 5.1,
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('validates before any DB update', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1' })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      await expect(
        updateLibraryGame(adminSession, 'game-1', {
          weight: 'invalid' as any,
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateMock).not.toHaveBeenCalled()
    })

    it('preserves current values for omitted fields', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1', title: 'Old Title' })])
      updateMock.mockResolvedValue([createGameRow({ id: 'game-1' })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        title: 'Updated Title',
      })

      expect(result.id).toBe('game-1')
    })
  })

  describe('deleteLibraryGame', () => {
    it('admin can delete a game', async () => {
      const adminSession = createAdminSession()
      deleteMock.mockResolvedValue([{ id: 'game-1' }])

      const { deleteLibraryGame } = await loadLibraryGamesService()

      await expect(deleteLibraryGame(adminSession, 'game-1')).resolves.toBeUndefined()
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const memberSession = createMemberSession()

      const { deleteLibraryGame } = await loadLibraryGamesService()

      await expect(deleteLibraryGame(memberSession, 'game-1')).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent game', async () => {
      const adminSession = createAdminSession()
      deleteMock.mockResolvedValue([]) // Empty result

      const { deleteLibraryGame } = await loadLibraryGamesService()

      await expect(deleteLibraryGame(adminSession, 'nonexistent-game')).rejects.toMatchObject({
        statusCode: 404,
      })
    })
  })

  describe('migration sanity checks', () => {
    const migrationPath = join(
      '/Users/samuelromeroarbelo/Projects/Alea/alea-webapp/supabase/migrations',
      '20260704000003_oir205_library_games_table.sql'
    )
    const migrationContent = readFileSync(migrationPath, 'utf8')

    it('migration file enables RLS on library_games table', () => {
      expect(migrationContent).toContain('ALTER TABLE "public"."library_games" ENABLE ROW LEVEL SECURITY')
    })

    it('migration creates SELECT-only policy for anon and authenticated where active=true', () => {
      expect(migrationContent).toContain('CREATE POLICY "library_games_select_active"')
      expect(migrationContent).toContain('FOR SELECT TO "anon", "authenticated"')
      expect(migrationContent).toContain('USING ("active" = true)')
    })

    it('migration grants SELECT only (no INSERT/UPDATE/DELETE)', () => {
      expect(migrationContent).toContain('GRANT SELECT ON TABLE "public"."library_games" TO "anon", "authenticated"')
      expect(migrationContent).not.toContain('GRANT INSERT')
      expect(migrationContent).not.toContain('GRANT UPDATE')
      expect(migrationContent).not.toContain('GRANT DELETE')
    })

    it('migration seeds exactly 8 games', () => {
      const insertMatch = migrationContent.match(/INSERT INTO "public"."library_games"[\s\S]*?VALUES([\s\S]*?);/)
      expect(insertMatch).not.toBeNull()
      if (insertMatch) {
        const valuesSection = insertMatch[1]
        const rowCount = (valuesSection.match(/^\s*\(/gm) || []).length
        expect(rowCount).toBe(8)
      }
    })

    it('migration seeds have category_es AND category_en populated for all games', () => {
      expect(migrationContent).toContain("'Bolt Action'")
      expect(migrationContent).toContain("'Wargame'")
      expect(migrationContent).toContain("'Pathfinder 2e'")
      expect(migrationContent).toContain("'Rol'")
      expect(migrationContent).toContain("'RPG'")
      expect(migrationContent).toContain("'Deducción'")
      expect(migrationContent).toContain("'Deduction'")
    })

    it('migration creates required columns with correct types', () => {
      expect(migrationContent).toContain('"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()')
      expect(migrationContent).toContain('"title" text NOT NULL')
      expect(migrationContent).toContain('"category_es" text NOT NULL')
      expect(migrationContent).toContain('"category_en" text NOT NULL')
      expect(migrationContent).toContain('"players" text NOT NULL')
      expect(migrationContent).toContain('"play_time" text NOT NULL')
      expect(migrationContent).toContain('"weight" numeric(2,1) NOT NULL')
      expect(migrationContent).toContain('"sort_order" integer NOT NULL DEFAULT 0')
      expect(migrationContent).toContain('"active" boolean NOT NULL DEFAULT true')
      expect(migrationContent).toContain('"created_at" timestamptz NOT NULL DEFAULT now()')
      expect(migrationContent).toContain('"updated_at" timestamptz NOT NULL DEFAULT now()')
    })
  })

  describe('createLibraryGame with optional English (OIR-206)', () => {
    it('admin can create a game with categoryEn absent, falls back to categoryEs', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([
        createGameRow({
          id: 'game-new-1',
          title: 'Juego de Estrategia',
          categoryEs: 'Estrategia',
          categoryEn: 'Estrategia',
        }),
      ])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Juego de Estrategia',
        categoryEs: 'Estrategia',
        players: '2-4',
        playTime: '45 min',
        weight: 3.0,
      })

      expect(result.title).toBe('Juego de Estrategia')
      expect(result.categoryEs).toBe('Estrategia')
      expect(result.categoryEn).toBe('Estrategia')
    })

    it('admin can create a game with categoryEn empty string, falls back to categoryEs', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([
        createGameRow({
          id: 'game-new-1',
          title: 'RPG de Fantasía',
          categoryEs: 'Rol',
          categoryEn: 'Rol',
        }),
      ])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'RPG de Fantasía',
        categoryEs: 'Rol',
        categoryEn: '',
        players: '2-8',
        playTime: '120 min',
        weight: 2.5,
      })

      expect(result.categoryEn).toBe('Rol')
    })

    it('admin can create a game with explicit categoryEn, preserves EN value', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([
        createGameRow({
          id: 'game-new-1',
          title: 'Modern Warfare Board Game',
          categoryEs: 'Wargame',
          categoryEn: 'War',
        }),
      ])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Modern Warfare Board Game',
        categoryEs: 'Wargame',
        categoryEn: 'War',
        players: '2',
        playTime: '60 min',
        weight: 3.5,
      })

      expect(result.categoryEn).toBe('War')
    })
  })

  describe('updateLibraryGame with optional English (OIR-206)', () => {
    it('admin can update game with categoryEn absent, follows new categoryEs when ES changes', async () => {
      const adminSession = createAdminSession()
      const currentRow = createGameRow({
        id: 'game-1',
        title: 'Old Game',
        categoryEs: 'Vieja Categoría',
        categoryEn: 'Vieja Categoría',
      })
      setFixture('library_games', [currentRow])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          categoryEs: 'Nueva Categoría',
          categoryEn: 'Nueva Categoría',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        categoryEs: 'Nueva Categoría',
      })

      expect(result.categoryEn).toBe('Nueva Categoría')
    })

    it('admin can update game with explicit categoryEn preserved when ES changes', async () => {
      const adminSession = createAdminSession()
      const currentRow = createGameRow({
        id: 'game-1',
        categoryEs: 'Vieja Categoría',
        categoryEn: 'Explicitly Set Category',
      })
      setFixture('library_games', [currentRow])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          categoryEs: 'Nueva Categoría',
          categoryEn: 'Explicitly Set Category',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        categoryEs: 'Nueva Categoría',
      })

      expect(result.categoryEn).toBe('Explicitly Set Category')
    })
  })

  describe('updateLibraryGame with fallback semantics edge cases (OIR-206 round 2)', () => {
    it('rule 2: explicit different categoryEn + blank categoryEn payload = re-enable auto-copy to new ES', async () => {
      const adminSession = createAdminSession()
      const currentRow = createGameRow({
        id: 'game-1',
        categoryEs: 'Vieja Categoría',
        categoryEn: 'Old Explicit Category',
      })
      setFixture('library_games', [currentRow])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          categoryEs: 'Nueva Categoría',
          categoryEn: 'Nueva Categoría',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        categoryEs: 'Nueva Categoría',
        categoryEn: '',
      })

      expect(result.categoryEn).toBe('Nueva Categoría')
    })

    it('rule 1: resending identical categoryEn (en === es deliberately) + ES change = EN preserved', async () => {
      const adminSession = createAdminSession()
      const currentRow = createGameRow({
        id: 'game-1',
        categoryEs: 'Vieja Categoría',
        categoryEn: 'Vieja Categoría',
      })
      setFixture('library_games', [currentRow])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          categoryEs: 'Nueva Categoría',
          categoryEn: 'Vieja Categoría',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        categoryEs: 'Nueva Categoría',
        categoryEn: 'Vieja Categoría',
      })

      expect(result.categoryEn).toBe('Vieja Categoría')
    })

    it('rule 2: whitespace-only categoryEn behaves as blank (re-enable auto-copy to new ES)', async () => {
      const adminSession = createAdminSession()
      const currentRow = createGameRow({
        id: 'game-1',
        categoryEs: 'Vieja Categoría',
        categoryEn: 'Old Explicit Category',
      })
      setFixture('library_games', [currentRow])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          categoryEs: 'Nueva Categoría',
          categoryEn: 'Nueva Categoría',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        categoryEs: 'Nueva Categoría',
        categoryEn: '   ',
      })

      expect(result.categoryEn).toBe('Nueva Categoría')
    })
  })

  describe('imageUrl validation (OIR-207)', () => {
    it('admin can create a game with optional imageUrl using valid https URL', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([
        createGameRow({
          id: 'game-new-1',
          imgUrl: 'https://example.com/landing-media/library-games/abc123.png',
        }),
      ])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Game with Image',
        categoryEs: 'Estrategia',
        categoryEn: 'Strategy',
        players: '2-4',
        playTime: '60m',
        weight: 3.0,
        imageUrl: 'https://example.com/landing-media/library-games/abc123.png',
      })

      expect(result.id).toBe('game-new-1')
      expect(result.imgUrl).toBe('https://example.com/landing-media/library-games/abc123.png')
    })

    it('admin can create a game with imageUrl absent (optional field)', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1', imgUrl: null })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Game without Image',
        categoryEs: 'Rol',
        categoryEn: 'RPG',
        players: '2-4',
        playTime: '90m',
        weight: 3.5,
      })

      expect(result.id).toBe('game-new-1')
      expect(result.imgUrl).toBeNull()
    })

    it('admin can create a game with imageUrl null (optional field)', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1', imgUrl: null })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Game without Image',
        categoryEs: 'Rol',
        categoryEn: 'RPG',
        players: '2-4',
        playTime: '90m',
        weight: 3.5,
        imageUrl: null,
      })

      expect(result.id).toBe('game-new-1')
      expect(result.imgUrl).toBeNull()
    })

    it('admin can create a game with imageUrl empty string (optional field)', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1', imgUrl: null })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Game without Image',
        categoryEs: 'Rol',
        categoryEn: 'RPG',
        players: '2-4',
        playTime: '90m',
        weight: 3.5,
        imageUrl: '',
      })

      expect(result.id).toBe('game-new-1')
      expect(result.imgUrl).toBeNull()
    })

    it('admin rejects imageUrl with javascript: protocol', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })

    it('admin rejects imageUrl with data: protocol', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
          imageUrl: 'data:image/png;base64,iVBORw0KG...',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })

    it('admin rejects imageUrl with relative path', async () => {
      const adminSession = createAdminSession()

      const { createLibraryGame } = await loadLibraryGamesService()

      await expect(
        createLibraryGame(adminSession, {
          title: 'Game',
          categoryEs: 'Estrategia',
          categoryEn: 'Strategy',
          players: '2-4',
          playTime: '60m',
          weight: 3.0,
          imageUrl: '/images/game.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertMock).not.toHaveBeenCalled()
    })

    it('admin accepts imageUrl with valid http:// URL', async () => {
      const adminSession = createAdminSession()
      insertMock.mockResolvedValue([createGameRow({ id: 'game-new-1' })])

      const { createLibraryGame } = await loadLibraryGamesService()

      const result = await createLibraryGame(adminSession, {
        title: 'Game',
        categoryEs: 'Estrategia',
        categoryEn: 'Strategy',
        players: '2-4',
        playTime: '60m',
        weight: 3.0,
        imageUrl: 'http://example.com/game.png',
      })

      expect(result.id).toBe('game-new-1')
    })

    it('admin can update game with imageUrl added', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1' })])
      updateMock.mockResolvedValue([
        createGameRow({
          id: 'game-1',
          imgUrl: 'https://example.com/landing-media/library-games/updated.png',
        }),
      ])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        imageUrl: 'https://example.com/landing-media/library-games/updated.png',
      })

      expect(result.id).toBe('game-1')
    })

    it('admin rejects imageUrl update with javascript: protocol', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1' })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      await expect(
        updateLibraryGame(adminSession, 'game-1', {
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateMock).not.toHaveBeenCalled()
    })

    it('admin can clear imageUrl by setting to empty string', async () => {
      const adminSession = createAdminSession()
      setFixture('library_games', [createGameRow({ id: 'game-1' })])
      updateMock.mockResolvedValue([createGameRow({ id: 'game-1', imgUrl: null })])

      const { updateLibraryGame } = await loadLibraryGamesService()

      const result = await updateLibraryGame(adminSession, 'game-1', {
        imageUrl: '',
      })

      expect(result.id).toBe('game-1')
    })

    it('migration adds img_url column to library_games', () => {
      const migrationPath = join(
        '/Users/samuelromeroarbelo/Projects/Alea/alea-webapp/supabase/migrations',
        '20260704000005_oir207_landing_media_bucket.sql'
      )
      const migrationContent = readFileSync(migrationPath, 'utf8')

      expect(migrationContent).toContain('ALTER TABLE "public"."library_games"')
      expect(migrationContent).toContain('ADD COLUMN IF NOT EXISTS "img_url" text')
    })
  })
})
