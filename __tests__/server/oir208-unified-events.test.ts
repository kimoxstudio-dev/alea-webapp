// @vitest-environment node
/**
 * OIR-208: Unified Events Coverage Tests
 *
 * Validates:
 * 1. Availability table-granularity: blocks with table_id only affect that table
 * 2. Visibility toggle: visibleOnLanding flag behavior
 * 3. Materials validation: quantity > 0, valid shape
 * 4. RPC payload: tableId inclusion and blocksMatchSchedules comparison
 * 5. Migration sanity: static checks on table_id FK, event_equipment constraints
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { createSqlMock, hasExactSelectColumns, whereColumnHasOperator, whereConditionCount, whereHasColumn } from '../helpers/sql-mock'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/server/database-time', () => ({
  getDatabaseNow: vi.fn(async () => new Date('2026-04-15T12:00:00.000Z')),
}))
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerAdminClient: vi.fn(),
  createSupabaseServerClient: vi.fn(),
}))

// rooms-service.ts (#302) and tables-service.ts (#333) use the raw-SQL `sql`
// export. Availability tests below register strict handlers here; unmatched
// statements fail loudly instead of attempting a real Neon connection.
const roomsSqlMock = createSqlMock()
vi.mock('@/lib/db/client', () => ({
  sql: roomsSqlMock.sql,
}))
// Keeps the REAL `ServiceError` class (via importActual) alongside a mocked
// `serviceError` factory function — club-events-service.ts's error-mapping
// paths do `error instanceof ServiceError` at runtime, so a mock that only
// stubs `serviceError` and omits the `ServiceError` export makes that
// instanceof check throw a Vitest "no export defined" error instead of the
// intended 400/500 branching.
vi.mock('@/lib/server/service-error', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/service-error')>('@/lib/server/service-error')
  return {
    ServiceError: actual.ServiceError,
    serviceError: vi.fn((message: string, statusCode: number) => {
      throw new actual.ServiceError(message, statusCode)
    }),
  }
})
vi.mock('@/lib/club-time', () => ({
  getCurrentClubDate: vi.fn(() => '2026-04-15'),
  isValidDateOnlyString: vi.fn((s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
}))

type EventRow = {
  id: string
  title: string
  title_es: string | null
  title_en: string | null
  blurb_es: string | null
  blurb_en: string | null
  description_es: string | null
  description_en: string | null
  category_es: string | null
  category_en: string | null
  date_kind: string | null
  date: string
  end_date: string | null
  recurrence_label_es: string | null
  recurrence_label_en: string | null
  image_url: string | null
  link_url: string | null
  created_by: string | null
  created_at: string
}

type EventRoomBlockRow = {
  id: string
  event_id: string
  room_id: string
  table_id: string | null
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}

type SessionUser = {
  id: string
  role: 'admin' | 'member'
}

function createAdminSession(): SessionUser {
  return { id: 'user-admin-1', role: 'admin' }
}

// OIR-208: fixed table -> room ownership used to simulate the migration's
// room_id/table_id consistency guard (mirrored by addTablesHandler's
// roomTableIds below, since #304 replaced the RPC with plain sequential SQL).
const TABLE_ROOM_MAP: Record<string, string> = {
  'table-1': 'room-1',
  'table-2': 'room-2',
}

// ---------------------------------------------------------------------------
// club-events-service.ts (#304) raw-SQL Neon handler factories — shared with
// club-events-service.test.ts's pattern. Registered against `roomsSqlMock`
// (the file's single shared `sql` mock, reset in the top-level beforeEach).
// ---------------------------------------------------------------------------

const ADMIN_RETURNING_COLUMNS =
  'id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url, category_es, category_en'

const ROOM_BLOCK_COLUMNS = 'id, event_id, room_id, table_id, date, start_time, end_time, all_day'

function currentEventRowFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title_es: 'Evento',
    title_en: 'Event',
    blurb_es: null,
    blurb_en: null,
    description_es: null,
    description_en: null,
    category_es: null,
    category_en: null,
    date_kind: 'single',
    date: '2026-04-20',
    end_date: null,
    recurrence_label_es: null,
    recurrence_label_en: null,
    image_url: null,
    link_url: null,
    ...overrides,
  }
}

/** INSERT INTO events (...20 cols...) RETURNING <admin columns> — createClubEvent */
function addCreateInsertHandler(id = 'evt-new-1') {
  roomsSqlMock.addHandler({
    name: 'INSERT events (createClubEvent)',
    verb: 'insert',
    match: (stmt) => stmt.table === 'events' && stmt.returning && stmt.values.length === 20,
    respond: (stmt) => {
      const [
        title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        category_es, category_en, date_kind, date, end_date,
        recurrence_label_es, recurrence_label_en, image_url, link_url,
      ] = stmt.values
      return [{
        id, title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        category_es, category_en, date_kind, date, end_date,
        recurrence_label_es, recurrence_label_en, image_url, link_url,
      }]
    },
  })
}

/** SELECT <admin columns> FROM events WHERE id=$1 LIMIT 1 — updateClubEvent's currentRows fetch */
function addCurrentEventSelectHandler(row: Record<string, unknown> | null) {
  roomsSqlMock.addHandler({
    name: 'SELECT current event row (updateClubEvent)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'events' && hasExactSelectColumns(stmt, ADMIN_RETURNING_COLUMNS) && Boolean(stmt.whereClause),
    respond: () => (row ? [row] : []),
  })
}

/** UPDATE events SET ... WHERE id=$N RETURNING <admin columns> — updateClubEvent field write */
function addUpdateEventHandler(respond: (values: unknown[]) => unknown) {
  roomsSqlMock.addHandler({
    name: 'UPDATE events (field write, RETURNING)',
    verb: 'update',
    match: (stmt) => stmt.table === 'events' && stmt.returning,
    respond: (stmt) => respond(stmt.values),
  })
}

/** SELECT id FROM rooms WHERE id = ANY(...) — validateRoomsExist */
function addRoomsExistHandler(missing: string[] = []) {
  roomsSqlMock.addHandler({
    name: 'SELECT id FROM rooms WHERE id = ANY(...)',
    verb: 'select',
    match: (stmt) => stmt.table === 'rooms',
    respond: (stmt) => {
      const ids = stmt.values[0] as string[]
      return ids.filter((id) => !missing.includes(id)).map((id) => ({ id }))
    },
  })
}

/**
 * Handles both "tables" SELECT shapes club-events-service.ts issues (#354
 * folded the old per-block `id = $1 AND room_id = $2` mismatch guard and the
 * single-room `room_id = $1` fetchTableIdsForRoom lookup into one batched
 * query, so only two shapes remain):
 * - `SELECT id FROM tables WHERE id = ANY(...)` (validateTablesExist)
 * - `SELECT id, room_id FROM tables WHERE room_id = ANY(...)` (batched
 *   room->table lookup: builds both `roomTableMap` for null-table_id blocks
 *   AND `tableRoomMap` for the table_id/room_id mismatch guard, so it must
 *   return `room_id` on every row — an `{ id }`-only row silently breaks the
 *   mismatch guard for non-null-table_id blocks).
 * These two shapes select different, non-overlapping column lists (`id` vs
 * `id, room_id`), so they're distinguished by exact SELECT projection
 * (`hasExactSelectColumns`) rather than by a shared `any(` substring check,
 * which would conflate them since both queries use `= ANY(...)`.
 * Defaults `roomTableIds` to TABLE_ROOM_MAP inverted, matching this file's
 * fixed table->room ownership convention.
 */
function addTablesHandler(opts: { missingTableIds?: string[]; roomTableIds?: Record<string, string[]> } = {}) {
  const { missingTableIds = [] } = opts
  const roomTableIds = opts.roomTableIds ?? Object.entries(TABLE_ROOM_MAP).reduce<Record<string, string[]>>(
    (acc, [tableId, roomId]) => {
      acc[roomId] = [...(acc[roomId] ?? []), tableId]
      return acc
    },
    {},
  )
  roomsSqlMock.addHandler({
    name: 'SELECT id FROM tables WHERE id = ANY(...) (validateTablesExist)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id') && whereHasColumn(stmt, 'id'),
    respond: (stmt) => {
      const ids = stmt.values[0] as string[]
      return ids.filter((id) => !missingTableIds.includes(id)).map((id) => ({ id }))
    },
  })
  roomsSqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (batched room->table lookup)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id') && whereHasColumn(stmt, 'room_id'),
    respond: (stmt) => {
      const roomIds = stmt.values[0] as string[]
      return roomIds.flatMap((roomId) => (roomTableIds[roomId] ?? []).map((id) => ({ id, room_id: roomId })))
    },
  })
}

/** SELECT id FROM equipment WHERE id = ANY(...) — validateEquipmentExists */
function addEquipmentExistsHandler(missing: string[] = []) {
  roomsSqlMock.addHandler({
    name: 'SELECT id FROM equipment WHERE id = ANY(...)',
    verb: 'select',
    match: (stmt) => stmt.table === 'equipment' && stmt.selectColumns === 'id',
    respond: (stmt) => {
      const ids = stmt.values[0] as string[]
      return ids.filter((id) => !missing.includes(id)).map((id) => ({ id }))
    },
  })
}

/** SELECT id FROM events WHERE id=$1 LIMIT 1 — applyClubEventBlocksAndMaterials existence check */
function addEventExistsHandler(exists = true) {
  roomsSqlMock.addHandler({
    name: 'SELECT id FROM events (applyClubEventBlocksAndMaterials existence)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, 'id'),
    respond: () => (exists ? [{ id: 'evt-1' }] : []),
  })
}

/** DELETE FROM event_room_blocks WHERE event_id=$1 RETURNING ... */
function addBlocksDeleteHandler(existingBlocks: unknown[] = []) {
  roomsSqlMock.addHandler({
    name: 'DELETE event_room_blocks WHERE event_id (RETURNING)',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_room_blocks',
    respond: () => existingBlocks,
  })
}

/** DELETE FROM event_equipment WHERE event_id=$1 RETURNING ... */
function addMaterialsDeleteHandler(existingMaterials: unknown[] = []) {
  roomsSqlMock.addHandler({
    name: 'DELETE event_equipment WHERE event_id (RETURNING)',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_equipment',
    respond: () => existingMaterials,
  })
}

/** INSERT INTO event_room_blocks (...) RETURNING ... */
function addBlockInsertHandler(idPrefix = 'block', spy?: (values: unknown[]) => void) {
  let counter = 0
  roomsSqlMock.addHandler({
    name: 'INSERT event_room_blocks RETURNING',
    verb: 'insert',
    match: (stmt) => stmt.table === 'event_room_blocks' && stmt.returning,
    respond: (stmt) => {
      counter += 1
      spy?.(stmt.values)
      const [event_id, room_id, table_id, date, start_time, end_time, all_day] = stmt.values
      return [{ id: `${idPrefix}-${counter}`, event_id, room_id, table_id, date, start_time, end_time, all_day }]
    },
  })
}

/** UPDATE reservations SET status='cancelled' FROM (...) WHERE ... RETURNING reservations.id, prior.status */
function addReservationsCancelHandler(respond: () => unknown = () => []) {
  roomsSqlMock.addHandler({
    name: 'UPDATE reservations cancel overlapping (club events)',
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
    respond,
  })
}

/** INSERT INTO event_equipment (...) ON CONFLICT (event_id, equipment_id) DO UPDATE */
function addMaterialsInsertHandler(spy?: (values: unknown[]) => void) {
  roomsSqlMock.addHandler({
    name: 'INSERT event_equipment ON CONFLICT DO UPDATE',
    verb: 'insert',
    match: (stmt) => stmt.table === 'event_equipment',
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
  })
}

/** SELECT <full block columns> FROM event_room_blocks WHERE event_id=$1 [ORDER BY ...] — resultBlocks / fetchEventRoomBlocks */
function addEventRoomBlocksSelectHandler(blocks: unknown[] = []) {
  roomsSqlMock.addHandler({
    name: 'SELECT event_room_blocks WHERE event_id (result/fetch)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS),
    respond: () => blocks,
  })
}

/** SELECT ee.event_id, ee.equipment_id, ee.quantity, eq.name FROM event_equipment ee JOIN equipment eq ... — fetchEventMaterials(ForMany) */
function addEventMaterialsSelectHandler(materials: unknown[] = []) {
  roomsSqlMock.addHandler({
    name: 'SELECT event_equipment JOIN equipment (materials)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_equipment',
    respond: () => materials,
  })
}

function buildSupabaseMock() {
  const state: any = {}
  return {
    from: vi.fn(function (table: string) {
      if (table === 'events') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  id: 'evt-1',
                  title: 'Test Event',
                  title_es: 'Evento Prueba',
                  title_en: 'Test Event',
                  blurb_es: null,
                  blurb_en: null,
                  description_es: null,
                  description_en: null,
                  category_es: null,
                  category_en: null,
                  date_kind: 'single',
                  date: '2026-04-20',
                  end_date: null,
                  recurrence_label_es: null,
                  recurrence_label_en: null,
                  image_url: null,
                  link_url: null,
                  created_by: 'user-1',
                  created_at: '2026-04-01T00:00:00Z',
                } as EventRow,
                error: null,
              })),
            })),
          })),
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: { id: 'evt-new-1' } as EventRow,
                error: null,
              })),
            })),
          })),
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              select: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: state.updateResult || ({} as EventRow),
                  error: null,
                })),
              })),
            })),
          })),
        }
      }

      if (table === 'event_equipment') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              [Symbol.toStringTag]: 'Promise',
              then: async (cb: any) =>
                cb?.({
                  data: state.eventEquipment || [],
                  error: null,
                }),
            })),
            in: vi.fn(() => ({
              [Symbol.toStringTag]: 'Promise',
              then: async (cb: any) =>
                cb?.({
                  data: state.eventEquipmentList || [],
                  error: null,
                }),
            })),
          })),
        }
      }

      if (table === 'event_room_blocks') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              [Symbol.toStringTag]: 'Promise',
              then: async (cb: any) =>
                cb?.({
                  data: state.eventRoomBlocks || [],
                  error: null,
                }),
            })),
          })),
        }
      }

      if (table === 'rooms' || table === 'tables' || table === 'equipment') {
        // PR #149 / PR #154 review: updateClubEvent/createClubEvent validate
        // referenced room/table/equipment ids exist before writing. Default
        // to "every referenced id exists" so tests in this file that don't
        // specifically exercise that validation path keep passing unmodified.
        return {
          select: vi.fn(() => ({
            in: vi.fn(async (_col: string, vals: string[]) => ({
              data: vals.map((id) => ({ id })),
              error: null,
            })),
          })),
        }
      }

      return {}
    }),
    rpc: vi.fn(async (fn: string, params: any) => {
      if (fn === 'apply_club_event_room_blocks') {
        // Simulate RPC call: validate payload includes table_id
        if (params.p_blocks !== null && Array.isArray(params.p_blocks)) {
          for (const block of params.p_blocks) {
            if (!('room_id' in block)) {
              return { data: null, error: { code: '23502' } }
            }
            // OIR-208: table_id is optional (can be null) but must be present in payload
            if (!('table_id' in block)) {
              return { data: null, error: { code: '22P02' } }
            }
            // OIR-208 regression: the migration's apply_club_event_room_blocks
            // rejects a block whose table_id does not belong to the given
            // room_id (mirrors the RAISE EXCEPTION ... USING ERRCODE = '23514'
            // guard added to the migration).
            if (block.table_id && TABLE_ROOM_MAP[block.table_id] && TABLE_ROOM_MAP[block.table_id] !== block.room_id) {
              return { data: null, error: { code: '23514' } }
            }
          }
        }
        if (params.p_materials !== null && Array.isArray(params.p_materials)) {
          for (const mat of params.p_materials) {
            if (!('equipment_id' in mat) || !('quantity' in mat)) {
              return { data: null, error: { code: '22P02' } }
            }
            if (mat.quantity < 1) {
              return { data: null, error: { code: '23514' } }
            }
          }
        }
        return {
          data: state.rpcBlocks || [],
          error: null,
        }
      }
      return { data: null, error: null }
    }),
  }
}

describe('OIR-208: Unified Events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    roomsSqlMock.reset()
  })

  describe('Visibility Toggle (visibleOnLanding)', () => {
    it('creates event with visibleOnLanding=true writes bilingual columns', async () => {
      addCreateInsertHandler()

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Evento Prueba',
        titleEn: 'Test Event',
        date: '2026-05-01',
        dateKind: 'single',
        visibleOnLanding: true,
      })

      expect(result).toBeDefined()
      expect(result.titleEs).toBe('Evento Prueba')
      expect(result.titleEn).toBe('Test Event')
      expect(result.visibleOnLanding).toBe(true)
    })

    it('creates event with visibleOnLanding=false nulls bilingual columns', async () => {
      addCreateInsertHandler('evt-internal')

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Evento Interno',
        date: '2026-05-01',
        dateKind: 'single',
        visibleOnLanding: false,
      })

      expect(result.id).toBe('evt-internal')
      // OIR-208: toggled OFF -> title_es/title_en are nulled in the DB row —
      // isClubEventRow (title_es/title_en both non-null) correctly reports
      // this as NOT landing-visible.
      expect(result.visibleOnLanding).toBe(false)
    })
  })

  describe('Materials Validation', () => {
    it('rejects materials with quantity 0', async () => {
      const mockSupabase = buildSupabaseMock()
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabase as any,
      )

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          materials: [{ equipmentId: 'eq-1', quantity: 0 }] as any,
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects materials with negative quantity', async () => {
      const mockSupabase = buildSupabaseMock()
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabase as any,
      )

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          materials: [{ equipmentId: 'eq-1', quantity: -5 }] as any,
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects non-array materials payload', async () => {
      const mockSupabase = buildSupabaseMock()
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabase as any,
      )

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          materials: 'not-an-array' as any,
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects materials with missing equipmentId', async () => {
      const mockSupabase = buildSupabaseMock()
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabase as any,
      )

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          materials: [{ quantity: 2 }] as any,
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts materials with valid equipmentId and quantity >= 1', async () => {
      addCreateInsertHandler('evt-with-materials')
      addEquipmentExistsHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const materialsInsertSpy = vi.fn()
      addMaterialsInsertHandler(materialsInsertSpy)
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([{ event_id: 'evt-with-materials', equipment_id: 'eq-1', quantity: 2, name: 'Projector' }])

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Evento',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        materials: [{ equipmentId: 'eq-1', quantity: 2 }],
      })

      expect(result.id).toBe('evt-with-materials')
    })

    it('rejects duplicate equipment IDs in materials array', async () => {
      const mockSupabase = buildSupabaseMock()
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        mockSupabase as any,
      )

      const { createClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          materials: [
            { equipmentId: 'eq-1', quantity: 2 },
            { equipmentId: 'eq-1', quantity: 3 },
          ],
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('RPC Payload: tableId in blocks', () => {
    it('includes tableId in block payload when provided', async () => {
      addCurrentEventSelectHandler(currentEventRowFixture())
      addUpdateEventHandler(() => [currentEventRowFixture()])
      addRoomsExistHandler()
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const blockInsertSpy = vi.fn()
      addBlockInsertHandler('block', blockInsertSpy)
      addReservationsCancelHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await updateClubEvent(createAdminSession(), 'evt-1', {
        schedules: [
          {
            roomId: 'room-1',
            tableId: 'table-1',
            date: '2026-04-20',
            startTime: '14:00',
            endTime: '16:00',
          },
        ],
        blocksRooms: true,
      })

      expect(blockInsertSpy).toHaveBeenCalled()
      const [, , table_id] = blockInsertSpy.mock.calls[0][0] as unknown[]
      expect(table_id).toBe('table-1')
    })

    it('sets tableId to null in block payload when not provided', async () => {
      addCurrentEventSelectHandler(currentEventRowFixture())
      addUpdateEventHandler(() => [currentEventRowFixture()])
      addRoomsExistHandler()
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const blockInsertSpy = vi.fn()
      addBlockInsertHandler('block', blockInsertSpy)
      addReservationsCancelHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await updateClubEvent(createAdminSession(), 'evt-1', {
        schedules: [
          {
            roomId: 'room-1',
            date: '2026-04-20',
            startTime: '14:00',
            endTime: '16:00',
          },
        ],
        blocksRooms: true,
      })

      expect(blockInsertSpy).toHaveBeenCalled()
      const [, , table_id] = blockInsertSpy.mock.calls[0][0] as unknown[]
      expect(table_id).toBeNull()
    })

    it('rejects a block whose table_id does not belong to room_id (mismatched room/table payload)', async () => {
      addCurrentEventSelectHandler(currentEventRowFixture())
      addUpdateEventHandler(() => [currentEventRowFixture()])
      addRoomsExistHandler()
      // table-1 belongs to room-1 only (default TABLE_ROOM_MAP mapping) —
      // pairing it with room-2 simulates an admin payload where the table
      // selection doesn't match the selected room. Both `id = ANY(...)`
      // existence checks pass (table-1 exists); the mismatch surfaces later,
      // inside applyClubEventBlocksAndMaterials's per-block room/table guard.
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addEventRoomBlocksSelectHandler([])
      // Best-effort compensating revert after the mismatch is detected.
      roomsSqlMock.addHandler({
        name: 'UPDATE events (compensating revert, no RETURNING)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events' && !stmt.returning,
        respond: () => [],
      })

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          schedules: [
            {
              roomId: 'room-2',
              tableId: 'table-1',
              date: '2026-04-20',
              startTime: '14:00',
              endTime: '16:00',
            },
          ],
          blocksRooms: true,
        }),
      ).rejects.toMatchObject({ statusCode: 400 })
    })
  })

  describe('blocksMatchSchedules includes tableId comparison', () => {
    // blocksMatchSchedules() is not exported — exercised indirectly through
    // updateClubEvent()'s "Finding 4" optimisation: when the incoming
    // schedules are identical to what's already stored, the block-replace
    // step (DELETE + re-INSERT event_room_blocks) is skipped entirely
    // (blocksParam stays null). If the comparison ignored tableId, a
    // tableId-only change would be wrongly treated as "unchanged" and the
    // replace would never fire.
    function setUpUpdateEventMock(currentBlocks: EventRoomBlockRow[]) {
      addCurrentEventSelectHandler(currentEventRowFixture())
      addUpdateEventHandler(() => [currentEventRowFixture()])
      addRoomsExistHandler()
      // Extend the default TABLE_ROOM_MAP-derived mapping with 'table-3' (an
      // id not in TABLE_ROOM_MAP in this file's convention) under room-1, so
      // the table/room mismatch guard doesn't interfere with these tests.
      addTablesHandler({ roomTableIds: { 'room-1': ['table-1', 'table-3'], 'room-2': ['table-2'] } })
      addEventExistsHandler(true)
      roomsSqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (comparison fetch, fixed response)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS),
        respond: () => currentBlocks,
      })
      const blockInsertSpy = vi.fn()
      addBlockInsertHandler('block-new', blockInsertSpy)
      addBlocksDeleteHandler(currentBlocks)
      addMaterialsDeleteHandler([])
      addReservationsCancelHandler()
      addEventMaterialsSelectHandler([])
      return { blockInsertSpy }
    }

    it('treats a schedule as unchanged when its tableId matches the stored block (replace step skipped)', async () => {
      const currentBlocks: EventRoomBlockRow[] = [
        {
          id: 'blk-1',
          event_id: 'evt-1',
          room_id: 'room-1',
          table_id: 'table-1',
          date: '2026-04-20',
          start_time: '14:00:00',
          end_time: '16:00:00',
          all_day: false,
        },
      ]
      const { blockInsertSpy } = setUpUpdateEventMock(currentBlocks)

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await updateClubEvent(createAdminSession(), 'evt-1', {
        schedules: [
          {
            roomId: 'room-1',
            tableId: 'table-1',
            date: '2026-04-20',
            startTime: '14:00',
            endTime: '16:00',
          },
        ],
        blocksRooms: true,
      })

      // Same room/table/date/time as the stored block -> blocksMatchSchedules
      // must recognise them as unchanged and skip the replace step entirely.
      expect(blockInsertSpy).not.toHaveBeenCalled()
    })

    it('detects difference when tableId changes between the stored block and incoming schedule', async () => {
      const currentBlocks: EventRoomBlockRow[] = [
        {
          id: 'blk-1',
          event_id: 'evt-1',
          room_id: 'room-1',
          table_id: 'table-1',
          date: '2026-04-20',
          start_time: '14:00:00',
          end_time: '16:00:00',
          all_day: false,
        },
      ]
      const { blockInsertSpy } = setUpUpdateEventMock(currentBlocks)

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await updateClubEvent(createAdminSession(), 'evt-1', {
        schedules: [
          {
            // Same room/date/time as the stored block, but a different table_id.
            roomId: 'room-1',
            tableId: 'table-3',
            date: '2026-04-20',
            startTime: '14:00',
            endTime: '16:00',
          },
        ],
        blocksRooms: true,
      })

      expect(blockInsertSpy).toHaveBeenCalled()
      const [, , table_id] = blockInsertSpy.mock.calls[0][0] as unknown[]
      expect(table_id).toBe('table-3')
    })

    it('detects difference when table_id differs (room-level block vs. table-scoped schedule)', async () => {
      const currentBlocks: EventRoomBlockRow[] = [
        {
          id: 'blk-1',
          event_id: 'evt-1',
          room_id: 'room-1',
          table_id: null,
          date: '2026-04-20',
          start_time: '14:00:00',
          end_time: '16:00:00',
          all_day: false,
        },
      ]
      const { blockInsertSpy } = setUpUpdateEventMock(currentBlocks)

      const { updateClubEvent } = await import('@/lib/server/club-events-service')

      await updateClubEvent(createAdminSession(), 'evt-1', {
        schedules: [
          {
            roomId: 'room-1',
            tableId: 'table-3',
            date: '2026-04-20',
            startTime: '14:00',
            endTime: '16:00',
          },
        ],
        blocksRooms: true,
      })

      // Stored block was room-level (table_id null); incoming schedule scopes
      // it to a table -> must be treated as a real change, not a no-op.
      expect(blockInsertSpy).toHaveBeenCalled()
    })
  })

  describe('Migration Sanity: table_id FK and event_equipment constraints', () => {
    const migrationPath = join(
      process.cwd(),
      'supabase/migrations',
      '20260704000006_oir208_table_blocks_and_materials.sql',
    )
    const migrationContent = readFileSync(migrationPath, 'utf8')

    it('verifies event_room_blocks.table_id column exists with FK constraint', () => {
      expect(migrationContent).toContain(
        'ADD COLUMN IF NOT EXISTS "table_id" uuid REFERENCES "public"."tables"("id") ON DELETE CASCADE',
      )
      // Same migration also guards against a table_id/room_id mismatch at
      // the RPC level (independent FKs alone can't enforce that pairing).
      expect(migrationContent).toContain("USING ERRCODE = '23514'")
      expect(migrationContent).toContain('table_id % does not belong to room_id %')
    })

    it('verifies event_equipment table has CHECK quantity > 0', () => {
      expect(migrationContent).toContain('CREATE TABLE IF NOT EXISTS "public"."event_equipment"')
      expect(migrationContent).toContain('"quantity" integer NOT NULL DEFAULT 1 CHECK ("quantity" > 0)')
    })

    it('verifies event_equipment RLS is enabled (service_role only)', () => {
      expect(migrationContent).toContain('ALTER TABLE "public"."event_equipment" ENABLE ROW LEVEL SECURITY')
      expect(migrationContent).toContain('GRANT ALL ON TABLE "public"."event_equipment" TO "service_role"')
      // No anon/authenticated policy or grant should exist for this table.
      expect(migrationContent).not.toMatch(/CREATE POLICY[^;]*"public"\."event_equipment"/)
      expect(migrationContent).not.toContain('GRANT ALL ON TABLE "public"."event_equipment" TO "anon"')
      expect(migrationContent).not.toContain('GRANT ALL ON TABLE "public"."event_equipment" TO "authenticated"')
    })

    it('verifies apply_club_event_room_blocks RPC accepts 3 args', () => {
      // The 2-arg overload is explicitly dropped so CREATE OR REPLACE defines
      // a single unambiguous 3-arg function.
      expect(migrationContent).toContain(
        'DROP FUNCTION IF EXISTS "public"."apply_club_event_room_blocks"(uuid, jsonb);',
      )
      expect(migrationContent).toContain('"p_event_id"  uuid,')
      expect(migrationContent).toContain('"p_blocks"    jsonb,')
      expect(migrationContent).toContain('"p_materials" jsonb DEFAULT NULL')
      // Grants/revokes target the 3-arg signature specifically.
      expect(migrationContent).toContain(
        'GRANT EXECUTE ON FUNCTION "public"."apply_club_event_room_blocks"(uuid, jsonb, jsonb) TO "service_role"',
      )
    })

    it('verifies RPC uses SECURITY DEFINER with pinned search_path', () => {
      expect(migrationContent).toContain('SECURITY DEFINER')
      expect(migrationContent).toContain("SET search_path TO 'public', 'pg_catalog'")
    })
  })

  describe('Availability table-granularity (highest-risk)', () => {
    // Shared query-chain stub: every method (eq/in/lt/gt/etc.) returns the
    // same thenable object so callers can `await` at whatever point their
    // real query chain happens to end — the different service files under
    // test (tables-service.ts, rooms-service.ts, reservations-service.ts,
    // saved-games-service.ts) all build slightly different chains.
    function chainThen(result: { data: unknown; error: unknown }) {
      const chain: any = {
        eq: () => chain,
        neq: () => chain,
        in: () => chain,
        lt: () => chain,
        gt: () => chain,
        lte: () => chain,
        gte: () => chain,
        is: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => result,
        single: async () => result,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      }
      return chain
    }

    function mockDatabaseNowRpc() {
      return vi.fn(async (fn: string) => (
        fn === 'get_database_time'
          ? { data: '2026-04-20T10:00:00.000Z', error: null }
          : { data: null, error: null }
      ))
    }

    type MockTable = { id: string; room_id: string; type: string }

    function setupTableAvailabilitySqlMock(
      tablesById: Record<string, MockTable>,
      eventBlocks: Array<Record<string, unknown>>,
    ) {
      roomsSqlMock.reset()
      roomsSqlMock.addHandler({
        name: 'SELECT table by id',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'id', '='),
        respond: (stmt) => {
          const table = tablesById[String(stmt.values[0])]
          return table ? [{
            ...table,
            name: table.id,
            qr_code: null,
            qr_code_inf: null,
            pos_x: null,
            pos_y: null,
          }] : []
        },
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservations for table/date',
        verb: 'select',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT event blocks for room/date',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'room_id'),
        respond: () => eventBlocks,
      })
      roomsSqlMock.addHandler({
        name: 'SELECT active saved game for table/date',
        verb: 'select',
        match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT event titles by ids',
        verb: 'select',
        match: (stmt) => stmt.table === 'events' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })
    }

    const ROOM = 'room-shared'
    const TABLES: Record<string, MockTable> = {
      'table-A': { id: 'table-A', room_id: ROOM, type: 'small' },
      'table-B': { id: 'table-B', room_id: ROOM, type: 'small' },
    }

    it('getTableAvailability: block with table_id affects only that table', async () => {
      const eventBlocks = [{
        id: 'blk-1', event_id: 'evt-1', room_id: ROOM, table_id: 'table-A',
        date: '2026-04-20', start_time: '14:00:00', end_time: '16:00:00', all_day: false,
      }]
      setupTableAvailabilitySqlMock(TABLES, eventBlocks)

      const { getTableAvailability } = await import('@/lib/server/tables-service')

      const blockedTable = await getTableAvailability('table-A', '2026-04-20')
      const blockedSlot = blockedTable.slots.find((slot) => slot.startTime === '14:00')
      expect(blockedSlot?.available).toBe(false)
      expect(blockedSlot?.source).toBe('event')

      const siblingTable = await getTableAvailability('table-B', '2026-04-20')
      const siblingSlot = siblingTable.slots.find((slot) => slot.startTime === '14:00')
      expect(siblingSlot?.available).toBe(true)
    })

    it('getTableAvailability: block with null table_id affects all room tables', async () => {
      const eventBlocks = [{
        id: 'blk-2', event_id: 'evt-1', room_id: ROOM, table_id: null,
        date: '2026-04-20', start_time: '14:00:00', end_time: '16:00:00', all_day: false,
      }]
      setupTableAvailabilitySqlMock(TABLES, eventBlocks)

      const { getTableAvailability } = await import('@/lib/server/tables-service')

      const tableA = await getTableAvailability('table-A', '2026-04-20')
      const tableB = await getTableAvailability('table-B', '2026-04-20')
      expect(tableA.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(false)
      expect(tableB.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(false)
    })

    // rooms-service.ts (#302) queries raw SQL, not Supabase — register
    // handlers on `roomsSqlMock` mirroring the same table/event-block
    // fixtures the Supabase-mock helpers above use, so these two tests
    // exercise the same table-vs-room block scoping behavior through the
    // migrated implementation.
    function setupRoomsSqlMock(tablesById: Record<string, MockTable>, eventBlocks: Array<Record<string, unknown>>) {
      roomsSqlMock.reset()
      roomsSqlMock.addHandler({
        name: 'SELECT tables by room_id',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'room_id', '=') && whereConditionCount(stmt) === 1,
        respond: (stmt) => {
          const roomId = stmt.values[0]
          return Object.values(tablesById)
            .filter((t) => t.room_id === roomId)
            .map((t) => ({
              id: t.id,
              room_id: t.room_id,
              name: t.id,
              type: t.type,
              qr_code: null,
              qr_code_inf: null,
              pos_x: null,
              pos_y: null,
            }))
        },
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservations for tables/date',
        verb: 'select',
        match: (stmt) => stmt.table === 'reservations' && whereColumnHasOperator(stmt, 'date', '=') && whereHasColumn(stmt, 'table_id'),
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT event_room_blocks for room/date',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereColumnHasOperator(stmt, 'room_id', '=') && whereColumnHasOperator(stmt, 'date', '='),
        respond: () => eventBlocks,
      })
      roomsSqlMock.addHandler({
        name: 'SELECT saved_games active/table-scoped',
        verb: 'select',
        match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT events by id',
        verb: 'select',
        match: (stmt) => stmt.table === 'events' && whereHasColumn(stmt, 'id'),
        respond: () => [],
      })
    }

    it('getRoomTablesAvailability respects table-level blocks', async () => {
      const eventBlocks = [{
        id: 'blk-3', event_id: 'evt-1', room_id: ROOM, table_id: 'table-A',
        date: '2026-04-20', start_time: '14:00:00', end_time: '16:00:00', all_day: false,
      }]
      setupRoomsSqlMock(TABLES, eventBlocks)

      const { getRoomTablesAvailability } = await import('@/lib/server/rooms-service')

      const result = await getRoomTablesAvailability(ROOM, '2026-04-20')
      expect(result['table-A']?.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(false)
      expect(result['table-B']?.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(true)
    })

    it('getRoomTablesAvailability room-level block blocks all tables', async () => {
      const eventBlocks = [{
        id: 'blk-4', event_id: 'evt-1', room_id: ROOM, table_id: null,
        date: '2026-04-20', start_time: '14:00:00', end_time: '16:00:00', all_day: false,
      }]
      setupRoomsSqlMock(TABLES, eventBlocks)

      const { getRoomTablesAvailability } = await import('@/lib/server/rooms-service')

      const result = await getRoomTablesAvailability(ROOM, '2026-04-20')
      expect(result['table-A']?.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(false)
      expect(result['table-B']?.slots.find((slot) => slot.startTime === '14:00')?.available).toBe(false)
    })

    // --- hasEventBlockConflict, exercised through the exported reservation
    // entry points (the function itself is module-private). ---

    const RESERVATION_ROOM = 'room-res'
    const RESERVATION_TABLES: Record<string, MockTable> = {
      'res-table-1': { id: 'res-table-1', room_id: RESERVATION_ROOM, type: 'small' },
      'res-table-2': { id: 'res-table-2', room_id: RESERVATION_ROOM, type: 'small' },
    }

    function buildReservationSessionClient(config: { insertSpy?: (payload: any) => void; existingReservation?: any }) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'tables') {
            return {
              select: vi.fn(() => ({
                eq: vi.fn((_column: string, value: string) => ({
                  maybeSingle: vi.fn(async () => ({ data: RESERVATION_TABLES[value] ?? null, error: null })),
                })),
              })),
            }
          }
          if (table === 'reservations') {
            return {
              select: vi.fn(() => chainThen({ data: [], error: null })), // no user-slot overlap
              insert: vi.fn((payload: any) => {
                config.insertSpy?.(payload)
                return {
                  select: vi.fn(() => ({
                    single: vi.fn(async () => ({
                      data: {
                        id: 'new-reservation-id',
                        table_id: payload.table_id,
                        user_id: payload.user_id,
                        date: payload.date,
                        start_time: `${payload.start_time}:00`,
                        end_time: payload.end_time === '24:00' ? '24:00:00' : `${payload.end_time}:00`,
                        status: 'active',
                        surface: payload.surface ?? null,
                        activated_at: null,
                        created_at: '2026-04-01T00:00:00.000Z',
                      },
                      error: null,
                    })),
                  })),
                }
              }),
              update: vi.fn((payload: any) => ({
                eq: vi.fn(() => ({
                  select: vi.fn(() => ({
                    single: vi.fn(async () => ({
                      data: { ...config.existingReservation, ...payload },
                      error: null,
                    })),
                  })),
                })),
              })),
            }
          }
          return {}
        }),
        rpc: mockDatabaseNowRpc(),
      }
    }

    function buildReservationAdminClient(config: {
      eventBlocks: Array<{ id: string; table_id: string | null }>
      existingReservation?: any
    }) {
      return {
        from: vi.fn((table: string) => {
          if (table === 'event_room_blocks') {
            return { select: vi.fn(() => chainThen({ data: config.eventBlocks, error: null })) }
          }
          if (table === 'saved_games') {
            return { select: vi.fn(() => chainThen({ data: [], error: null })) }
          }
          if (table === 'reservation_equipment') {
            return {
              select: vi.fn(() => chainThen({ data: [], error: null })),
              delete: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
            }
          }
          if (table === 'reservations') {
            return {
              select: vi.fn(() => {
                const filters: Record<string, unknown> = {}
                const chain: any = {
                  eq: (column: string, value: unknown) => {
                    filters[column] = value
                    return chain
                  },
                  neq: () => chain,
                  in: () => chain,
                  is: () => chain,
                  order: () => chain,
                  maybeSingle: async () => ({
                    data: filters.id && config.existingReservation?.id === filters.id ? config.existingReservation : null,
                    error: null,
                  }),
                  then: (resolve: any, reject: any) =>
                    Promise.resolve({ data: [], error: null }).then(resolve, reject),
                }
                return chain
              }),
            }
          }
          return {}
        }),
        rpc: mockDatabaseNowRpc(),
      }
    }

    function setupReservationServiceSqlMock(config: {
      eventBlocks: Array<{ id: string; table_id: string | null }>
      existingReservation?: Record<string, unknown>
      insertSpy?: (payload: unknown) => void
    }) {
      roomsSqlMock.reset()
      roomsSqlMock.addHandler({
        name: 'SELECT reservation table', verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'id', '=') && whereConditionCount(stmt) === 1,
        respond: (stmt) => {
          const table = RESERVATION_TABLES[String(stmt.values[0])]
          return table ? [table] : []
        },
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservation event blocks', verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks', respond: () => config.eventBlocks,
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservation saved games', verb: 'select',
        match: (stmt) => stmt.table === 'saved_games', respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservation equipment', verb: 'select',
        match: (stmt) => stmt.table === 'reservation_equipment', respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'DELETE reservation equipment', verb: 'delete',
        match: (stmt) => stmt.table === 'reservation_equipment', respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'INSERT reservation equipment', verb: 'insert',
        match: (stmt) => stmt.table === 'reservation_equipment', respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT all equipment', verb: 'select',
        match: (stmt) => stmt.table === 'equipment', respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'SELECT reservation rows', verb: 'select',
        match: (stmt) => stmt.table === 'reservations',
        respond: (stmt) => stmt.values.length === 1 && config.existingReservation?.id === stmt.values[0]
          ? [config.existingReservation] : [],
      })
      roomsSqlMock.addHandler({
        name: 'UPDATE stale pending reservation', verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && !stmt.returning,
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        name: 'UPDATE reservation', verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && stmt.returning,
        respond: () => config.existingReservation ? [config.existingReservation] : [],
      })
      roomsSqlMock.addHandler({
        name: 'INSERT reservation', verb: 'insert',
        match: (stmt) => stmt.table === 'reservations',
        respond: (stmt) => {
          config.insertSpy?.(stmt.values)
          const [table_id, user_id, date, start_time, end_time, surface] = stmt.values
          return [{ id: 'new-reservation-id', table_id, user_id, date, start_time, end_time, surface, status: 'active', activated_at: null, created_at: '2026-04-01T00:00:00.000Z' }]
        },
      })
    }

    it('hasEventBlockConflict: detects conflict on exact table when table_id set', async () => {
      const eventBlocks = [{ id: 'blk-5', table_id: 'res-table-1' }]
      setupReservationServiceSqlMock({ eventBlocks })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({}) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks }) as any,
      )

      const { createReservationForSession } = await import('@/lib/server/reservations-service')

      await expect(createReservationForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'res-table-1',
        date: '2026-04-20',
        startTime: '14:00',
        endTime: '16:00',
      })).rejects.toMatchObject({ message: 'ROOM_BLOCKED_BY_EVENT', statusCode: 409 })
    })

    it('hasEventBlockConflict: no conflict for sibling table when table_id set', async () => {
      const eventBlocks = [{ id: 'blk-6', table_id: 'res-table-1' }]
      setupReservationServiceSqlMock({ eventBlocks })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({}) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks }) as any,
      )

      const { createReservationForSession } = await import('@/lib/server/reservations-service')

      const result = await createReservationForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'res-table-2',
        date: '2026-04-20',
        startTime: '14:00',
        endTime: '16:00',
      })
      expect(result.tableId).toBe('res-table-2')
    })

    it('hasEventBlockConflict: conflict on any table when table_id is null', async () => {
      const eventBlocks = [{ id: 'blk-7', table_id: null }]
      setupReservationServiceSqlMock({ eventBlocks })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({}) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks }) as any,
      )

      const { createReservationForSession } = await import('@/lib/server/reservations-service')

      await expect(createReservationForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'res-table-2',
        date: '2026-04-20',
        startTime: '14:00',
        endTime: '16:00',
      })).rejects.toMatchObject({ message: 'ROOM_BLOCKED_BY_EVENT', statusCode: 409 })
    })

    it('assertTableAndEventAvailability respects table_id scoping', async () => {
      // saved-games-service.ts (#301) uses the raw-SQL `sql` client, not
      // Supabase — register handlers on the shared `roomsSqlMock` (the mock
      // bound to `@/lib/db/client` for this whole file) instead of the old
      // Supabase admin-client mock.
      const savedGameTables: Record<string, MockTable> = {
        'sg-table-1': { id: 'sg-table-1', room_id: RESERVATION_ROOM, type: 'removable_top' },
        'sg-table-2': { id: 'sg-table-2', room_id: RESERVATION_ROOM, type: 'removable_top' },
      }
      roomsSqlMock.reset()
      roomsSqlMock.addHandler({
        name: 'SELECT saved-game table by id',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && whereColumnHasOperator(stmt, 'id', '=') && whereConditionCount(stmt) === 1,
        respond: (stmt) => {
          const table = savedGameTables[String(stmt.values[0])]
          return table ? [table] : []
        },
      })
      roomsSqlMock.addHandler({
        name: 'SELECT saved-game event blocks',
        verb: 'select',
        // Block is scoped ONLY to sg-table-1.
        match: (stmt) => stmt.table === 'event_room_blocks',
        respond: () => [{ id: 'blk-8', table_id: 'sg-table-1' }],
      })
      roomsSqlMock.addHandler({
        // assertNoBottomReservationConflict (security-review fix, #301):
        // SELECT id FROM reservations WHERE table_id = $1 AND status IN
        // (...) AND (surface IS NULL OR surface = 'bottom') AND date >= $2
        // AND date <= $3 LIMIT 1 — no conflict for this test's scenario.
        name: 'SELECT no bottom reservation conflict',
        verb: 'select',
        match: (stmt) => stmt.table === 'reservations',
        respond: () => [],
      })
      roomsSqlMock.addHandler({
        // WITH ins AS (INSERT INTO saved_games ... RETURNING *) SELECT ...
        // FROM ins sg LEFT JOIN tables/rooms — CTE-wrapped insert
        // (security-review fix, #301), still anchored as verb='insert'/
        // table='saved_games' by the sql-mock's CTE support.
        name: 'INSERT saved game',
        verb: 'insert',
        match: (stmt) => stmt.table === 'saved_games',
        respond: (stmt) => {
          const [tableId, userId, startDate, endDate] = stmt.values.map(String)
          return [{
            id: 'sg-1',
            table_id: tableId,
            user_id: userId,
            start_date: startDate,
            end_date: endDate,
            status: 'active',
            attendance_count: 0,
            renewed_from_id: null,
            created_at: '2026-04-01T00:00:00.000Z',
            updated_at: '2026-04-01T00:00:00.000Z',
            table_name: null,
            room_name: null,
          }]
        },
      })

      const { createSavedGameForSession } = await import('@/lib/server/saved-games-service')

      // The blocked table itself must conflict.
      await expect(createSavedGameForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'sg-table-1',
        startDate: '2026-04-20',
        endDate: '2026-05-20',
      })).rejects.toMatchObject({ message: 'SAVED_GAME_EVENT_CONFLICT', statusCode: 409 })

      // A sibling table not referenced by the block must NOT conflict.
      const result = await createSavedGameForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'sg-table-2',
        startDate: '2026-04-20',
        endDate: '2026-05-20',
      })
      expect(result.tableId).toBe('sg-table-2')
    })

    it('create reservation fails if table-level block conflict', async () => {
      const insertSpy = vi.fn()
      const eventBlocks = [{ id: 'blk-9', table_id: 'res-table-1' }]
      setupReservationServiceSqlMock({ eventBlocks, insertSpy })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({ insertSpy }) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks }) as any,
      )

      const { createReservationForSession } = await import('@/lib/server/reservations-service')

      await expect(createReservationForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'res-table-1',
        date: '2026-04-20',
        startTime: '10:00',
        endTime: '12:00',
      })).rejects.toMatchObject({ statusCode: 409 })
      // Fail-fast: the conflicting reservation must never reach the DB write.
      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('create reservation succeeds on sibling table despite table-level block', async () => {
      const insertSpy = vi.fn()
      const eventBlocks = [{ id: 'blk-10', table_id: 'res-table-1' }]
      setupReservationServiceSqlMock({ eventBlocks, insertSpy })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({ insertSpy }) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks }) as any,
      )

      const { createReservationForSession } = await import('@/lib/server/reservations-service')

      const result = await createReservationForSession({ id: 'user-1', role: 'member' }, {
        tableId: 'res-table-2',
        date: '2026-04-20',
        startTime: '10:00',
        endTime: '12:00',
      })

      expect(result.id).toBe('new-reservation-id')
      expect(result.tableId).toBe('res-table-2')
      expect(insertSpy).toHaveBeenCalledTimes(1)
    })

    it('update reservation fails if would overlap table-level block', async () => {
      const existingReservation = {
        id: 'res-existing-1',
        table_id: 'res-table-1',
        user_id: 'user-1',
        date: '2026-04-20',
        start_time: '10:00:00',
        end_time: '12:00:00',
        status: 'active',
        surface: null,
        activated_at: null,
        created_at: '2026-04-01T00:00:00.000Z',
      }
      const eventBlocks = [{ id: 'blk-11', table_id: 'res-table-1' }]
      setupReservationServiceSqlMock({ eventBlocks, existingReservation })
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerClient.mockResolvedValue(
        buildReservationSessionClient({ existingReservation }) as any,
      )
      vi.mocked(await import('@/lib/supabase/server')).createSupabaseServerAdminClient.mockReturnValue(
        buildReservationAdminClient({ eventBlocks, existingReservation }) as any,
      )

      const { updateReservationForSession } = await import('@/lib/server/reservations-service')

      // Existing reservation runs 10:00-12:00 (no conflict); moving it to
      // 14:00-16:00 now overlaps the table-level block on its own table.
      await expect(updateReservationForSession({ id: 'user-1', role: 'admin' }, 'res-existing-1', {
        startTime: '14:00',
        endTime: '16:00',
      })).rejects.toMatchObject({ message: 'ROOM_BLOCKED_BY_EVENT', statusCode: 409 })
    })
  })

  // NOTE: this describe used to be closed here and reopened as a second,
  // top-level `describe('OIR-208: Unified Events')` — meaning it never
  // inherited the outer describe's `beforeEach(() => roomsSqlMock.reset())`.
  // That let a broad `event_room_blocks` handler registered by an earlier
  // Availability test (setupReservationServiceSqlMock's catch-all matcher)
  // leak into "OIR-208 Round 2" tests below, since nothing reset the shared
  // `roomsSqlMock` between them. Fixed by nesting Round 2 inside this
  // describe (closing brace moved to the very end of the file) so it
  // inherits the same reset-per-test guarantee as every other section here.
  describe('OIR-208 Round 2: Regression tests for fix 65485a1', () => {
    describe('updateClubEvent preserves legacy anchor fields', () => {
      it('preserves description on update with only title change', async () => {
        // NOTE: title_es/title_en are intentionally non-null here (a
        // published/landing event) — a null title_es on `current` trips an
        // unrelated pre-existing service bug (see final QA report: the
        // unconditional `resolveClubEventFields({}, current)` snapshot at
        // club-events-service.ts:1165 falls back to `current.title`, which
        // the ADMIN_CLUB_EVENT_RETURNING SELECT never fetches, so any update
        // to an internal-only event 400s on "titleEs is required"). This
        // test targets description preservation only, unrelated to that bug.
        addCurrentEventSelectHandler(currentEventRowFixture({
          id: 'evt-preserve-1',
          description_es: 'Existing description',
        }))
        addUpdateEventHandler((values) => [currentEventRowFixture({
          id: 'evt-preserve-1',
          title_es: values[0] as string,
          title_en: values[1] as string,
          description_es: values[4] as string,
        })])
        addEventRoomBlocksSelectHandler([])
        addEventMaterialsSelectHandler([])

        const { updateClubEvent } = await import('@/lib/server/club-events-service')

        const result = await updateClubEvent(createAdminSession(), 'evt-preserve-1', {
          titleEs: 'Nuevo Título',
          titleEn: 'New Title',
          // Only sending title change, NOT sending description
        })

        // Verify preserved values are in the result
        expect(result.descriptionEs).toBe('Existing description')
        expect(result.id).toBe('evt-preserve-1')
      })

      it('does NOT touch start_time/end_time in the UPDATE statement (SET clause omits them entirely)', async () => {
        addCurrentEventSelectHandler(currentEventRowFixture({ id: 'evt-times-1' }))
        let capturedUpdateText = ''
        roomsSqlMock.addHandler({
          name: 'UPDATE events (captures SET clause text)',
          verb: 'update',
          match: (stmt) => stmt.table === 'events' && stmt.returning,
          respond: (stmt) => {
            capturedUpdateText = stmt.text
            return [currentEventRowFixture({ id: 'evt-times-1' })]
          },
        })
        addEventRoomBlocksSelectHandler([])
        addEventMaterialsSelectHandler([])

        const { updateClubEvent } = await import('@/lib/server/club-events-service')

        await updateClubEvent(createAdminSession(), 'evt-times-1', {
          titleEs: 'Updated Title',
          // NO change to times in the payload
        })

        // The UPDATE's SET clause deliberately omits start_time/end_time
        // entirely (see ClubEventFieldSet doc in club-events-service.ts) —
        // whatever value the row already has is left untouched by SQL, not
        // overwritten with the same value.
        expect(capturedUpdateText).not.toMatch(/\bstart_time\s*=/)
        expect(capturedUpdateText).not.toMatch(/\bend_time\s*=/)
      })
    })

    describe('createClubEvent sets proper defaults', () => {
      it('createClubEvent sets description=null, start_time=00:00:00, end_time=23:59:00 for new events', async () => {
        let capturedValues: unknown[] = []
        roomsSqlMock.addHandler({
          name: 'INSERT events (captures values)',
          verb: 'insert',
          match: (stmt) => stmt.table === 'events' && stmt.returning && stmt.values.length === 20,
          respond: (stmt) => {
            capturedValues = stmt.values
            return [{ ...currentEventRowFixture({ title_es: 'New Event', title_en: 'New Event' }), id: 'evt-new-defaults' }]
          },
        })

        const { createClubEvent } = await import('@/lib/server/club-events-service')

        const result = await createClubEvent(createAdminSession(), {
          titleEs: 'New Event',
          titleEn: 'New Event',
          date: '2026-05-20',
          dateKind: 'single',
        })

        // Values order: title_es, title_en, blurb_es, blurb_en, description_es,
        // description_en, category_es, category_en, date_kind, date, end_date,
        // recurrence_label_es, recurrence_label_en, image_url, link_url,
        // title, description, start_time, end_time, created_by
        expect(capturedValues[16]).toBeNull() // description
        expect(capturedValues[17]).toBe('00:00:00') // start_time
        expect(capturedValues[18]).toBe('23:59:00') // end_time
        expect(result.id).toBe('evt-new-defaults')
      })
    })

    describe('Toggle visibleOnLanding OFF preserves content', () => {
      it('toggle OFF (visibleOnLanding=false) preserves blurb_es and image_url', async () => {
        addCurrentEventSelectHandler(currentEventRowFixture({
          id: 'evt-toggle-1',
          title_es: 'Evento Publicado',
          title_en: 'Published Event',
          blurb_es: 'Descripción breve',
          blurb_en: 'Brief description',
          image_url: 'https://example.com/image.jpg',
        }))
        addUpdateEventHandler(() => [currentEventRowFixture({
          id: 'evt-toggle-1',
          title_es: null, // toggled OFF
          title_en: null, // toggled OFF
          // blurb_es/image_url preserved (visibleOnLanding OFF doesn't clear them)
          blurb_es: 'Descripción breve',
          blurb_en: 'Brief description',
          image_url: 'https://example.com/image.jpg',
        })])
        addEventRoomBlocksSelectHandler([])
        addEventMaterialsSelectHandler([])

        const { updateClubEvent } = await import('@/lib/server/club-events-service')

        const result = await updateClubEvent(createAdminSession(), 'evt-toggle-1', {
          visibleOnLanding: false,
          // No change to blurbEs or imageUrl — they should be preserved
        })

        // Verify that blurb_es and image_url are preserved in the returned data
        expect(result.blurbEs).toBe('Descripción breve')
        expect(result.imageUrl).toBe('https://example.com/image.jpg')
        // But the event is now internal-only (titles nulled)
        expect(result.visibleOnLanding).toBe(false)
      })
    })
  })
})
