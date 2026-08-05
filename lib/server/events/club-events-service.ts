import 'server-only'
import { and, asc, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm'
import type {
  AdminClubEvent,
  AdminEventMaterial,
  AdminEventRoomBlock,
  AdminListClubEventsResult,
  ClubEvent,
  ClubEventDateKind,
  ClubEventStatus,
} from '@/lib/types'
import { getDrizzleAdminDb, getDrizzleDb, type AdminDbClient } from '@/lib/db'
import { equipment, eventEquipment, events, eventRoomBlocks, reservations, rooms, tables } from '@/lib/db/schema'
import { ServiceError, serviceError } from '@/lib/server/shared/service-error'
import { getCurrentClubDate } from '@/lib/club-time'
import type { SessionUser } from '@/lib/server/auth/auth'
import {
  cancelSavedGamesForBlockedRoom,
  deleteEventCascade,
  isClubEventRow,
  validateAndNormaliseSchedule,
  type NormalisedEventSchedule,
} from '@/lib/server/events/events-service'
import { validateOptionalUrl } from '@/lib/validations/url'

export type { AdminClubEvent, AdminListClubEventsResult }

type EventRow = typeof events.$inferSelect
type EventRoomBlockRow = typeof eventRoomBlocks.$inferSelect

/** Transaction handle type, same pattern as events-service.ts's `AdminTx`. */
type AdminTx = Parameters<Parameters<AdminDbClient['transaction']>[0]>[0]

/**
 * KIM-438: `events` / `event_room_blocks` / `event_equipment` reads/writes
 * below use the Drizzle/Neon seam (`getDrizzleDb()` / `getDrizzleAdminDb()`),
 * following the pattern established in `lib/server/events/events-service.ts`
 * (KIM-434 PR3) and `lib/server/reservations/reservations-service.ts`
 * (#238). `reservations` is also on Drizzle/Neon, so reservation cancellation
 * for blocked rooms/tables runs inside the same transaction as event/block
 * writes here and in `events-service.ts`. Both paths now preserve the
 * all-or-nothing behavior of the removed Postgres RPCs.
 */

/**
 * Runs a Drizzle query, translating any thrown DB/driver error into a
 * uniform 500 ServiceError. Business-logic outcomes (e.g. "no row
 * returned" -> 404, validation -> 400) are handled by callers, outside this
 * wrapper, so their specific status codes aren't swallowed into a 500.
 * (Same helper as lib/server/events/events-service.ts.)
 */
async function runQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch {
    serviceError('Internal server error', 500)
  }
}

const DEFAULT_PAST_LIMIT = 24

/**
 * "Upcoming" vs "past" is derived from date/end_date at read time rather than
 * stored — a recurring event (e.g. "every Friday") is always upcoming since
 * it has no defined end.
 */
function statusFor(row: Pick<EventRow, 'dateKind' | 'date' | 'endDate'>, today: string): ClubEventStatus {
  if (row.dateKind === 'recurring') return 'upcoming'
  const referenceDate = row.endDate ?? row.date
  return referenceDate < today ? 'past' : 'upcoming'
}

function toClubEvent(row: EventRow, today: string): ClubEvent {
  return {
    id: row.id,
    titleEs: row.titleEs ?? row.title,
    titleEn: row.titleEn ?? row.title,
    blurbEs: row.blurbEs ?? '',
    blurbEn: row.blurbEn ?? '',
    descriptionEs: row.descriptionEs,
    descriptionEn: row.descriptionEn,
    dateKind: (row.dateKind as ClubEventDateKind) ?? 'single',
    startDate: row.date,
    endDate: row.endDate,
    recurrenceLabelEs: row.recurrenceLabelEs,
    recurrenceLabelEn: row.recurrenceLabelEn,
    imageUrl: row.imageUrl,
    linkUrl: row.linkUrl,
    status: statusFor(row, today),
  }
}

export interface ListClubEventsOptions {
  /** Maximum number of past events to return (most recent first). Defaults to 24. */
  pastLimit?: number
}

export interface ListClubEventsResult {
  upcoming: ClubEvent[]
  past: ClubEvent[]
}

/**
 * Public read of club marketing events (tournaments, game nights, club
 * history) for the landing page. These live in the same "events" table used
 * for internal room-reservation blocking (lib/server/events/events-service.ts) —
 * a row is landing-eligible once it carries bilingual copy (title_es/title_en).
 * Uses the RLS-respecting client since this is unauthenticated, publicly
 * readable content; the "events_select_public" RLS policy additionally
 * restricts anon visibility to rows with bilingual copy populated.
 */
export async function listClubEvents(options: ListClubEventsOptions = {}): Promise<ListClubEventsResult> {
  const pastLimit = options.pastLimit ?? DEFAULT_PAST_LIMIT
  const today = getCurrentClubDate()

  const db = getDrizzleDb()
  const rows = await runQuery(
    db
      .select()
      .from(events)
      .where(and(isNotNull(events.titleEs), isNotNull(events.titleEn)))
      .orderBy(asc(events.date)),
  )

  const eventList = rows.map((row) => toClubEvent(row, today))

  const upcoming = eventList.filter((event) => event.status === 'upcoming')
  const past = eventList
    .filter((event) => event.status === 'past')
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
    .slice(0, pastLimit)

  return { upcoming, past }
}

// ---------------------------------------------------------------------------
// Admin CRUD (OIR-203)
//
// Public club events are rows in the same "events" table used for internal
// room-reservation blocking. Room blocking is optional: creating/updating a
// club event never creates event_room_blocks rows unless the admin
// explicitly attaches them via `blocksRooms` + `schedules` (reusing the same
// validation as the internal admin event flow in events-service.ts).
//
// Privilege checks (role === 'admin') live here in the service layer, not in
// the route handlers, so every entry point is protected regardless of how
// it's invoked.
// ---------------------------------------------------------------------------

export interface ClubEventInput {
  titleEs?: unknown
  titleEn?: unknown
  blurbEs?: unknown
  blurbEn?: unknown
  descriptionEs?: unknown
  descriptionEn?: unknown
  dateKind?: unknown
  date?: unknown
  endDate?: unknown
  recurrenceLabelEs?: unknown
  recurrenceLabelEn?: unknown
  imageUrl?: unknown
  linkUrl?: unknown
  categoryEs?: unknown
  categoryEn?: unknown
  /** When true, `schedules` is required and creates/replaces room blocks. */
  blocksRooms?: unknown
  schedules?: unknown
  /**
   * OIR-208: unified events. ON (default for new events) writes the
   * bilingual landing columns (title_es/title_en, ...) so the event
   * publishes on the landing; OFF stores title_es/title_en as NULL (paired
   * constraint holds) and keeps the Spanish title in the legacy `title`
   * column only — an internal-only event. Toggling this on an update
   * converts the row in place.
   */
  visibleOnLanding?: unknown
  /** Materials (equipment) needed for the event; replace-set on every save. */
  materials?: unknown
}

function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

function requireNonEmptyString(value: unknown, field: string): string {
  const str = typeof value === 'string' ? value.trim() : ''
  if (!str) serviceError(`${field} is required`, 400)
  return str
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  // Finding 5: mirror requireNonEmptyString's typeof guard — a non-string,
  // non-null value (e.g. `{}`, `[]`, a number) must be rejected rather than
  // silently coerced via String(value), which would persist "[object
  // Object]" or similar garbage into the row.
  if (typeof value !== 'string') serviceError(`${field} must be a string`, 400)
  const str = value.trim()
  return str === '' ? null : str
}

const CLUB_EVENT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function requireDateString(value: unknown, field: string): string {
  const str = typeof value === 'string' ? value.trim() : ''
  if (!CLUB_EVENT_DATE_RE.test(str)) serviceError(`${field} must be in YYYY-MM-DD format`, 400)
  return str
}

function optionalDateString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const str = String(value).trim()
  if (!CLUB_EVENT_DATE_RE.test(str)) serviceError(`${field} must be in YYYY-MM-DD format`, 400)
  return str
}

function normaliseDateKind(value: unknown): ClubEventDateKind {
  const str = String(value ?? '').trim()
  if (str !== 'single' && str !== 'range' && str !== 'recurring') {
    serviceError('dateKind must be one of single, range, recurring', 400)
  }
  return str as ClubEventDateKind
}

function parseBooleanFlag(value: unknown): boolean {
  return value === true || value === 'true'
}

/**
 * OIR-206: English copy is optional everywhere — when the admin leaves an
 * `*En` field blank, fall back to the paired `*Es` value so DB NOT NULL /
 * paired constraints (`events_bilingual_titles_paired`) stay satisfied and
 * the landing still renders content in the EN locale.
 *
 * Resolution rules (explicit, in priority order):
 * 1. `enProvided` and the trimmed value is non-empty → use it verbatim.
 * 2. `enProvided` and the trimmed value is empty → treat blanking as
 *    "re-enable auto-copy": return the (new) ES value.
 * 3. Not provided (`undefined`) → preserve `current.en` if it exists and
 *    differs from the OLD ES value (a deliberate edit); if `current.en`
 *    equals the OLD ES value (or there is no current row), auto-copy the
 *    new ES value.
 *
 * Rule 3's "identical EN === ES" auto-copy heuristic is safe because our
 * admin forms always resend every field: a deliberately identical EN is
 * resent explicitly on every update and is preserved by rule 1, so it never
 * falls into rule 3's heuristic path.
 */
function resolveBilingualEnFallback(
  field: string,
  esValue: string | null,
  rawEn: unknown,
  enProvided: boolean,
  current: { es: string | null; en: string | null } | null,
): string | null {
  if (enProvided) {
    // Finding 5 (mirrors optionalString): a non-string, non-null value (an
    // array, object, number…) must be rejected rather than silently treated
    // as "absent" and falling back to the ES value.
    if (rawEn !== null && typeof rawEn !== 'string') {
      serviceError(`${field} must be a string`, 400)
    }
    const trimmed = typeof rawEn === 'string' ? rawEn.trim() : ''
    return trimmed !== '' ? trimmed : esValue
  }
  if (!current) return esValue
  const wasAutoCopied = current.en === current.es
  return wasAutoCopied ? esValue : current.en
}

interface ClubEventFieldSet {
  // OIR-208: null when visibleOnLanding is false (internal-only event) — the
  // paired-titles CHECK constraint holds since both are nulled together.
  titleEs: string | null
  titleEn: string | null
  blurbEs: string | null
  blurbEn: string | null
  descriptionEs: string | null
  descriptionEn: string | null
  categoryEs: string | null
  categoryEn: string | null
  dateKind: ClubEventDateKind
  date: string
  endDate: string | null
  recurrenceLabelEs: string | null
  recurrenceLabelEn: string | null
  imageUrl: string | null
  linkUrl: string | null
  // Legacy single-locale anchor columns kept NOT NULL by the original
  // "events" schema — mirrored from the ES copy / all-day sentinel, same
  // convention used by the OIR-202 seed migration, since club events have no
  // meaningful room-block time-of-day unless blocksRooms is also set.
  title: string
  description: string | null
  startTime: string
  endTime: string
}

/**
 * Resolve the full field set for a create/update, falling back to the
 * current row's values for anything omitted from the payload. `current` is
 * null for creates, where every field not provided by the caller falls back
 * to empty/required validation instead.
 */
function resolveClubEventFields(body: ClubEventInput, current: EventRow | null): ClubEventFieldSet {
  // OIR-208: current.title_es is NULL for internal-only events — fall back
  // to the legacy `title` column (same convention as the read-side mappers)
  // so editing an internal event without resending titleEs doesn't 400.
  const titleEs = body.titleEs !== undefined
    ? requireNonEmptyString(body.titleEs, 'titleEs')
    : requireNonEmptyString(current ? (current.titleEs ?? current.title) : null, 'titleEs')
  // OIR-206: titleEn is optional — falls back to titleEs (see
  // resolveBilingualEnFallback) rather than being required client- or
  // service-side. `?? titleEs` is a type-level safety net only; in practice
  // the fallback never returns null here because titleEs is always a
  // non-empty string.
  const titleEn = resolveBilingualEnFallback(
    'titleEn',
    titleEs,
    body.titleEn,
    body.titleEn !== undefined,
    current ? { es: current.titleEs, en: current.titleEn } : null,
  ) ?? titleEs

  const blurbEs = body.blurbEs !== undefined ? optionalString(body.blurbEs, 'blurbEs') : (current?.blurbEs ?? null)
  const blurbEn = resolveBilingualEnFallback(
    'blurbEn',
    blurbEs,
    body.blurbEn,
    body.blurbEn !== undefined,
    current ? { es: current.blurbEs, en: current.blurbEn } : null,
  )
  const descriptionEs = body.descriptionEs !== undefined ? optionalString(body.descriptionEs, 'descriptionEs') : (current?.descriptionEs ?? null)
  const descriptionEn = resolveBilingualEnFallback(
    'descriptionEn',
    descriptionEs,
    body.descriptionEn,
    body.descriptionEn !== undefined,
    current ? { es: current.descriptionEs, en: current.descriptionEn } : null,
  )
  const categoryEs = body.categoryEs !== undefined ? optionalString(body.categoryEs, 'categoryEs') : (current?.categoryEs ?? null)
  const categoryEn = resolveBilingualEnFallback(
    'categoryEn',
    categoryEs,
    body.categoryEn,
    body.categoryEn !== undefined,
    current ? { es: current.categoryEs, en: current.categoryEn } : null,
  )
  const recurrenceLabelEs = body.recurrenceLabelEs !== undefined
    ? optionalString(body.recurrenceLabelEs, 'recurrenceLabelEs')
    : (current?.recurrenceLabelEs ?? null)
  const recurrenceLabelEn = resolveBilingualEnFallback(
    'recurrenceLabelEn',
    recurrenceLabelEs,
    body.recurrenceLabelEn,
    body.recurrenceLabelEn !== undefined,
    current ? { es: current.recurrenceLabelEs, en: current.recurrenceLabelEn } : null,
  )

  const dateKind = body.dateKind !== undefined
    ? normaliseDateKind(body.dateKind)
    : ((current?.dateKind as ClubEventDateKind | undefined) ?? 'single')

  const startDate = body.date !== undefined
    ? requireDateString(body.date, 'date')
    : requireDateString(current?.date, 'date')

  let endDate: string | null = null
  if (dateKind === 'range') {
    endDate = body.endDate !== undefined
      ? optionalDateString(body.endDate, 'endDate')
      : (current?.endDate ?? null)
    if (!endDate) serviceError('endDate is required when dateKind is range', 400)
    if (endDate < startDate) serviceError('endDate must be on or after date', 400)
  }

  const imageUrl = body.imageUrl !== undefined ? validateOptionalUrl(body.imageUrl, 'imageUrl') : (current?.imageUrl ?? null)
  const linkUrl = body.linkUrl !== undefined ? validateOptionalUrl(body.linkUrl, 'linkUrl') : (current?.linkUrl ?? null)

  // OIR-208: ON (default for new events) publishes the bilingual columns;
  // OFF nulls them (paired constraint holds) and keeps only the legacy
  // `title` column populated — an internal-only event. When omitted on an
  // update, preserve whatever the row currently is.
  // KIM-438: isClubEventRow (imported from the already-migrated
  // events-service.ts) expects the camelCase (Drizzle) shape
  // { titleEs, titleEn } — `current` is now a Drizzle row already in that
  // shape, so no inline snake_case->camelCase mapping is needed here anymore.
  const visibleOnLanding = body.visibleOnLanding !== undefined
    ? parseBooleanFlag(body.visibleOnLanding)
    : (current ? isClubEventRow(current) : true)

  // OIR-208 review fix: the unified form never edits description/start_time/
  // end_time, so an UPDATE must preserve whatever is already on the row (a
  // pre-existing legacy internal event may carry a real description and
  // anchor times, and silently nulling/resetting them on every save would
  // destroy that data) — only a CREATE gets the all-day/no-description
  // defaults, since there is no prior row to preserve.
  const description = current ? current.description : null
  const startTime = current ? current.startTime : '00:00:00'
  const endTime = current ? current.endTime : '23:59:00'

  return {
    titleEs: visibleOnLanding ? titleEs : null,
    titleEn: visibleOnLanding ? titleEn : null,
    // Deliberate (toggle OFF stale content): blurb/description/image are kept
    // as-is when visibleOnLanding flips to false rather than being cleared.
    // This preserves the marketing copy for a later re-publish and lets the
    // admin form show it back for review when the event is re-enabled.
    blurbEs,
    blurbEn,
    descriptionEs,
    descriptionEn,
    categoryEs,
    categoryEn,
    dateKind,
    date: startDate,
    endDate,
    recurrenceLabelEs,
    recurrenceLabelEn,
    imageUrl,
    linkUrl,
    title: titleEs,
    description,
    startTime,
    endTime,
  }
}

function toAdminClubEvent(
  row: EventRow,
  blocks: EventRoomBlockRow[],
  materials: AdminEventMaterial[],
  today: string,
): AdminClubEvent {
  const roomBlocks: AdminEventRoomBlock[] = blocks.map((b) => ({
    id: b.id,
    roomId: b.roomId,
    tableId: b.tableId ?? null,
    date: b.date,
    startTime: b.startTime.slice(0, 5),
    endTime: b.endTime.slice(0, 5),
    allDay: b.allDay,
  }))

  return {
    id: row.id,
    titleEs: row.titleEs ?? row.title,
    titleEn: row.titleEn ?? row.title,
    blurbEs: row.blurbEs ?? '',
    blurbEn: row.blurbEn ?? '',
    descriptionEs: row.descriptionEs,
    descriptionEn: row.descriptionEn,
    dateKind: (row.dateKind as ClubEventDateKind) ?? 'single',
    startDate: row.date,
    endDate: row.endDate,
    recurrenceLabelEs: row.recurrenceLabelEs,
    recurrenceLabelEn: row.recurrenceLabelEn,
    imageUrl: row.imageUrl,
    linkUrl: row.linkUrl,
    categoryEs: row.categoryEs,
    categoryEn: row.categoryEn,
    status: statusFor(row, today),
    blocksRooms: roomBlocks.length > 0,
    roomBlocks,
    // OIR-208: unified events — a row is landing-visible once both bilingual
    // titles are populated (same predicate as isClubEventRow).
    // KIM-438: row is already the camelCase Drizzle shape isClubEventRow
    // expects — no inline mapping needed anymore.
    visibleOnLanding: isClubEventRow(row),
    materials,
  }
}

/**
 * KIM-438: room/table consistency guard, reimplemented from the removed
 * `apply_club_event_room_blocks` RPC (which raised a 23514 check_violation
 * in-DB when a block's table_id didn't belong to its room_id). Independent
 * FKs on room_id/table_id alone don't catch a table_id from an unrelated
 * room — same rationale and same shape as
 * `lib/server/events/events-service.ts`'s `assertBlocksTableRoomConsistency`
 * (kept as a local copy here rather than exported/shared, since this file
 * owns its own transaction and Drizzle-shaped block inputs).
 */
async function assertClubEventBlocksTableRoomConsistency(
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

/**
 * Cancel overlapping active/pending reservations for a set of newly-written
 * event_room_blocks rows, scoped to a single table when the block carries a
 * `tableId` (OIR-208) or the whole room's tables when it doesn't — same
 * overlap predicate the removed `apply_club_event_room_blocks` RPC used.
 *
 * Reservations are on Drizzle/Neon (#238), so this runs inside the caller's
 * transaction and remains atomic with the event/block write.
 */
async function cancelOverlappingReservationsForClubEventBlocks(
  tx: AdminTx,
  blocks: EventRoomBlockRow[],
): Promise<void> {
  if (blocks.length === 0) return

  const roomIdsNeedingLookup = [...new Set(
    blocks.filter((b) => b.tableId === null).map((b) => b.roomId),
  )]

  const roomTableMap = new Map<string, string[]>()
  if (roomIdsNeedingLookup.length > 0) {
    const tableRows = await tx
      .select({ id: tables.id, roomId: tables.roomId })
      .from(tables)
      .where(inArray(tables.roomId, roomIdsNeedingLookup))

    for (const t of tableRows) {
      const list = roomTableMap.get(t.roomId) ?? []
      list.push(t.id)
      roomTableMap.set(t.roomId, list)
    }
  }

  for (const block of blocks) {
    const tableIds = block.tableId ? [block.tableId] : (roomTableMap.get(block.roomId) ?? [])
    if (tableIds.length === 0) continue

    await tx
      .update(reservations)
      .set({ status: 'cancelled' })
      .where(
        and(
          inArray(reservations.tableId, tableIds),
          eq(reservations.date, block.date),
          lt(reservations.startTime, block.endTime),
          gt(reservations.endTime, block.startTime),
          inArray(reservations.status, ['active', 'pending']),
        ),
      )
  }
}

/**
 * Replace room blocks and/or materials for a club event, reimplementing the
 * removed `apply_club_event_room_blocks` SECURITY DEFINER RPC as plain
 * Drizzle statements run inside the CALLER's `tx` (see createClubEvent /
 * updateClubEvent) — deletes existing blocks for the event, inserts one row
 * per schedule entry that has a room attached (entries with no room are
 * informational-only and create no block — this is how "room blocking
 * optional" is enforced even when `blocksRooms` is true but a given
 * schedule row has no room selected), cancels overlapping active/pending
 * reservations for every newly-created block, and cascades to
 * `cancelSavedGamesForBlockedRoom` (KIM-438 fix — previously never called
 * from this file, see events-service.ts's createEventWithBlocksAtomic for
 * the calling convention this mirrors). Materials (event_equipment) are
 * replaced the same way. All of the above shares the SAME transaction as
 * the event row write in the caller, so a failure anywhere rolls back the
 * whole operation atomically — restoring the atomicity the removed RPC
 * used to provide.
 *
 * `blocks`/`materials` of `null` leaves the corresponding rows untouched
 * (mirrors the RPC's "NULL section is skipped" behavior) — used when a save
 * only changes the other axis. An array (including `[]`) fully replaces it.
 * The event's current full block list is always returned, regardless of
 * whether `blocks` was touched (same as the RPC's unconditional final
 * SELECT).
 */
async function applyClubEventRoomBlocksAndMaterials(
  tx: AdminTx,
  eventId: string,
  blocks: NormalisedEventSchedule[] | null,
  materials: NormalisedMaterial[] | null,
): Promise<EventRoomBlockRow[]> {
  if (blocks !== null) {
    await tx.delete(eventRoomBlocks).where(eq(eventRoomBlocks.eventId, eventId))

    const blocksWithRoom = blocks.filter(
      (b): b is NormalisedEventSchedule & { room_id: string } => !!b.room_id,
    )

    await assertClubEventBlocksTableRoomConsistency(tx, blocksWithRoom)

    if (blocksWithRoom.length > 0) {
      const insertedBlocks = await tx
        .insert(eventRoomBlocks)
        .values(
          blocksWithRoom.map((b) => ({
            eventId,
            roomId: b.room_id,
            tableId: b.table_id,
            date: b.date,
            startTime: b.start_time,
            endTime: b.end_time,
            allDay: b.all_day,
          })),
        )
        .returning()

      // KIM-438 fix: this cascade previously had ZERO call sites in this
      // file (confirmed via grep) — blocking a room for a club event never
      // cancelled active saved_games rows for that room/date, unlike the
      // internal admin event flow (events-service.ts). Reuses the same
      // exported helper events-service.ts's own block-write paths call, run
      // inside this same tx for true atomicity with the block insert.
      await cancelSavedGamesForBlockedRoom(
        tx,
        insertedBlocks.map((b) => ({ roomId: b.roomId, tableId: b.tableId, date: b.date })),
      )

      await cancelOverlappingReservationsForClubEventBlocks(tx, insertedBlocks)
    }
  }

  if (materials !== null) {
    await tx.delete(eventEquipment).where(eq(eventEquipment.eventId, eventId))

    if (materials.length > 0) {
      await tx.insert(eventEquipment).values(
        materials.map((m) => ({ eventId, equipmentId: m.equipment_id, quantity: m.quantity })),
      )
    }
  }

  return tx
    .select()
    .from(eventRoomBlocks)
    .where(eq(eventRoomBlocks.eventId, eventId))
    .orderBy(asc(eventRoomBlocks.date), asc(eventRoomBlocks.startTime))
}

/**
 * Order-insensitive comparison of the currently-stored room blocks against
 * an incoming (already-validated) schedules payload — used by Finding 4 to
 * skip the block-replace RPC entirely when a save carries no actual block
 * changes (e.g. a metadata-only edit that always resends the current
 * schedules from the edit form).
 */
function blocksMatchSchedules(current: EventRoomBlockRow[], incoming: NormalisedEventSchedule[]): boolean {
  const incomingWithRoom = incoming.filter((s): s is NormalisedEventSchedule & { room_id: string } => !!s.room_id)
  if (current.length !== incomingWithRoom.length) return false

  const blockKey = (b: { room_id: string; table_id?: string | null; date: string; all_day: boolean; start_time: string; end_time: string }) =>
    `${b.room_id}|${b.table_id ?? ''}|${b.date}|${b.all_day}|${b.start_time.slice(0, 5)}|${b.end_time.slice(0, 5)}`

  const currentKeys = current
    .map((b) => blockKey({
      room_id: b.roomId,
      table_id: b.tableId,
      date: b.date,
      all_day: b.allDay,
      start_time: b.startTime,
      end_time: b.endTime,
    }))
    .sort()
  const incomingKeys = incomingWithRoom.map((s) => blockKey(s)).sort()

  return currentKeys.every((key, i) => key === incomingKeys[i])
}

/** OIR-208: one validated {equipment_id, quantity} entry for an event's materials. */
interface NormalisedMaterial {
  equipment_id: string
  quantity: number
}

const MAX_EVENT_MATERIALS = 100

/** `undefined` means "materials not provided" and resolves to an empty set. */
function validateMaterialsPayload(raw: unknown): NormalisedMaterial[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) serviceError('materials must be an array', 400)
  if (raw.length > MAX_EVENT_MATERIALS) serviceError('Too many materials', 400)

  const seen = new Set<string>()
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      serviceError(`materials[${index}] must be an object`, 400)
    }
    const item = entry as Record<string, unknown>
    const equipmentId = typeof item.equipmentId === 'string' ? item.equipmentId.trim() : ''
    if (!equipmentId) serviceError(`materials[${index}].equipmentId is required`, 400)
    if (seen.has(equipmentId)) serviceError(`materials[${index}].equipmentId is duplicated`, 400)
    seen.add(equipmentId)

    const rawQuantity = item.quantity
    const quantity = rawQuantity === undefined || rawQuantity === null ? 1 : Number(rawQuantity)
    if (!Number.isInteger(quantity) || quantity < 1) {
      serviceError(`materials[${index}].quantity must be a positive integer`, 400)
    }

    return { equipment_id: equipmentId, quantity }
  })
}

async function fetchEventMaterials(
  db: AdminDbClient,
  eventId: string,
): Promise<AdminEventMaterial[]> {
  const rows = await runQuery(
    db
      .select({ equipmentId: eventEquipment.equipmentId, quantity: eventEquipment.quantity, name: equipment.name })
      .from(eventEquipment)
      .innerJoin(equipment, eq(eventEquipment.equipmentId, equipment.id))
      .where(eq(eventEquipment.eventId, eventId)),
  )

  return rows.map((row) => ({ equipmentId: row.equipmentId, name: row.name, quantity: row.quantity }))
}

async function fetchEventMaterialsForMany(
  db: AdminDbClient,
  eventIds: string[],
): Promise<Map<string, AdminEventMaterial[]>> {
  const byEvent = new Map<string, AdminEventMaterial[]>()
  if (eventIds.length === 0) return byEvent

  const rows = await runQuery(
    db
      .select({
        eventId: eventEquipment.eventId,
        equipmentId: eventEquipment.equipmentId,
        quantity: eventEquipment.quantity,
        name: equipment.name,
      })
      .from(eventEquipment)
      .innerJoin(equipment, eq(eventEquipment.equipmentId, equipment.id))
      .where(inArray(eventEquipment.eventId, eventIds)),
  )

  for (const row of rows) {
    const list = byEvent.get(row.eventId) ?? []
    list.push({ equipmentId: row.equipmentId, name: row.name, quantity: row.quantity })
    byEvent.set(row.eventId, list)
  }
  return byEvent
}

function validateSchedulesPayload(raw: unknown): NormalisedEventSchedule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    serviceError('At least one schedule is required when blocksRooms is true', 400)
  }
  if (raw.length > 366) serviceError('Too many schedule blocks', 400)
  return raw.map((s, i) => validateAndNormaliseSchedule(s, i))
}

/**
 * Validate that every room referenced by an incoming schedules payload
 * actually exists, BEFORE any write to the "events" table (PR #149 review).
 * Rejecting unknown room ids up front removes the most common failure cause
 * before the transaction in createClubEvent/updateClubEvent ever opens.
 */
async function validateRoomsExist(
  db: AdminDbClient,
  schedules: NormalisedEventSchedule[],
): Promise<void> {
  const roomIds = Array.from(new Set(schedules.map((s) => s.room_id).filter((id): id is string => !!id)))
  if (roomIds.length === 0) return

  const found = await runQuery(db.select({ id: rooms.id }).from(rooms).where(inArray(rooms.id, roomIds)))

  const foundIds = new Set(found.map((r) => r.id))
  const missing = roomIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid room id in schedules', 400)
}

/**
 * Validate that every table referenced by an incoming schedules payload
 * actually exists (PR #154 review — OIR-208 extends the room-only PR #149
 * fix to also cover the table-scoped blocks the unified event flow allows).
 * Runs BEFORE any write to the "events" table, same rationale as
 * validateRoomsExist.
 */
async function validateTablesExist(
  db: AdminDbClient,
  schedules: NormalisedEventSchedule[],
): Promise<void> {
  const tableIds = Array.from(new Set(schedules.map((s) => s.table_id).filter((id): id is string => !!id)))
  if (tableIds.length === 0) return

  const found = await runQuery(db.select({ id: tables.id }).from(tables).where(inArray(tables.id, tableIds)))

  const foundIds = new Set(found.map((r) => r.id))
  const missing = tableIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid table id in schedules', 400)
}

/**
 * Validate that every equipment id referenced by an incoming materials
 * payload actually exists (PR #154 review), for the same reason
 * validateRoomsExist/validateTablesExist run before any write — an unknown
 * equipment id must be rejected before the event fields UPDATE commits.
 */
async function validateEquipmentExists(
  db: AdminDbClient,
  materials: NormalisedMaterial[],
): Promise<void> {
  const equipmentIds = Array.from(new Set(materials.map((m) => m.equipment_id)))
  if (equipmentIds.length === 0) return

  const found = await runQuery(db.select({ id: equipment.id }).from(equipment).where(inArray(equipment.id, equipmentIds)))

  const foundIds = new Set(found.map((r) => r.id))
  const missing = equipmentIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid equipment id in materials', 400)
}

async function fetchEventRoomBlocks(
  db: AdminDbClient,
  eventId: string,
): Promise<EventRoomBlockRow[]> {
  return runQuery(db.select().from(eventRoomBlocks).where(eq(eventRoomBlocks.eventId, eventId)))
}

/**
 * Admin read of EVERY event (upcoming + past), landing-published or
 * internal-only, including room blocks and materials (OIR-208: the
 * dashboard's unified "Eventos" section shows every row, with a "Landing"
 * badge on published ones — see AdminClubEvent.visibleOnLanding).
 */
export async function listAdminClubEvents(session: SessionUser): Promise<AdminListClubEventsResult> {
  requireAdminSession(session)
  const today = getCurrentClubDate()

  const db = getDrizzleAdminDb()
  const rows = await runQuery(db.select().from(events).orderBy(asc(events.date)))

  if (rows.length === 0) return { upcoming: [], past: [] }

  const eventIds = rows.map((r) => r.id)

  const blocks = await runQuery(
    db.select().from(eventRoomBlocks).where(inArray(eventRoomBlocks.eventId, eventIds)),
  )

  const blocksByEvent = new Map<string, EventRoomBlockRow[]>()
  for (const block of blocks) {
    const list = blocksByEvent.get(block.eventId) ?? []
    list.push(block)
    blocksByEvent.set(block.eventId, list)
  }

  const materialsByEvent = await fetchEventMaterialsForMany(db, eventIds)

  const eventList = rows.map((row) => toAdminClubEvent(
    row,
    blocksByEvent.get(row.id) ?? [],
    materialsByEvent.get(row.id) ?? [],
    today,
  ))
  const upcoming = eventList.filter((event) => event.status === 'upcoming')
  const past = eventList
    .filter((event) => event.status === 'past')
    .sort((a, b) => b.startDate.localeCompare(a.startDate))

  return { upcoming, past }
}

export async function createClubEvent(session: SessionUser, body: ClubEventInput): Promise<AdminClubEvent> {
  requireAdminSession(session)

  // Finding 2: validate EVERYTHING — fields, URL allowlist, and (when
  // blocksRooms/materials are set) their payloads — before any DB write.
  const fields = resolveClubEventFields(body, null)
  const wantsBlocks = parseBooleanFlag(body.blocksRooms)
  const schedules = wantsBlocks ? validateSchedulesPayload(body.schedules) : null
  const materials = validateMaterialsPayload(body.materials)

  const db = getDrizzleAdminDb()

  // PR #149 review: validate every referenced room exists BEFORE the event
  // insert, so the most common cause of a block-write failure (an invalid
  // room id) is rejected up front instead of opening a transaction that
  // would just roll back anyway.
  if (schedules) {
    await validateRoomsExist(db, schedules)
  }
  if (materials.length > 0) {
    await validateEquipmentExists(db, materials)
  }

  // KIM-438: the event insert AND the block/material replace (including
  // reservation-cancellation and the saved_games cascade) now run in ONE
  // db.transaction() — restoring the atomicity the removed
  // apply_club_event_room_blocks RPC used to provide. A failure anywhere
  // inside rolls back the whole operation automatically, so the old
  // "insert row, then compensating-delete on failure" pattern (which was
  // itself non-atomic — the compensating delete could fail too) is no
  // longer needed.
  let result: { row: EventRow; blocks: EventRoomBlockRow[] }
  try {
    result = await db.transaction(async (tx) => {
      const [insertedRow] = await tx
        .insert(events)
        .values({ ...fields, createdBy: session.id })
        .returning()

      if (!insertedRow) serviceError('Internal server error', 500)

      let blockRows: EventRoomBlockRow[] = []
      if (schedules || materials.length > 0) {
        blockRows = await applyClubEventRoomBlocksAndMaterials(
          tx,
          insertedRow.id,
          schedules,
          materials.length > 0 ? materials : null,
        )
      }

      return { row: insertedRow, blocks: blockRows }
    })
  } catch (err) {
    if (err instanceof ServiceError) throw err
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid event data', 400)
    }
    serviceError('Internal server error', 500)
  }

  const eventMaterials = materials.length > 0 ? await fetchEventMaterials(db, result.row.id) : []

  return toAdminClubEvent(result.row, result.blocks, eventMaterials, getCurrentClubDate())
}

export async function updateClubEvent(session: SessionUser, id: string, body: ClubEventInput): Promise<AdminClubEvent> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [current] = await runQuery(db.select().from(events).where(eq(events.id, id)))
  // OIR-208: the unified service operates on ANY event row (landing or
  // internal) — the isClubEventRow guard from OIR-203 is superseded here.
  // The legacy /api/events/[id] endpoints (lib/server/events/events-service.ts)
  // keep their own isClubEventRow guard so old clients can't touch these rows.
  if (!current) serviceError('Club event not found', 404)

  // Finding 2: validate EVERYTHING — fields, URL allowlist, and (when
  // applicable) the schedules/materials payloads — before any DB write
  // (UPDATE below).
  const fields = resolveClubEventFields(body, current)

  const blocksRoomsProvided = body.blocksRooms !== undefined
  const schedulesProvided = body.schedules !== undefined
  const wantsBlocks = blocksRoomsProvided ? parseBooleanFlag(body.blocksRooms) : undefined

  if (wantsBlocks === true && !schedulesProvided) {
    serviceError('At least one schedule is required when blocksRooms is true', 400)
  }

  const validatedSchedules = wantsBlocks !== false && schedulesProvided
    ? validateSchedulesPayload(body.schedules)
    : null

  const materialsProvided = body.materials !== undefined
  const validatedMaterials = materialsProvided ? validateMaterialsPayload(body.materials) : null

  // PR #149 / PR #154 review: validate every referenced room, table, and
  // equipment id BEFORE the event fields UPDATE below, mirroring the
  // createClubEvent fix. Without this, a bad reference (room id, table id,
  // or equipment id) would only surface later from the block/material
  // replace step — by which point the event metadata UPDATE would already
  // be pending in the same transaction.
  if (validatedSchedules) {
    await validateRoomsExist(db, validatedSchedules)
    await validateTablesExist(db, validatedSchedules)
  }
  if (validatedMaterials) {
    await validateEquipmentExists(db, validatedMaterials)
  }

  // `blocksParam` of null means "leave existing blocks untouched" — passed
  // straight through to applyClubEventRoomBlocksAndMaterials, which skips
  // touching event_room_blocks entirely for that value.
  let blocksParam: NormalisedEventSchedule[] | null = null

  if (wantsBlocks === false) {
    // Explicit opt-out: clear any existing room blocks for this event.
    blocksParam = []
  } else if (validatedSchedules) {
    // Finding 4: skip the block-replace step entirely when the incoming
    // schedules are identical to what's already stored — metadata-only
    // edits (title/blurb/etc) always resend the current schedules from the
    // edit form, so this avoids needless churn.
    const cachedCurrentBlocks = await fetchEventRoomBlocks(db, id)
    blocksParam = blocksMatchSchedules(cachedCurrentBlocks, validatedSchedules) ? null : validatedSchedules
  }
  // else: neither blocksRooms nor schedules provided — blocksParam stays
  // null (leave existing blocks untouched).

  const materialsParam = validatedMaterials

  // KIM-438: the event fields UPDATE AND the block/material replace
  // (including reservation-cancellation and the saved_games cascade) now
  // run in ONE db.transaction() — restoring the atomicity the removed
  // apply_club_event_room_blocks RPC used to provide. The old "snapshot
  // originalFields, then compensating-revert on failure" pattern is no
  // longer needed: a failure anywhere inside rolls back the whole
  // operation automatically, including the event fields UPDATE itself.
  let result: { row: EventRow; blocks: EventRoomBlockRow[] }
  try {
    result = await db.transaction(async (tx) => {
      const [updatedRow] = await tx.update(events).set(fields).where(eq(events.id, id)).returning()
      if (!updatedRow) serviceError('Club event not found', 404)

      const blockRows = await applyClubEventRoomBlocksAndMaterials(tx, id, blocksParam, materialsParam)

      return { row: updatedRow, blocks: blockRows }
    })
  } catch (err) {
    if (err instanceof ServiceError) throw err
    const pgCode = (err as { code?: string }).code
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '23502') {
      serviceError('Invalid event data', 400)
    }
    serviceError('Internal server error', 500)
  }

  const eventMaterials = await fetchEventMaterials(db, id)

  return toAdminClubEvent(result.row, result.blocks, eventMaterials, getCurrentClubDate())
}

export async function deleteClubEvent(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db.select({ id: events.id, titleEs: events.titleEs, titleEn: events.titleEn }).from(events).where(eq(events.id, id)),
  )

  // OIR-208: the unified service operates on ANY event row (landing or
  // internal) — the isClubEventRow guard from OIR-203 is superseded here.
  if (!row) serviceError('Club event not found', 404)

  // Reuse the internal delete flow: cancels overlapping reservations for any
  // attached room blocks, then removes the row (and its blocks/materials, via
  // FK cascade) — same behavior as deleting a room-booking event today.
  // Calls deleteEventCascade directly (not the guarded deleteEvent) since
  // this surface intentionally operates on any row — the inverse of
  // deleteEvent's own isClubEventRow guard.
  //
  // KIM-438: deleteEventCascade's signature is `(id)` (verified against
  // events-service.ts, current on develop as of this migration — it no
  // longer takes a Supabase client parameter since events-service.ts's own
  // event/block delete runs on the Drizzle/Neon seam). This file's call
  // already matched that signature before this migration and is unchanged.
  await deleteEventCascade(id)
}
