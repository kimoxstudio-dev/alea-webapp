// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSqlMock, hasExactSelectColumns, whereHasColumn } from '../helpers/sql-mock'

/**
 * CLUB EVENTS SERVICE TEST COVERAGE (OIR-203, raw-SQL Neon port #304)
 *
 * Tests for admin CRUD operations on public club events
 * Implementation: lib/server/club-events-service.ts
 *
 * Rewritten off the old Supabase-client/`apply_club_event_room_blocks` RPC
 * mocks to the raw-SQL Neon implementation (#304) — that RPC no longer
 * exists; `applyClubEventBlocksAndMaterials` in club-events-service.ts now
 * runs the same behavior as plain sequential `sql` statements. Uses the
 * shared `createSqlMock` helper (#332), same pattern as events-service.test.ts
 * (#303).
 *
 * Key scenarios tested:
 * - createClubEvent with bilingual titles and optional room blocks (admin-only)
 * - updateClubEvent with partial updates and room block toggling (admin-only)
 * - deleteClubEvent removes event and cancels conflicting reservations (admin-only)
 * - Non-admin users get 403 Forbidden from every CRUD endpoint
 * - URL hardening: validateOptionalUrl rejects javascript:, data:, relative URLs
 * - Room blocking is optional: events without blocksRooms don't create event_room_blocks rows
 * - Upcoming/past split derived from date_kind and end_date at read time
 * - listEvents() excludes landing rows (both title_es and title_en populated)
 */

vi.mock('server-only', () => ({}))

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

const sqlMock = createSqlMock()
vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

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

async function loadClubEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/club-events-service')
  return {
    createClubEvent: mod.createClubEvent,
    updateClubEvent: mod.updateClubEvent,
    deleteClubEvent: mod.deleteClubEvent,
    listAdminClubEvents: mod.listAdminClubEvents,
    listClubEvents: mod.listClubEvents,
  }
}

async function loadEventsService() {
  vi.resetModules()
  const mod = await import('@/lib/server/events-service')
  return {
    listEvents: mod.listEvents,
  }
}

// ---------------------------------------------------------------------------
// Shared column-list constants (mirror lib/server/club-events-service.ts and
// lib/server/events-service.ts exactly — used to disambiguate the several
// SELECT/RETURNING shapes issued against the "events" table).
// ---------------------------------------------------------------------------

const ADMIN_RETURNING_COLUMNS =
  'id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url, category_es, category_en'

// listAdminClubEvents's own SELECT is a separate literal column list (not
// built from ADMIN_CLUB_EVENT_RETURNING) and does NOT include `title` —
// only the create/update RETURNING clause (and updateClubEvent's currentRows
// fetch) gained `title` in the #304 fix.
const ADMIN_LIST_COLUMNS =
  'id, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url, category_es, category_en'

const PUBLIC_RETURNING_COLUMNS =
  'id, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url'

const ROOM_BLOCK_COLUMNS = 'id, event_id, room_id, table_id, date, start_time, end_time, all_day'

// ---------------------------------------------------------------------------
// Shared row fixtures
// ---------------------------------------------------------------------------

function currentEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    title_es: 'Evento Antiguo',
    title_en: 'Old Event',
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

// ---------------------------------------------------------------------------
// Shared handler factories
// ---------------------------------------------------------------------------

/** INSERT INTO events (...20 cols...) RETURNING <admin columns> — createClubEvent */
function addCreateInsertHandler(id = 'evt-new-1') {
  sqlMock.addHandler({
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
  sqlMock.addHandler({
    name: 'SELECT current event row (updateClubEvent)',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'events' && hasExactSelectColumns(stmt, ADMIN_RETURNING_COLUMNS) && Boolean(stmt.whereClause),
    respond: () => (row ? [row] : []),
  })
}

/** UPDATE events SET ... WHERE id=$N RETURNING <admin columns> — updateClubEvent field write */
function addUpdateEventHandler(respond: (values: unknown[]) => unknown) {
  sqlMock.addHandler({
    name: 'UPDATE events (field write, RETURNING)',
    verb: 'update',
    match: (stmt) => stmt.table === 'events' && stmt.returning,
    respond: (stmt) => respond(stmt.values),
  })
}

/** UPDATE events SET ... WHERE id=$N (no RETURNING) — revertClubEventFieldsOnFailure */
function addRevertEventHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
    name: 'UPDATE events (compensating revert, no RETURNING)',
    verb: 'update',
    match: (stmt) => stmt.table === 'events' && !stmt.returning,
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
  })
}

/** DELETE FROM events WHERE id=$1 — createClubEvent compensating delete / deleteEventCascade final step */
function addEventsDeleteHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
    name: 'DELETE events WHERE id',
    verb: 'delete',
    match: (stmt) => stmt.table === 'events',
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
  })
}

/** SELECT id, title_es, title_en FROM events WHERE id=$1 LIMIT 1 — deleteClubEvent guard */
function addDeleteGuardHandler(row: { id: string; title_es: string | null; title_en: string | null } | null) {
  sqlMock.addHandler({
    name: 'SELECT id, title_es, title_en FROM events (deleteClubEvent guard)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, 'id, title_es, title_en'),
    respond: () => (row ? [row] : []),
  })
}

/** SELECT id FROM events WHERE id=$1 LIMIT 1 — applyClubEventBlocksAndMaterials existence check */
function addEventExistsHandler(exists = true) {
  sqlMock.addHandler({
    name: 'SELECT id FROM events (applyClubEventBlocksAndMaterials existence)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, 'id'),
    respond: () => (exists ? [{ id: 'evt-1' }] : []),
  })
}

/** SELECT <admin columns> FROM events ORDER BY date ASC (no WHERE) — listAdminClubEvents */
function addListAdminEventsSelectHandler(rows: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT events ORDER BY date ASC (listAdminClubEvents)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, ADMIN_LIST_COLUMNS) && !stmt.whereClause,
    respond: () => rows,
  })
}

/** SELECT <public columns> FROM events WHERE title_es/title_en IS NOT NULL ORDER BY date ASC — listClubEvents (public) */
function addListClubEventsSelectHandler(rows: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT events WHERE title_es/title_en IS NOT NULL (listClubEvents public)',
    verb: 'select',
    match: (stmt) => stmt.table === 'events' && hasExactSelectColumns(stmt, PUBLIC_RETURNING_COLUMNS),
    respond: () => rows,
  })
}

/** SELECT id FROM rooms WHERE id = ANY(...) — validateRoomsExist */
function addRoomsExistHandler(missing: string[] = []) {
  sqlMock.addHandler({
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
 * Handles all three "tables" SELECT shapes club-events-service.ts issues:
 * - `WHERE id = ANY(...)` (validateTablesExist)
 * - `WHERE id = $1 AND room_id = $2` (table/room mismatch guard)
 * - `WHERE room_id = $1` (fetchTableIdsForRoom)
 */
function addTablesHandler(opts: { missingTableIds?: string[]; roomTableIds?: Record<string, string[]> } = {}) {
  const { missingTableIds = [], roomTableIds = {} } = opts
  sqlMock.addHandler({
    name: 'SELECT id FROM tables (validateTablesExist / mismatch guard / fetchTableIdsForRoom)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables',
    respond: (stmt) => {
      if (stmt.whereClause?.includes('any(')) {
        const ids = stmt.values[0] as string[]
        return ids.filter((id) => !missingTableIds.includes(id)).map((id) => ({ id }))
      }
      if (whereHasColumn(stmt, 'id') && whereHasColumn(stmt, 'room_id')) {
        const [tableId, roomId] = stmt.values as [string, string]
        const valid = (roomTableIds[roomId] ?? []).includes(tableId)
        return valid ? [{ id: tableId }] : []
      }
      const roomId = stmt.values[0] as string
      return (roomTableIds[roomId] ?? []).map((id) => ({ id }))
    },
  })
}

/** SELECT id FROM equipment WHERE id = ANY(...) — validateEquipmentExists */
function addEquipmentExistsHandler(missing: string[] = []) {
  sqlMock.addHandler({
    name: 'SELECT id FROM equipment WHERE id = ANY(...)',
    verb: 'select',
    match: (stmt) => stmt.table === 'equipment' && stmt.selectColumns === 'id',
    respond: (stmt) => {
      const ids = stmt.values[0] as string[]
      return ids.filter((id) => !missing.includes(id)).map((id) => ({ id }))
    },
  })
}

/** DELETE FROM event_room_blocks WHERE event_id=$1 RETURNING ... */
function addBlocksDeleteHandler(existingBlocks: unknown[] = []) {
  sqlMock.addHandler({
    name: 'DELETE event_room_blocks WHERE event_id (RETURNING)',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_room_blocks',
    respond: () => existingBlocks,
  })
}

/** DELETE FROM event_equipment WHERE event_id=$1 RETURNING ... */
function addMaterialsDeleteHandler(existingMaterials: unknown[] = []) {
  sqlMock.addHandler({
    name: 'DELETE event_equipment WHERE event_id (RETURNING)',
    verb: 'delete',
    match: (stmt) => stmt.table === 'event_equipment',
    respond: () => existingMaterials,
  })
}

/** INSERT INTO event_room_blocks (...) RETURNING ... */
function addBlockInsertHandler(idPrefix = 'block', spy?: (values: unknown[]) => void) {
  let counter = 0
  sqlMock.addHandler({
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
  sqlMock.addHandler({
    name: 'UPDATE reservations cancel overlapping',
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
    respond,
  })
}

/** INSERT INTO event_equipment (...) ON CONFLICT (event_id, equipment_id) DO UPDATE */
function addMaterialsInsertHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
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
  sqlMock.addHandler({
    name: 'SELECT event_room_blocks WHERE event_id (result/fetch)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS),
    respond: () => blocks,
  })
}

/** SELECT room_id, date, start_time, end_time FROM event_room_blocks WHERE event_id=$1 — deleteEventCascade's blocks fetch */
function addCascadeBlocksFetchHandler(blocks: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT room_id, date, start_time, end_time FROM event_room_blocks (cascade)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, 'room_id, date, start_time, end_time'),
    respond: () => blocks,
  })
}

/** SELECT id, room_id FROM tables WHERE room_id = ANY(...) — deleteEventCascade's table fetch */
function addCascadeTablesFetchHandler(tables: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables (cascade)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
    respond: () => tables,
  })
}

/** SELECT ee.event_id, ee.equipment_id, ee.quantity, eq.name FROM event_equipment ee JOIN equipment eq ... — fetchEventMaterials(ForMany) */
function addEventMaterialsSelectHandler(materials: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT event_equipment JOIN equipment (materials)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_equipment',
    respond: () => materials,
  })
}

describe('club-events-service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sqlMock.reset()
  })

  describe('createClubEvent', () => {
    it('admin can create a public club event without room blocks', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Gastronómica Viernes',
        titleEn: 'Friday Gastro',
        blurbEs: 'Noche de comida',
        blurbEn: 'Food night',
        dateKind: 'recurring',
        date: '2026-04-17',
        recurrenceLabelEs: 'Todos los viernes',
        recurrenceLabelEn: 'Every Friday',
        imageUrl: 'https://example.com/gastro.png',
        linkUrl: 'https://example.com/reserve',
        categoryEs: 'Social',
        categoryEn: 'Social',
        blocksRooms: false,
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Gastronómica Viernes')
      expect(result.titleEn).toBe('Friday Gastro')
      expect(result.status).toBe('upcoming')
      expect(result.blocksRooms).toBe(false)
      expect(result.roomBlocks.length).toBe(0)
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createMemberSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('rejects javascript: URL in image_url', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: 'javascript:alert(1)',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects data: URL in link_url', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          linkUrl: 'data:text/html,<script>alert(1)</script>',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects relative URL in imageUrl', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          imageUrl: '/images/event.png',
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts empty/undefined imageUrl and linkUrl', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        imageUrl: undefined,
        linkUrl: null,
      })

      expect(result.imageUrl).toBeNull()
      expect(result.linkUrl).toBeNull()
    })

    it('creates a club event with titleEn absent, succeeds with title_en === title_es in DB (OIR-206)', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Evento en Español',
        // titleEn absent — should fallback
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.titleEs).toBe('Evento en Español')
      expect(result.titleEn).toBe('Evento en Español') // Fallback to ES
    })

    it('creates a club event with titleEn empty string, succeeds with fallback (OIR-206)', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Evento Viernes',
        titleEn: '', // Empty string — should fallback
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Evento Viernes')
    })

    it('creates a club event with explicit titleEn, preserves EN value (OIR-206)', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo de Ajedrez',
        titleEn: 'Chess Tournament',
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.titleEn).toBe('Chess Tournament')
    })

    it('creates a club event with blurbEn absent, falls back to blurbEs (OIR-206)', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Event',
        titleEn: 'Event',
        blurbEs: 'Descripción breve',
        // blurbEn absent
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.blurbEs).toBe('Descripción breve')
      expect(result.blurbEn).toBe('Descripción breve')
    })

    it('creates a club event with categoryEn absent, falls back to categoryEs (OIR-206)', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Event',
        titleEn: 'Event',
        categoryEs: 'Torneo',
        // categoryEn absent
        date: '2026-05-01',
        dateKind: 'single',
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.categoryEs).toBe('Torneo')
      expect(result.categoryEn).toBe('Torneo')
    })

    it('rejects categoryEn as non-string object (still 400, not fallback) (OIR-206)', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          categoryEs: 'Torneo',
          categoryEn: { nested: 'object' }, // Non-string — still 400
          date: '2026-05-01',
          dateKind: 'single',
        })
      ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('must be a string') })
    })

    it('creates a club event with blocksRooms:true, inserting a room block via the sequential SQL flow (Finding 1)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const insertedBlocks: unknown[] = []
      addBlockInsertHandler('block', (values) => {
        const [event_id, room_id, table_id, date, start_time, end_time, all_day] = values
        insertedBlocks.push({ id: `block-${insertedBlocks.length + 1}`, event_id, room_id, table_id, date, start_time, end_time, all_day })
      })
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (result, tracks inserted)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS),
        respond: () => insertedBlocks,
      })
      addEventMaterialsSelectHandler([])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo con Bloques',
        titleEn: 'Tournament with Blocks',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          {
            date: '2026-05-01',
            startTime: '18:00',
            endTime: '22:00',
            allDay: false,
            roomId: 'room-1',
          },
        ],
      })

      expect(result.blocksRooms).toBe(true)
      expect(result.roomBlocks.length).toBe(1)
      expect(result.roomBlocks[0].roomId).toBe('room-1')
      expect(result.roomBlocks[0].startTime).toBe('18:00')
      expect(result.roomBlocks[0].endTime).toBe('22:00')
    })

    it('rolls back (deletes) the created event when the block/material write fails, leaving no orphan row (PR #149 review)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      // Simulate a transient failure in the block-write step (after the event
      // row already exists) — the existence check itself fails.
      addEventExistsHandler(false)
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 404 })

      // The event row created by the earlier insert (id: evt-new-1) must be
      // deleted once the block-write step fails — no orphan club event
      // should ever be left behind.
      expect(deleteSpy).toHaveBeenCalledWith(['evt-new-1'])
    })

    it('logs the orphaned event id when BOTH the block write and the compensating delete fail, and still rethrows the original error (PR #149 review round 2)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addEventExistsHandler(false)
      const deleteSpy = vi.fn()
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (fails)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          deleteSpy(stmt.values)
          throw new Error('delete failed')
        },
      })

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-1',
            },
          ],
        })
        // The ORIGINAL error (from applyClubEventBlocksAndMaterials) must
        // still be what the client sees — never the compensating delete's
        // own error, which is only a logging concern.
      ).rejects.toMatchObject({ statusCode: 404 })

      expect(deleteSpy).toHaveBeenCalledWith(['evt-new-1'])
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('orphaned event row requires manual cleanup'),
        'evt-new-1',
        expect.anything(),
      )

      consoleErrorSpy.mockRestore()
    })

    it('rejects an unknown room id in schedules with 400 BEFORE inserting the event row (PR #149 review)', async () => {
      // No rooms "exist" — every referenced room id is unknown.
      addRoomsExistHandler(['room-does-not-exist'])
      const insertSpy = vi.fn()
      sqlMock.addHandler({
        name: 'INSERT events (should never be called)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          insertSpy(stmt.values)
          return [{ id: 'evt-new-1', ...currentEventRow() }]
        },
      })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Torneo con Bloques',
          titleEn: 'Tournament with Blocks',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            {
              date: '2026-05-01',
              startTime: '18:00',
              endTime: '22:00',
              allDay: false,
              roomId: 'room-does-not-exist',
            },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('rejects malformed schedules with 400 and no insert on events table (Finding 2)', async () => {
      const insertSpy = vi.fn()
      sqlMock.addHandler({
        name: 'INSERT events (should never be called)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          insertSpy(stmt.values)
          return [{ id: 'evt-new-1', ...currentEventRow() }]
        },
      })

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: 'not-an-array',
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(insertSpy).not.toHaveBeenCalled()
    })

    it('rejects blurbEs as object with 400 (Finding 5)', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          blurbEs: {},
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('rejects categoryEn as array with 400 (Finding 5)', async () => {
      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Event',
          titleEn: 'Event',
          date: '2026-05-01',
          dateKind: 'single',
          categoryEn: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })
    })

    it('accepts null and undefined for optional string fields', async () => {
      addCreateInsertHandler()
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Event',
        titleEn: 'Event',
        date: '2026-05-01',
        dateKind: 'single',
        blurbEs: null,
        blurbEn: undefined,
        categoryEs: null,
        categoryEn: undefined,
      })

      expect(result.id).toBe('evt-new-1')
      expect(result.blurbEs).toBe('')
      expect(result.blurbEn).toBe('')
    })
  })

  describe('updateClubEvent', () => {
    it('admin can update a club event', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addUpdateEventHandler((values) => [currentEventRow({ blurb_en: values[3] as string })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        titleEs: 'Updated Event ES',
        blurbEn: 'Updated blurb',
      })

      expect(result.id).toBe('evt-1')
    })

    it('non-admin member gets 403 Forbidden on update', async () => {
      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createMemberSession(), 'evt-1', { titleEs: 'Updated' })
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 for non-existent club event', async () => {
      addCurrentEventSelectHandler(null)

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'nonexistent-evt', { titleEs: 'Test' })
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('rejects malformed schedules with 400 and no update on events table (Finding 2)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      const updateSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE events (should never be called)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          updateSpy(stmt.values)
          return [currentEventRow()]
        },
      })

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('skips the block-replace step when schedules match current blocks (order-insensitive, Finding 4)', async () => {
      const currentBlocks = [
        { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
        { id: 'block-2', event_id: 'evt-1', room_id: 'room-2', table_id: null, date: '2026-04-20', start_time: '10:00:00', end_time: '14:00:00', all_day: false },
      ]

      addCurrentEventSelectHandler(currentEventRow())
      addUpdateEventHandler((values) => [currentEventRow({ blurb_en: values[3] as string })])
      addRoomsExistHandler()
      addTablesHandler()
      addEventRoomBlocksSelectHandler(currentBlocks)
      addEventMaterialsSelectHandler([])
      const blockInsertSpy = vi.fn()
      addBlockInsertHandler('block', blockInsertSpy)

      const { updateClubEvent } = await loadClubEventsService()

      await updateClubEvent(createAdminSession(), 'evt-1', {
        blurbEn: 'Updated blurb',
        blocksRooms: true,
        schedules: [
          { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
          { date: '2026-04-20', startTime: '10:00', endTime: '14:00', allDay: false, roomId: 'room-2' },
        ],
      })

      // Blocks are identical (order-insensitive) — the replace step (DELETE +
      // re-INSERT) must never run.
      expect(blockInsertSpy).not.toHaveBeenCalled()
    })

    it('replaces blocks when schedules differ from current blocks (Finding 4)', async () => {
      const currentBlocks = [
        { id: 'block-1', event_id: 'evt-1', room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false },
      ]

      addCurrentEventSelectHandler(currentEventRow())
      addUpdateEventHandler(() => [currentEventRow()])
      addRoomsExistHandler()
      addTablesHandler()
      addEventExistsHandler(true)
      // First call to the "fetch current blocks" comparison SELECT returns
      // the stale block; addEventRoomBlocksSelectHandler's fixed response
      // covers both that call and the post-replace resultBlocks SELECT —
      // register the DELETE (which returns the pre-existing rows) separately
      // so the replace step actually runs.
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (comparison fetch)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS),
        respond: () => currentBlocks,
      })
      addBlocksDeleteHandler(currentBlocks)
      addMaterialsDeleteHandler([])
      const blockInsertSpy = vi.fn()
      addBlockInsertHandler('block-new', blockInsertSpy)
      addReservationsCancelHandler()
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      await updateClubEvent(createAdminSession(), 'evt-1', {
        blocksRooms: true,
        schedules: [
          { date: '2026-04-20', startTime: '10:00', endTime: '14:00', allDay: false, roomId: 'room-2' },
        ],
      })

      expect(blockInsertSpy).toHaveBeenCalled()
      const [, roomId] = blockInsertSpy.mock.calls[0][0] as unknown[]
      expect(roomId).toBe('room-2')
    })

    it('rejects an unknown room id in schedules with 400 BEFORE updating the event fields (PR #149 review)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler(['room-unknown'])
      const updateSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE events (should never be called)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          updateSpy(stmt.values)
          return [currentEventRow()]
        },
      })

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-unknown' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('rejects an unknown table id in schedules with 400 BEFORE updating the event fields (PR #154 review)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler()
      addTablesHandler({ missingTableIds: ['table-unknown'] })
      const updateSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE events (should never be called)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          updateSpy(stmt.values)
          return [currentEventRow()]
        },
      })

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1', tableId: 'table-unknown' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('rejects an unknown equipment id in materials with 400 BEFORE updating the event fields (PR #154 review)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addEquipmentExistsHandler(['equip-unknown'])
      const updateSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE events (should never be called)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events',
        respond: (stmt) => {
          updateSpy(stmt.values)
          return [currentEventRow()]
        },
      })

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          materials: [{ equipmentId: 'equip-unknown', quantity: 1 }],
        })
      ).rejects.toMatchObject({ statusCode: 400 })

      expect(updateSpy).not.toHaveBeenCalled()
    })

    it('reverts the event fields UPDATE when the block-replace step fails, leaving no partial update (PR #149 / PR #154 review)', async () => {
      addCurrentEventSelectHandler(currentEventRow({ title_es: 'Evento Antiguo' }))
      addRoomsExistHandler()
      addTablesHandler()
      addUpdateEventHandler((values) => [currentEventRow({ title_es: values[0] as string })])
      // The block-write step fails: applyClubEventBlocksAndMaterials'
      // existence check comes back empty (simulating a transient failure).
      addEventExistsHandler(false)
      const revertSpy = vi.fn()
      addRevertEventHandler(revertSpy)
      addEventRoomBlocksSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          titleEs: 'Nuevo Titulo',
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 404 })

      // The compensating revert must restore the original title_es value.
      expect(revertSpy).toHaveBeenCalled()
      expect(revertSpy.mock.calls[0][0][0]).toBe('Evento Antiguo')
    })

    it('logs when both the block-replace step and the compensating revert fail, and still rethrows the original error (PR #149 / PR #154 review)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler()
      addTablesHandler()
      addUpdateEventHandler((values) => [currentEventRow({ title_es: values[0] as string })])
      addEventExistsHandler(false)
      sqlMock.addHandler({
        name: 'UPDATE events (compensating revert fails)',
        verb: 'update',
        match: (stmt) => stmt.table === 'events' && !stmt.returning,
        respond: () => {
          throw new Error('revert failed')
        },
      })
      addEventRoomBlocksSelectHandler([])

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          titleEs: 'Nuevo Titulo',
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 404 })

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('event row left partially updated'),
        'evt-1',
        expect.anything(),
      )

      consoleErrorSpy.mockRestore()
    })

    it('updates a non-title field (visibleOnLanding toggle) on an internal-only event (title_es null) without a spurious "titleEs is required" error (regression, club-events-service.ts:1165)', async () => {
      // updateClubEvent's pre-update snapshot (resolveClubEventFields({},
      // current)) and toAdminClubEvent's response mapping both fall back to
      // current.title_es ?? current.title. Before the fix, ADMIN_CLUB_EVENT_
      // RETURNING never selected `title`, so ANY update to an internal-only
      // event (title_es null) 400'd on "titleEs is required" even when the
      // update never touched the title — reproduced here with a blurbEs-only
      // change on a row that's internal-only (title_es/title_en null,
      // legacy `title` populated).
      addCurrentEventSelectHandler(currentEventRow({
        title_es: null,
        title_en: null,
        title: 'Evento Interno Legado',
        blurb_es: 'Resumen viejo',
      }))
      addUpdateEventHandler((values) => [currentEventRow({
        title_es: null,
        title_en: null,
        title: 'Evento Interno Legado',
        blurb_es: values[2] as string,
      })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        blurbEs: 'Resumen nuevo',
      })

      expect(result.blurbEs).toBe('Resumen nuevo')
      // `title` (the legacy fallback column) is now selected by both the
      // currentRows fetch and the RETURNING clause, so the response's
      // titleEs/titleEn fall back to the row's `title` instead of coming
      // back `undefined` for an internal-only event.
      expect(result.titleEs).toBe('Evento Interno Legado')
      expect(result.titleEn).toBe('Evento Interno Legado')
      expect(result.visibleOnLanding).toBe(false)
    })
  })

  describe('deleteClubEvent', () => {
    it('admin can delete a club event with no room blocks', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([])
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('non-admin member gets 403 Forbidden on delete', async () => {
      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createMemberSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 403 })
    })

    it('returns 404 when the event does not exist', async () => {
      addDeleteGuardHandler(null)

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'nonexistent-evt')
      ).rejects.toMatchObject({ statusCode: 404 })
    })

    it('cascades to cancel overlapping reservations for an event with a room block', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      const cancelSpy = vi.fn(() => [])
      addReservationsCancelHandler(cancelSpy)
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      expect(cancelSpy).toHaveBeenCalledTimes(1)
      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })
  })

  describe('listAdminClubEvents', () => {
    it('admin gets upcoming and past events split by date', async () => {
      addListAdminEventsSelectHandler([
        currentEventRow({ id: 'evt-upcoming', date: '2026-05-01' }),
        currentEventRow({ id: 'evt-past', date: '2026-01-01' }),
      ])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { listAdminClubEvents } = await loadClubEventsService()

      const result = await listAdminClubEvents(createAdminSession())

      expect(result).toHaveProperty('upcoming')
      expect(result).toHaveProperty('past')
      expect(result.upcoming.map((e) => e.id)).toContain('evt-upcoming')
      expect(result.past.map((e) => e.id)).toContain('evt-past')
    })

    it('non-admin member gets 403 Forbidden', async () => {
      const { listAdminClubEvents } = await loadClubEventsService()

      await expect(
        listAdminClubEvents(createMemberSession())
      ).rejects.toMatchObject({ statusCode: 403 })
    })
  })

  describe('listClubEvents', () => {
    it('returns upcoming and past club events for public listing', async () => {
      addListClubEventsSelectHandler([
        {
          id: 'evt-upcoming-1',
          title_es: 'Tornero 2026',
          title_en: 'Tournament 2026',
          blurb_es: 'Torneo amistoso',
          blurb_en: 'Friendly tournament',
          description_es: null,
          description_en: null,
          date_kind: 'single',
          date: '2026-05-01',
          end_date: null,
          recurrence_label_es: null,
          recurrence_label_en: null,
          image_url: 'https://example.com/tournament.png',
          link_url: null,
        },
      ])

      const { listClubEvents } = await loadClubEventsService()

      const result = await listClubEvents()

      expect(result).toHaveProperty('upcoming')
      expect(result).toHaveProperty('past')
      expect(result.upcoming.map((e) => e.id)).toContain('evt-upcoming-1')
    })
  })

  describe('listEvents (from events-service.ts)', () => {
    it('excludes landing-only rows (both title_es and title_en populated)', async () => {
      const eventsSelectSpy = vi.fn(() => [
        {
          id: 'evt-internal-1',
          title: 'Internal Event',
          description: null,
          date: '2026-04-20',
          start_time: '18:00:00',
          end_time: '22:00:00',
          created_by: 'user-1',
          created_at: '2026-04-01T00:00:00Z',
        },
      ])
      sqlMock.addHandler({
        name: 'SELECT events excluding landing rows (title_es/title_en IS NULL)',
        verb: 'select',
        match: (stmt) =>
          stmt.table === 'events' &&
          hasExactSelectColumns(stmt, 'id, title, description, date, start_time, end_time, created_by, created_at') &&
          Boolean(stmt.whereClause?.includes('title_es')) &&
          Boolean(stmt.whereClause?.includes('title_en')),
        respond: eventsSelectSpy,
      })
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks for the listed events',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks',
        respond: () => [],
      })

      const { listEvents } = await loadEventsService()

      const result = await listEvents()

      expect(eventsSelectSpy).toHaveBeenCalledTimes(1)
      expect(Array.isArray(result)).toBe(true)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('evt-internal-1')
    })
  })

  describe('updateClubEvent with fallback semantics edge cases (OIR-206 round 2)', () => {
    it('rule 2: explicit different titleEn + blank titleEn payload = re-enable auto-copy to new ES', async () => {
      addCurrentEventSelectHandler(currentEventRow({ title_es: 'Evento Antiguo', title_en: 'Old Explicit Title' }))
      addUpdateEventHandler((values) => [currentEventRow({ title_es: values[0] as string, title_en: values[1] as string })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: '', // Blank = re-enable auto-copy
      })

      expect(result.titleEn).toBe('Evento Nuevo') // Follows new ES
    })

    it('rule 1: resending identical titleEn (en === es deliberately) + ES change = EN preserved', async () => {
      addCurrentEventSelectHandler(currentEventRow({ title_es: 'Evento Antiguo', title_en: 'Evento Antiguo' }))
      addUpdateEventHandler((values) => [currentEventRow({ title_es: values[0] as string, title_en: values[1] as string })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: 'Evento Antiguo', // Resend explicit identical value
      })

      expect(result.titleEn).toBe('Evento Antiguo') // Preserved by rule 1
    })

    it('rule 2: whitespace-only titleEn behaves as blank (re-enable auto-copy to new ES)', async () => {
      addCurrentEventSelectHandler(currentEventRow({ title_es: 'Evento Antiguo', title_en: 'Old Explicit Title' }))
      addUpdateEventHandler((values) => [currentEventRow({ title_es: values[0] as string, title_en: values[1] as string })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        titleEs: 'Evento Nuevo',
        titleEn: '   ', // Whitespace-only = treated as empty (rule 2)
      })

      expect(result.titleEn).toBe('Evento Nuevo') // Follows new ES
    })

    it('rule 2: blank blurbEn (nullable) re-enables auto-copy to new ES (nullable field)', async () => {
      addCurrentEventSelectHandler(currentEventRow({ blurb_es: 'Viejo resumen', blurb_en: 'Old blurb summary' }))
      addUpdateEventHandler((values) => [currentEventRow({ blurb_es: values[2] as string, blurb_en: values[3] as string })])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { updateClubEvent } = await loadClubEventsService()

      const result = await updateClubEvent(createAdminSession(), 'evt-1', {
        blurbEs: 'Nuevo resumen',
        blurbEn: '', // Blank = re-enable auto-copy (rule 2)
      })

      expect(result.blurbEn).toBe('Nuevo resumen')
    })
  })

  // ---------------------------------------------------------------------------
  // #304 code-review regression coverage: applyClubEventBlocksAndMaterials'
  // rollback/compensation paths (rollbackClubEventBlocksWrite, the batched
  // room->table lookup's own rollback, per-step rollback resilience, and the
  // ClubEventReadBackError read-back-after-commit path). None of these were
  // covered by the tests above, which only exercise the block/material
  // write-loop failures, not the lookup-before-the-loop or read-back-after
  // failure branches.
  // ---------------------------------------------------------------------------
  describe('applyClubEventBlocksAndMaterials rollback resilience (#304 code-review)', () => {
    it('restores deleted blocks and materials when the batched room->table lookup fails (high-effort finding)', async () => {
      const deletedBlockRow = {
        id: 'block-old-1', event_id: 'evt-1', room_id: 'room-old', table_id: null,
        date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00', all_day: false,
      }
      const deletedMaterialRow = { event_id: 'evt-1', equipment_id: 'equip-old', quantity: 2 }

      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler()
      addUpdateEventHandler(() => [currentEventRow()])
      // Comparison fetch (fetchEventRoomBlocks, no ORDER BY) — deliberately
      // differs from the incoming schedule so the block-replace step runs.
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (comparison fetch, no ORDER BY)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS) && !stmt.orderBy,
        respond: () => [{ ...deletedBlockRow }],
      })
      addEventExistsHandler(true)
      addBlocksDeleteHandler([deletedBlockRow])
      addMaterialsDeleteHandler([deletedMaterialRow])
      // The batched room->table lookup itself fails — after both DELETEs
      // above (with their RETURNING captures) have already committed.
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (roomTableMap, throws)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => { throw new Error('room->table lookup failed') },
      })
      const blockReinsertSpy = vi.fn()
      sqlMock.addHandler({
        name: 'INSERT event_room_blocks (rollback reinsert, no RETURNING)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_room_blocks' && !stmt.returning,
        respond: (stmt) => {
          blockReinsertSpy(stmt.values)
          return []
        },
      })
      const materialReinsertSpy = vi.fn()
      addMaterialsInsertHandler((values) => materialReinsertSpy(values))
      addRevertEventHandler()

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '10:00', endTime: '14:00', allDay: false, roomId: 'room-1' },
          ],
          materials: [],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // The block DELETE'd earlier in the call must be reinserted…
      expect(blockReinsertSpy).toHaveBeenCalledTimes(1)
      expect(blockReinsertSpy.mock.calls[0][0]).toEqual([
        'block-old-1', 'evt-1', 'room-old', null, '2026-04-20', '18:00:00', '22:00:00', false,
      ])
      // …and so must the material DELETE'd earlier in the same call.
      expect(materialReinsertSpy).toHaveBeenCalledTimes(1)
      expect(materialReinsertSpy.mock.calls[0][0]).toEqual(['evt-1', 'equip-old', 2])
    })

    it('per-step rollback resilience: a failure in one compensating step does not block later steps (high-effort finding)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler()
      addEquipmentExistsHandler()
      addUpdateEventHandler(() => [currentEventRow()])
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (comparison fetch, no ORDER BY)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS) && !stmt.orderBy,
        respond: () => [{
          id: 'block-other', event_id: 'evt-1', room_id: 'room-other', table_id: null,
          date: '2026-04-20', start_time: '09:00:00', end_time: '10:00:00', all_day: false,
        }],
      })
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([{ event_id: 'evt-1', equipment_id: 'equip-old', quantity: 5 }])
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (roomTableMap)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => [{ id: 'table-1', room_id: 'room-1' }],
      })
      addBlockInsertHandler('block-new')
      addReservationsCancelHandler(() => [{ id: 'res-1', status: 'active' }])

      // First material insert succeeds, second fails — triggers the
      // compensating rollback mid-materials-loop, with one already-inserted
      // block and one already-cancelled reservation from the earlier
      // blocks loop still needing cleanup.
      let materialInsertCount = 0
      const materialInsertSpy = vi.fn()
      sqlMock.addHandler({
        name: 'INSERT event_equipment (second insert fails, mid-loop)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_equipment',
        respond: (stmt) => {
          materialInsertCount += 1
          if (materialInsertCount === 2) throw new Error('material insert failed')
          materialInsertSpy(stmt.values)
          return []
        },
      })

      // Rollback step 1 (delete THIS call's inserted blocks) fails — this
      // must NOT prevent the later independent steps (reservation restore,
      // material reinsert) from still running.
      sqlMock.prependHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback delete-inserted, throws)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'event_id'),
        respond: () => { throw new Error('rollback delete-inserted-blocks failed') },
      })

      const reservationRestoreSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE reservations SET status=active (restore, no table_id in WHERE)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'status') && !whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          reservationRestoreSpy(stmt.values)
          return []
        },
      })

      addRevertEventHandler()

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '10:00', endTime: '14:00', allDay: false, roomId: 'room-1' },
          ],
          materials: [
            { equipmentId: 'equip-a', quantity: 1 },
            { equipmentId: 'equip-b', quantity: 1 },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // Step 1 (delete this call's inserted blocks) failed (logged, non-fatal)
      // — but the reservation-restore step still ran despite that.
      expect(reservationRestoreSpy).toHaveBeenCalledTimes(1)
      expect(reservationRestoreSpy.mock.calls[0][0][0]).toEqual(['res-1'])
      // …and so did the material-reinsert step: one forward-loop insert
      // (equip-a, before the failure) plus one rollback reinsert (equip-old,
      // the pre-existing material this call had deleted).
      expect(materialInsertSpy).toHaveBeenCalledTimes(2)
      expect(materialInsertSpy.mock.calls[0][0]).toEqual(['evt-1', 'equip-a', 1])
      expect(materialInsertSpy.mock.calls[1][0]).toEqual(['evt-1', 'equip-old', 5])

      consoleErrorSpy.mockRestore()
    })

    it('createClubEvent surfaces a ClubEventReadBackError as a failure WITHOUT deleting the successfully-written event row (high-effort finding)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (roomTableMap)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => [{ id: 'table-1', room_id: 'room-1' }],
      })
      addBlockInsertHandler('block')
      addReservationsCancelHandler(() => [])
      // The final read-back SELECT fails AFTER every write above has
      // already committed successfully.
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id ORDER BY ... (read-back, throws)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS) && Boolean(stmt.orderBy),
        respond: () => { throw new Error('read-back failed') },
      })
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { createClubEvent } = await loadClubEventsService()

      await expect(
        createClubEvent(createAdminSession(), {
          titleEs: 'Torneo',
          titleEn: 'Tournament',
          date: '2026-05-01',
          dateKind: 'single',
          blocksRooms: true,
          schedules: [
            { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      // The event row and its already-committed block write must be left
      // alone — a read-only failure must never trigger the orphan-row
      // compensating delete.
      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('updateClubEvent surfaces a ClubEventReadBackError as a failure WITHOUT reverting the successfully-written metadata (high-effort finding)', async () => {
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler()
      addUpdateEventHandler(() => [currentEventRow()])
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id (comparison fetch, no ORDER BY)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS) && !stmt.orderBy,
        respond: () => [{
          id: 'block-other', event_id: 'evt-1', room_id: 'room-other', table_id: null,
          date: '2026-04-20', start_time: '09:00:00', end_time: '10:00:00', all_day: false,
        }],
      })
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (roomTableMap)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => [{ id: 'table-1', room_id: 'room-1' }],
      })
      addBlockInsertHandler('block')
      addReservationsCancelHandler(() => [])
      sqlMock.addHandler({
        name: 'SELECT event_room_blocks WHERE event_id ORDER BY ... (read-back, throws)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, ROOM_BLOCK_COLUMNS) && Boolean(stmt.orderBy),
        respond: () => { throw new Error('read-back failed') },
      })
      const revertSpy = vi.fn()
      addRevertEventHandler(revertSpy)

      const { updateClubEvent } = await loadClubEventsService()

      await expect(
        updateClubEvent(createAdminSession(), 'evt-1', {
          blocksRooms: true,
          schedules: [
            { date: '2026-04-20', startTime: '10:00', endTime: '14:00', allDay: false, roomId: 'room-1' },
          ],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(revertSpy).not.toHaveBeenCalled()
    })
  })
})
