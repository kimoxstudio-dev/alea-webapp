# F3e: DB-side triggers/functions audit and reimplementation (GitHub #246)

**Status:** Audit complete. 4 confirmed gaps implemented in application code, on
`feat/issue-246-db-triggers-audit`, branched from `origin/develop` @ `fb76c0d`
(includes PR #288 / GitHub #237, #438). No Drizzle migration SQL was needed —
all 4 gaps were pure application-layer logic (the underlying columns already
exist in the Drizzle schema).

This is a companion document to the now-deleted
`docs/MIGRATION-F1-DRIZZLE-COVERAGE.md` (recovered read-only via
`git show 17f2716^:docs/MIGRATION-F1-DRIZZLE-COVERAGE.md` for this audit — see
§3 below), which first cataloged the ~20 SECURITY DEFINER/plpgsql functions
and 9 triggers dropped by the Supabase→Drizzle/Neon schema translation and
flagged them for follow-up.

## 1. Already covered — no action needed

Confirmed by reading the current code (file:line references against
`fb76c0d`, unchanged by this PR):

- **`event_blocks_cancel_saved_games`** → `cancelSavedGamesForBlockedRoom()`,
  `lib/server/events/events-service.ts:393-454`, AND
  `club-events-service.ts:594-655`'s `applyClubEventRoomBlocksAndMaterials()`
  (calling `cancelSavedGamesForBlockedRoom(tx, …)` at line 631 and
  `cancelOverlappingReservationsForClubEventBlocks(tx, …)` at line 636),
  which runs inside `db.transaction()` from both `createClubEvent` (line
  884, calling it at line 927) and `updateClubEvent` (line 951, calling it
  at line 1030) — landed as PR #288 (GitHub #237/#438).
- **`mark_no_show_reservations`** → `markNoShowReservations()`,
  `reservations-service.ts:1050-1075`, wired via
  `app/api/cron/mark-no-show/route.ts`.
- **`create_event_atomic` / `update_event_atomic`** →
  `events-service.ts:465-563`, plus `assertBlocksTableRoomConsistency()`
  (568-591).
- **`create_event_with_blocks` / `update_event_with_blocks`** (multi-room/day
  RPCs, `20260617000001`) → confirmed via grep, same file:
  `createEventWithBlocksAtomic()` (line 602) / `updateEventWithBlocksAtomic()`
  (line 681), called from `createEvent`/`updateEvent` (lines 918, 990).
- **`apply_club_event_room_blocks`** → resolved via PR #288 (same as
  `event_blocks_cancel_saved_games` above).
- **`cancel_expired_pending_reservations`** → N/A, dropped in the Supabase
  era itself (KIM-366), replaced by lazy evaluation;
  `app/api/cron/cancel-pending/route.ts` returns `410 Gone`.
- **`get_database_time()`** → confirmed via grep:
  `lib/server/shared/database-time.ts`'s `getDatabaseNow()` now understands
  both the Drizzle/Neon seam (`select now()`, line 50) and the legacy
  Supabase RPC seam (`admin.rpc('get_database_time')`, line 62, kept only
  for the 11 not-yet-migrated services per that file's own doc comment).

## 2. Escalated — not implemented in this PR, needs product decision

- **`on_auth_user_created` / `handle_new_user()`**: no code links a
  newly-created Clerk user to a `profiles` row. `getSessionUser()`
  (`lib/server/auth/auth.ts:28-50`) reads a profile by `clerkUserId`, but
  nothing writes that field; no `app/api/webhooks/` route exists; `svix` is
  not a dependency. This is a real gap, but closing it means adding a new
  external dependency (`svix`) and a new webhook authentication surface — an
  architectural/security decision, not a mechanical trigger port. Per the
  Team Lead's scoping for this issue, this is escalated to the product owner
  for a decision on whether Clerk self-signup is live and whether
  webhook-based profile linking should be built now, rather than implemented
  here. No `svix` dependency was added, no webhook route was created, and
  `lib/server/auth/` was not touched by this PR (only `auth-service.ts`, a
  sibling file — see §4).
- **RLS helper functions `internal.is_admin()` / `internal.is_active_member()`**:
  these are authorization predicates, not business-logic triggers — out of
  #246's scope (they're KIM-418's/the Auth.js-migration's job, not this
  issue's). Confirmed already superseded by service-layer session checks
  (`session.role !== 'admin'` / `SessionUser.role`, e.g.
  `lib/server/auth/auth.ts:74`, and equivalent per-service
  `requireAdminSession()` helpers) — not a #246 gap, no action taken.

## 3. §5 cross-reference addendum (recovered historical doc)

The recovered `docs/MIGRATION-F1-DRIZZLE-COVERAGE.md` §5 named the following
distinct SECURITY DEFINER functions / triggers as "no Drizzle equivalent,
needs follow-up":

| §5 item | Disposition | Where |
|---|---|---|
| `on_auth_user_created` / `handle_new_user()` | Escalated | §2 above |
| `internal.is_admin()` | Out of #246 scope (RLS helper) | §2 above |
| `internal.is_active_member()` | Out of #246 scope (RLS helper) | §2 above |
| `create_event_atomic` / `update_event_atomic` | Covered | §1 above |
| `create_event_with_blocks` / `update_event_with_blocks` | Covered | §1 above |
| `apply_club_event_room_blocks` | Covered | §1 above |
| `mark_no_show_reservations` | Covered | §1 above |
| `cancel_expired_pending_reservations` | N/A (dropped pre-migration) | §1 above |
| `get_database_time()` | Covered | §1 above |
| `handle_updated_at()` (→ `profiles_updated_at`, `activation_tokens_updated_at`) | **Implemented in this PR** | §4 item 4 |
| `validate_saved_game` (→ `saved_games_validate`) | **Implemented in this PR** | §4 item 1 |
| `increment_saved_game_attendance` (→ `saved_game_attendance_count`) | **Implemented in this PR** | §4 item 2 |
| `cancel_saved_games_for_event_block` (→ `event_blocks_cancel_saved_games`) | Covered | §1 above |
| `validate_reservation_against_saved_game` (→ `reservations_validate_saved_game`) | **Implemented in this PR** | §4 item 5 |
| `record_saved_game_attendance_on_activation` (→ `record_saved_game_attendance_after_activation`) | **Implemented in this PR** | §4 item 3 |

All 15 distinct named items from §5 are accounted for above: 8 covered
pre-existing, 2 escalated (out of scope), 5 implemented in this PR. None
require a "needs follow-up audit" placeholder — every item resolved to a
concrete disposition within the bounded effort for this cross-reference.

## 4. Implemented in this PR

No new Drizzle migration SQL was needed for any of the 5 items below —
`attendance_count` and the `updated_at` timestamp columns already exist in
the schema; this is pure application-layer code.

### Item 1 — `saved_games_validate`: missing advisory lock

**Gap:** `assertTableAndEventAvailability()` in
`lib/server/games/saved-games-service.ts` did the table-type/event-conflict
check with plain reads, read `event_room_blocks` from the obsolete Supabase
seam, omitted the trigger's reverse check for existing bottom reservations,
and used no transaction or `pg_advisory_xact_lock`. The matching lock was
already implemented on the
"blocking a room" side (`cancelSavedGamesForBlockedRoom()` in
`lib/server/events/events-service.ts`, `hashtextextended(table_id, 0)`), but
nothing on the "creating a saved game" side took the same lock — so a
concurrent "block this room's event" transaction and a "create a saved game"
transaction could each act on a pre-commit view of the other's write.

**Fix:** `createSavedGameForSession()` and `renewSavedGameForSession()`
(`lib/server/games/saved-games-service.ts:236` and `:286`) now wrap the
conflict-check-then-insert in `db.transaction()`, taking
`pg_advisory_xact_lock(hashtextextended(table_id::text, 0))` first (lines
252-264 and 318-322) — the exact same lock key and pattern as
`cancelSavedGamesForBlockedRoom()`. `assertTableAndEventAvailability()`
(line ~181) was changed to take the transaction handle (`tx: AdminTx`) as its
first parameter instead of opening its own `getDrizzleAdminDb()` connection,
so its reads are guaranteed to run after the lock is held. The helper now
checks `event_room_blocks` and pending/active bottom `reservations` through
that same Neon transaction, restoring both directions of the dropped
`validate_saved_game` contract without a Supabase/Neon split-brain read. Both
callers rethrow
business-validation errors from `assertTableAndEventAvailability()`
(400/404/409) instead of collapsing them into a generic 500 — via a local
`isServiceError()` duck-type check (`error is { statusCode: number }`)
rather than `instanceof ServiceError` (the `instanceof` pattern used
elsewhere in this codebase, e.g. `events-service.ts:660`,
`club-events-service.ts:938`, requires importing the `ServiceError` class,
and this file's own existing test mock
(`tests/unit/server/saved-games-service.test.ts`) factory-mocks
`@/lib/server/shared/service-error` without exporting `ServiceError` —
duck-typing on `statusCode` gets the identical rethrow behavior without
requiring a test-file change).

### Item 2 — `saved_game_attendance_count`: never incremented

**Gap:** `lib/db/schema/saved-games.ts` has `attendanceCount` (line 34) with
a nonnegative CHECK (line 48), but no code anywhere did
`.update(savedGames).set({ attendanceCount: … })`.

**Fix:** implemented together with item 3 (same transaction) — see below.

### Item 3 — `record_saved_game_attendance_after_activation`: dead code, never wired

**Gap:** `recordSavedGameAttendance(playReservation)` existed
(`lib/server/games/saved-games-service.ts`, now at line 374) and inserted
into `saved_game_attendances`, but had zero production call sites.
`activateReservationByTable()` (`lib/server/reservations/reservations-service.ts:1068`)
— the real check-in flow, reached via `app/api/tables/[id]/activate/route.ts`
— never called it.

**Fix:**
- `activateReservationByTable()` now calls
  `recordSavedGameAttendance(toAttendanceReservation(updated))` (line 1166)
  after the activation `UPDATE ... RETURNING` succeeds. `toAttendanceReservation()`
  (new helper, same file, next to the existing `toPendingSlot()` bridge)
  converts the Drizzle camelCase `reservations.$inferSelect` row into the
  snake_case shape `recordSavedGameAttendance()` expects.
- `recordSavedGameAttendance()`'s parameter type was narrowed from the full
  legacy `Tables<'reservations'>` row to a `Pick` of just the 6 fields it
  actually reads (`id`, `table_id`, `user_id`, `date`, `surface`, `status`) —
  named `PlayReservationForAttendance` — so callers with a partial Drizzle
  row don't need to fabricate the rest of the legacy Supabase row shape.
- Items 2 and 3 are combined atomically: inside `recordSavedGameAttendance()`,
  the caller's transaction selects the matching active `saved_games` row,
  inserts the `saved_game_attendances` row, then performs an atomic SQL
  `attendance_count = attendance_count + 1` update and refreshes `updated_at`
  — all in one transaction, so concurrent check-ins cannot lose increments and
  the attendance insert and the counter increment can never diverge. The
  existing 23505 (duplicate `play_reservation_id`) idempotency check is
  preserved: a duplicate call rolls back the whole transaction (attendance
  insert AND counter increment both skipped), matching the prior
  insert-only idempotent-no-op behavior.

### Item 4 — `profiles_updated_at` / `activation_tokens_updated_at`: timestamps never updated

**Gap:** `lib/db/schema/profiles.ts:33` and
`lib/db/schema/activation-tokens.ts:30` (`updatedAt` columns) use
`.defaultNow()` only (no Drizzle schema-builder "on update" equivalent
exists — documented in both files' doc comments, see Linear KIM-417). Every
`.update(profiles)` /
`.update(activationTokens)` call site outside of `upsertActivationToken()`
omitted `updatedAt`.

**Fix — every `.update(profiles)` / `.update(activationTokens)` call site**
(found via `grep -rn '\.update(profiles)\|\.update(activationTokens)'` across
`lib/server/` and `app/`, 8 total sites, all now include `updatedAt: new
Date()`, matching the existing convention already used at
`events-service.ts:446`):

- `lib/server/auth/auth-service.ts:61` — `persistDrizzlePasswordHash()`.
- `lib/server/auth/auth-service.ts:219` — `rollbackActivationTokenClaim()`.
- `lib/server/auth/auth-service.ts:238` — `claimActivationToken()`.
- `lib/server/auth/auth-service.ts:251-275` (`upsertActivationToken()`,
  INSERT … ON CONFLICT DO UPDATE, `updatedAt: values.updatedAt` at line 270)
  — **already had this before this PR**; no change needed, listed here for
  completeness of the full-file audit pass.
- `lib/server/users/users-service.ts:148` — member-import existing-row update.
- `lib/server/users/users-service.ts:396` (`updates.updatedAt = new Date()`,
  applied before the `.update(profiles).set(updates)` at line 398) —
  `updateUser()` main update.
- `lib/server/users/users-service.ts:421` — `updateUser()`'s best-effort
  member-number/auth-email rollback on auth-credential-alignment failure.
- `lib/server/users/users-service.ts:442` — `resetNoShows()`.
- `lib/server/users/users-service.ts:455` — `unblockUser()`.

### Item 5 — `reservations_validate_saved_game`: matching advisory lock missing

**Gap:** the application already checked active saved games before creating or
updating a bottom reservation, but the check and write were separate. The
dropped trigger took the same per-table advisory lock as `validate_saved_game`,
so concurrent saved-game and bottom-reservation writes could not both validate
against stale snapshots and commit incompatible rows.

**Fix:** `createReservationForSession()` and
`updateReservationForSession()` now run the bottom-surface saved-game check and
reservation write in one transaction. For pending/active bottom reservations,
`assertNoSavedGameBottomConflict()` first executes
`pg_advisory_xact_lock(hashtextextended(table_id::text, 0))`, then queries
`saved_games` through that transaction before the insert/update. Cancelled,
completed, and no-show rows skip the lock and conflict check, matching the old
trigger predicate.

## 5. `assertMemberRowsScoped` invariant — confirmed intact

None of items 1-5 weaken the member-scoped read paths
(`listSavedGamesForSession`, `listVisibleReservations`) that
`assertMemberRowsScoped()` (`lib/server/shared/data-scoping.ts` — confirmed
the actual path; the original audit report's citation of
`lib/server/shared/data-scoping.ts` was already correct) guards. Item 3's
attendance write goes through `getDrizzleAdminDb()` from a system/check-in
context (`activateReservationByTable()`), correctly outside that invariant's
scope — it never reads or returns saved-games/reservations rows to a member
session, it only writes.

## 6. Test-mock compatibility note (why item 1 duck-types instead of `instanceof`)

`tests/unit/server/saved-games-service.test.ts` factory-mocks
`@/lib/server/shared/service-error` with only `serviceError:
createMockServiceError()` — no `ServiceError` class export. The first
implementation of item 1 used `if (err instanceof ServiceError) throw err`,
the same pattern already used elsewhere in this codebase
(`club-events-service.ts:938,1035`, `events-service.ts:660,741`,
`equipment-service.ts:236`), whose test files already mock `ServiceError:
MockServiceError` for exactly this reason (see
`tests/unit/server/club-events-service.test.ts:56` and
`tests/unit/server/events-service-multiday.test.ts:54`). That first version
made 2 of `saved-games-service.test.ts`'s 8 tests fail locally and (via the
repo's pre-push hook, which runs the full suite) blocked pushing this
branch at all — `instanceof` against an import that a `vi.mock()` factory
doesn't re-export throws "No 'ServiceError' export is defined on the mock"
before the assertion is even reached.

The final implementation uses a local duck-typed
`isServiceError()` check (`error is { statusCode: number }`,
`lib/server/games/saved-games-service.ts`) instead of `instanceof
ServiceError`, achieving the identical rethrow behavior (preserving the
original 400/404/409 from `assertTableAndEventAvailability()`) without
importing the `ServiceError` class at all. Reservations use the same narrow
duck type so both service mocks and production errors preserve their original
status codes across transaction boundaries.
