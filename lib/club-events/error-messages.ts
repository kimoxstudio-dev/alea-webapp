import { ERROR_CODES, type ClubEventErrorCode } from '@/lib/types/error-codes'

/**
 * Maps an `events-service.ts`/`club-events-service.ts` `ERROR_CODES.CLUB_EVENT_*`
 * code (the raw `error.message` a failed `apiClient` call throws — see
 * `lib/api/client.ts`) to its translation key under the `admin.clubEvents.errors`
 * namespace in `messages/en.json` / `messages/es.json`.
 *
 * Same pattern as `lib/auth/service-error-messages.ts` (#313): shared by every
 * client surface that calls a club-event-service-backed endpoint (the admin
 * "Eventos" create/edit form), so a server validation code is never rendered
 * to the user as raw, untranslated English text. Returns `null` for a code
 * with no mapping (e.g. "Internal server error" or "Forbidden", which are
 * out of scope — see the doc comment on `ERROR_CODES.CLUB_EVENT_*`); callers
 * fall back to their own generic, already-translated message in that case.
 *
 * Typed `Record<ClubEventErrorCode, string>` (not `Partial<Record<string, string>>`)
 * so a new `ERROR_CODES.CLUB_EVENT_*` value with no entry here is a compile
 * error.
 */
const CLUB_EVENT_ERROR_MESSAGE_KEYS: Record<ClubEventErrorCode, string> = {
  [ERROR_CODES.CLUB_EVENT_INVALID_DATE_FORMAT]: 'clubEvents.errors.invalidDateFormat',
  [ERROR_CODES.CLUB_EVENT_INVALID_TIME_FORMAT]: 'clubEvents.errors.invalidTimeFormat',
  [ERROR_CODES.CLUB_EVENT_END_BEFORE_START]: 'clubEvents.errors.endBeforeStart',
  [ERROR_CODES.CLUB_EVENT_INVALID_DATE_KIND]: 'clubEvents.errors.invalidDateKind',
  [ERROR_CODES.CLUB_EVENT_END_DATE_REQUIRED]: 'clubEvents.errors.endDateRequired',
  [ERROR_CODES.CLUB_EVENT_END_DATE_BEFORE_START]: 'clubEvents.errors.endDateBeforeStart',
  [ERROR_CODES.CLUB_EVENT_SCHEDULE_REQUIRED]: 'clubEvents.errors.scheduleRequired',
  [ERROR_CODES.CLUB_EVENT_TOO_MANY_SCHEDULES]: 'clubEvents.errors.tooManySchedules',
  [ERROR_CODES.CLUB_EVENT_INVALID_ROOM]: 'clubEvents.errors.invalidRoom',
  [ERROR_CODES.CLUB_EVENT_INVALID_TABLE]: 'clubEvents.errors.invalidTable',
  [ERROR_CODES.CLUB_EVENT_MATERIALS_NOT_ARRAY]: 'clubEvents.errors.materialsNotArray',
  [ERROR_CODES.CLUB_EVENT_TOO_MANY_MATERIALS]: 'clubEvents.errors.tooManyMaterials',
  [ERROR_CODES.CLUB_EVENT_INVALID_EQUIPMENT]: 'clubEvents.errors.invalidEquipment',
}

export function getClubEventErrorMessageKey(code: string | undefined | null): string | null {
  if (!code) return null
  return CLUB_EVENT_ERROR_MESSAGE_KEYS[code as ClubEventErrorCode] ?? null
}
