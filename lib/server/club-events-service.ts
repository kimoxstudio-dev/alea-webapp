import 'server-only'
import type {
  AdminClubEvent,
  AdminEventMaterial,
  AdminEventRoomBlock,
  AdminListClubEventsResult,
  ClubEvent,
  ClubEventDateKind,
  ClubEventStatus,
} from '@/lib/types'
import { sql } from '@/lib/db/client'
import { serviceError, ServiceError } from '@/lib/server/service-error'
import { getCurrentClubDate } from '@/lib/club-time'
import type { Tables } from '@/lib/supabase/types'
import type { SessionUser } from '@/lib/server/auth'
import {
  deleteEventCascade,
  isClubEventRow,
  mapEventWriteError,
  restoreCancelledReservations,
  validateAndNormaliseSchedule,
  type CancelledReservation,
  type NormalisedEventSchedule,
} from '@/lib/server/events-service'
import { validateOptionalUrl } from '@/lib/validations/url'

export type { AdminClubEvent, AdminListClubEventsResult }

/**
 * #304 code-review (high): marks a failure of the post-write read-back
 * SELECT inside `applyClubEventBlocksAndMaterials` — thrown only after every
 * block/material write for the call has already committed successfully.
 * Callers (`createClubEvent`/`updateClubEvent`) special-case this via
 * `instanceof` to skip their own compensating rollback/revert, since there is
 * nothing to compensate: the underlying writes genuinely succeeded and
 * reverting metadata or deleting the event row here would turn a read-only
 * failure into data loss on top of it.
 */
class ClubEventReadBackError extends ServiceError {
  constructor(message: string, statusCode: number) {
    super(message, statusCode)
    this.name = 'ClubEventReadBackError'
  }
}

/**
 * Raw-SQL Neon port of the unified "Club events" admin service (#304).
 *
 * Ported off Supabase (`createSupabaseServerAdminClient`/
 * `createSupabaseServerClient`) to the tagged-template `sql` export from
 * `lib/db/client.ts`, matching the established style from
 * `events-service.ts` (#303), `equipment-service.ts` (#305), and
 * `rooms-service.ts`/`tables-service.ts` (#302/#308).
 *
 * The `apply_club_event_room_blocks` Postgres RPC this service used to call
 * (see `supabase/migrations/20260704000004_oir203_apply_club_event_blocks_rpc.sql`
 * and `20260704000006_oir208_table_blocks_and_materials.sql`) is business
 * logic, not table structure, and is intentionally NOT part of the Neon
 * schema-as-code (that's #309/#334, not started). Its exact behavior is
 * reproduced here as plain sequential `sql` statements in
 * `applyClubEventBlocksAndMaterials`, with the same compensating-rollback
 * approach already established in `events-service.ts` for multi-step writes
 * that aren't wrapped in a real `sql.transaction()` (Neon's HTTP driver only
 * batches queries built up-front, not ones that branch on a prior query's
 * runtime result).
 *
 * #334: the legacy `cancel_saved_games_for_event_block()` trigger function
 * (`supabase/migrations/20260619000010_kim384_event_cancels_saved_games.sql`,
 * wired via the `event_blocks_cancel_saved_games` AFTER INSERT OR UPDATE OF
 * room_id, date trigger in `..._trigger.sql`) auto-cancelled active
 * `saved_games` rows conflicting with a newly written `event_room_blocks`
 * row and had no app-layer equivalent — the audit in #309 flagged it as the
 * one real gap. `cancelActiveSavedGamesForRoomBlock` below ports it, with
 * two deliberate departures from the original trigger — table-scoping
 * (matches the block's own `table_id` instead of always cancelling
 * room-wide) and advisory-lock coordination with `createSavedGameForSession`
 * (see its own doc comment for the exact semantics preserved and why they
 * changed), called alongside the existing reservation-cancellation step per inserted
 * block, since this function only ever inserts new `event_room_blocks` rows
 * (never updates room_id/date on an existing row in place), which is the
 * INSERT half of the original trigger's "AFTER INSERT OR UPDATE OF room_id,
 * date" firing condition.
 */

type EventRow = Tables<'events'>
type EventRoomBlockRow = Tables<'event_room_blocks'>
type EventEquipmentRow = Tables<'event_equipment'>

// Includes the legacy `title` column: toAdminClubEvent falls back to it via
// `row.title_es ?? row.title` for internal-only events (title_es is null),
// so it must be fetched here or that fallback silently resolves to undefined.
const ADMIN_CLUB_EVENT_RETURNING = `id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url,
        category_es, category_en`

const DEFAULT_PAST_LIMIT = 24

/**
 * "Upcoming" vs "past" is derived from date/end_date at read time rather than
 * stored — a recurring event (e.g. "every Friday") is always upcoming since
 * it has no defined end.
 */
function statusFor(row: Pick<EventRow, 'date_kind' | 'date' | 'end_date'>, today: string): ClubEventStatus {
  if (row.date_kind === 'recurring') return 'upcoming'
  const referenceDate = row.end_date ?? row.date
  return referenceDate < today ? 'past' : 'upcoming'
}

function toClubEvent(row: EventRow, today: string): ClubEvent {
  return {
    id: row.id,
    titleEs: row.title_es ?? row.title,
    titleEn: row.title_en ?? row.title,
    blurbEs: row.blurb_es ?? '',
    blurbEn: row.blurb_en ?? '',
    descriptionEs: row.description_es,
    descriptionEn: row.description_en,
    dateKind: (row.date_kind as ClubEventDateKind) ?? 'single',
    startDate: row.date,
    endDate: row.end_date,
    recurrenceLabelEs: row.recurrence_label_es,
    recurrenceLabelEn: row.recurrence_label_en,
    imageUrl: row.image_url,
    linkUrl: row.link_url,
    status: statusFor(row, today),
  }
}

/**
 * Defense-in-depth for the public club-events read. The "events_select_public"
 * RLS policy used to guarantee anon visibility was restricted to rows with
 * bilingual copy populated; the Neon migration dropped RLS, so the `.not()`
 * filters on the query above are now the only thing enforcing that. Re-check
 * the invariant at the application layer (same pattern as
 * assertMemberRowsScoped in lib/server/data-scoping.ts) so a regression in
 * the query can't leak a row with a null title_es/title_en into
 * toClubEvent's `row.title_es ?? row.title` fallback.
 */
function assertPublicClubEventRowsHaveBilingualTitles(rows: EventRow[]): EventRow[] {
  return rows.filter((row) => row.title_es !== null && row.title_en !== null)
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
 * for internal room-reservation blocking (lib/server/events-service.ts) —
 * a row is landing-eligible once it carries bilingual copy (title_es/title_en).
 *
 * Neon has no RLS — the "events_select_public" Supabase RLS policy that used
 * to additionally restrict anon visibility to bilingual rows is replaced by
 * the explicit `WHERE title_es IS NOT NULL AND title_en IS NOT NULL` below,
 * which is the sole authority now (same approach as other Neon-migrated
 * services).
 */
export async function listClubEvents(options: ListClubEventsOptions = {}): Promise<ListClubEventsResult> {
  const pastLimit = options.pastLimit ?? DEFAULT_PAST_LIMIT
  const today = getCurrentClubDate()

  let rows: EventRow[]
  try {
    rows = await sql`
      SELECT id, title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url
      FROM events
      WHERE title_es IS NOT NULL AND title_en IS NOT NULL
      ORDER BY date ASC
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  rows = assertPublicClubEventRowsHaveBilingualTitles(rows)
  const events = rows.map((row) => toClubEvent(row, today))

  const upcoming = events.filter((event) => event.status === 'upcoming')
  const past = events
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
  title_es: string | null
  title_en: string | null
  blurb_es: string | null
  blurb_en: string | null
  description_es: string | null
  description_en: string | null
  category_es: string | null
  category_en: string | null
  date_kind: ClubEventDateKind
  date: string
  end_date: string | null
  recurrence_label_es: string | null
  recurrence_label_en: string | null
  image_url: string | null
  link_url: string | null
  // Legacy single-locale anchor columns kept NOT NULL by the original
  // "events" schema — mirrored from the ES copy / all-day sentinel, same
  // convention used by the OIR-202 seed migration, since club events have no
  // meaningful room-block time-of-day unless blocksRooms is also set.
  title: string
  // `description`/`start_time`/`end_time` are `undefined` (not `null`) for
  // updates (see resolveClubEventFields) — the unified form never edits
  // them, so the update SQL below deliberately omits these three columns
  // from its SET clause entirely, preserving whatever value the row already
  // has (mirrors the old Supabase `.update(fields)` call, whose JSON
  // serialization silently dropped `undefined`-valued keys, achieving the
  // same "leave unchanged" effect). Only CREATE writes concrete values.
  description: string | null | undefined
  start_time: string | undefined
  end_time: string | undefined
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
    : requireNonEmptyString(current ? (current.title_es ?? current.title) : null, 'titleEs')
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
    current ? { es: current.title_es, en: current.title_en } : null,
  ) ?? titleEs

  const blurbEs = body.blurbEs !== undefined ? optionalString(body.blurbEs, 'blurbEs') : (current?.blurb_es ?? null)
  const blurbEn = resolveBilingualEnFallback(
    'blurbEn',
    blurbEs,
    body.blurbEn,
    body.blurbEn !== undefined,
    current ? { es: current.blurb_es, en: current.blurb_en } : null,
  )
  const descriptionEs = body.descriptionEs !== undefined ? optionalString(body.descriptionEs, 'descriptionEs') : (current?.description_es ?? null)
  const descriptionEn = resolveBilingualEnFallback(
    'descriptionEn',
    descriptionEs,
    body.descriptionEn,
    body.descriptionEn !== undefined,
    current ? { es: current.description_es, en: current.description_en } : null,
  )
  const categoryEs = body.categoryEs !== undefined ? optionalString(body.categoryEs, 'categoryEs') : (current?.category_es ?? null)
  const categoryEn = resolveBilingualEnFallback(
    'categoryEn',
    categoryEs,
    body.categoryEn,
    body.categoryEn !== undefined,
    current ? { es: current.category_es, en: current.category_en } : null,
  )
  const recurrenceLabelEs = body.recurrenceLabelEs !== undefined
    ? optionalString(body.recurrenceLabelEs, 'recurrenceLabelEs')
    : (current?.recurrence_label_es ?? null)
  const recurrenceLabelEn = resolveBilingualEnFallback(
    'recurrenceLabelEn',
    recurrenceLabelEs,
    body.recurrenceLabelEn,
    body.recurrenceLabelEn !== undefined,
    current ? { es: current.recurrence_label_es, en: current.recurrence_label_en } : null,
  )

  const dateKind = body.dateKind !== undefined
    ? normaliseDateKind(body.dateKind)
    : ((current?.date_kind as ClubEventDateKind | undefined) ?? 'single')

  const startDate = body.date !== undefined
    ? requireDateString(body.date, 'date')
    : requireDateString(current?.date, 'date')

  let endDate: string | null = null
  if (dateKind === 'range') {
    endDate = body.endDate !== undefined
      ? optionalDateString(body.endDate, 'endDate')
      : (current?.end_date ?? null)
    if (!endDate) serviceError('endDate is required when dateKind is range', 400)
    if (endDate < startDate) serviceError('endDate must be on or after date', 400)
  }

  const imageUrl = body.imageUrl !== undefined ? validateOptionalUrl(body.imageUrl, 'imageUrl') : (current?.image_url ?? null)
  const linkUrl = body.linkUrl !== undefined ? validateOptionalUrl(body.linkUrl, 'linkUrl') : (current?.link_url ?? null)

  // OIR-208: ON (default for new events) publishes the bilingual columns;
  // OFF nulls them (paired constraint holds) and keeps only the legacy
  // `title` column populated — an internal-only event. When omitted on an
  // update, preserve whatever the row currently is.
  const visibleOnLanding = body.visibleOnLanding !== undefined
    ? parseBooleanFlag(body.visibleOnLanding)
    : (current ? isClubEventRow(current) : true)

  // OIR-208 review fix: the unified form never edits description/start_time/
  // end_time, so an UPDATE must preserve whatever is already on the row (a
  // pre-existing legacy internal event may carry a real description and
  // anchor times, and silently nulling/resetting them on every save would
  // destroy that data) — only a CREATE gets the all-day/no-description
  // defaults, since there is no prior row to preserve. For updates these are
  // deliberately `undefined` (see ClubEventFieldSet doc above), not `null`.
  const description = current ? undefined : null
  const startTime = current ? undefined : '00:00:00'
  const endTime = current ? undefined : '23:59:00'

  return {
    title_es: visibleOnLanding ? titleEs : null,
    title_en: visibleOnLanding ? titleEn : null,
    // Deliberate (toggle OFF stale content): blurb/description/image are kept
    // as-is when visibleOnLanding flips to false rather than being cleared.
    // This preserves the marketing copy for a later re-publish and lets the
    // admin form show it back for review when the event is re-enabled.
    blurb_es: blurbEs,
    blurb_en: blurbEn,
    description_es: descriptionEs,
    description_en: descriptionEn,
    category_es: categoryEs,
    category_en: categoryEn,
    date_kind: dateKind,
    date: startDate,
    end_date: endDate,
    recurrence_label_es: recurrenceLabelEs,
    recurrence_label_en: recurrenceLabelEn,
    image_url: imageUrl,
    link_url: linkUrl,
    title: titleEs,
    description,
    start_time: startTime,
    end_time: endTime,
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
    roomId: b.room_id,
    tableId: b.table_id ?? null,
    date: b.date,
    startTime: b.start_time.slice(0, 5),
    endTime: b.end_time.slice(0, 5),
    allDay: b.all_day,
  }))

  return {
    id: row.id,
    titleEs: row.title_es ?? row.title,
    titleEn: row.title_en ?? row.title,
    blurbEs: row.blurb_es ?? '',
    blurbEn: row.blurb_en ?? '',
    descriptionEs: row.description_es,
    descriptionEn: row.description_en,
    dateKind: (row.date_kind as ClubEventDateKind) ?? 'single',
    startDate: row.date,
    endDate: row.end_date,
    recurrenceLabelEs: row.recurrence_label_es,
    recurrenceLabelEn: row.recurrence_label_en,
    imageUrl: row.image_url,
    linkUrl: row.link_url,
    categoryEs: row.category_es,
    categoryEn: row.category_en,
    status: statusFor(row, today),
    blocksRooms: roomBlocks.length > 0,
    roomBlocks,
    // OIR-208: unified events — a row is landing-visible once both bilingual
    // titles are populated (same predicate as isClubEventRow).
    visibleOnLanding: isClubEventRow(row),
    materials,
  }
}

/**
 * #334 — port of the legacy `cancel_saved_games_for_event_block()` trigger
 * function, with two deliberate departures from the original SQL (both
 * code-review findings, fixed after the initial port):
 *   - Fires per newly-written `event_room_blocks` row (`NEW`), matched here
 *     to a single inserted block (`tableIds`/`date` = that row's scope and
 *     date).
 *   - Cancels `saved_games` rows whose `table_id` is in `tableIds` — the
 *     caller now passes the SAME scoped table-id list it already computed
 *     for the reservation cancellation right above this call site
 *     (table-scoped when the block's own `table_id` is set, room-wide only
 *     when it's null). The legacy trigger always cancelled room-wide,
 *     ignoring the block's own `table_id`, because it predates OIR-208's
 *     per-table `event_room_blocks` scoping; that room-wide-always behavior
 *     was a bug relative to `assertTableAndEventAvailability` (which only
 *     rejects new games on the specifically blocked table), not a semantic
 *     worth preserving, so this port does not carry it forward.
 *   - Only rows with `status = 'active'` are eligible.
 *   - Overlap condition: `date BETWEEN saved.start_date AND saved.end_date`
 *     (inclusive on both ends), where `date` is the block's date — not a
 *     start/end-time overlap, since saved_games are whole-day date ranges.
 * The original function also took an advisory xact lock per table in the
 * room before the UPDATE, guarding concurrent saved-game inserts/renewals
 * inside the same DB transaction. This port now has an equivalent (see the
 * race-condition paragraph below) instead of omitting it.
 *
 * Captures each cancelled row's id AND its pre-cancellation `updated_at`
 * (via `UPDATE ... FROM (subquery) ... RETURNING`, same pattern as
 * `cancelOverlappingReservationsForRoomCapturing`) so a later failure in the
 * same call can restore it exactly — including the timestamp, not just the
 * status (code-review finding: the original restore flipped `status` back
 * but left `updated_at` at the cancellation-time value, so a rolled-back
 * event mutation still left the saved game's public `updatedAt` changed).
 * Every cancelled row's pre-cancellation status was always `'active'` (the
 * trigger's own WHERE clause), so — unlike `CancelledReservation` — no
 * status needs capturing, only the timestamp.
 *
 * Takes the room's already-resolved table ids (`tableIds`) rather than
 * re-joining `tables` by `room_id` itself (code-review finding, high-effort
 * pass) — the caller already batches every room's table ids into
 * `roomTableMap` up front specifically to avoid a redundant per-block
 * `tables` lookup (the #304/#354 code-review optimization); joining inline
 * here would reintroduce exactly that redundant lookup, once per block.
 *
 * Race with `createSavedGameForSession` (code-review finding): removing the
 * legacy trigger's advisory lock left a check-then-insert race — that
 * function's event-block precheck and its insert are two separate Neon HTTP
 * round trips, so this UPDATE could run between them and the new saved game
 * would stay `'active'` even though it should have been blocked. Both sides
 * now take the same per-table `pg_advisory_xact_lock` (keyed by
 * `hashtext(table_id)`) as the first statement of a `sql.transaction()`,
 * before touching `saved_games` — the lock statement blocks until any
 * concurrent holder commits and releases it, and (per Neon's
 * `sql.transaction()`, a real non-interactive Postgres transaction) each
 * statement after it gets its own fresh READ COMMITTED snapshot, so the
 * second statement here always runs after any concurrent
 * `createSavedGameForSession` insert has either committed or is blocked
 * behind this same lock. See `createSavedGameForSession` in
 * `saved-games-service.ts` for the other side.
 */
async function cancelActiveSavedGamesForRoomBlock(
  tableIds: string[],
  date: string,
): Promise<Array<{ id: string; updatedAt: string }>> {
  if (tableIds.length === 0) return []

  let cancelledRows: Array<{ id: string; updated_at: string | Date }>
  try {
    const results = await sql.transaction(
      [
        sql`
          SELECT pg_advisory_xact_lock(hashtext(t::text))
          FROM (
            -- Cast to uuid before hashtext (code-review finding): canonicalizes
            -- each id's text form so this always hashes to the same lock key
            -- createSavedGameForSession's own lock derives, regardless of
            -- spelling — matters there since that id is client-supplied, and
            -- kept consistent here too so both sides key off the identical
            -- canonicalization rule. Ordered ascending (ORDER BY 1) so two
            -- concurrent calls whose tableIds overlap always acquire the
            -- per-table locks in the same order — without this, call A locking
            -- [x, y] while call B locks [y, x] concurrently can deadlock.
            SELECT unnest(${tableIds}::uuid[]) AS t ORDER BY 1
          ) AS ordered_tables
        `,
        sql`
          UPDATE saved_games AS saved
          SET status = 'cancelled', updated_at = now()
          FROM (
            SELECT id, updated_at FROM saved_games
            WHERE table_id = ANY(${tableIds})
              AND status = 'active'
              AND ${date} BETWEEN start_date AND end_date
          ) AS prior
          WHERE saved.id = prior.id
          RETURNING saved.id, prior.updated_at
        `,
      ],
      { isolationLevel: 'ReadCommitted' },
    )
    cancelledRows = results[1] as Array<{ id: string; updated_at: string | Date }>
  } catch {
    serviceError('Internal server error', 500)
  }
  // @neondatabase/serverless returns `timestamptz` columns as `Date`
  // instances, not strings (code-review finding) — normalize here so
  // `restoreCancelledSavedGames`'s "restore it exactly" round-trips through
  // the same `timestamptz` cast it started from, matching the
  // `instanceof Date` normalization pattern already used in
  // equipment-service.ts's `toEquipment`.
  return cancelledRows.map((row) => ({
    id: row.id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  }))
}

/**
 * Compensating restore for `cancelActiveSavedGamesForRoomBlock` (#334,
 * mirrors `restoreCancelledReservations`). Every row cancelled by that
 * function was `'active'` beforehand, so restoration is a plain status flip
 * back — no per-row status needs to be tracked, unlike reservations (which
 * can be 'active' or 'pending'). Restores each row's own captured
 * pre-cancellation `updated_at` alongside its status (code-review finding —
 * see `cancelActiveSavedGamesForRoomBlock`'s doc comment), not just the
 * status, so a rolled-back event mutation leaves no trace on the saved
 * game's public `updatedAt`. Best-effort: errors are logged and swallowed,
 * matching every other compensating step in this file.
 */
async function restoreCancelledSavedGames(cancelled: Array<{ id: string; updatedAt: string }>): Promise<void> {
  if (cancelled.length === 0) return
  try {
    const ids = cancelled.map((row) => row.id)
    const updatedAts = cancelled.map((row) => row.updatedAt)
    await sql`
      UPDATE saved_games
      SET status = 'active', updated_at = restored.updated_at
      FROM (
        SELECT * FROM unnest(${ids}::uuid[], ${updatedAts}::timestamptz[]) AS restored(id, updated_at)
      ) AS restored
      WHERE saved_games.id = restored.id AND saved_games.status = 'cancelled'
    `
  } catch (rollbackError) {
    console.error('club-events-service: compensating saved-game restore failed (non-fatal):', rollbackError)
  }
}

/**
 * Compensating rollback for `applyClubEventBlocksAndMaterials` (#304, mirrors
 * `events-service.ts`'s `rollbackPartialMultiBlockWrite`/
 * `restoreDeletedBlocksOnUpdateFailure`). If a later step in that function's
 * block/material loops fails, this restores what the call has done so far:
 * deletes any `event_room_blocks` rows this call itself inserted, reactivates
 * any reservations AND saved games this call itself cancelled, and reinserts
 * the exact rows this call deleted from `event_room_blocks` / `event_equipment`
 * (captured via each DELETE's own `RETURNING`). Best-effort: errors here are
 * logged and swallowed, so the caller's original failure is always what
 * surfaces.
 */
async function rollbackClubEventBlocksWrite(params: {
  eventId: string
  insertedBlockIds: string[]
  cancelledReservations: CancelledReservation[]
  cancelledSavedGames: Array<{ id: string; updatedAt: string }>
  deletedBlocks: EventRoomBlockRow[]
  deletedMaterials: EventEquipmentRow[]
  insertedMaterialEquipmentIds: string[]
}): Promise<void> {
  const {
    eventId, insertedBlockIds, cancelledReservations, cancelledSavedGames, deletedBlocks, deletedMaterials,
    insertedMaterialEquipmentIds,
  } = params

  // #304 code-review (high): each compensating step below gets its own
  // try/catch instead of one shared try wrapping the whole function. These
  // steps are independent restorations (block cleanup, reservation restore,
  // block reinsert, material rollback) — if an early one throws, the later
  // ones must still run, or a single failure (e.g. the block-delete) silently
  // skips restoring cancelled reservations and deleted materials too. Every
  // step is still best-effort: errors are logged and swallowed so the
  // caller's original failure is always what surfaces.
  try {
    if (insertedBlockIds.length > 0) {
      await sql`DELETE FROM event_room_blocks WHERE id = ANY(${insertedBlockIds})`
    }
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — deleting inserted blocks:', rollbackError)
  }

  try {
    // Restore each cancelled reservation to its own captured pre-cancellation
    // status ('active' or 'pending') rather than assuming 'active' — reuses
    // events-service.ts's restoreCancelledReservations (#304 code-review,
    // medium effort) instead of a second copy of the same status-aware
    // split/UPDATE logic that function already implements.
    await restoreCancelledReservations(cancelledReservations)
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — restoring cancelled reservations:', rollbackError)
  }

  try {
    // #334: restore any saved_games this call cancelled via
    // cancelActiveSavedGamesForRoomBlock, same best-effort convention as the
    // reservation restore above.
    await restoreCancelledSavedGames(cancelledSavedGames)
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — restoring cancelled saved games:', rollbackError)
  }

  try {
    for (const block of deletedBlocks) {
      await sql`
        INSERT INTO event_room_blocks (id, event_id, room_id, table_id, date, start_time, end_time, all_day)
        VALUES (${block.id}, ${block.event_id}, ${block.room_id}, ${block.table_id}, ${block.date}, ${block.start_time}, ${block.end_time}, ${block.all_day})
      `
    }
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — reinserting deleted blocks:', rollbackError)
  }

  try {
    // #304 code-review round 4: undo everything THIS call's materials loop
    // inserted before restoring the pre-delete rows — otherwise a brand-new
    // equipment_id (one that had no prior row, so it's absent from
    // deletedMaterials) that this call successfully inserted before a later
    // material failed would survive the rollback and stay silently attached
    // to the event.
    if (insertedMaterialEquipmentIds.length > 0) {
      await sql`
        DELETE FROM event_equipment
        WHERE event_id = ${eventId}
          AND equipment_id = ANY(${insertedMaterialEquipmentIds})
      `
    }
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — deleting inserted materials:', rollbackError)
  }

  try {
    // #304 code-review (medium): idempotent against this same call's own
    // partial progress — the insert loop in applyClubEventBlocksAndMaterials
    // may have already re-inserted a row for this (event_id, equipment_id)
    // pair before failing on a later material, so a plain re-INSERT of the
    // captured pre-delete row would hit a PRIMARY KEY violation here.
    // ON CONFLICT DO UPDATE (mirroring the main insert loop above) restores
    // the pre-delete quantity regardless of whether a fresh row already
    // exists. The DELETE above already removed conflicting fresh rows, but
    // this stays as defense-in-depth.
    for (const material of deletedMaterials) {
      await sql`
        INSERT INTO event_equipment (event_id, equipment_id, quantity)
        VALUES (${material.event_id}, ${material.equipment_id}, ${material.quantity})
        ON CONFLICT (event_id, equipment_id) DO UPDATE SET quantity = EXCLUDED.quantity
      `
    }
  } catch (rollbackError) {
    console.error('club-events-service: compensating rollback failed (non-fatal) — reinserting deleted materials:', rollbackError)
  }
}

/**
 * Raw-SQL replacement for the `apply_club_event_room_blocks` RPC (#304).
 * `blocks`/`materials` of `null` leaves the corresponding rows untouched (no
 * DELETE/INSERT for that axis at all); an array (including `[]`) fully
 * replaces it. Returns the resulting `event_room_blocks` rows for the event,
 * ordered by date/start_time (same shape the RPC returned).
 *
 * Pre-implementation audit (#304): the DELETEs below use `RETURNING` to
 * capture pre-existing rows in the same round trip (no separate SELECT-then-
 * DELETE race); the block-insert loop tracks ids inserted/cancelled by THIS
 * call so `rollbackClubEventBlocksWrite` can undo exactly what this call did
 * — and only what this call did — on any later failure, restoring the rows
 * this call deleted along the way.
 */
async function applyClubEventBlocksAndMaterials(
  eventId: string,
  blocks: NormalisedEventSchedule[] | null,
  materials: NormalisedMaterial[] | null,
): Promise<EventRoomBlockRow[]> {
  let eventExists: Array<{ id: string }>
  try {
    eventExists = await sql`SELECT id FROM events WHERE id = ${eventId} LIMIT 1` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }
  if (eventExists.length === 0) serviceError('Club event not found', 404)

  let deletedBlocks: EventRoomBlockRow[] = []
  if (blocks !== null) {
    try {
      deletedBlocks = await sql`
        DELETE FROM event_room_blocks
        WHERE event_id = ${eventId}
        RETURNING id, event_id, room_id, table_id, date, start_time, end_time, all_day
      ` as EventRoomBlockRow[]
    } catch {
      serviceError('Internal server error', 500)
    }
  }

  let deletedMaterials: EventEquipmentRow[] = []
  if (materials !== null) {
    try {
      deletedMaterials = await sql`
        DELETE FROM event_equipment
        WHERE event_id = ${eventId}
        RETURNING event_id, equipment_id, quantity
      ` as EventEquipmentRow[]
    } catch {
      // The blocks DELETE above (if it ran) already committed — restore it
      // before surfacing this failure so the event doesn't silently lose its
      // room blocks alongside a 500 for an unrelated materials-delete error.
      await rollbackClubEventBlocksWrite({
        eventId, insertedBlockIds: [], cancelledReservations: [], cancelledSavedGames: [], deletedBlocks, deletedMaterials: [],
        insertedMaterialEquipmentIds: [],
      })
      serviceError('Internal server error', 500)
    }
  }

  const insertedBlockIds: string[] = []
  const cancelledReservations: CancelledReservation[] = []
  const cancelledSavedGames: Array<{ id: string; updatedAt: string }> = []
  const insertedMaterialEquipmentIds: string[] = []

  // Batch the room->table id lookups for every block that needs one (no
  // table_id, so the whole room's tables are cancelled), instead of one
  // round trip per block inside the loop below (#304 code-review, medium
  // effort) — mirrors events-service.ts's deleteEventCascade, which
  // pre-fetches all rooms' table ids into a Map before its own block loop.
  // The same query also covers every distinct room referenced by a block
  // that DOES have a table_id, so the per-block table_id/room_id mismatch
  // guard below can be answered from an in-memory Map instead of issuing a
  // redundant per-block SELECT (#354 code-review).
  const roomTableMap = new Map<string, string[]>()
  const tableRoomMap = new Map<string, string>()
  if (blocks !== null) {
    const distinctRoomIds = [...new Set(
      blocks
        .filter((b): b is NormalisedEventSchedule & { room_id: string } => b.room_id !== null)
        .map((b) => b.room_id),
    )]
    if (distinctRoomIds.length > 0) {
      let tables: Array<{ id: string; room_id: string }>
      try {
        tables = await sql`
          SELECT id, room_id FROM tables WHERE room_id = ANY(${distinctRoomIds})
        ` as Array<{ id: string; room_id: string }>
      } catch {
        // #304 code-review (high): this batched lookup runs after the DELETEs
        // above have already captured deletedBlocks/deletedMaterials — on
        // failure here those rows must be restored just like every other
        // failure branch in this function, or they stay deleted with nothing
        // to put them back.
        await rollbackClubEventBlocksWrite({
          eventId, insertedBlockIds: [], cancelledReservations: [], cancelledSavedGames: [], deletedBlocks, deletedMaterials,
          insertedMaterialEquipmentIds: [],
        })
        serviceError('Internal server error', 500)
      }
      for (const t of tables) {
        const list = roomTableMap.get(t.room_id) ?? []
        list.push(t.id)
        roomTableMap.set(t.room_id, list)
        tableRoomMap.set(t.id, t.room_id)
      }
    }
  }

  if (blocks !== null) {
    for (const block of blocks) {
      if (block.room_id === null) continue

      try {
        // Guard against a table_id/room_id mismatch (mirrors the RPC's own
        // in-function check): independent FKs alone would let a caller pair
        // a table_id from one room with a room_id from another. Answered
        // from the batched tableRoomMap built above instead of a redundant
        // per-block SELECT (#354 code-review).
        if (block.table_id !== null && tableRoomMap.get(block.table_id) !== block.room_id) {
          serviceError('Invalid event data', 400)
        }

        const blockRows = await sql`
          INSERT INTO event_room_blocks (event_id, room_id, table_id, date, start_time, end_time, all_day)
          VALUES (${eventId}, ${block.room_id}, ${block.table_id}, ${block.date}, ${block.start_time}, ${block.end_time}, ${block.all_day})
          RETURNING id, event_id, room_id, table_id, date, start_time, end_time, all_day
        ` as EventRoomBlockRow[]

        const blockRow = blockRows[0]
        if (blockRow) insertedBlockIds.push(blockRow.id)

        // Table-level scoping (OIR-208): a block with a table_id only
        // cancels reservations for that single table; a null table_id
        // cancels reservations across every table of the room (unchanged
        // behavior).
        const tableIds = block.table_id ? [block.table_id] : (roomTableMap.get(block.room_id) ?? [])

        if (tableIds.length > 0) {
          // Capture each cancelled reservation's id AND pre-cancellation
          // status (via `UPDATE ... FROM` `RETURNING`, same pattern as
          // events-service.ts's cancelOverlappingReservationsForRoomCapturing)
          // so rollback can restore it exactly, not assume 'active'.
          let cancelledRows: CancelledReservation[]
          try {
            cancelledRows = await sql`
              UPDATE reservations
              SET status = 'cancelled'
              FROM (
                SELECT id, status FROM reservations
                WHERE table_id = ANY(${tableIds})
                  AND date = ${block.date}
                  AND start_time < ${block.end_time}
                  AND end_time > ${block.start_time}
                  AND status IN ('active', 'pending')
              ) AS prior
              WHERE reservations.id = prior.id
              RETURNING reservations.id, prior.status
            ` as CancelledReservation[]
          } catch {
            serviceError('Internal server error', 500)
          }
          cancelledReservations.push(...cancelledRows)
        }

        // #334: port of the legacy cancel_saved_games_for_event_block()
        // trigger — cancels active saved_games conflicting with this block.
        // Code-review finding: this used to always pass the room's FULL
        // table list (`roomTableMap.get(block.room_id)`), even for a
        // table-scoped block (`block.table_id` set), cancelling saved games
        // on unrelated tables the block never actually blocked —
        // inconsistent with `assertTableAndEventAvailability`, which only
        // rejects new games on the specifically blocked table. Reuses the
        // same scoped `tableIds` already computed above for the reservation
        // cancellation (table-scoped when `block.table_id` is set, room-wide
        // only when it's null) instead of re-deriving room-wide scope here.
        const blockCancelledSavedGames = await cancelActiveSavedGamesForRoomBlock(tableIds, block.date)
        cancelledSavedGames.push(...blockCancelledSavedGames)
      } catch (error) {
        await rollbackClubEventBlocksWrite({
          eventId, insertedBlockIds, cancelledReservations, cancelledSavedGames, deletedBlocks, deletedMaterials,
          insertedMaterialEquipmentIds,
        })
        if (error instanceof ServiceError) throw error
        mapEventWriteError(error)
      }
    }
  }

  if (materials !== null) {
    for (const material of materials) {
      try {
        await sql`
          INSERT INTO event_equipment (event_id, equipment_id, quantity)
          VALUES (${eventId}, ${material.equipment_id}, ${material.quantity})
          ON CONFLICT (event_id, equipment_id) DO UPDATE SET quantity = EXCLUDED.quantity
        `
        insertedMaterialEquipmentIds.push(material.equipment_id)
      } catch (error) {
        await rollbackClubEventBlocksWrite({
          eventId, insertedBlockIds, cancelledReservations, cancelledSavedGames, deletedBlocks, deletedMaterials,
          insertedMaterialEquipmentIds,
        })
        mapEventWriteError(error)
      }
    }
  }

  let resultBlocks: EventRoomBlockRow[]
  try {
    resultBlocks = await sql`
      SELECT id, event_id, room_id, table_id, date, start_time, end_time, all_day
      FROM event_room_blocks
      WHERE event_id = ${eventId}
      ORDER BY date ASC, start_time ASC
    ` as EventRoomBlockRow[]
  } catch (error) {
    // #304 code-review (high): every write above has already committed
    // successfully by this point — this SELECT only re-reads what was just
    // written. A failure here is a read-only failure, not a write failure:
    // throwing a plain ServiceError would make the caller's catch treat it
    // exactly like a failed write and trigger revertClubEventFieldsOnFailure
    // / the compensating event delete, undoing metadata that was never
    // actually wrong and leaving old metadata paired with the new (correctly
    // committed) blocks/materials. ClubEventReadBackError lets the callers
    // skip that compensation while still surfacing a 500 to the client.
    console.error('club-events-service: post-write read-back failed after successful block/material write:', eventId, error)
    throw new ClubEventReadBackError('Internal server error', 500)
  }

  return resultBlocks
}

/**
 * Order-insensitive comparison of the currently-stored room blocks against
 * an incoming (already-validated) schedules payload — used by Finding 4 to
 * skip the block-replace step entirely when a save carries no actual block
 * changes (e.g. a metadata-only edit that always resends the current
 * schedules from the edit form).
 */
function blocksMatchSchedules(current: EventRoomBlockRow[], incoming: NormalisedEventSchedule[]): boolean {
  const incomingWithRoom = incoming.filter((s): s is NormalisedEventSchedule & { room_id: string } => !!s.room_id)
  if (current.length !== incomingWithRoom.length) return false

  const blockKey = (b: { room_id: string; table_id?: string | null; date: string; all_day: boolean; start_time: string; end_time: string }) =>
    `${b.room_id}|${b.table_id ?? ''}|${b.date}|${b.all_day}|${b.start_time.slice(0, 5)}|${b.end_time.slice(0, 5)}`

  const currentKeys = current.map((b) => blockKey(b)).sort()
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

type EventEquipmentJoinRow = {
  event_id: string
  equipment_id: string
  quantity: number
  name: string
}

async function fetchEventMaterials(eventId: string): Promise<AdminEventMaterial[]> {
  let rows: EventEquipmentJoinRow[]
  try {
    rows = await sql`
      SELECT ee.event_id, ee.equipment_id, ee.quantity, eq.name
      FROM event_equipment ee
      JOIN equipment eq ON eq.id = ee.equipment_id
      WHERE ee.event_id = ${eventId}
    ` as EventEquipmentJoinRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return rows.map((row) => ({
    equipmentId: row.equipment_id,
    name: row.name,
    quantity: row.quantity,
  }))
}

async function fetchEventMaterialsForMany(eventIds: string[]): Promise<Map<string, AdminEventMaterial[]>> {
  const byEvent = new Map<string, AdminEventMaterial[]>()
  if (eventIds.length === 0) return byEvent

  let rows: EventEquipmentJoinRow[]
  try {
    rows = await sql`
      SELECT ee.event_id, ee.equipment_id, ee.quantity, eq.name
      FROM event_equipment ee
      JOIN equipment eq ON eq.id = ee.equipment_id
      WHERE ee.event_id = ANY(${eventIds})
    ` as EventEquipmentJoinRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  for (const row of rows) {
    const list = byEvent.get(row.event_id) ?? []
    list.push({ equipmentId: row.equipment_id, name: row.name, quantity: row.quantity })
    byEvent.set(row.event_id, list)
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
 * Creating the event row before the block-replace step could otherwise leave
 * an orphaned club event behind if that step failed (bad room id, FK issue,
 * transient DB error) — rejecting unknown room ids up front removes the most
 * common failure cause before the insert ever happens. The try/catch
 * rollback in createClubEvent still guards against any other write failure
 * (e.g. transient errors) so the "no orphan event row" invariant holds
 * unconditionally, not just for bad-room-id cases.
 */
async function validateRoomsExist(schedules: NormalisedEventSchedule[]): Promise<void> {
  const roomIds = Array.from(new Set(schedules.map((s) => s.room_id).filter((id): id is string => !!id)))
  if (roomIds.length === 0) return

  let rows: Array<{ id: string }>
  try {
    rows = await sql`SELECT id FROM rooms WHERE id = ANY(${roomIds})` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const foundIds = new Set(rows.map((r) => r.id))
  const missing = roomIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid room id in schedules', 400)
}

/**
 * Validate that every table referenced by an incoming schedules payload
 * actually exists (PR #154 review — OIR-208 extends the room-only PR #149
 * fix to also cover the table-scoped blocks the unified event flow allows).
 * Runs BEFORE any write to the "events" table, same rationale as
 * validateRoomsExist: rejecting an unknown table id up front avoids
 * committing the event fields UPDATE before the later block-replace step
 * would otherwise surface the bad reference.
 */
async function validateTablesExist(schedules: NormalisedEventSchedule[]): Promise<void> {
  const tableIds = Array.from(new Set(schedules.map((s) => s.table_id).filter((id): id is string => !!id)))
  if (tableIds.length === 0) return

  let rows: Array<{ id: string }>
  try {
    rows = await sql`SELECT id FROM tables WHERE id = ANY(${tableIds})` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const foundIds = new Set(rows.map((r) => r.id))
  const missing = tableIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid table id in schedules', 400)
}

/**
 * Validate that every equipment id referenced by an incoming materials
 * payload actually exists (PR #154 review), for the same reason
 * validateRoomsExist/validateTablesExist run before any write — an unknown
 * equipment id must be rejected before the event fields UPDATE commits.
 */
async function validateEquipmentExists(materials: NormalisedMaterial[]): Promise<void> {
  const equipmentIds = Array.from(new Set(materials.map((m) => m.equipment_id)))
  if (equipmentIds.length === 0) return

  let rows: Array<{ id: string }>
  try {
    rows = await sql`SELECT id FROM equipment WHERE id = ANY(${equipmentIds})` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  const foundIds = new Set(rows.map((r) => r.id))
  const missing = equipmentIds.filter((id) => !foundIds.has(id))
  if (missing.length > 0) serviceError('Invalid equipment id in materials', 400)
}

async function fetchEventRoomBlocks(eventId: string): Promise<EventRoomBlockRow[]> {
  let rows: EventRoomBlockRow[]
  try {
    rows = await sql`
      SELECT id, event_id, room_id, table_id, date, start_time, end_time, all_day
      FROM event_room_blocks
      WHERE event_id = ${eventId}
    ` as EventRoomBlockRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  return rows
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

  let rows: EventRow[]
  try {
    // Finding (PR #354 review): `title` must be selected here — toAdminClubEvent
    // falls back to it via `row.title_es ?? row.title` for internal-only events
    // (title_es is null), so omitting it silently breaks that fallback.
    rows = await sql`
      SELECT id, title, title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        date_kind, date, end_date, recurrence_label_es, recurrence_label_en, image_url, link_url,
        category_es, category_en
      FROM events
      ORDER BY date ASC
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  if (rows.length === 0) return { upcoming: [], past: [] }

  const eventIds = rows.map((r) => r.id)

  let blocks: EventRoomBlockRow[]
  try {
    blocks = await sql`
      SELECT id, event_id, room_id, table_id, date, start_time, end_time, all_day
      FROM event_room_blocks
      WHERE event_id = ANY(${eventIds})
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

  const materialsByEvent = await fetchEventMaterialsForMany(eventIds)

  const events = rows.map((row) => toAdminClubEvent(
    row,
    blocksByEvent.get(row.id) ?? [],
    materialsByEvent.get(row.id) ?? [],
    today,
  ))
  const upcoming = events.filter((event) => event.status === 'upcoming')
  const past = events
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

  // PR #149 review: validate every referenced room exists BEFORE the event
  // insert, so the most common cause of a post-insert block-write failure
  // (an invalid room id) is rejected up front instead of leaving an orphan
  // "events" row.
  if (schedules) {
    await validateRoomsExist(schedules)
  }

  let insertedRows: EventRow[]
  try {
    insertedRows = await sql`
      INSERT INTO events (
        title_es, title_en, blurb_es, blurb_en, description_es, description_en,
        category_es, category_en, date_kind, date, end_date,
        recurrence_label_es, recurrence_label_en, image_url, link_url,
        title, description, start_time, end_time, created_by
      )
      VALUES (
        ${fields.title_es}, ${fields.title_en}, ${fields.blurb_es}, ${fields.blurb_en},
        ${fields.description_es}, ${fields.description_en}, ${fields.category_es}, ${fields.category_en},
        ${fields.date_kind}, ${fields.date}, ${fields.end_date},
        ${fields.recurrence_label_es}, ${fields.recurrence_label_en}, ${fields.image_url}, ${fields.link_url},
        ${fields.title}, ${fields.description}, ${fields.start_time}, ${fields.end_time}, ${session.id}
      )
      RETURNING ${sql.unsafe(ADMIN_CLUB_EVENT_RETURNING)}
    ` as EventRow[]
  } catch (error) {
    mapEventWriteError(error)
  }

  const row = insertedRows[0]
  if (!row) serviceError('Internal server error', 500)

  let blocks: EventRoomBlockRow[] = []
  if (schedules || materials.length > 0) {
    try {
      blocks = await applyClubEventBlocksAndMaterials(row.id, schedules, materials.length > 0 ? materials : null)
    } catch (err) {
      // #304 code-review (high): a ClubEventReadBackError means every
      // block/material write already committed successfully — only the
      // post-write SELECT failed. Deleting the event row here would destroy
      // a genuinely-successful write on top of a read failure, so skip the
      // compensating delete and just surface the error.
      if (err instanceof ClubEventReadBackError) throw err

      // Compensating delete (PR #149 review): the block/material-write step
      // failed after the event row was already inserted (validated room ids
      // notwithstanding — e.g. a transient DB error). Remove the now-orphaned
      // row so a failed create never leaves a partial club event behind, then
      // rethrow the original error (preserves its status code/message).
      try {
        await sql`DELETE FROM events WHERE id = ${row.id}`
      } catch (compensatingDeleteError) {
        // PR #149 review (round 2): if the compensating delete itself fails,
        // the client still sees the original error below, but a fully
        // public, un-blocked event row would otherwise silently persist with
        // no room blocks and no visibility for ops. Log it loudly so the
        // orphaned row can be found and cleaned up manually.
        console.error(
          '[club-events] compensating delete failed after applyClubEventBlocksAndMaterials error — orphaned event row requires manual cleanup:',
          row.id,
          compensatingDeleteError,
        )
      }
      throw err
    }
  }
  const eventMaterials = materials.length > 0 ? await fetchEventMaterials(row.id) : []

  return toAdminClubEvent(row, blocks, eventMaterials, getCurrentClubDate())
}

/**
 * Best-effort compensation for `updateClubEvent`'s own event-fields UPDATE
 * (mirrors `events-service.ts`'s `revertEventFieldsOnFailure`). Reverts the
 * row back to the field values it had before this call (captured from the
 * pre-write `originalFields` snapshot at the top of `updateClubEvent`).
 * Errors here are logged and swallowed, matching the pattern above.
 */
async function revertClubEventFieldsOnFailure(id: string, original: ClubEventFieldSet): Promise<void> {
  try {
    await sql`
      UPDATE events
      SET
        title_es = ${original.title_es},
        title_en = ${original.title_en},
        blurb_es = ${original.blurb_es},
        blurb_en = ${original.blurb_en},
        description_es = ${original.description_es},
        description_en = ${original.description_en},
        category_es = ${original.category_es},
        category_en = ${original.category_en},
        date_kind = ${original.date_kind},
        date = ${original.date},
        end_date = ${original.end_date},
        recurrence_label_es = ${original.recurrence_label_es},
        recurrence_label_en = ${original.recurrence_label_en},
        image_url = ${original.image_url},
        link_url = ${original.link_url},
        title = ${original.title}
      WHERE id = ${id}
    `
  } catch (rollbackError) {
    console.error(
      '[club-events] compensating revert failed after applyClubEventBlocksAndMaterials error — event row left partially updated, requires manual reconciliation:',
      id,
      rollbackError,
    )
  }
}

export async function updateClubEvent(session: SessionUser, id: string, body: ClubEventInput): Promise<AdminClubEvent> {
  requireAdminSession(session)

  let currentRows: EventRow[]
  try {
    currentRows = await sql`
      SELECT ${sql.unsafe(ADMIN_CLUB_EVENT_RETURNING)}
      FROM events
      WHERE id = ${id}
      LIMIT 1
    ` as EventRow[]
  } catch {
    serviceError('Internal server error', 500)
  }
  const current = currentRows[0] ?? null
  // OIR-208: the unified service operates on ANY event row (landing or
  // internal) — the isClubEventRow guard from OIR-203 is superseded here.
  // The legacy /api/events/[id] endpoints (lib/server/events-service.ts)
  // keep their own isClubEventRow guard so old clients can't touch these rows.
  if (!current) serviceError('Club event not found', 404)

  // Finding 2: validate EVERYTHING — fields, URL allowlist, and (when
  // applicable) the schedules/materials payloads — before any DB write
  // (UPDATE below).
  const fields = resolveClubEventFields(body, current)

  const blocksRoomsProvided = body.blocksRooms !== undefined
  const schedulesProvided = body.schedules !== undefined
  const wantsBlocks = blocksRoomsProvided ? parseBooleanFlag(body.blocksRooms) : undefined

  const validatedSchedules = wantsBlocks !== false && schedulesProvided
    ? validateSchedulesPayload(body.schedules)
    : null

  const materialsProvided = body.materials !== undefined
  const validatedMaterials = materialsProvided ? validateMaterialsPayload(body.materials) : null

  // PR #149 / PR #154 review: validate every referenced room, table, and
  // equipment id BEFORE the event fields UPDATE below, mirroring the
  // createClubEvent fix. Without this, a bad reference (room id, table id,
  // or equipment id) would only surface later from the block/material-
  // replace step — by which point the event metadata UPDATE has already been
  // committed, leaving the event in a partially-updated state even though
  // the request as a whole failed.
  // Finding (PR #354 review): rooms/tables/equipment are independent
  // validations against different tables with no data dependency between
  // them (each is a plain read-only SELECT with no shared state), so run
  // them concurrently instead of sequentially.
  await Promise.all([
    validatedSchedules ? validateRoomsExist(validatedSchedules) : Promise.resolve(),
    validatedSchedules ? validateTablesExist(validatedSchedules) : Promise.resolve(),
    validatedMaterials ? validateEquipmentExists(validatedMaterials) : Promise.resolve(),
  ])

  // Snapshot of the pre-update field values (reconstructed the same way
  // resolveClubEventFields derives fields from `current`), used to revert
  // the UPDATE below if the block/material-replace step still fails for some
  // other reason (e.g. a transient DB error) after references were validated.
  const originalFields = resolveClubEventFields({}, current)

  let updatedRows: EventRow[]
  try {
    updatedRows = await sql`
      UPDATE events
      SET
        title_es = ${fields.title_es},
        title_en = ${fields.title_en},
        blurb_es = ${fields.blurb_es},
        blurb_en = ${fields.blurb_en},
        description_es = ${fields.description_es},
        description_en = ${fields.description_en},
        category_es = ${fields.category_es},
        category_en = ${fields.category_en},
        date_kind = ${fields.date_kind},
        date = ${fields.date},
        end_date = ${fields.end_date},
        recurrence_label_es = ${fields.recurrence_label_es},
        recurrence_label_en = ${fields.recurrence_label_en},
        image_url = ${fields.image_url},
        link_url = ${fields.link_url},
        title = ${fields.title}
      WHERE id = ${id}
      RETURNING ${sql.unsafe(ADMIN_CLUB_EVENT_RETURNING)}
    ` as EventRow[]
  } catch (error) {
    mapEventWriteError(error)
  }

  const row = updatedRows[0]
  if (!row) serviceError('Club event not found', 404)

  // `blocksParam` of null means "leave existing blocks untouched" — passed
  // straight through to applyClubEventBlocksAndMaterials, which skips
  // touching event_room_blocks entirely for that value.
  let blocksParam: NormalisedEventSchedule[] | null = null
  let cachedCurrentBlocks: EventRoomBlockRow[] | null = null

  if (wantsBlocks === false) {
    // Explicit opt-out: clear any existing room blocks for this event.
    blocksParam = []
  } else if (validatedSchedules) {
    // Finding 4: skip the (now atomic-by-compensation, but still non-free)
    // block-replace step entirely when the incoming schedules are identical
    // to what's already stored — metadata-only edits (title/blurb/etc)
    // always resend the current schedules from the edit form, so this
    // avoids needless churn.
    cachedCurrentBlocks = await fetchEventRoomBlocks(id)
    blocksParam = blocksMatchSchedules(cachedCurrentBlocks, validatedSchedules) ? null : validatedSchedules
  }
  // else: neither blocksRooms nor schedules provided — blocksParam stays
  // null (leave existing blocks untouched).

  const materialsParam = validatedMaterials

  let blocks: EventRoomBlockRow[]
  if (blocksParam !== null || materialsParam !== null) {
    try {
      blocks = await applyClubEventBlocksAndMaterials(id, blocksParam, materialsParam)
    } catch (err) {
      // #304 code-review (high): a ClubEventReadBackError means the
      // block/material write itself already committed successfully — only
      // the post-write SELECT failed. Reverting the event fields here would
      // leave old metadata paired with the new (correctly committed)
      // blocks/materials, an inconsistent state worse than just surfacing
      // the read failure, so skip the revert in that case.
      if (err instanceof ClubEventReadBackError) throw err

      // Compensating revert (PR #149 / PR #154 review): the block/material
      // replacement step failed after the event fields UPDATE above had
      // already committed. Room/table/equipment ids were pre-validated
      // above, so this covers any other write failure (e.g. a transient DB
      // error). Restore the event's pre-update field values so a failed
      // update never leaves the event partially changed, then rethrow the
      // original error (preserves its status code/message).
      await revertClubEventFieldsOnFailure(id, originalFields)
      throw err
    }
  } else {
    blocks = cachedCurrentBlocks ?? await fetchEventRoomBlocks(id)
  }

  const eventMaterials = await fetchEventMaterials(id)

  return toAdminClubEvent(row, blocks, eventMaterials, getCurrentClubDate())
}

export async function deleteClubEvent(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)

  let rows: Array<Pick<EventRow, 'id' | 'title_es' | 'title_en'>>
  try {
    rows = await sql`
      SELECT id, title_es, title_en FROM events WHERE id = ${id} LIMIT 1
    ` as Array<Pick<EventRow, 'id' | 'title_es' | 'title_en'>>
  } catch {
    serviceError('Internal server error', 500)
  }
  const row = rows[0]
  // OIR-208: the unified service operates on ANY event row (landing or
  // internal) — the isClubEventRow guard from OIR-203 is superseded here.
  if (!row) serviceError('Club event not found', 404)

  // Reuse the internal delete flow: cancels overlapping reservations for any
  // attached room blocks, then removes the row (and its blocks/materials, via
  // FK cascade) — same behavior as deleting a room-booking event today.
  // Calls deleteEventCascade directly (not the guarded deleteEvent) since
  // this surface intentionally operates on any row — the inverse of
  // deleteEvent's own isClubEventRow guard.
  await deleteEventCascade(id)
}
