import 'server-only'
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, or } from 'drizzle-orm'
import { getAdminDb, getDrizzleAdminDb, getDrizzleDb, type AdminDbClient } from '@/lib/db'
import { events, eventRoomBlocks, savedGames, tables } from '@/lib/db/schema'
import { ServiceError, serviceError } from '@/lib/server/shared/service-error'
import type { AdminEvent, AdminEventRoomBlock, AdminEventSchedule } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth/auth'

export type { AdminEvent, AdminEventRoomBlock, AdminEventSchedule }

/**
 * KIM-434 (F3c) PR3: `events` / `event_room_blocks` reads/writes below use
 * the Drizzle/Neon seam (`getDrizzleDb()` / `getDrizzleAdminDb()`), following
 * the pattern established in `lib/server/equipment/equipment-service.ts`
 * (PR1) and `lib/server/tables/tables-service.ts` (PR2).
 *
 * `reservations` is owned by a service NOT yet migrated (PR5), so it
 * intentionally stays on the legacy Supabase seam (`getAdminDb()`) — see
 * `cancelOverlappingReservationsForBlocks()` below for the resulting
 * cross-database reservation-cancellation tradeoff, and the PR description's
 * "Split-brain disclosure" section for the full consistency caveat this
 * implies during the migration window.
 */

type EventRow = typeof events.$inferSelect
type EventRoomBlockRow = typeof eventRoomBlocks.$inferSelect
type EventAnchorFields = Pick<
  EventRow,
  'id' | 'title' | 'description' | 'date' | 'startTime' | 'endTime' | 'createdBy' | 'createdAt'
>

/**
 * Runs a Drizzle query, translating any thrown DB/driver error into a
 * uniform 500 ServiceError. Business-logic outcomes (e.g. "no row
 * returned" -> 404, validation -> 400) are handled by callers, outside this
 * wrapper, so their specific status codes aren't swallowed into a 500.
 */
async function runQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch {
    serviceError('Internal server error', 500)
  }
}

// Privilege checks (role === 'admin') live here in the service layer, not in
// route handlers (repo convention). These mutations use the admin client
// (bypasses RLS entirely), so this in-function check is the only
// authorization guard once RLS is removed as part of the Vercel/Postgres
// migration — mirrors events_admin_insert/update/delete RLS policies
// (is_admin()).
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

// ---------------------------------------------------------------------------
// Shared "is this a club-event (landing) row?" predicate (OIR-203 code
// review, Finding 3). A row becomes public landing content once BOTH
// title_es and title_en are populated (see lib/server/events/club-events-service.ts).
// Every legacy internal room-booking entry point (updateEvent, deleteEvent,
// and listEvents' bilingual-null filter) must treat such rows as out of
// scope for this surface — they are owned exclusively by the "Club events"
// admin flow.
// ---------------------------------------------------------------------------
export function isClubEventRow(row: Pick<EventRow, 'titleEs' | 'titleEn'>): boolean {
  return row.titleEs != null && row.titleEn != null
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const WHOLE_HOUR_TIME_RE = /^([01]\d|2[0-3]):00$/

function validateDateTimeFields(date: string, startTime: string, endTime: string): void {
  if (!DATE_RE.test(date)) serviceError('date must be in YYYY-MM-DD format', 400)
  if (!TIME_RE.test(startTime)) serviceError('startTime must be in HH:MM format', 400)
  if (!TIME_RE.test(endTime)) serviceError('endTime must be in HH:MM format', 400)
  if (!WHOLE_HOUR_TIME_RE.test(startTime)) serviceError('startTime must be on a whole-hour boundary', 400)
  if (!WHOLE_HOUR_TIME_RE.test(endTime)) serviceError('endTime must be on a whole-hour boundary', 400)
  if (endTime <= startTime) serviceError('endTime must be after startTime', 400)
}

function parseAllDay(value: unknown): boolean {
  return value === true || value === 'true'
}

function resolveBlockTimes(date: string, startTime: string, endTime: string, allDay: boolean) {
  if (!DATE_RE.test(date)) serviceError('date must be in YYYY-MM-DD format', 400)
  if (allDay) {
    return { startTime: '00:00', endTime: '23:59' }
  }

  validateDateTimeFields(date, startTime, endTime)
  return { startTime, endTime }
}

/** Derive the earliest (date, start_time, end_time) from a block list for the event anchor columns */
function deriveAnchor(
  blocks: Array<{ date: string; startTime: string; endTime: string }>,
): { date: string; startTime: string; endTime: string } {
  if (blocks.length === 0) return { date: '', startTime: '00:00', endTime: '00:00' }
  const sorted = [...blocks].sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    return d !== 0 ? d : a.startTime.localeCompare(b.startTime)
  })
  const first = sorted[0]
  return {
    date: first.date,
    startTime: first.startTime.slice(0, 5),
    endTime: first.endTime.slice(0, 5),
  }
}

function toAdminEvent(row: EventAnchorFields, blocks: EventRoomBlockRow[]): AdminEvent {
  const anchor = blocks.length > 0 ? deriveAnchor(blocks) : {
    date: row.date,
    startTime: row.startTime.slice(0, 5),
    endTime: row.endTime.slice(0, 5),
  }
  const inferredAllDay = anchor.startTime === '00:00' && anchor.endTime === '23:59'

  const roomBlocks: AdminEventRoomBlock[] = blocks.map((b) => ({
    id: b.id,
    roomId: b.roomId,
    tableId: b.tableId ?? null,
    date: b.date,
    startTime: b.startTime.slice(0, 5),
    endTime: b.endTime.slice(0, 5),
    allDay: b.allDay,
  }))

  const rawSchedules: AdminEventSchedule[] = blocks.map((b) => ({
    id: b.id,
    roomId: b.roomId,
    tableId: b.tableId ?? null,
    date: b.date,
    startTime: b.startTime.slice(0, 5),
    endTime: b.endTime.slice(0, 5),
    allDay: b.allDay,
  }))

  // Sort schedules chronologically ascending (date, then startTime)
  const schedules = [...rawSchedules].sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    return d !== 0 ? d : a.startTime.localeCompare(b.startTime)
  })

  // If no blocks exist, synthesize one entry from the event anchor so edit pre-fill works
  if (schedules.length === 0) {
    schedules.push({
      id: undefined,
      roomId: null,
      date: anchor.date,
      startTime: anchor.startTime,
      endTime: anchor.endTime,
      allDay: inferredAllDay,
    })
  }

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    date: anchor.date,
    startTime: anchor.startTime,
    endTime: anchor.endTime,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    roomBlocks,
    schedules,
    allDay: blocks.some((b) => b.allDay) || inferredAllDay,
  }
}

// ---------------------------------------------------------------------------
// Validate a raw schedule payload element and return normalised block
//
// Exported so lib/server/events/club-events-service.ts (OIR-203) can reuse the same
// validation for the public club-event "blocks rooms" sub-flow instead of
// duplicating date/time parsing rules.
// ---------------------------------------------------------------------------
export interface NormalisedEventSchedule {
  room_id: string | null
  /** Null blocks the whole room; a table id scopes the block to that single table (OIR-208). */
  table_id: string | null
  date: string
  start_time: string
  end_time: string
  all_day: boolean
}

export function validateAndNormaliseSchedule(
  raw: unknown,
  index: number,
): NormalisedEventSchedule {
  if (typeof raw !== 'object' || raw === null) {
    serviceError(`schedules[${index}] must be an object`, 400)
  }
  const s = raw as Record<string, unknown>
  const date = String(s.date ?? '').trim()
  const allDay = parseAllDay(s.allDay)
  const rawStart = String(s.startTime ?? '').trim()
  const rawEnd = String(s.endTime ?? '').trim()
  const resolved = resolveBlockTimes(date, rawStart, rawEnd, allDay)
  const roomId = s.roomId ? String(s.roomId).trim() : null
  // OIR-208: a schedule row may optionally scope its block to a single table
  // of the room (empty/"Sala entera" = whole room, unchanged behavior).
  // Ignored when no room is attached — a table without a room makes no sense.
  const tableId = roomId && s.tableId ? String(s.tableId).trim() || null : null

  return {
    room_id: roomId,
    table_id: tableId,
    date,
    start_time: resolved.startTime,
    end_time: resolved.endTime,
    all_day: allDay,
  }
}

// ---------------------------------------------------------------------------
// Reservation-cancellation split-brain (KIM-434 PR3, architectural tradeoff
// — NOT a bug, see PR description's "Split-brain disclosure" section).
//
// The legacy Postgres RPCs this PR replaces (create_event_atomic,
// update_event_atomic, create_event_with_blocks, update_event_with_blocks,
// apply_club_event_room_blocks — see lib/server/events/club-events-service.ts)
// used to cancel overlapping `reservations` rows INSIDE the SAME Postgres
// transaction as the event/block write, so the whole operation was atomic on
// one database.
//
// `reservations` has not been migrated to Neon yet (KIM-434 PR5) — its
// source of truth is still Supabase. Since the event/block write now targets
// Neon (this PR) while reservations still live on Supabase, no single
// database transaction can span both anymore. This function therefore runs
// the reservation-cancellation step as a SEPARATE, NON-TRANSACTIONAL
// follow-up call, invoked AFTER the Neon transaction that wrote the
// event/blocks has already committed.
//
// Consequence: if this follow-up call fails (network blip, Supabase outage,
// etc.) after the Neon transaction committed, the event/block rows remain
// committed on Neon with their overlapping reservations NOT cancelled — a
// new inconsistency window that did not exist before this migration. This
// function does not attempt to "fix" that: it logs a failure loudly per
// block and keeps going instead of throwing, since the primary (event/block)
// write already succeeded and must not be reported as failed to the caller.
//
// Exported so lib/server/events/club-events-service.ts's
// applyClubEventRoomBlocksAndMaterials (the apply_club_event_room_blocks
// replacement) can reuse the same follow-up instead of duplicating it.
// ---------------------------------------------------------------------------
export interface EventBlockForCancellation {
  roomId: string
  /** Null cancels reservations across every table of the room; a concrete id scopes cancellation to that single table (OIR-208). */
  tableId: string | null
  date: string
  startTime: string
  endTime: string
}

export async function cancelOverlappingReservationsForBlocks(
  blocks: EventBlockForCancellation[],
): Promise<void> {
  if (blocks.length === 0) return

  // Whole-room blocks (tableId === null) need their member table ids
  // resolved first. `tables` was migrated to Neon in PR2 and is the source
  // of truth there.
  const roomIdsNeedingLookup = [...new Set(
    blocks.filter((b) => b.tableId === null).map((b) => b.roomId),
  )]

  const roomTableMap = new Map<string, string[]>()
  if (roomIdsNeedingLookup.length > 0) {
    try {
      const drizzleDb = getDrizzleDb()
      const tableRows = await drizzleDb
        .select({ id: tables.id, roomId: tables.roomId })
        .from(tables)
        .where(inArray(tables.roomId, roomIdsNeedingLookup))

      for (const t of tableRows) {
        const list = roomTableMap.get(t.roomId) ?? []
        list.push(t.id)
        roomTableMap.set(t.roomId, list)
      }
    } catch (error) {
      console.error(
        '[events] cancelOverlappingReservationsForBlocks: failed to resolve room -> table ids from Neon; ' +
          'whole-room blocks below will skip reservation cancellation entirely for this call',
        error,
      )
    }
  }

  const admin = getAdminDb()

  for (const block of blocks) {
    const tableIds = block.tableId ? [block.tableId] : (roomTableMap.get(block.roomId) ?? [])
    if (tableIds.length === 0) continue

    const { error } = await admin
      .from('reservations')
      .update({ status: 'cancelled' })
      .in('table_id', tableIds)
      .eq('date', block.date)
      .lt('start_time', block.endTime)
      .gt('end_time', block.startTime)
      .in('status', ['active', 'pending'])

    if (error) {
      console.error(
        '[events] cancelOverlappingReservationsForBlocks: failed to cancel overlapping reservations for a ' +
          'block — the event/block rows on Neon are already committed and will NOT be rolled back',
        { roomId: block.roomId, tableId: block.tableId, date: block.date, startTime: block.startTime, endTime: block.endTime },
        error,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// saved_games cancellation cascade (KIM-434 PR #182 review fix).
//
// Reimplements the dropped Supabase trigger `event_blocks_cancel_saved_games`
// (AFTER INSERT OR UPDATE OF room_id, date ON event_room_blocks, FOR EACH ROW
// -> cancel_saved_games_for_event_block()), which this migration removed
// with no Drizzle/Neon equivalent — a confirmed regression: creating or
// updating an admin event with room blocks silently stopped cancelling
// active saved_games rows for the blocked room/date.
//
// Trigger body (verbatim, from
// supabase/migrations/20260619000010_kim384_event_cancels_saved_games.sql):
//   FOR v_table_id IN SELECT id FROM public.tables WHERE room_id = NEW.room_id
//     ORDER BY id LOOP
//       PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_table_id::text, 0));
//     END LOOP;
//   UPDATE public.saved_games AS saved
//     SET status = 'cancelled', updated_at = now()
//     FROM public.tables AS game_table
//     WHERE saved.table_id = game_table.id
//       AND game_table.room_id = NEW.room_id
//       AND saved.status = 'active'
//       AND NEW.date BETWEEN saved.start_date AND saved.end_date;
//
// Unlike cancelOverlappingReservationsForBlocks() above (which must run
// post-commit, against the still-Supabase `reservations` table), saved_games
// is already on the Drizzle/Neon seam (PR1 — lib/db/schema/saved-games.ts),
// so this runs INSIDE the caller's transaction, alongside the
// event_room_blocks insert, giving true all-or-nothing atomicity: a rollback
// of the block write also rolls back this cascade.
//
// Known, disclosed gap vs. the trigger: the `pg_advisory_xact_lock` loop
// above is NOT reimplemented here. It guarded a race between this UPDATE and
// a concurrent saved-game creation racing the `saved_games_no_active_overlap`
// EXCLUDE constraint — a defense-in-depth concurrency guard, not the
// business rule under regression (the missing cancellation itself). It is
// intentionally out of scope for this fix: it needs a raw `tx.execute(sql\`...\`)`
// call that tests/unit/mocks/drizzle-mock.ts's shared transaction builder has
// no chain for, and per repo convention test infra is qa-engineer-owned, not
// software-engineer's to extend. Flagged for qa/security follow-up.
//
// Exported (same pattern as deleteEventCascade below) so
// lib/server/events/club-events-service.ts can reuse it once its own
// room-block write path (KIM-438, tracked separately) is wired to call this
// inside its own Drizzle tx — do not duplicate this logic inline there.
// ---------------------------------------------------------------------------
export async function cancelSavedGamesForBlockedRoom(
  tx: AdminTx,
  blocks: Array<{ roomId: string; date: string }>,
): Promise<number> {
  if (blocks.length === 0) return 0

  let cancelledCount = 0

  for (const block of blocks) {
    const roomTables = await tx
      .select({ id: tables.id })
      .from(tables)
      .where(eq(tables.roomId, block.roomId))
      .orderBy(asc(tables.id))

    const tableIds = roomTables.map((t) => t.id)
    if (tableIds.length === 0) continue

    // Pre-select the exact candidate rows the trigger's UPDATE would have
    // matched, and only issue the UPDATE when there's at least one — same
    // net effect as an UPDATE...WHERE matching zero rows, but keeps this a
    // true no-op (no write attempted) when a block's room has no active
    // saved_games overlapping its date.
    const candidates = await tx
      .select({ id: savedGames.id })
      .from(savedGames)
      .where(
        and(
          inArray(savedGames.tableId, tableIds),
          eq(savedGames.status, 'active'),
          lte(savedGames.startDate, block.date),
          gte(savedGames.endDate, block.date),
        ),
      )

    const candidateIds = candidates.map((c) => c.id)
    if (candidateIds.length === 0) continue

    const cancelled = await tx
      .update(savedGames)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(inArray(savedGames.id, candidateIds))
      .returning({ id: savedGames.id })

    cancelledCount += cancelled.length
  }

  return cancelledCount
}

// ---------------------------------------------------------------------------
// Atomic (Neon-transaction) event+blocks write helpers, replacing the
// removed Supabase RPCs create_event_atomic / update_event_atomic /
// create_event_with_blocks / update_event_with_blocks. The reservation
// cancellation these RPCs used to perform in-transaction now runs as a
// separate follow-up call via cancelOverlappingReservationsForBlocks() —
// see that function's doc comment above.
// ---------------------------------------------------------------------------

async function createEventAtomic(
  title: string,
  description: string | null,
  date: string,
  startTime: string,
  endTime: string,
  roomId: string | null,
  allDay: boolean,
): Promise<AdminEvent> {
  const db = getDrizzleAdminDb()

  const result = await runQuery(
    db.transaction(async (tx) => {
      const [eventRow] = await tx.insert(events).values({ title, description, date, startTime, endTime }).returning()
      if (!eventRow) serviceError('Internal server error', 500)

      let insertedBlocks: EventRoomBlockRow[] = []
      if (roomId) {
        insertedBlocks = await tx
          .insert(eventRoomBlocks)
          .values({ eventId: eventRow.id, roomId, date, startTime, endTime, allDay })
          .returning()

        await cancelSavedGamesForBlockedRoom(
          tx,
          insertedBlocks.map((b) => ({ roomId: b.roomId, date: b.date })),
        )
      }

      return { eventRow, insertedBlocks }
    }),
  )

  await cancelOverlappingReservationsForBlocks(
    result.insertedBlocks.map((b) => ({
      roomId: b.roomId,
      tableId: b.tableId,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
    })),
  )

  return toAdminEvent(result.eventRow, result.insertedBlocks)
}

async function updateEventAtomic(
  id: string,
  title: string,
  description: string | null,
  date: string,
  startTime: string,
  endTime: string,
  roomId: string | null,
  allDay: boolean,
): Promise<AdminEvent> {
  const db = getDrizzleAdminDb()

  const result = await runQuery(
    db.transaction(async (tx) => {
      const [eventRow] = await tx
        .update(events)
        .set({ title, description, date, startTime, endTime })
        .where(eq(events.id, id))
        .returning()

      if (!eventRow) serviceError('Internal server error', 500)

      await tx.delete(eventRoomBlocks).where(eq(eventRoomBlocks.eventId, id))

      let insertedBlocks: EventRoomBlockRow[] = []
      if (roomId) {
        insertedBlocks = await tx
          .insert(eventRoomBlocks)
          .values({ eventId: id, roomId, date, startTime, endTime, allDay })
          .returning()

        await cancelSavedGamesForBlockedRoom(
          tx,
          insertedBlocks.map((b) => ({ roomId: b.roomId, date: b.date })),
        )
      }

      return { eventRow, insertedBlocks }
    }),
  )

  await cancelOverlappingReservationsForBlocks(
    result.insertedBlocks.map((b) => ({
      roomId: b.roomId,
      tableId: b.tableId,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
    })),
  )

  return toAdminEvent(result.eventRow, result.insertedBlocks)
}

// ---------------------------------------------------------------------------
// room_id/table_id consistency guard (PR #182 review fix).
//
// The removed create_event_with_blocks/update_event_with_blocks RPCs
// (supabase/migrations/20260704000006_oir208_table_blocks_and_materials.sql)
// verified that a block's table_id actually belongs to its room_id before
// inserting: independent FKs on room_id/table_id alone are not sufficient,
// since a table_id from an unrelated room still passes FK checks. This
// Drizzle rewrite must reimplement that same guard explicitly.
// ---------------------------------------------------------------------------
type AdminTx = Parameters<Parameters<AdminDbClient['transaction']>[0]>[0]

async function assertBlocksTableRoomConsistency(
  tx: AdminTx,
  blocksWithRoom: Array<{ room_id: string; table_id: string | null }>,
): Promise<void> {
  const tableIds = [...new Set(
    blocksWithRoom.filter((b) => b.table_id !== null).map((b) => b.table_id as string),
  )]
  if (tableIds.length === 0) return

  const tableRows = await tx
    .select({ id: tables.id, roomId: tables.roomId })
    .from(tables)
    .where(inArray(tables.id, tableIds))

  const tableRoomMap = new Map(tableRows.map((t) => [t.id, t.roomId]))

  for (const block of blocksWithRoom) {
    if (block.table_id === null) continue
    const actualRoomId = tableRoomMap.get(block.table_id)
    if (actualRoomId === undefined || actualRoomId !== block.room_id) {
      serviceError(`table_id ${block.table_id} does not belong to room_id ${block.room_id}`, 400)
    }
  }
}

async function createEventWithBlocksAtomic(
  title: string,
  description: string | null,
  normBlocks: NormalisedEventSchedule[],
  createdBy: string | null,
): Promise<AdminEvent> {
  const db = getDrizzleAdminDb()
  const anchor = deriveAnchor(normBlocks.map((b) => ({ date: b.date, startTime: b.start_time, endTime: b.end_time })))

  let result: { eventRow: EventRow; insertedBlocks: EventRoomBlockRow[] }
  try {
    result = await db.transaction(async (tx) => {
      const [eventRow] = await tx
        .insert(events)
        .values({
          title,
          description,
          date: anchor.date,
          startTime: anchor.startTime,
          endTime: anchor.endTime,
          createdBy,
        })
        .returning()

      if (!eventRow) serviceError('Internal server error', 500)

      const blocksWithRoom = normBlocks.filter(
        (b): b is NormalisedEventSchedule & { room_id: string } => b.room_id !== null,
      )

      await assertBlocksTableRoomConsistency(tx, blocksWithRoom)

      let insertedBlocks: EventRoomBlockRow[] = []
      if (blocksWithRoom.length > 0) {
        insertedBlocks = await tx
          .insert(eventRoomBlocks)
          .values(
            blocksWithRoom.map((b) => ({
              eventId: eventRow.id,
              roomId: b.room_id,
              tableId: b.table_id,
              date: b.date,
              startTime: b.start_time,
              endTime: b.end_time,
              allDay: b.all_day,
            })),
          )
          .returning()

        await cancelSavedGamesForBlockedRoom(
          tx,
          insertedBlocks.map((b) => ({ roomId: b.roomId, date: b.date })),
        )
      }

      return { eventRow, insertedBlocks }
    })
  } catch (error) {
    if (error instanceof ServiceError) throw error
    const pgCode = (error as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid event data', 400)
    }
    serviceError('Internal server error', 500)
  }

  await cancelOverlappingReservationsForBlocks(
    result.insertedBlocks.map((b) => ({
      roomId: b.roomId,
      tableId: b.tableId,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
    })),
  )

  return toAdminEvent(result.eventRow, result.insertedBlocks)
}

async function updateEventWithBlocksAtomic(
  id: string,
  title: string,
  description: string | null,
  normBlocks: NormalisedEventSchedule[],
): Promise<AdminEvent> {
  const db = getDrizzleAdminDb()
  const anchor = deriveAnchor(normBlocks.map((b) => ({ date: b.date, startTime: b.start_time, endTime: b.end_time })))

  let result: { eventRow: EventRow; insertedBlocks: EventRoomBlockRow[] }
  try {
    result = await db.transaction(async (tx) => {
      const [eventRow] = await tx
        .update(events)
        .set({
          title,
          description,
          date: anchor.date,
          startTime: anchor.startTime,
          endTime: anchor.endTime,
        })
        .where(eq(events.id, id))
        .returning()

      if (!eventRow) serviceError('Event not found', 404)

      await tx.delete(eventRoomBlocks).where(eq(eventRoomBlocks.eventId, id))

      const blocksWithRoom = normBlocks.filter(
        (b): b is NormalisedEventSchedule & { room_id: string } => b.room_id !== null,
      )

      await assertBlocksTableRoomConsistency(tx, blocksWithRoom)

      let insertedBlocks: EventRoomBlockRow[] = []
      if (blocksWithRoom.length > 0) {
        insertedBlocks = await tx
          .insert(eventRoomBlocks)
          .values(
            blocksWithRoom.map((b) => ({
              eventId: id,
              roomId: b.room_id,
              tableId: b.table_id,
              date: b.date,
              startTime: b.start_time,
              endTime: b.end_time,
              allDay: b.all_day,
            })),
          )
          .returning()

        await cancelSavedGamesForBlockedRoom(
          tx,
          insertedBlocks.map((b) => ({ roomId: b.roomId, date: b.date })),
        )
      }

      return { eventRow, insertedBlocks }
    })
  } catch (error) {
    if (error instanceof ServiceError) throw error
    const pgCode = (error as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid event data', 400)
    }
    serviceError('Internal server error', 500)
  }

  await cancelOverlappingReservationsForBlocks(
    result.insertedBlocks.map((b) => ({
      roomId: b.roomId,
      tableId: b.tableId,
      date: b.date,
      startTime: b.startTime,
      endTime: b.endTime,
    })),
  )

  return toAdminEvent(result.eventRow, result.insertedBlocks)
}

/**
 * Cancel overlapping reservations for every room block attached to `id`,
 * then delete the event row (blocks/materials cascade via FK). Shared by
 * `deleteEvent` (legacy internal surface, guarded above) and
 * `lib/server/events/club-events-service.ts`'s `deleteClubEvent` (which
 * performs its own club-event-row validation — the inverse of the guard
 * above — before calling this directly, so it must NOT go through the
 * `isClubEventRow` check in `deleteEvent`).
 *
 * KIM-434 PR3: signature changed from `(admin, id)` to `(id)` — no longer
 * takes a Supabase client parameter, since the event/block delete now runs
 * on the Drizzle/Neon seam. See `cancelOverlappingReservationsForBlocks()`
 * above for why the reservation cancellation below still runs separately,
 * non-transactionally, against the legacy Supabase seam.
 */
export async function deleteEventCascade(id: string): Promise<void> {
  const db = getDrizzleAdminDb()

  const blocks = await runQuery(
    db.transaction(async (tx) => {
      const rows = await tx
        .select({
          roomId: eventRoomBlocks.roomId,
          tableId: eventRoomBlocks.tableId,
          date: eventRoomBlocks.date,
          startTime: eventRoomBlocks.startTime,
          endTime: eventRoomBlocks.endTime,
        })
        .from(eventRoomBlocks)
        .where(eq(eventRoomBlocks.eventId, id))

      // event_room_blocks / event_equipment cascade-delete via FK ON DELETE CASCADE.
      await tx.delete(events).where(eq(events.id, id))

      return rows
    }),
  )

  await cancelOverlappingReservationsForBlocks(blocks)
}

// ---------------------------------------------------------------------------
// Public API
//
// OIR-208 review (Finding 2 — legacy /api/events double-write surface):
// listEvents/createEvent/updateEvent/deleteEvent below back the legacy
// internal-events dashboard section, which has since been replaced by the
// unified "Eventos" flow in lib/server/events/club-events-service.ts. No component
// or hook consumes app/api/events/route.ts or app/api/events/[id]/route.ts
// anymore (verified: no references to the use-admin.ts event hooks outside
// that hook file and its tests). Those routes — and these functions — are
// intentionally NOT removed here because tests/unit/app/api/events.test.ts
// and tests/unit/server/events-service.test.ts (and
// events-service-multiday.test.ts) exercise them directly and test edits are
// out of scope for this change. Divergence risk: a unified internal event
// (both title_es/title_en NULL, created via the unified admin flow) remains
// writable/deletable through this surface too, with different
// validation/defaults than the unified service. Do not wire any new
// consumer to this surface — prefer lib/server/events/club-events-service.ts.
// ---------------------------------------------------------------------------

export async function listEvents(): Promise<AdminEvent[]> {
  const db = getDrizzleDb()
  const rows = await runQuery(
    db
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        createdBy: events.createdBy,
        createdAt: events.createdAt,
      })
      .from(events)
      // Exclude public "club event" landing rows (OIR-203): a row becomes
      // landing content once both bilingual titles are populated (see
      // lib/server/events/club-events-service.ts). Those are managed
      // exclusively via the dedicated "Club events" dashboard section, not
      // this legacy internal room-booking view.
      .where(or(isNull(events.titleEs), isNull(events.titleEn)))
      .orderBy(asc(events.date), asc(events.startTime)),
  )

  if (rows.length === 0) return []

  const blockRows = await runQuery(
    db.select().from(eventRoomBlocks).where(inArray(eventRoomBlocks.eventId, rows.map((r) => r.id))),
  )

  const blocksByEvent = new Map<string, EventRoomBlockRow[]>()
  for (const block of blockRows) {
    const list = blocksByEvent.get(block.eventId) ?? []
    list.push(block)
    blocksByEvent.set(block.eventId, list)
  }

  return rows.map((row) => toAdminEvent(row, blocksByEvent.get(row.id) ?? []))
}

export async function getEvent(id: string): Promise<AdminEvent> {
  const db = getDrizzleDb()
  const [event] = await runQuery(
    db
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        createdBy: events.createdBy,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(eq(events.id, id)),
  )

  if (!event) serviceError('Event not found', 404)

  const blocks = await runQuery(
    db.select().from(eventRoomBlocks).where(eq(eventRoomBlocks.eventId, id)),
  )

  return toAdminEvent(event, blocks)
}

export async function createEvent(
  session: SessionUser,
  body: {
    title?: unknown
    description?: unknown
    schedules?: unknown
    // Legacy single-block fields (kept for backward compat / existing tests)
    date?: unknown
    startTime?: unknown
    endTime?: unknown
    roomId?: unknown
    createdBy?: unknown
    allDay?: unknown
  },
): Promise<AdminEvent> {
  requireAdminSession(session)
  const title = String(body.title ?? '').trim()
  if (!title) serviceError('Title is required', 400)

  const description = body.description ? String(body.description).trim() : null

  // --- Multi-block path (new) ---
  if (Array.isArray(body.schedules)) {
    if (body.schedules.length === 0) serviceError('At least one schedule is required', 400)
    if (body.schedules.length > 366) serviceError('Too many schedule blocks', 400)

    const normBlocks = body.schedules.map((s, i) => validateAndNormaliseSchedule(s, i))

    return createEventWithBlocksAtomic(
      title,
      description,
      normBlocks,
      body.createdBy ? String(body.createdBy) : null,
    )
  }

  // --- Legacy single-block path (preserved for existing callers / tests) ---
  const date = String(body.date ?? '').trim()
  const allDay = parseAllDay(body.allDay)
  const resolvedTimes = resolveBlockTimes(date, String(body.startTime ?? '').trim(), String(body.endTime ?? '').trim(), allDay)
  const roomId = body.roomId ? String(body.roomId).trim() : null

  return createEventAtomic(title, description, date, resolvedTimes.startTime, resolvedTimes.endTime, roomId, allDay)
}

export async function updateEvent(
  session: SessionUser,
  id: string,
  body: {
    title?: unknown
    description?: unknown
    schedules?: unknown
    // Legacy single-block fields
    date?: unknown
    startTime?: unknown
    endTime?: unknown
    roomId?: unknown
    allDay?: unknown
  },
): Promise<AdminEvent> {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()

  // Load current event to fill in any fields not provided in the body
  const [currentRow] = await runQuery(
    db
      .select({
        title: events.title,
        description: events.description,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        titleEs: events.titleEs,
        titleEn: events.titleEn,
      })
      .from(events)
      .where(eq(events.id, id)),
  )

  if (!currentRow) serviceError('Event not found', 404)

  // Finding 3: a club-event (landing) row is out of scope for this legacy
  // internal surface — treat it as not found, same as listEvents' filter.
  if (isClubEventRow(currentRow)) serviceError('Event not found', 404)

  const title = body.title !== undefined ? String(body.title).trim() || currentRow.title : currentRow.title
  const description =
    body.description !== undefined
      ? body.description === null
        ? null
        : String(body.description).trim() || null
      : currentRow.description

  // --- Multi-block path (new) ---
  if (Array.isArray(body.schedules)) {
    if (body.schedules.length === 0) serviceError('At least one schedule is required', 400)
    if (body.schedules.length > 366) serviceError('Too many schedule blocks', 400)

    const normBlocks = body.schedules.map((s, i) => validateAndNormaliseSchedule(s, i))

    return updateEventWithBlocksAtomic(id, title, description, normBlocks)
  }

  // --- Legacy single-block path ---
  const date = body.date !== undefined ? String(body.date).trim() || currentRow.date : currentRow.date
  const inputStartTime =
    body.startTime !== undefined ? String(body.startTime).trim() || currentRow.startTime : currentRow.startTime
  const inputEndTime =
    body.endTime !== undefined ? String(body.endTime).trim() || currentRow.endTime : currentRow.endTime

  let roomId: string | null
  let currentAllDay = false
  if (body.roomId === undefined || body.allDay === undefined) {
    const [firstBlock] = await runQuery(
      db
        .select({ roomId: eventRoomBlocks.roomId, allDay: eventRoomBlocks.allDay })
        .from(eventRoomBlocks)
        .where(eq(eventRoomBlocks.eventId, id))
        .limit(1),
    )
    currentAllDay = firstBlock?.allDay ?? false
    roomId = body.roomId !== undefined
      ? (body.roomId ? String(body.roomId).trim() : null)
      : (firstBlock ? firstBlock.roomId : null)
  } else {
    roomId = body.roomId ? String(body.roomId).trim() : null
  }
  const allDay = body.allDay !== undefined ? parseAllDay(body.allDay) : currentAllDay
  const resolvedTimes = resolveBlockTimes(date, inputStartTime, inputEndTime, allDay)

  return updateEventAtomic(id, title, description, date, resolvedTimes.startTime, resolvedTimes.endTime, roomId, allDay)
}

export async function deleteEvent(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)
  const db = getDrizzleDb()

  const [eventRow] = await runQuery(
    db.select({ id: events.id, titleEs: events.titleEs, titleEn: events.titleEn }).from(events).where(eq(events.id, id)),
  )

  if (!eventRow) serviceError('Event not found', 404)

  // Finding 3: a club-event (landing) row is out of scope for this legacy
  // internal surface — treat it as not found, same as listEvents' filter.
  if (isClubEventRow(eventRow)) {
    serviceError('Event not found', 404)
  }

  await deleteEventCascade(id)
}

export interface EventConflictBlock {
  date: string
  roomId: string
  count: number
}

export interface EventConflictPreview {
  total: number
  blocks: EventConflictBlock[]
}

export async function previewEventConflicts(body: {
  schedules?: unknown
}): Promise<EventConflictPreview> {
  if (!Array.isArray(body.schedules) || body.schedules.length === 0) {
    return { total: 0, blocks: [] }
  }
  if (body.schedules.length > 366) serviceError('Too many schedule blocks', 400)

  // Reuse the same validation path as createEvent/updateEvent
  const normBlocks = body.schedules.map((s, i) => validateAndNormaliseSchedule(s, i))

  // Only blocks with a non-null room_id can have reservations to cancel
  const roomedBlocks = normBlocks.filter((b): b is typeof b & { room_id: string } => b.room_id !== null)

  if (roomedBlocks.length === 0) {
    return { total: 0, blocks: [] }
  }

  const drizzleDb = getDrizzleDb()

  // Pre-fetch table ids for all distinct rooms in one round-trip (avoids N+1)
  const distinctRoomIds = [...new Set(roomedBlocks.map((b) => b.room_id))]

  const tableRows = await runQuery(
    drizzleDb.select({ id: tables.id, roomId: tables.roomId }).from(tables).where(inArray(tables.roomId, distinctRoomIds)),
  )

  const roomTableMap = new Map<string, string[]>()
  for (const t of tableRows) {
    const list = roomTableMap.get(t.roomId) ?? []
    list.push(t.id)
    roomTableMap.set(t.roomId, list)
  }

  // `reservations` is not yet migrated (PR5) — its source of truth is still
  // Supabase, so the count itself must be read from there.
  const admin = getAdminDb()

  const resultBlocks: EventConflictBlock[] = []
  let total = 0

  for (const block of roomedBlocks) {
    // Match cancelOverlappingReservationsForBlocks()'s scoping rule: a
    // table-level block (table_id set) only counts against that single
    // table; a room-level block (table_id null) falls back to the room's
    // full table list. Counting against the whole room regardless of
    // table_id would overstate how many reservations will actually be
    // cancelled for a table-level block.
    const tableIds = block.table_id ? [block.table_id] : (roomTableMap.get(block.room_id) ?? [])

    if (tableIds.length === 0) {
      resultBlocks.push({ date: block.date, roomId: block.room_id, count: 0 })
      continue
    }

    const { count, error: countError } = await admin
      .from('reservations')
      .select('id', { count: 'exact', head: true })
      .in('table_id', tableIds)
      .eq('date', block.date)
      .lt('start_time', block.end_time)
      .gt('end_time', block.start_time)
      .in('status', ['active', 'pending'])

    if (countError) serviceError('Internal server error', 500)

    const blockCount = count ?? 0
    total += blockCount
    resultBlocks.push({ date: block.date, roomId: block.room_id, count: blockCount })
  }

  return { total, blocks: resultBlocks }
}

export async function listEventsBlockingRoom(
  roomId: string,
  date: string,
  start: string,
  end: string,
): Promise<AdminEvent[]> {
  const db = getDrizzleDb()

  const blocks = await runQuery(
    db
      .select({ eventId: eventRoomBlocks.eventId })
      .from(eventRoomBlocks)
      .where(
        and(
          eq(eventRoomBlocks.roomId, roomId),
          eq(eventRoomBlocks.date, date),
          lt(eventRoomBlocks.startTime, end),
          gt(eventRoomBlocks.endTime, start),
        ),
      ),
  )

  const eventIds = [...new Set(blocks.map((b) => b.eventId))]
  if (eventIds.length === 0) return []

  const rows = await runQuery(
    db
      .select({
        id: events.id,
        title: events.title,
        description: events.description,
        date: events.date,
        startTime: events.startTime,
        endTime: events.endTime,
        createdBy: events.createdBy,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(inArray(events.id, eventIds)),
  )

  return rows.map((row) => toAdminEvent(row, []))
}
