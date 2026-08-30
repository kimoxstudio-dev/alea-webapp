import 'server-only'
import { sql } from '@/lib/db/client'
import { NeonDbError } from '@neondatabase/serverless'
import { serviceError } from '@/lib/server/service-error'
import type { Tables } from '@/lib/supabase/types'
import type { AdminEvent, AdminEventRoomBlock, AdminEventSchedule } from '@/lib/types'
import type { createSupabaseServerAdminClient } from '@/lib/supabase/server'

type SupabaseAdminClient = ReturnType<typeof createSupabaseServerAdminClient>

/**
 * Raw-SQL Neon port of the legacy internal events service (#303).
 *
 * Ported off Supabase (`createSupabaseServerAdminClient`/
 * `createSupabaseServerClient`) to the tagged-template `sql` export from
 * `lib/db/client.ts`, matching the established style from
 * `equipment-service.ts` (#305), `rooms-service.ts`/`tables-service.ts`
 * (#302/#308) and `database-time.ts`.
 *
 * The `create_event_atomic` / `update_event_atomic` / `create_event_with_blocks`
 * / `update_event_with_blocks` Postgres RPC functions this service used to
 * call are business logic, not table structure (see
 * `lib/db/schema/008_events.sql`), and are intentionally NOT part of the
 * Neon schema-as-code (that's #309/#334, not started). Their exact behavior
 * (see `supabase/migrations/20260417000003_baseline.sql` and
 * `supabase/migrations/20260617000001_kim383_multi_day_events.sql`) is
 * reproduced here as plain sequential `sql` statements instead — the same
 * "no DB functions/triggers" approach already used by sibling Neon-migrated
 * services for multi-step writes (e.g. `equipment-service.ts`'s
 * `setRoomDefaultEquipment`). Neon's HTTP driver's `sql.transaction()` only
 * batches queries that are fully built up-front (no branching on a prior
 * query's runtime result), which these RPCs' insert-then-use-the-new-id flow
 * needs, so — matching `reservations-service.ts`'s established precedent —
 * these are sequential non-transactional statements, not a single atomic
 * `sql.transaction()`.
 *
 * `deleteEventCascade` is exported and reused by
 * `lib/server/club-events-service.ts` (`deleteClubEvent`), which is still
 * Supabase-based (#304, not started). It keeps a dual Neon/Supabase path: a
 * real Supabase admin client (the still-Supabase `deleteClubEvent` caller)
 * routes through a restored pre-#303 Supabase-based cascade, since
 * `events`/`event_room_blocks` are effectively empty in Neon until #304
 * migrates that caller; `undefined` (this service's own already-migrated
 * `deleteEvent`) uses the Neon path. See `deleteEventCascade`'s own doc
 * comment below for the full rationale.
 */

export type { AdminEvent, AdminEventRoomBlock, AdminEventSchedule }

type EventRow = Tables<'events'>
type EventRoomBlockRow = Tables<'event_room_blocks'>

// ---------------------------------------------------------------------------
// Shared "is this a club-event (landing) row?" predicate (OIR-203 code
// review, Finding 3). A row becomes public landing content once BOTH
// title_es and title_en are populated (see lib/server/club-events-service.ts).
// Every legacy internal room-booking entry point (updateEvent, deleteEvent,
// and listEvents' `.or('title_es.is.null,title_en.is.null')` filter) must
// treat such rows as out of scope for this surface — they are owned
// exclusively by the "Club events" admin flow.
// ---------------------------------------------------------------------------
export function isClubEventRow(row: Pick<EventRow, 'title_es' | 'title_en'>): boolean {
  return row.title_es != null && row.title_en != null
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
function deriveAnchor(blocks: EventRoomBlockRow[]): { date: string; startTime: string; endTime: string } {
  if (blocks.length === 0) return { date: '', startTime: '00:00', endTime: '00:00' }
  const sorted = [...blocks].sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    return d !== 0 ? d : a.start_time.localeCompare(b.start_time)
  })
  const first = sorted[0]
  return {
    date: first.date,
    startTime: first.start_time.slice(0, 5),
    endTime: first.end_time.slice(0, 5),
  }
}

function toAdminEvent(row: EventRow, blocks: EventRoomBlockRow[]): AdminEvent {
  const anchor = blocks.length > 0 ? deriveAnchor(blocks) : {
    date: row.date,
    startTime: row.start_time.slice(0, 5),
    endTime: row.end_time.slice(0, 5),
  }
  const inferredAllDay = anchor.startTime === '00:00' && anchor.endTime === '23:59'

  const roomBlocks: AdminEventRoomBlock[] = blocks.map((b) => ({
    id: b.id,
    roomId: b.room_id,
    tableId: b.table_id ?? null,
    date: b.date,
    startTime: b.start_time.slice(0, 5),
    endTime: b.end_time.slice(0, 5),
    allDay: b.all_day,
  }))

  const rawSchedules: AdminEventSchedule[] = blocks.map((b) => ({
    id: b.id,
    roomId: b.room_id,
    tableId: b.table_id ?? null,
    date: b.date,
    startTime: b.start_time.slice(0, 5),
    endTime: b.end_time.slice(0, 5),
    allDay: b.all_day,
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    roomBlocks,
    schedules,
    allDay: blocks.some((b) => b.all_day) || inferredAllDay,
  }
}

// ---------------------------------------------------------------------------
// Validate a raw schedule payload element and return normalised block
//
// Exported so lib/server/club-events-service.ts (OIR-203) can reuse the same
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

/** Sort normalised schedule blocks chronologically and return the earliest — mirrors
 *  create_event_with_blocks'/update_event_with_blocks' anchor-derivation ORDER BY. */
function deriveAnchorFromBlocks(blocks: NormalisedEventSchedule[]): NormalisedEventSchedule {
  const sorted = [...blocks].sort((a, b) => {
    const d = a.date.localeCompare(b.date)
    return d !== 0 ? d : a.start_time.localeCompare(b.start_time)
  })
  return sorted[0]
}

/** Maps a NeonDbError from an events/event_room_blocks write to the same 400/500
 *  split the old create_event_with_blocks/update_event_with_blocks RPC error handling used. */
function mapEventWriteError(error: unknown): never {
  if (
    error instanceof NeonDbError &&
    (error.code === '23514' || error.code === '22P02' || error.code === '23502')
  ) {
    serviceError('Invalid event data', 400)
  }
  serviceError('Internal server error', 500)
}

/** Cancels active/pending reservations overlapping a room block, mirroring the
 *  "SELECT ARRAY(table ids) ... UPDATE reservations SET status='cancelled'" fragment
 *  shared by all four legacy RPCs. */
async function cancelOverlappingReservationsForRoom(
  roomId: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<void> {
  let tableRows: Array<{ id: string }>
  try {
    tableRows = await sql`
      SELECT id FROM tables WHERE room_id = ${roomId}
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const tableIds = tableRows.map((t) => t.id)
  if (tableIds.length === 0) return

  try {
    await sql`
      UPDATE reservations
      SET status = 'cancelled'
      WHERE table_id = ANY(${tableIds})
        AND date = ${date}
        AND start_time < ${endTime}
        AND end_time > ${startTime}
        AND status IN ('active', 'pending')
    `
  } catch {
    serviceError('Internal server error', 500)
  }
}

/**
 * Same overlap-cancellation as `cancelOverlappingReservationsForRoom`, but
 * also returns the ids of every reservation it cancelled, so a multi-block
 * loop (see `createEvent`/`updateEvent`'s schedules path below) can restore
 * them if a *later* block in the same call fails. Used only by those loops —
 * `cancelOverlappingReservationsForRoom` itself is unchanged and still backs
 * the legacy single-block path.
 */
async function cancelOverlappingReservationsForRoomCapturing(
  roomId: string,
  date: string,
  startTime: string,
  endTime: string,
): Promise<string[]> {
  let tableRows: Array<{ id: string }>
  try {
    tableRows = await sql`
      SELECT id FROM tables WHERE room_id = ${roomId}
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const tableIds = tableRows.map((t) => t.id)
  if (tableIds.length === 0) return []

  let cancelledRows: Array<{ id: string }>
  try {
    cancelledRows = await sql`
      UPDATE reservations
      SET status = 'cancelled'
      WHERE table_id = ANY(${tableIds})
        AND date = ${date}
        AND start_time < ${endTime}
        AND end_time > ${startTime}
        AND status IN ('active', 'pending')
      RETURNING id
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  return cancelledRows.map((r) => r.id)
}

/**
 * Compensating rollback for the multi-block `createEvent`/`updateEvent`
 * loops (#303 code-review Finding 2). Those loops are NOT wrapped in a
 * single `sql.transaction()`: each iteration's overlap-cancellation branches
 * on the previous query's runtime result (the room's table ids), which is
 * exactly the batching limitation the file header documents for the old
 * RPCs' insert-then-use-new-id flow. If a later block's INSERT (or the
 * cancellation that follows it) throws, this restores what the loop has
 * done so far in the current call: deletes any `event_room_blocks` rows it
 * already inserted, and reactivates any reservations it already cancelled.
 *
 * Restoring cancelled reservations to `'active'` rather than each one's
 * exact prior status (`'active'` vs `'pending'`) is an accepted
 * simplification — undoing the loop's own partial writes matters far more
 * here than perfectly reproducing a reservation's prior pending/active
 * distinction on this already-rare failure path.
 *
 * Best-effort: errors from the rollback itself are logged and swallowed, so
 * the caller's original failure (via `mapEventWriteError`) is always what
 * actually surfaces to the API caller — mirroring the compensating-delete
 * pattern in `reservations-service.ts`'s `createReservationForSession`.
 */
async function rollbackPartialMultiBlockWrite(params: {
  eventId: string
  insertedBlockIds: string[]
  cancelledReservationIds: string[]
  deleteEvent: boolean
}): Promise<void> {
  const { eventId, insertedBlockIds, cancelledReservationIds, deleteEvent } = params
  try {
    if (insertedBlockIds.length > 0) {
      await sql`DELETE FROM event_room_blocks WHERE id = ANY(${insertedBlockIds})`
    }
    if (cancelledReservationIds.length > 0) {
      await sql`
        UPDATE reservations
        SET status = 'active'
        WHERE id = ANY(${cancelledReservationIds}) AND status = 'cancelled'
      `
    }
    if (deleteEvent) {
      await sql`DELETE FROM events WHERE id = ${eventId}`
    }
  } catch (rollbackError) {
    console.error('events-service: compensating rollback failed (non-fatal):', rollbackError)
  }
}

/**
 * Compensating rollback for `updateEvent`'s legacy single-block path
 * (#303 code-review round 3, Finding 2) AND its multi-block path (round 4 —
 * same gap, same fix, since both delete the event's existing room block(s)
 * *before* inserting the replacement(s)). A failure inserting a replacement
 * block would otherwise leave the event with zero blocks, silently losing
 * its room assignment. Reinserts the exact rows the failed call just
 * deleted (captured via the DELETE's own `RETURNING`, see each call site).
 * Best-effort: errors here are logged and swallowed, matching the pattern
 * in `rollbackPartialMultiBlockWrite` above.
 */
async function restoreDeletedBlocksOnUpdateFailure(
  deletedBlocks: EventRoomBlockRow[],
): Promise<void> {
  if (deletedBlocks.length === 0) return
  try {
    for (const block of deletedBlocks) {
      await sql`
        INSERT INTO event_room_blocks (id, event_id, room_id, date, start_time, end_time, all_day)
        VALUES (${block.id}, ${block.event_id}, ${block.room_id}, ${block.date}, ${block.start_time}, ${block.end_time}, ${block.all_day})
      `
    }
  } catch (rollbackError) {
    console.error('events-service: compensating block restore failed (non-fatal):', rollbackError)
  }
}

/**
 * Compensating rollback for `updateEvent`'s own `UPDATE events SET title =
 * ..., date = ..., ...` statement (#303 code-review round 4 audit — found
 * while verifying no 5th instance of the rounds 1-4 pattern remained). Both
 * updateEvent paths mutate the event row's fields *before* the block
 * delete/insert steps that can still fail; on such a failure the event's
 * new field values would otherwise persist despite the request reporting an
 * error. Reverts the row back to the field values it had before this call
 * (captured from the pre-write `currentRow` read at the top of
 * `updateEvent`). Best-effort: errors here are logged and swallowed,
 * matching the pattern above.
 */
async function revertEventFieldsOnFailure(
  eventId: string,
  original: Pick<EventRow, 'title' | 'description' | 'date' | 'start_time' | 'end_time'>,
): Promise<void> {
  try {
    await sql`
      UPDATE events
      SET
        title       = ${original.title},
        description = ${original.description},
        date        = ${original.date},
        start_time  = ${original.start_time},
        end_time    = ${original.end_time}
      WHERE id = ${eventId}
    `
  } catch (rollbackError) {
    console.error('events-service: compensating event-fields revert failed (non-fatal):', rollbackError)
  }
}

// ---------------------------------------------------------------------------
// Public API
//
// OIR-208 review (Finding 2 — legacy /api/events double-write surface):
// listEvents/createEvent/updateEvent/deleteEvent below back the legacy
// internal-events dashboard section, which has since been replaced by the
// unified "Eventos" flow in lib/server/club-events-service.ts. No component
// or hook consumes app/api/events/route.ts or app/api/events/[id]/route.ts
// anymore (verified: no references to the use-admin.ts event hooks outside
// that hook file and its tests). Those routes — and these functions — are
// intentionally NOT removed here because __tests__/app/api/events.test.ts
// and __tests__/server/events-service.test.ts (and
// events-service-multiday.test.ts) exercise them directly and test edits are
// out of scope for this change. Divergence risk: a unified internal event
// (both title_es/title_en NULL, created via the unified admin flow) remains
// writable/deletable through this surface too, with different
// validation/defaults than the unified service. Do not wire any new
// consumer to this surface — prefer lib/server/club-events-service.ts.
// ---------------------------------------------------------------------------

export async function listEvents(): Promise<AdminEvent[]> {
  let rows: EventRow[]
  try {
    rows = await sql`
      SELECT id, title, description, date, start_time, end_time, created_by, created_at
      FROM events
      WHERE title_es IS NULL OR title_en IS NULL
      ORDER BY date ASC, start_time ASC
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  if (rows.length === 0) return []

  let blocks: EventRoomBlockRow[]
  try {
    blocks = await sql`
      SELECT id, event_id, room_id, date, start_time, end_time, all_day
      FROM event_room_blocks
      WHERE event_id = ANY(${rows.map((r) => r.id)})
    ` as EventRoomBlockRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const blocksByEvent = new Map<string, EventRoomBlockRow[]>()
  for (const block of blocks) {
    const list = blocksByEvent.get(block.event_id) ?? []
    list.push(block)
    blocksByEvent.set(block.event_id, list)
  }

  return rows.map((row) => toAdminEvent(row, blocksByEvent.get(row.id) ?? []))
}

export async function getEvent(id: string): Promise<AdminEvent> {
  let eventRows: EventRow[]
  try {
    eventRows = await sql`
      SELECT id, title, description, date, start_time, end_time, created_by, created_at
      FROM events
      WHERE id = ${id}
      LIMIT 1
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  const event = eventRows[0]
  if (!event) serviceError('Event not found', 404)

  let blocks: EventRoomBlockRow[]
  try {
    blocks = await sql`
      SELECT id, event_id, room_id, date, start_time, end_time, all_day
      FROM event_room_blocks
      WHERE event_id = ${id}
    ` as EventRoomBlockRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return toAdminEvent(event, blocks)
}

export async function createEvent(body: {
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
}): Promise<AdminEvent> {
  const title = String(body.title ?? '').trim()
  if (!title) serviceError('Title is required', 400)

  const description = body.description ? String(body.description).trim() : null

  // --- Multi-block path (new) ---
  if (Array.isArray(body.schedules)) {
    if (body.schedules.length === 0) serviceError('At least one schedule is required', 400)
    if (body.schedules.length > 366) serviceError('Too many schedule blocks', 400)

    const normBlocks = body.schedules.map((s, i) => validateAndNormaliseSchedule(s, i))
    const anchor = deriveAnchorFromBlocks(normBlocks)
    const createdBy = body.createdBy ? String(body.createdBy) : null

    let eventRows: EventRow[]
    try {
      eventRows = await sql`
        INSERT INTO events (title, description, date, start_time, end_time, created_by)
        VALUES (${title}, ${description}, ${anchor.date}, ${anchor.start_time}, ${anchor.end_time}, ${createdBy})
        RETURNING id, title, description, date, start_time, end_time, created_by, created_at
      ` as EventRow[]
    } catch (error) {
      mapEventWriteError(error)
    }

    const event = eventRows[0]
    if (!event) serviceError('Internal server error', 500)

    const roomBlocks: EventRoomBlockRow[] = []
    const insertedBlockIds: string[] = []
    const cancelledReservationIds: string[] = []
    for (const block of normBlocks) {
      if (block.room_id === null) continue

      try {
        const blockRows = await sql`
          INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day)
          VALUES (${event.id}, ${block.room_id}, ${block.date}, ${block.start_time}, ${block.end_time}, ${block.all_day})
          RETURNING id, event_id, room_id, date, start_time, end_time, all_day
        ` as EventRoomBlockRow[]

        const blockRow = blockRows[0]
        if (blockRow) {
          roomBlocks.push(blockRow)
          insertedBlockIds.push(blockRow.id)
        }

        const cancelled = await cancelOverlappingReservationsForRoomCapturing(
          block.room_id, block.date, block.start_time, block.end_time,
        )
        cancelledReservationIds.push(...cancelled)
      } catch (error) {
        await rollbackPartialMultiBlockWrite({
          eventId: event.id, insertedBlockIds, cancelledReservationIds, deleteEvent: true,
        })
        mapEventWriteError(error)
      }
    }

    return toAdminEvent(event, roomBlocks)
  }

  // --- Legacy single-block path (preserved for existing callers / tests) ---
  const date = String(body.date ?? '').trim()
  const allDay = parseAllDay(body.allDay)
  const resolvedTimes = resolveBlockTimes(date, String(body.startTime ?? '').trim(), String(body.endTime ?? '').trim(), allDay)
  const roomId = body.roomId ? String(body.roomId).trim() : null

  let eventRows: EventRow[]
  try {
    eventRows = await sql`
      INSERT INTO events (title, description, date, start_time, end_time)
      VALUES (${title}, ${description}, ${date}, ${resolvedTimes.startTime}, ${resolvedTimes.endTime})
      RETURNING id, title, description, date, start_time, end_time, created_by, created_at
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const event = eventRows[0]
  if (!event) serviceError('Internal server error', 500)

  const roomBlocks: EventRoomBlockRow[] = []
  if (roomId) {
    let blockRows: EventRoomBlockRow[]
    try {
      blockRows = await sql`
        INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day)
        VALUES (${event.id}, ${roomId}, ${date}, ${resolvedTimes.startTime}, ${resolvedTimes.endTime}, ${allDay})
        RETURNING id, event_id, room_id, date, start_time, end_time, all_day
      ` as EventRoomBlockRow[]
    } catch {
      // #303 code-review round 3, Finding 1: the event insert above and this
      // block insert are two separate statements (same non-transactional
      // constraint as the multi-block loops — see file header). On failure
      // here, remove the just-inserted event row so it doesn't persist
      // orphaned with zero blocks, mirroring the multi-block createEvent
      // path's rollbackPartialMultiBlockWrite(deleteEvent: true).
      await rollbackPartialMultiBlockWrite({
        eventId: event.id, insertedBlockIds: [], cancelledReservationIds: [], deleteEvent: true,
      })
      serviceError('Internal server error', 500)
    }

    const blockRow = blockRows[0]
    if (blockRow) roomBlocks.push(blockRow)

    try {
      await cancelOverlappingReservationsForRoom(roomId, date, resolvedTimes.startTime, resolvedTimes.endTime)
    } catch (error) {
      // #303 code-review round 5: this call was previously outside any
      // try/catch — a failure here left the just-committed event + block
      // rows with no compensation. Delete the just-inserted event (cascades
      // to its block via ON DELETE CASCADE — see
      // lib/db/schema/009_event_room_blocks.sql), mirroring the block-insert
      // failure's rollback above.
      await rollbackPartialMultiBlockWrite({
        eventId: event.id, insertedBlockIds: blockRow ? [blockRow.id] : [], cancelledReservationIds: [], deleteEvent: true,
      })
      throw error
    }
  }

  return toAdminEvent(event, roomBlocks)
}

export async function updateEvent(
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
  // Load current event to fill in any fields not provided in the body
  let currentRows: Array<Pick<EventRow, 'title' | 'description' | 'date' | 'start_time' | 'end_time' | 'title_es' | 'title_en'>>
  try {
    currentRows = await sql`
      SELECT title, description, date, start_time, end_time, title_es, title_en
      FROM events
      WHERE id = ${id}
      LIMIT 1
    ` as typeof currentRows
  } catch {
    serviceError('Internal server error', 500)
  }

  const currentRow = currentRows[0]
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
    const anchor = deriveAnchorFromBlocks(normBlocks)

    let updatedRows: EventRow[]
    try {
      updatedRows = await sql`
        UPDATE events
        SET
          title       = ${title},
          description = ${description},
          date        = ${anchor.date},
          start_time  = ${anchor.start_time},
          end_time    = ${anchor.end_time}
        WHERE id = ${id}
        RETURNING id, title, description, date, start_time, end_time, created_by, created_at
      ` as EventRow[]
    } catch (error) {
      mapEventWriteError(error)
    }

    const event = updatedRows[0]
    if (!event) serviceError('Event not found', 404)

    // #303 code-review round 4, Finding (4th recurrence): capture (via
    // RETURNING, no extra round trip) the blocks this call is about to wipe,
    // so they can be restored if a later block's INSERT fails mid-loop below
    // — same gap, same fix shape as round 3's legacy single-block updateEvent
    // path (restoreDeletedBlocksOnUpdateFailure).
    let preExistingBlocks: EventRoomBlockRow[]
    try {
      preExistingBlocks = await sql`
        DELETE FROM event_room_blocks
        WHERE event_id = ${id}
        RETURNING id, event_id, room_id, date, start_time, end_time, all_day
      ` as EventRoomBlockRow[]
    } catch {
      // Round 4 audit: the UPDATE events above already committed new field
      // values before this DELETE ran and failed — revert them so the
      // request's 500 isn't paired with a silently-applied partial update.
      await revertEventFieldsOnFailure(id, currentRow)
      serviceError('Internal server error', 500)
    }

    const roomBlocks: EventRoomBlockRow[] = []
    const insertedBlockIds: string[] = []
    const cancelledReservationIds: string[] = []
    for (const block of normBlocks) {
      if (block.room_id === null) continue

      try {
        const blockRows = await sql`
          INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day)
          VALUES (${id}, ${block.room_id}, ${block.date}, ${block.start_time}, ${block.end_time}, ${block.all_day})
          RETURNING id, event_id, room_id, date, start_time, end_time, all_day
        ` as EventRoomBlockRow[]

        const blockRow = blockRows[0]
        if (blockRow) {
          roomBlocks.push(blockRow)
          insertedBlockIds.push(blockRow.id)
        }

        const cancelled = await cancelOverlappingReservationsForRoomCapturing(
          block.room_id, block.date, block.start_time, block.end_time,
        )
        cancelledReservationIds.push(...cancelled)
      } catch (error) {
        // Unlike createEvent, `event` pre-existed this call — only the newly
        // (partially) inserted blocks and cancellations from this call are
        // rolled back; the event row itself is not deleted on failure.
        // Also restore the pre-existing blocks the unconditional DELETE
        // above already wiped (see comment there) — without this, the event
        // would silently end up with zero room blocks alongside whatever
        // this call itself managed to insert.
        await rollbackPartialMultiBlockWrite({
          eventId: id, insertedBlockIds, cancelledReservationIds, deleteEvent: false,
        })
        await restoreDeletedBlocksOnUpdateFailure(preExistingBlocks)
        await revertEventFieldsOnFailure(id, currentRow)
        mapEventWriteError(error)
      }
    }

    return toAdminEvent(event, roomBlocks)
  }

  // --- Legacy single-block path ---
  const date = body.date !== undefined ? String(body.date).trim() || currentRow.date : currentRow.date
  const inputStartTime =
    body.startTime !== undefined
      ? String(body.startTime).trim() || currentRow.start_time.slice(0, 5)
      : currentRow.start_time.slice(0, 5)
  const inputEndTime =
    body.endTime !== undefined
      ? String(body.endTime).trim() || currentRow.end_time.slice(0, 5)
      : currentRow.end_time.slice(0, 5)

  let roomId: string | null
  let currentAllDay = false
  if (body.roomId === undefined || body.allDay === undefined) {
    let existingBlocks: Array<{ room_id: string; all_day: boolean }>
    try {
      existingBlocks = await sql`
        SELECT room_id, all_day
        FROM event_room_blocks
        WHERE event_id = ${id}
        LIMIT 1
      ` as Array<{ room_id: string; all_day: boolean }>
    } catch {
      serviceError('Internal server error', 500)
    }

    const firstBlock = existingBlocks[0]
    currentAllDay = firstBlock?.all_day ?? false
    roomId = body.roomId !== undefined
      ? (body.roomId ? String(body.roomId).trim() : null)
      : (firstBlock ? firstBlock.room_id : null)
  } else {
    roomId = body.roomId ? String(body.roomId).trim() : null
  }
  const allDay = body.allDay !== undefined ? parseAllDay(body.allDay) : currentAllDay
  const resolvedTimes = resolveBlockTimes(date, inputStartTime, inputEndTime, allDay)

  let updatedRows: EventRow[]
  try {
    updatedRows = await sql`
      UPDATE events
      SET
        title       = ${title},
        description = ${description},
        date        = ${date},
        start_time  = ${resolvedTimes.startTime},
        end_time    = ${resolvedTimes.endTime}
      WHERE id = ${id}
      RETURNING id, title, description, date, start_time, end_time, created_by, created_at
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const event = updatedRows[0]
  // Race: the event existed at the SELECT above but was deleted before this
  // UPDATE ran. Matches the multi-block path's identical race (line ~631),
  // which already returns 404 here — keep both paths consistent (#303
  // code-review Finding 3) instead of this one surfacing a spurious 500.
  if (!event) serviceError('Event not found', 404)

  // #303 code-review round 3, Finding 2: capture (via RETURNING, no extra
  // round trip) the blocks this call is about to delete, so they can be
  // restored if the replacement INSERT below fails — otherwise the event
  // silently loses its room assignment (ends up with zero blocks) on a 500.
  let blocksToRestoreOnFailure: EventRoomBlockRow[]
  try {
    blocksToRestoreOnFailure = await sql`
      DELETE FROM event_room_blocks
      WHERE event_id = ${id}
      RETURNING id, event_id, room_id, date, start_time, end_time, all_day
    ` as EventRoomBlockRow[]
  } catch {
    // Round 4 audit: the UPDATE events above already committed new field
    // values before this DELETE ran and failed — revert them so the
    // request's 500 isn't paired with a silently-applied partial update.
    await revertEventFieldsOnFailure(id, currentRow)
    serviceError('Internal server error', 500)
  }

  const roomBlocks: EventRoomBlockRow[] = []
  if (roomId) {
    let blockRows: EventRoomBlockRow[]
    try {
      blockRows = await sql`
        INSERT INTO event_room_blocks (event_id, room_id, date, start_time, end_time, all_day)
        VALUES (${id}, ${roomId}, ${date}, ${resolvedTimes.startTime}, ${resolvedTimes.endTime}, ${allDay})
        RETURNING id, event_id, room_id, date, start_time, end_time, all_day
      ` as EventRoomBlockRow[]
    } catch {
      await restoreDeletedBlocksOnUpdateFailure(blocksToRestoreOnFailure)
      await revertEventFieldsOnFailure(id, currentRow)
      serviceError('Internal server error', 500)
    }

    const blockRow = blockRows[0]
    if (blockRow) roomBlocks.push(blockRow)

    try {
      await cancelOverlappingReservationsForRoom(roomId, date, resolvedTimes.startTime, resolvedTimes.endTime)
    } catch (error) {
      // #303 code-review round 5: this call was previously outside any
      // try/catch. By this point the event fields were updated, the old
      // blocks deleted, and the new block inserted — a failure here left
      // all of that committed, with conflicting reservations still active
      // (double-booking risk) on top of the silent partial write. Undo
      // everything this call did: delete the newly-inserted block, restore
      // the blocks that existed before this call, and revert the event's
      // field values — same helpers used by the failure branches above.
      await rollbackPartialMultiBlockWrite({
        eventId: id, insertedBlockIds: blockRow ? [blockRow.id] : [], cancelledReservationIds: [], deleteEvent: false,
      })
      await restoreDeletedBlocksOnUpdateFailure(blocksToRestoreOnFailure)
      await revertEventFieldsOnFailure(id, currentRow)
      throw error
    }
  }

  return toAdminEvent(event, roomBlocks)
}

export async function deleteEvent(id: string): Promise<void> {
  let eventRows: Array<Pick<EventRow, 'id' | 'title_es' | 'title_en'>>
  try {
    eventRows = await sql`
      SELECT id, title_es, title_en FROM events WHERE id = ${id} LIMIT 1
    ` as Array<Pick<EventRow, 'id' | 'title_es' | 'title_en'>>
  } catch {
    serviceError('Internal server error', 500)
  }

  const eventData = eventRows[0]
  if (!eventData) serviceError('Event not found', 404)

  // Finding 3: a club-event (landing) row is out of scope for this legacy
  // internal surface — treat it as not found, same as listEvents' filter.
  if (isClubEventRow(eventData)) {
    serviceError('Event not found', 404)
  }

  await deleteEventCascade(undefined, id)
}

/**
 * Cancel overlapping reservations for every room block attached to `id`,
 * then delete the event row (blocks cascade via FK). Shared by `deleteEvent`
 * (legacy internal surface, guarded above) and
 * `lib/server/club-events-service.ts`'s `deleteClubEvent` (which performs its
 * own club-event-row validation — the inverse of the guard above — before
 * calling this directly, so it must NOT go through the `isClubEventRow`
 * check in `deleteEvent`).
 *
 * DUAL PATH (#303 code-review Finding 1): `club-events-service.ts` is still
 * Supabase-based (#304, not started) — `deleteClubEvent` confirms the event
 * row exists via Supabase and then calls this function with its own
 * Supabase admin client. `events`/`event_room_blocks` are effectively empty
 * in Neon until #304 migrates that service, so routing that caller through
 * the Neon-only path below would silently affect 0 rows — `deleteClubEvent`
 * would report success without deleting anything. So: when a real Supabase
 * admin client is passed, this restores the pre-#303 Supabase-based cascade
 * (see `git show develop:lib/server/events-service.ts`) for that caller;
 * when called with `undefined` (this service's own, already-migrated
 * `deleteEvent`), it uses the Neon path. Remove this dual path once #304
 * migrates `club-events-service.ts` to Neon and its caller no longer has a
 * Supabase admin client to pass here.
 */
export async function deleteEventCascade(
  admin: SupabaseAdminClient | undefined,
  id: string,
): Promise<void> {
  if (admin) {
    await deleteEventCascadeSupabase(admin, id)
    return
  }

  let blocks: Array<{ room_id: string; date: string; start_time: string; end_time: string }>
  try {
    blocks = await sql`
      SELECT room_id, date, start_time, end_time
      FROM event_room_blocks
      WHERE event_id = ${id}
    ` as Array<{ room_id: string; date: string; start_time: string; end_time: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  // Collect distinct room_ids and pre-fetch their table ids into a Map to avoid N+1 round trips
  const distinctRoomIds = [...new Set(blocks.map((b) => b.room_id).filter(Boolean))]

  const roomTableMap = new Map<string, string[]>()
  if (distinctRoomIds.length > 0) {
    let tables: Array<{ id: string; room_id: string }>
    try {
      tables = await sql`
        SELECT id, room_id FROM tables WHERE room_id = ANY(${distinctRoomIds})
      ` as Array<{ id: string; room_id: string }>
    } catch {
      serviceError('Internal server error', 500)
    }

    for (const t of tables) {
      const list = roomTableMap.get(t.room_id) ?? []
      list.push(t.id)
      roomTableMap.set(t.room_id, list)
    }
  }

  // Cancel overlapping reservations for every block (multi-day aware)
  for (const block of blocks) {
    const tableIds = roomTableMap.get(block.room_id) ?? []

    if (tableIds.length > 0) {
      try {
        await sql`
          UPDATE reservations
          SET status = 'cancelled'
          WHERE table_id = ANY(${tableIds})
            AND date = ${block.date}
            AND start_time < ${block.end_time}
            AND end_time > ${block.start_time}
            AND status IN ('active', 'pending')
        `
      } catch {
        serviceError('Internal server error', 500)
      }
    }
  }

  try {
    await sql`DELETE FROM events WHERE id = ${id}`
  } catch {
    serviceError('Internal server error', 500)
  }
}

/**
 * Pre-#303 Supabase-based cascade delete, restored as the fallback path for
 * `deleteEventCascade`'s still-Supabase caller (`club-events-service.ts`'s
 * `deleteClubEvent`) — see the dual-path note above. Ported unchanged from
 * `git show develop:lib/server/events-service.ts`.
 */
async function deleteEventCascadeSupabase(
  admin: SupabaseAdminClient,
  id: string,
): Promise<void> {
  const { data: blocks } = await admin
    .from('event_room_blocks')
    .select('room_id, date, start_time, end_time')
    .eq('event_id', id)

  type SupabaseBlock = { room_id: string; date: string; start_time: string; end_time: string }

  // Collect distinct room_ids and pre-fetch their table ids into a Map to avoid N+1 round trips
  const distinctRoomIds = [...new Set(
    ((blocks ?? []) as SupabaseBlock[]).map((b) => b.room_id).filter(Boolean),
  )]

  const roomTableMap = new Map<string, string[]>()
  if (distinctRoomIds.length > 0) {
    const { data: tables } = await admin
      .from('tables')
      .select('id, room_id')
      .in('room_id', distinctRoomIds)

    for (const t of (tables ?? []) as { id: string; room_id: string }[]) {
      const list = roomTableMap.get(t.room_id) ?? []
      list.push(t.id)
      roomTableMap.set(t.room_id, list)
    }
  }

  // Cancel overlapping reservations for every block (multi-day aware)
  for (const block of (blocks ?? []) as SupabaseBlock[]) {
    const tableIds = roomTableMap.get(block.room_id) ?? []

    if (tableIds.length > 0) {
      const { error: cancelError } = await admin
        .from('reservations')
        .update({ status: 'cancelled' })
        .in('table_id', tableIds)
        .eq('date', block.date)
        .lt('start_time', block.end_time)
        .gt('end_time', block.start_time)
        .in('status', ['active', 'pending'])

      if (cancelError) serviceError('Internal server error', 500)
    }
  }

  const { error } = await admin.from('events').delete().eq('id', id)
  if (error) serviceError('Internal server error', 500)
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

  // Pre-fetch table ids for all distinct rooms in one round-trip (avoids N+1)
  const distinctRoomIds = [...new Set(roomedBlocks.map((b) => b.room_id))]

  let tables: Array<{ id: string; room_id: string }>
  try {
    tables = await sql`
      SELECT id, room_id FROM tables WHERE room_id = ANY(${distinctRoomIds})
    ` as Array<{ id: string; room_id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const roomTableMap = new Map<string, string[]>()
  for (const t of tables) {
    const list = roomTableMap.get(t.room_id) ?? []
    list.push(t.id)
    roomTableMap.set(t.room_id, list)
  }

  const resultBlocks: EventConflictBlock[] = []
  let total = 0

  for (const block of roomedBlocks) {
    const tableIds = roomTableMap.get(block.room_id) ?? []

    if (tableIds.length === 0) {
      resultBlocks.push({ date: block.date, roomId: block.room_id, count: 0 })
      continue
    }

    let countRows: Array<{ count: string | number }>
    try {
      countRows = await sql`
        SELECT COUNT(*) AS count
        FROM reservations
        WHERE table_id = ANY(${tableIds})
          AND date = ${block.date}
          AND start_time < ${block.end_time}
          AND end_time > ${block.start_time}
          AND status IN ('active', 'pending')
      ` as Array<{ count: string | number }>
    } catch {
      serviceError('Internal server error', 500)
    }

    const blockCount = Number(countRows[0]?.count ?? 0)
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
  let blocks: Array<{ event_id: string }>
  try {
    blocks = await sql`
      SELECT event_id
      FROM event_room_blocks
      WHERE room_id = ${roomId}
        AND date = ${date}
        AND start_time < ${end}
        AND end_time > ${start}
    ` as Array<{ event_id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const eventIds = [...new Set(blocks.map((b) => b.event_id))]
  if (eventIds.length === 0) return []

  let events: EventRow[]
  try {
    events = await sql`
      SELECT id, title, description, date, start_time, end_time, created_by, created_at
      FROM events
      WHERE id = ANY(${eventIds})
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return events.map((row) => toAdminEvent(row, []))
}
