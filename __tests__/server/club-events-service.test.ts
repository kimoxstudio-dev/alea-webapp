// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSqlMock, hasExactSelectColumns, whereHasColumn, neonDbError, type ParsedStatement } from '../helpers/sql-mock'

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

// ---------------------------------------------------------------------------
// Shared column-list constants (mirror lib/server/club-events-service.ts and
// lib/server/events-service.ts exactly — used to disambiguate the several
// SELECT/RETURNING shapes issued against the "events" table).
// ---------------------------------------------------------------------------

// `date::text as date`/`end_date::text as end_date`: production added these
// casts (#313 smoke-pass finding) since the Neon driver otherwise parses the
// `date` column (OID 1082) into a JS `Date` object, not a string, crashing
// formatClubEventDate on the client. Mirror exactly or hasExactSelectColumns
// stops matching.
const ADMIN_RETURNING_COLUMNS =
  'id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date::text as date, end_date::text as end_date, recurrence_label_es, recurrence_label_en, image_url, link_url, category_es, category_en'

// listAdminClubEvents's own SELECT is a separate literal column list (not
// built from ADMIN_CLUB_EVENT_RETURNING). PR #354 review: it must also
// select `title` — toAdminClubEvent falls back to it via
// `row.title_es ?? row.title` for internal-only events (title_es null),
// so omitting it here silently broke that fallback.
const ADMIN_LIST_COLUMNS =
  'id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date::text as date, end_date::text as end_date, recurrence_label_es, recurrence_label_en, image_url, link_url, category_es, category_en'

const PUBLIC_RETURNING_COLUMNS =
  'id, title_es, title_en, blurb_es, blurb_en, description_es, description_en, date_kind, date::text as date, end_date::text as end_date, recurrence_label_es, recurrence_label_en, image_url, link_url'

const ROOM_BLOCK_COLUMNS = 'id, event_id, room_id, table_id, date::text as date, start_time, end_time, all_day'

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
 * Handles the three "tables" SELECT shapes club-events-service.ts issues:
 * - `SELECT id FROM tables WHERE id = ANY(...)` (validateTablesExist)
 * - `SELECT id, room_id FROM tables WHERE room_id = ANY(...)` — the
 *   room-wide fallback lookup (`fetchRoomTableMap`, events-service.ts),
 *   narrowed (#378) to only rooms referenced by a block with a null
 *   `table_id`.
 * - `SELECT id, room_id FROM tables WHERE id = ANY(...)` — the table/room
 *   mismatch guard's own lookup (#378), split out from the room-wide query
 *   above so a call whose blocks are all table-scoped still gets a correct
 *   `tableRoomMap` even though the room-wide query is skipped entirely.
 * The last two shapes share a column list (`id, room_id`) but differ in
 * WHERE column (`room_id` vs `id`), so they're distinguished by
 * `whereHasColumn` rather than by a shared `any(` substring check.
 */
function addTablesHandler(opts: { missingTableIds?: string[]; roomTableIds?: Record<string, string[]> } = {}) {
  const { missingTableIds = [], roomTableIds = {} } = opts
  const tableToRoom: Record<string, string> = {}
  for (const [roomId, tableIds] of Object.entries(roomTableIds)) {
    for (const tableId of tableIds) tableToRoom[tableId] = roomId
  }
  sqlMock.addHandler({
    name: 'SELECT id FROM tables WHERE id = ANY(...) (validateTablesExist)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id'),
    respond: (stmt) => {
      const ids = stmt.values[0] as string[]
      return ids.filter((id) => !missingTableIds.includes(id)).map((id) => ({ id }))
    },
  })
  sqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...) (room-wide fallback lookup)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id') && whereHasColumn(stmt, 'room_id'),
    respond: (stmt) => {
      const roomIds = stmt.values[0] as string[]
      return roomIds.flatMap((roomId) => (roomTableIds[roomId] ?? []).map((id) => ({ id, room_id: roomId })))
    },
  })
  sqlMock.addHandler({
    name: 'SELECT id, room_id FROM tables WHERE id = ANY(...) (table/room mismatch guard, #378)',
    verb: 'select',
    match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id') && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'room_id'),
    respond: (stmt) => {
      const tableIds = stmt.values[0] as string[]
      return tableIds
        .filter((id) => Object.hasOwn(tableToRoom, id) && !missingTableIds.includes(id))
        .map((id) => ({ id, room_id: tableToRoom[id] }))
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

/**
 * SELECT pg_advisory_xact_lock(hashtext(t)) FROM (...) — the first statement
 * of the `sql.transaction([lock, update])` `cancelActiveSavedGamesForRoomBlock`
 * now issues (code-review fix: coordinates with `createSavedGameForSession`'s
 * precheck+insert via the same per-table lock). The mock's `sql.transaction`
 * just runs every batched statement through this same handler set (see
 * `sql-mock.ts`'s transaction doc comment), so this must be registered
 * wherever `addSavedGamesCancelHandler` below is used.
 */
function addSavedGamesLockHandler() {
  sqlMock.addHandler({
    name: 'SELECT pg_advisory_xact_lock (saved-games cancel, #334)',
    verb: 'select',
    match: (stmt) => stmt.text.includes('pg_advisory_xact_lock'),
    respond: () => [{ pg_advisory_xact_lock: null }],
  })
}

/**
 * UPDATE saved_games AS saved SET status='cancelled', updated_at=now() FROM
 * (SELECT id, updated_at FROM saved_games WHERE table_id = ANY(...) AND
 * status='active' AND $N BETWEEN start_date AND end_date) AS prior WHERE
 * saved.id = prior.id RETURNING saved.id, prior.updated_at —
 * cancelActiveSavedGamesForRoomBlock (#334), the second statement of its
 * `sql.transaction()`. Disambiguated from the restore handler below (also
 * `saved_games`, also `update`) by the presence of `table_id` in the WHERE
 * clause — only the cancel query's (nested) WHERE filters on it. Also
 * registers the lock handler above, since production code always issues
 * both statements together.
 */
function addSavedGamesCancelHandler(respond: (stmt: ParsedStatement) => unknown = () => []) {
  addSavedGamesLockHandler()
  sqlMock.addHandler({
    name: 'UPDATE saved_games cancel active (#334)',
    verb: 'update',
    match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
    respond,
  })
}

/**
 * UPDATE saved_games SET status='active', updated_at=restored.updated_at
 * FROM (SELECT * FROM unnest(...) AS restored(id, updated_at)) AS restored
 * WHERE saved_games.id = restored.id AND saved_games.status='cancelled' —
 * restoreCancelledSavedGames (#334), the compensating rollback for the
 * cancel handler above. Restores both the status AND the pre-cancellation
 * `updated_at` (code-review finding: the rollback used to leave `updated_at`
 * at its cancellation-time value). No `table_id` in its WHERE clause, which
 * is exactly what separates it from the cancel query.
 */
function addSavedGamesRestoreHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
    name: 'UPDATE saved_games restore cancelled (#334)',
    verb: 'update',
    match: (stmt) => stmt.table === 'saved_games' && !whereHasColumn(stmt, 'table_id'),
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
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

/** SELECT room_id, table_id, date::text AS date, start_time, end_time FROM event_room_blocks WHERE event_id=$1 — deleteEventCascade's blocks fetch (#353 fix: table_id now selected so cancellation can be table-scoped) */
function addCascadeBlocksFetchHandler(blocks: unknown[] = []) {
  sqlMock.addHandler({
    name: 'SELECT room_id, table_id, date::text AS date, start_time, end_time FROM event_room_blocks (cascade)',
    verb: 'select',
    match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, 'room_id, table_id, date::text as date, start_time, end_time'),
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

/**
 * UPDATE reservations SET status='active' WHERE id = ANY(...) AND
 * status='cancelled' — restoreCancelledReservations, deleteEventCascade's
 * compensating rollback for a reservation that was originally 'active'.
 * Disambiguated from the cancel-overlapping handler (also `reservations`,
 * also `update`) by the absence of `table_id` in the WHERE clause, and from
 * the 'pending' restore handler below by the `SET status = 'active'` literal
 * in the statement text — the SET value is a literal, not a bound param, so
 * both restore branches share the exact same `id = ANY(...) AND status =
 * 'cancelled'` WHERE shape and can only be told apart by that literal.
 */
function addReservationsRestoreActiveHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
    name: "UPDATE reservations SET status = 'active' (deleteEventCascade rollback)",
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && !whereHasColumn(stmt, 'table_id') && stmt.text.includes("status = 'active'"),
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
  })
}

/**
 * UPDATE reservations SET status='pending' WHERE id = ANY(...) AND
 * status='cancelled' — restoreCancelledReservations, deleteEventCascade's
 * compensating rollback for a reservation that was originally 'pending'. See
 * `addReservationsRestoreActiveHandler` above for why the `status = 'pending'`
 * literal, not WHERE shape, is what disambiguates the two branches.
 */
function addReservationsRestorePendingHandler(spy?: (values: unknown[]) => void) {
  sqlMock.addHandler({
    name: "UPDATE reservations SET status = 'pending' (deleteEventCascade rollback)",
    verb: 'update',
    match: (stmt) => stmt.table === 'reservations' && !whereHasColumn(stmt, 'table_id') && stmt.text.includes("status = 'pending'"),
    respond: (stmt) => {
      spy?.(stmt.values)
      return []
    },
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

    it('creates a club event with titleEn absent, succeeds with title_en === title_es in DB', async () => {
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

    it('creates a club event with titleEn empty string, succeeds with fallback', async () => {
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

    it('creates a club event with explicit titleEn, preserves EN value', async () => {
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

    it('creates a club event with blurbEn absent, falls back to blurbEs', async () => {
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

    it('creates a club event with categoryEn absent, falls back to categoryEs', async () => {
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

    it('rejects categoryEn as non-string object (still 400, not fallback)', async () => {
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

    it('creates a club event with blocksRooms:true, inserting a room block via the sequential SQL flow', async () => {
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

    it('skips the room-wide table lookup when every block is table-scoped (#378)', async () => {
      // Regression guard for #378: `fetchRoomTableMap`'s room-id list used
      // to be built from EVERY block's room_id regardless of table_id, so
      // this SELECT ran even though a table-scoped block never consults the
      // room-wide map. No handler for that `room_id = ANY(...)` shape is
      // registered here (only validateTablesExist's `id = ANY(...)` and the
      // separate table/room mismatch-guard lookup are) — if the room-wide
      // fetch is (re)issued unconditionally, the sql-mock's "no handler
      // matched" throw (no silent [] fallback) fails this test.
      addCreateInsertHandler()
      addRoomsExistHandler()
      sqlMock.addHandler({
        name: 'SELECT id FROM tables WHERE id = ANY(...) (validateTablesExist)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id'),
        respond: (stmt) => (stmt.values[0] as string[]).map((id) => ({ id })),
      })
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE id = ANY(...) (mismatch guard)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id') && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'room_id'),
        respond: (stmt) => (stmt.values[0] as string[]).map((id) => ({ id, room_id: 'room-1' })),
      })
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const insertedBlocks: unknown[] = []
      addBlockInsertHandler('block', (values) => {
        const [event_id, room_id, table_id, date, start_time, end_time, all_day] = values
        insertedBlocks.push({ id: `block-${insertedBlocks.length + 1}`, event_id, room_id, table_id, date, start_time, end_time, all_day })
      })
      addReservationsCancelHandler()
      addSavedGamesCancelHandler()
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
        titleEs: 'Torneo con Mesa',
        titleEn: 'Tournament with Table',
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
            tableId: 'table-1',
          },
        ],
      })

      expect(result.roomBlocks[0].tableId).toBe('table-1')
    })

    it('resolves a table-scoped block and a room-wide block sharing the same room independently (#378 mismatch-guard coverage)', async () => {
      // kx-reviewer round 1 (#378): the two-query split's whole point is that
      // `tableRoomMap` (mismatch guard) must cover every table-scoped block
      // regardless of whether that block's room ALSO has a room-wide block —
      // narrowing that lookup to only rooms WITHOUT a room-wide block would
      // wrongly 400 this exact scenario. Two schedules in the same room:
      // one table-scoped ('table-1'), one room-wide (no tableId).
      addCreateInsertHandler()
      addRoomsExistHandler()
      addTablesHandler({ roomTableIds: { 'room-1': ['table-1', 'table-2'] } })
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      const insertedBlocks: unknown[] = []
      addBlockInsertHandler('block', (values) => {
        const [event_id, room_id, table_id, date, start_time, end_time, all_day] = values
        insertedBlocks.push({ id: `block-${insertedBlocks.length + 1}`, event_id, room_id, table_id, date, start_time, end_time, all_day })
      })
      const cancelSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (mixed room-wide + table-scoped, #378)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          cancelSpy(stmt.values[0])
          return []
        },
      })
      addSavedGamesCancelHandler()
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
        titleEs: 'Torneo Mixto',
        titleEn: 'Mixed Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          {
            date: '2026-05-01',
            startTime: '18:00',
            endTime: '20:00',
            allDay: false,
            roomId: 'room-1',
            tableId: 'table-1',
          },
          {
            date: '2026-05-01',
            startTime: '20:00',
            endTime: '22:00',
            allDay: false,
            roomId: 'room-1',
          },
        ],
      })

      // The mismatch guard didn't fire for the table-scoped block despite its
      // room also carrying a room-wide block — proving createClubEvent as a
      // whole didn't reject with 400.
      expect(result.roomBlocks).toHaveLength(2)
      expect(cancelSpy).toHaveBeenCalledTimes(2)
      // Block 1 (table-scoped): cancellation is scoped to 'table-1' only.
      expect(cancelSpy.mock.calls[0][0]).toEqual(['table-1'])
      // Block 2 (room-wide, null table_id): cancellation covers every table
      // in the room, resolved via the room-wide roomTableMap.
      expect(cancelSpy.mock.calls[1][0]).toEqual(['table-1', 'table-2'])
    })

    it('rolls back (deletes) the created event when the block/material write fails, leaving no orphan row', async () => {
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

    it('logs the orphaned event id when BOTH the block write and the compensating delete fail, and still rethrows the original error', async () => {
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

    it('rejects an unknown room id in schedules with 400 BEFORE inserting the event row', async () => {
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

    it('rejects malformed schedules with 400 and no insert on events table', async () => {
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

    it('rejects blurbEs as object with 400', async () => {
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

    it('rejects categoryEn as array with 400', async () => {
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

    it('rejects malformed schedules with 400 and no update on events table', async () => {
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

    it('replaces blocks when schedules differ from current blocks', async () => {
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

    it('rejects an unknown room id in schedules with 400 BEFORE updating the event fields', async () => {
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

    it('rejects an unknown table id in schedules with 400 BEFORE updating the event fields', async () => {
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

    it('surfaces a clear 400 (not an unhandled rejection) when room, table, AND equipment validation all fail concurrently (concurrent validation)', async () => {
      // validateRoomsExist/validateTablesExist/validateEquipmentExists now
      // run via Promise.all instead of sequential awaits — with all three
      // failing at once, Promise.all rejects with the first settled
      // rejection while the other two rejections must not escape as
      // unhandled promise rejections.
      addCurrentEventSelectHandler(currentEventRow())
      addRoomsExistHandler(['room-unknown'])
      addTablesHandler({ missingTableIds: ['table-unknown'] })
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

      const unhandledRejections: unknown[] = []
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
      process.on('unhandledRejection', onUnhandledRejection)

      const { updateClubEvent } = await loadClubEventsService()

      try {
        await expect(
          updateClubEvent(createAdminSession(), 'evt-1', {
            blocksRooms: true,
            schedules: [
              { date: '2026-04-20', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-unknown', tableId: 'table-unknown' },
            ],
            materials: [{ equipmentId: 'equip-unknown', quantity: 1 }],
          })
        ).rejects.toMatchObject({ statusCode: 400 })
      } finally {
        // Let any pending microtasks (the other two rejected validations)
        // flush before asserting no unhandled rejection escaped.
        await new Promise((resolve) => setTimeout(resolve, 0))
        process.off('unhandledRejection', onUnhandledRejection)
      }

      expect(updateSpy).not.toHaveBeenCalled()
      expect(unhandledRejections).toHaveLength(0)
    })

    it('rejects an unknown equipment id in materials with 400 BEFORE updating the event fields', async () => {
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

    it('reverts the event fields UPDATE when the block-replace step fails, leaving no partial update', async () => {
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

    it('logs when both the block-replace step and the compensating revert fail, and still rethrows the original error', async () => {
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
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      const cancelSpy = vi.fn(() => [])
      addReservationsCancelHandler(cancelSpy)
      addSavedGamesCancelHandler(() => [])
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      expect(cancelSpy).toHaveBeenCalledTimes(1)
      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('only cancels reservations on the block\'s own table, not other tables in the same room (#353)', async () => {
      // Regression for #353: deleteEventCascade used to always cancel
      // reservations across every table in the room, ignoring the block's
      // own table_id. A room with two tables ('table-A', 'table-B') and a
      // block scoped to 'table-A' only must not touch a reservation on
      // 'table-B', even though it overlaps the same room/date/time window.
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: 'table-A', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([
        { id: 'table-A', room_id: 'room-1' },
        { id: 'table-B', room_id: 'room-1' },
      ])

      const seededReservations = [
        { id: 'res-table-a', table_id: 'table-A', status: 'active' },
        { id: 'res-table-b', table_id: 'table-B', status: 'active' },
      ]
      const cancelSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (table-scoped, #353 regression)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          cancelSpy(stmt.values)
          const tableIds = stmt.values[0] as string[]
          return seededReservations
            .filter((r) => tableIds.includes(r.table_id))
            .map((r) => ({ id: r.id, status: r.status }))
        },
      })
      addSavedGamesCancelHandler(() => [])
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      // The cancellation query must have been scoped to table-A only.
      expect(cancelSpy).toHaveBeenCalledTimes(1)
      const [values] = cancelSpy.mock.calls[0]
      const tableIdsArg = (values as unknown[])[0]
      expect(tableIdsArg).toEqual(['table-A'])

      // Asserted via the seeded-data filter above: res-table-a was cancelled
      // (returned from the mocked UPDATE...RETURNING), res-table-b was not
      // (never matched table_id = ANY(['table-A'])) — proving the reservation
      // on the other table in the room survives the cascade.
      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('skips the room->table lookup entirely when every block is table-scoped (#378)', async () => {
      // Regression guard for #378: `fetchRoomTableMap`'s room-id list used
      // to be built from EVERY block's room_id regardless of table_id, so
      // this SELECT ran even when no block needed the room-wide fallback.
      // No 'tables' handler is registered in this test — if the lookup is
      // (re)issued unconditionally, the sql-mock's "no handler matched"
      // throw (no silent [] fallback) fails this test.
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: 'table-A', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addReservationsCancelHandler(() => [])
      addSavedGamesCancelHandler(() => [])
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('returns 500 when the event_room_blocks fetch fails (deleteEventCascade)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      sqlMock.addHandler({
        name: 'SELECT room_id, table_id, date::text AS date, start_time, end_time FROM event_room_blocks (cascade, failing)',
        verb: 'select',
        match: (stmt) => stmt.table === 'event_room_blocks' && hasExactSelectColumns(stmt, 'room_id, table_id, date::text as date, start_time, end_time'),
        respond: () => { throw new Error('blocks fetch failed') },
      })

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })
    })

    it('returns 500 when the room->table lookup fails (deleteEventCascade)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables (cascade, failing)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => { throw new Error('table lookup failed') },
      })

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })
    })

    it('restores already-cancelled reservations and returns 500 when a later reservation-cancel fails (deleteEventCascade, multi-block)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
        { room_id: 'room-1', table_id: null, date: '2026-04-21', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])

      let callCount = 0
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (second call fails)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => {
          callCount += 1
          if (callCount === 2) throw new Error('second cancel failed')
          return [{ id: 'res-1', status: 'active' }]
        },
      })
      // Saved games cancellation must succeed for both blocks so this test
      // still exercises its intended failure point (the second block's
      // reservation cancel), not an incidental unmocked saved_games query.
      addSavedGamesCancelHandler(() => [])
      const restoreActiveSpy = vi.fn()
      const restorePendingSpy = vi.fn()
      addReservationsRestoreActiveHandler(restoreActiveSpy)
      addReservationsRestorePendingHandler(restorePendingSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })

      // The cancelled reservation was originally 'active' — restore must route
      // through the 'active' branch, not 'pending' (a mutation inverting the
      // pendingIds/activeIds filters in restoreCancelledReservations would
      // otherwise pass this test unchanged).
      expect(restoreActiveSpy).toHaveBeenCalledWith([['res-1']])
      expect(restorePendingSpy).not.toHaveBeenCalled()
    })

    it('restores cancelled reservations and returns 500 when the final DELETE FROM events fails (deleteEventCascade)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      addReservationsCancelHandler(() => [{ id: 'res-1', status: 'pending' }])
      // Saved games cancellation must succeed so this test reaches its
      // intended failure point (the final DELETE FROM events), not an
      // incidental unmocked saved_games query.
      addSavedGamesCancelHandler(() => [])
      const restoreActiveSpy = vi.fn()
      const restorePendingSpy = vi.fn()
      addReservationsRestoreActiveHandler(restoreActiveSpy)
      addReservationsRestorePendingHandler(restorePendingSpy)
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (failing)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: () => { throw new Error('delete failed') },
      })

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })

      // The cancelled reservation was originally 'pending' — restore must
      // route through the 'pending' branch, not 'active'.
      expect(restorePendingSpy).toHaveBeenCalledWith([['res-1']])
      expect(restoreActiveSpy).not.toHaveBeenCalled()
    })

    // Regression for #375: deleteEventCascade cancelled overlapping
    // reservations but never overlapping active saved_games, unlike the
    // create/update path (applyClubEventBlocksAndMaterials, tested above
    // under "cancelActiveSavedGamesForRoomBlock / restoreCancelledSavedGames").
    it('cancels active saved games scoped to the block\'s own table when deleting an event with a table-scoped block (#375)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: 'table-A', date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([
        { id: 'table-A', room_id: 'room-1' },
        { id: 'table-B', room_id: 'room-1' },
      ])
      addReservationsCancelHandler(() => [])
      const savedGamesCancelSpy = vi.fn()
      addSavedGamesCancelHandler((stmt) => {
        savedGamesCancelSpy(stmt.values)
        return [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }]
      })
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      // Table-scoped: only the block's own table (table-A) is passed, not
      // table-B, which is in the same room but outside the block's scope.
      // Also asserts the block's own date is the second bound param — a
      // mutation swapping in e.g. `block.start_time` instead of `block.date`
      // would otherwise go undetected (the date is the entire overlap
      // predicate: `${date} BETWEEN start_date AND end_date`).
      expect(savedGamesCancelSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesCancelSpy.mock.calls[0][0]).toEqual([['table-A'], '2026-04-20'])
      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('cancels active saved games room-wide when deleting an event with a room-wide block (#375)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([
        { id: 'table-A', room_id: 'room-1' },
        { id: 'table-B', room_id: 'room-1' },
      ])
      addReservationsCancelHandler(() => [])
      const savedGamesCancelSpy = vi.fn()
      addSavedGamesCancelHandler((stmt) => {
        savedGamesCancelSpy(stmt.values)
        return [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }]
      })
      const deleteSpy = vi.fn()
      addEventsDeleteHandler(deleteSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await deleteClubEvent(createAdminSession(), 'evt-1')

      // Room-wide (table_id null): every table in the room is passed, and
      // (same rationale as the table-scoped test above) the block's own date
      // is asserted as the second bound param, not just the table list.
      expect(savedGamesCancelSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesCancelSpy.mock.calls[0][0]).toEqual([['table-A', 'table-B'], '2026-04-20'])
      expect(deleteSpy).toHaveBeenCalledWith(['evt-1'])
    })

    it('restores a cancelled saved game to active when the final DELETE FROM events fails (deleteEventCascade, #375)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      addReservationsCancelHandler(() => [])
      addSavedGamesCancelHandler(() => [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }])
      const savedGamesRestoreSpy = vi.fn()
      addSavedGamesRestoreHandler(savedGamesRestoreSpy)
      sqlMock.addHandler({
        name: 'DELETE events WHERE id (failing, #375)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'events',
        respond: () => { throw new Error('delete failed') },
      })

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })

      // The saved game cancelled above must be restored to 'active', with
      // its exact pre-cancellation updated_at (not just the status flipped),
      // mirroring the reservation-restore-on-final-delete-failure test above.
      expect(savedGamesRestoreSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesRestoreSpy.mock.calls[0][0][0]).toEqual(['sg-1'])
      expect(savedGamesRestoreSpy.mock.calls[0][0][1]).toEqual(['2026-04-01T10:00:00.000Z'])
    })

    // kx-reviewer round 1, HIGH: the per-block rollback branch had zero test
    // coverage that could actually fail — a mutation dropping both restore
    // calls from that catch, or dropping just the saved-games restore call,
    // left 72/72 tests green. These two tests each fail without the
    // corresponding restore call in events-service.ts's deleteEventCascade.
    it('restores both reservations and saved games cancelled by earlier blocks when a later block\'s saved-games cancel fails (deleteEventCascade, multi-block, #375)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
        { room_id: 'room-1', table_id: null, date: '2026-04-21', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])

      let reservationCallCount = 0
      addReservationsCancelHandler(() => {
        reservationCallCount += 1
        return [{ id: `res-${reservationCallCount}`, status: 'active' }]
      })

      let savedGamesCallCount = 0
      addSavedGamesCancelHandler(() => {
        savedGamesCallCount += 1
        if (savedGamesCallCount === 2) throw new Error('second saved-games cancel failed')
        return [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }]
      })

      const restoreActiveSpy = vi.fn()
      const restorePendingSpy = vi.fn()
      addReservationsRestoreActiveHandler(restoreActiveSpy)
      addReservationsRestorePendingHandler(restorePendingSpy)
      const savedGamesRestoreSpy = vi.fn()
      addSavedGamesRestoreHandler(savedGamesRestoreSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })

      // Block 1's reservation AND saved game were already cancelled by the
      // time block 2's saved-games cancel fails — both must be restored, not
      // just the reservation (which the code already restored before #375;
      // the saved-games restore is what #375 added to this exact branch).
      expect(restoreActiveSpy).toHaveBeenCalledWith([['res-1', 'res-2']])
      expect(restorePendingSpy).not.toHaveBeenCalled()
      expect(savedGamesRestoreSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesRestoreSpy.mock.calls[0][0][0]).toEqual(['sg-1'])
    })

    it('restores a saved game cancelled by an earlier block when a later block\'s reservation cancel fails (deleteEventCascade, multi-block, #375)', async () => {
      addDeleteGuardHandler({ id: 'evt-1', title_es: null, title_en: null })
      addCascadeBlocksFetchHandler([
        { room_id: 'room-1', table_id: null, date: '2026-04-20', start_time: '18:00:00', end_time: '22:00:00' },
        { room_id: 'room-1', table_id: null, date: '2026-04-21', start_time: '18:00:00', end_time: '22:00:00' },
      ])
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])

      let reservationCallCount = 0
      sqlMock.addHandler({
        name: 'UPDATE reservations cancel overlapping (second block\'s reservation cancel fails, #375)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'table_id'),
        respond: () => {
          reservationCallCount += 1
          if (reservationCallCount === 2) throw new Error('second reservation cancel failed')
          return [{ id: 'res-1', status: 'active' }]
        },
      })
      addSavedGamesCancelHandler(() => [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }])

      const restoreActiveSpy = vi.fn()
      const restorePendingSpy = vi.fn()
      addReservationsRestoreActiveHandler(restoreActiveSpy)
      addReservationsRestorePendingHandler(restorePendingSpy)
      const savedGamesRestoreSpy = vi.fn()
      addSavedGamesRestoreHandler(savedGamesRestoreSpy)

      const { deleteClubEvent } = await loadClubEventsService()

      await expect(
        deleteClubEvent(createAdminSession(), 'evt-1')
      ).rejects.toMatchObject({ statusCode: 500 })

      // The failure this time is in block 2's RESERVATION cancel (not its
      // saved-games cancel) — proving the reservation-failure catch also
      // restores a saved game cancelled by an earlier block, not just its
      // own reservations. Block 2 never reaches its own saved-games call, so
      // only block 1's sg-1 was ever cancelled.
      expect(restoreActiveSpy).toHaveBeenCalledWith([['res-1']])
      expect(restorePendingSpy).not.toHaveBeenCalled()
      expect(savedGamesRestoreSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesRestoreSpy.mock.calls[0][0][0]).toEqual(['sg-1'])
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

    it('falls back to the legacy `title` column for an internal-only event (title_es/title_en null)', async () => {
      // toAdminClubEvent does `row.title_es ?? row.title` / `row.title_en ??
      // row.title` — listAdminClubEvents's SELECT must fetch `title` or that
      // fallback silently resolves to undefined for internal-only rows.
      addListAdminEventsSelectHandler([
        currentEventRow({
          id: 'evt-internal-1',
          title_es: null,
          title_en: null,
          title: 'Evento Interno Legado',
          date: '2026-05-01',
        }),
      ])
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      const { listAdminClubEvents } = await loadClubEventsService()

      const result = await listAdminClubEvents(createAdminSession())

      const event = [...result.upcoming, ...result.past].find((e) => e.id === 'evt-internal-1')
      expect(event).toBeDefined()
      expect(event?.titleEs).toBe('Evento Interno Legado')
      expect(event?.titleEn).toBe('Evento Interno Legado')
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

    it('filters out a row with a null title_es/title_en via assertPublicClubEventRowsHaveBilingualTitles (defense-in-depth)', async () => {
      // The WHERE clause is the primary guarantee, but this guard is the
      // application-layer backstop for a regression in that query (RLS was
      // dropped in the Neon migration). Simulate that regression by having
      // the mocked SELECT hand back one bilingual row and one row that
      // slipped past the WHERE clause with a null title_en.
      addListClubEventsSelectHandler([
        {
          id: 'evt-bilingual',
          title_es: 'Evento Bilingue',
          title_en: 'Bilingual Event',
          blurb_es: null,
          blurb_en: null,
          description_es: null,
          description_en: null,
          date_kind: 'single',
          date: '2026-05-01',
          end_date: null,
          recurrence_label_es: null,
          recurrence_label_en: null,
          image_url: null,
          link_url: null,
        },
        {
          id: 'evt-leaked-internal',
          title_es: 'Titulo interno filtrado',
          title_en: null, // simulates a query-layer regression
          blurb_es: null,
          blurb_en: null,
          description_es: null,
          description_en: null,
          date_kind: 'single',
          date: '2026-05-02',
          end_date: null,
          recurrence_label_es: null,
          recurrence_label_en: null,
          image_url: null,
          link_url: null,
        },
      ])

      const { listClubEvents } = await loadClubEventsService()

      const result = await listClubEvents()

      const allIds = [...result.upcoming, ...result.past].map((e) => e.id)
      expect(allIds).toContain('evt-bilingual')
      expect(allIds).not.toContain('evt-leaked-internal')
    })
  })

  describe('updateClubEvent EN/ES title fallback semantics edge cases', () => {
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
  describe('applyClubEventBlocksAndMaterials rollback resilience', () => {
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
      addSavedGamesCancelHandler()

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
      addSavedGamesCancelHandler()
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
      addSavedGamesCancelHandler()
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

  describe('cancelActiveSavedGamesForRoomBlock / restoreCancelledSavedGames (table-scoped vs room-wide)', () => {
    it('cancels active saved games scoped to the block\'s own table only, when block.table_id is set — not room-wide (code-review fix)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      // Registered BEFORE addTablesHandler(): its broad `stmt.table ===
      // 'tables'` match (no column check) would otherwise intercept this
      // exact-column 'id, room_id' query too, since handlers dispatch
      // first-match-in-registration-order (see shared-sql-mock-broad-
      // handlers-need-disambiguation memory).
      // The room has two tables; the block itself only targets table-1.
      addCascadeTablesFetchHandler([
        { id: 'table-1', room_id: 'room-1' },
        { id: 'table-2', room_id: 'room-1' },
      ])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      addSavedGamesLockHandler()
      const savedGamesCancelSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE saved_games cancel active (table-scoped, spy)',
        verb: 'update',
        match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          savedGamesCancelSpy(stmt.values[0])
          return [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }]
        },
      })

      const { createClubEvent } = await loadClubEventsService()

      await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo',
        titleEn: 'Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1', tableId: 'table-1' },
        ],
      })

      expect(savedGamesCancelSpy).toHaveBeenCalledTimes(1)
      // Table-scoped (code-review fix): the block's own table_id is set, so
      // only table-1 is passed to the saved-games cancellation — table-2 is
      // NOT included, unlike the pre-fix room-wide-always behavior.
      expect(savedGamesCancelSpy.mock.calls[0][0]).toEqual(['table-1'])

      // Code-review finding (HIGH): structural proof the lock and the
      // cancellation UPDATE actually travelled together as one
      // sql.transaction([...]) call — without this, someone could revert
      // cancelActiveSavedGamesForRoomBlock back to two sequential `await
      // sql` calls (fully reopening the #334 race with
      // createSavedGameForSession) and this test would stay green, since the
      // lock/cancel handlers above match on statement shape regardless of
      // how they were dispatched.
      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      const batched = sqlMock.transaction.mock.calls[0]?.[0]
      expect(Array.isArray(batched)).toBe(true)
      expect(batched).toHaveLength(2)
      // Order matters (LOW 3 code-review finding): batch length alone
      // doesn't prove the lock runs first — [update, lock] would also have
      // length 2 and would reopen the race silently. `createClubEvent`
      // dispatches several more `sql` calls after this transaction
      // (materials insert, final read-back SELECTs), so — unlike
      // saved-games-service.ts's tests, where the transaction is the very
      // last DB call — the last two entries in sqlMock.sql's call history
      // are NOT necessarily this transaction's own two calls. Locate the
      // cancel UPDATE by its distinctive text instead, and check what
      // dispatched immediately before it.
      const dispatchedTexts = sqlMock.sql.mock.calls.map((call) => String(call[0]))
      const cancelUpdateIndex = dispatchedTexts.findIndex(
        (text) => text.includes('saved_games') && text.includes("'cancelled'"),
      )
      expect(cancelUpdateIndex).toBeGreaterThan(0)
      expect(dispatchedTexts[cancelUpdateIndex - 1]).toContain('pg_advisory_xact_lock')
    })

    it('cancels active saved games room-wide when the block has no table_id (room-wide block)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addCascadeTablesFetchHandler([
        { id: 'table-1', room_id: 'room-1' },
        { id: 'table-2', room_id: 'room-1' },
      ])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      addSavedGamesLockHandler()
      const savedGamesCancelSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE saved_games cancel active (room-wide, spy)',
        verb: 'update',
        match: (stmt) => stmt.table === 'saved_games' && whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          savedGamesCancelSpy(stmt.values[0])
          return [{ id: 'sg-1', updated_at: '2026-04-01T10:00:00.000Z' }]
        },
      })

      const { createClubEvent } = await loadClubEventsService()

      await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo',
        titleEn: 'Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          // No tableId — a room-wide block, so scope falls back to every
          // table in the room via roomTableMap.
          { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
        ],
      })

      expect(savedGamesCancelSpy).toHaveBeenCalledTimes(1)
      expect(savedGamesCancelSpy.mock.calls[0][0]).toEqual(['table-1', 'table-2'])

      // Code-review finding (HIGH): same structural batching proof as the
      // table-scoped test above.
      expect(sqlMock.transaction).toHaveBeenCalledTimes(1)
      const batched = sqlMock.transaction.mock.calls[0]?.[0]
      expect(Array.isArray(batched)).toBe(true)
      expect(batched).toHaveLength(2)
      // Order matters (LOW 3 code-review finding) — see the table-scoped
      // test's comment above for why batch length alone doesn't prove it,
      // and why the check locates the cancel UPDATE by content instead of
      // assuming it's among the last two dispatched calls.
      const dispatchedTexts = sqlMock.sql.mock.calls.map((call) => String(call[0]))
      const cancelUpdateIndex = dispatchedTexts.findIndex(
        (text) => text.includes('saved_games') && text.includes("'cancelled'"),
      )
      expect(cancelUpdateIndex).toBeGreaterThan(0)
      expect(dispatchedTexts[cancelUpdateIndex - 1]).toContain('pg_advisory_xact_lock')
    })

    it('does not cancel a saved game whose status is not "active" (e.g. already cancelled) — enforced by the mock only matching the active-status query, verified via the real WHERE guard', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      // Simulates the real UPDATE's own `status = 'active'` WHERE guard: a
      // saved game that is already 'cancelled'/'completed' never matches the
      // real query's WHERE clause, so the RETURNING set is empty — no id
      // comes back and cancelledSavedGameIds stays empty.
      addSavedGamesCancelHandler(() => [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo',
        titleEn: 'Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
        ],
      })

      expect(result.id).toBe('evt-new-1')
    })

    it('does not cancel a saved game whose date falls outside its [start_date, end_date] range — enforced by the mock only matching the BETWEEN-satisfying query', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      // Simulates the real UPDATE's `$date BETWEEN start_date AND end_date`
      // guard: a saved game whose range doesn't cover the block's date never
      // matches, so RETURNING comes back empty.
      addSavedGamesCancelHandler(() => [])

      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo',
        titleEn: 'Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
        ],
      })

      expect(result.id).toBe('evt-new-1')
    })

    it('early-returns with no query issued when the room has no tables (empty tableIds)', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      // Room has zero tables — roomTableMap.get(room_id) is undefined, so
      // cancelActiveSavedGamesForRoomBlock's tableIds argument is [].
      addCascadeTablesFetchHandler([])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      addMaterialsInsertHandler()
      addEventRoomBlocksSelectHandler([])
      addEventMaterialsSelectHandler([])

      // No saved_games handler registered at all — if the early-return in
      // cancelActiveSavedGamesForRoomBlock did not fire, the unmatched UPDATE
      // would throw "no handler matched" and fail this test loudly.
      const { createClubEvent } = await loadClubEventsService()

      const result = await createClubEvent(createAdminSession(), {
        titleEs: 'Torneo',
        titleEn: 'Tournament',
        date: '2026-05-01',
        dateKind: 'single',
        blocksRooms: true,
        schedules: [
          { date: '2026-05-01', startTime: '18:00', endTime: '22:00', allDay: false, roomId: 'room-1' },
        ],
      })

      expect(result.id).toBe('evt-new-1')
    })

    it('rollback restores cancelled saved games to active when a later write in the same call fails', async () => {
      addCreateInsertHandler()
      addRoomsExistHandler()
      addCascadeTablesFetchHandler([{ id: 'table-1', room_id: 'room-1' }])
      addTablesHandler()
      addEventExistsHandler(true)
      addBlocksDeleteHandler([])
      addMaterialsDeleteHandler([])
      addBlockInsertHandler('block')
      addReservationsCancelHandler()
      // Two saved games get cancelled by the forward pass, each carrying its
      // own pre-cancellation `updated_at` (captured via the cancel query's
      // `RETURNING saved.id, prior.updated_at`). sg-1's comes back as a real
      // `Date` instance (code-review finding, LOW 4) — matching what
      // @neondatabase/serverless actually returns for a `timestamptz`
      // column in production, not the ISO string every other handler in
      // this file returns for convenience — so the `instanceof Date`
      // normalization branch in `cancelActiveSavedGamesForRoomBlock` is
      // actually exercised, not just plumbed through untouched.
      addSavedGamesCancelHandler(() => [
        { id: 'sg-1', updated_at: new Date('2026-04-01T10:00:00.000Z') },
        { id: 'sg-2', updated_at: '2026-04-01T11:30:00.000Z' },
      ])

      const savedGamesRestoreSpy = vi.fn()
      addSavedGamesRestoreHandler(savedGamesRestoreSpy)

      // The materials loop fails, triggering rollbackClubEventBlocksWrite —
      // which must restore the two saved games cancelled just above.
      addDeleteGuardHandler(null)
      sqlMock.addHandler({
        name: 'DELETE event_room_blocks WHERE id = ANY(...) (rollback delete-inserted)',
        verb: 'delete',
        match: (stmt) => stmt.table === 'event_room_blocks' && whereHasColumn(stmt, 'id') && !whereHasColumn(stmt, 'event_id'),
        respond: () => [],
      })
      const reservationRestoreSpy = vi.fn()
      sqlMock.addHandler({
        name: 'UPDATE reservations SET status=active (restore)',
        verb: 'update',
        match: (stmt) => stmt.table === 'reservations' && whereHasColumn(stmt, 'status') && !whereHasColumn(stmt, 'table_id'),
        respond: (stmt) => {
          reservationRestoreSpy(stmt.values)
          return []
        },
      })
      sqlMock.addHandler({
        name: 'INSERT event_equipment (fails)',
        verb: 'insert',
        match: (stmt) => stmt.table === 'event_equipment',
        respond: () => { throw new Error('material insert failed') },
      })

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

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
          materials: [{ equipmentId: 'equip-a', quantity: 1 }],
        })
      ).rejects.toMatchObject({ statusCode: 500 })

      expect(savedGamesRestoreSpy).toHaveBeenCalledTimes(1)
      // values[0] = ids, values[1] = each row's captured pre-cancellation
      // updated_at — the rollback restores both together (code-review fix),
      // not just the status.
      expect(savedGamesRestoreSpy.mock.calls[0][0][0]).toEqual(['sg-1', 'sg-2'])
      expect(savedGamesRestoreSpy.mock.calls[0][0][1]).toEqual([
        '2026-04-01T10:00:00.000Z', '2026-04-01T11:30:00.000Z',
      ])

      consoleErrorSpy.mockRestore()
    })
  })
})

// ---------------------------------------------------------------------------
// events-service.ts's own exported helpers, shared by club-events-service.ts
// (#353: the legacy events admin surface was removed and its unit tests along
// with it — these still-live shared validators need their own direct
// coverage rather than relying on it as an incidental side effect of
// club-events-service.ts's own scenarios).
// ---------------------------------------------------------------------------
describe('events-service shared helpers', () => {
  describe('validateAndNormaliseSchedule', () => {
    it('rejects a non-object schedule entry', async () => {
      const { validateAndNormaliseSchedule } = await import('@/lib/server/events-service')

      expect(() => validateAndNormaliseSchedule(null, 0)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      )
      expect(() => validateAndNormaliseSchedule('not-an-object', 0)).toThrow(
        expect.objectContaining({ statusCode: 400 }),
      )
    })

    it('an allDay schedule resolves to the 00:00-23:59 window regardless of the supplied times', async () => {
      const { validateAndNormaliseSchedule } = await import('@/lib/server/events-service')

      const result = validateAndNormaliseSchedule(
        { date: '2026-05-01', allDay: true, roomId: 'room-1' },
        0,
      )

      expect(result.all_day).toBe(true)
      expect(result.start_time).toBe('00:00')
      expect(result.end_time).toBe('23:59')
    })
  })

  describe('mapEventWriteError', () => {
    it('maps a mapped Postgres error code to 400 Invalid event data', async () => {
      const { mapEventWriteError } = await import('@/lib/server/events-service')

      expect(() => mapEventWriteError(neonDbError('23503'))).toThrow(
        expect.objectContaining({ statusCode: 400, message: 'Invalid event data' }),
      )
    })

    it('maps an unrecognised Postgres error code to 500 Internal server error', async () => {
      const { mapEventWriteError } = await import('@/lib/server/events-service')

      expect(() => mapEventWriteError(neonDbError('99999'))).toThrow(
        expect.objectContaining({ statusCode: 500 }),
      )
    })

    it('maps a non-NeonDbError to 500 Internal server error', async () => {
      const { mapEventWriteError } = await import('@/lib/server/events-service')

      expect(() => mapEventWriteError(new Error('unexpected'))).toThrow(
        expect.objectContaining({ statusCode: 500 }),
      )
    })
  })

  describe('resolveBlockCancellationTableIds', () => {
    it('returns just the block\'s own table when the block has a table_id', async () => {
      const { resolveBlockCancellationTableIds } = await import('@/lib/server/events-service')

      const roomTableMap = new Map([['room-1', ['table-1', 'table-2']]])

      expect(resolveBlockCancellationTableIds('table-2', 'room-1', roomTableMap)).toEqual(['table-2'])
    })

    it('returns every table of the room when the block has no table_id', async () => {
      const { resolveBlockCancellationTableIds } = await import('@/lib/server/events-service')

      const roomTableMap = new Map([['room-1', ['table-1', 'table-2']]])

      expect(resolveBlockCancellationTableIds(null, 'room-1', roomTableMap)).toEqual(['table-1', 'table-2'])
    })

    it('returns an empty array when the block has no table_id and the room has no entry in the map', async () => {
      const { resolveBlockCancellationTableIds } = await import('@/lib/server/events-service')

      const roomTableMap = new Map<string, string[]>()

      expect(resolveBlockCancellationTableIds(null, 'room-1', roomTableMap)).toEqual([])
    })
  })

  describe('fetchRoomTableMap (#378)', () => {
    beforeEach(() => {
      sqlMock.reset()
    })

    it('returns a room_id -> table ids map for the given room ids', async () => {
      sqlMock.addHandler({
        name: 'SELECT id, room_id FROM tables WHERE room_id = ANY(...)',
        verb: 'select',
        match: (stmt) => stmt.table === 'tables' && hasExactSelectColumns(stmt, 'id, room_id'),
        respond: () => [
          { id: 'table-1', room_id: 'room-1' },
          { id: 'table-2', room_id: 'room-1' },
          { id: 'table-3', room_id: 'room-2' },
        ],
      })
      const { fetchRoomTableMap } = await import('@/lib/server/events-service')

      const result = await fetchRoomTableMap(['room-1', 'room-2'])

      expect(result.get('room-1')).toEqual(['table-1', 'table-2'])
      expect(result.get('room-2')).toEqual(['table-3'])
    })

    it('returns an empty map without querying when roomIds is empty', async () => {
      // No handler is registered — if the query is (re)issued despite the
      // empty-guard, the sql-mock's "no handler matched" throw fails this
      // test in addition to the explicit call-count assertion below.
      const { fetchRoomTableMap } = await import('@/lib/server/events-service')

      const result = await fetchRoomTableMap([])

      expect(result.size).toBe(0)
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })
  })
})
