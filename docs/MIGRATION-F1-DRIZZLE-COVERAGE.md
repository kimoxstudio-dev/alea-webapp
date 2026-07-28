# F1: Drizzle schema coverage report (KIM-417)

**Status:** Schema authored, not applied to any database. Part of the Supabase → Neon
migration (see Linear KIM-393..422, Supabase→Neon migration, phase F1). This is a companion
document to `lib/db/schema/*.ts` and `lib/db/migrations/*.sql`.

**Scope of this issue:** translate the 85 Supabase SQL migrations in `supabase/migrations/`
into a Drizzle ORM schema targeting Vercel Postgres (Neon). RLS policies are cataloged
here but **not** translated into schema code — service-layer authorization is KIM-418's
job. This document is the audit trail a reviewer needs before that work starts, and
before this schema is ever applied to a real database (F2 cutover, user-only).

## 1. Summary

- **85 / 85** migration files read and accounted for (none skipped without review).
- **15 / 15** tables (100%) translated into `lib/db/schema/*.ts` with full column,
  type, default, `NOT NULL`, primary key, foreign key (including `ON DELETE`/`ON UPDATE`
  behavior), unique constraint, check constraint, and index fidelity — **except** for
  2 documented adaptations (Supabase `auth.users` FK removal/redirect, see §5) and
  3 `EXCLUDE` constraints that Drizzle's pg-core schema builder cannot express and are
  instead delivered as a hand-written "custom" `drizzle-kit` SQL migration (see §4).
- **4 / 4** enum types translated (`reservation_status`, `role`, `table_surface`,
  `table_type`).
- **0** RLS policies translated into schema code (by design — see §2). All are
  cataloged below for KIM-418.
- **~20** SECURITY DEFINER / plpgsql functions and **9** triggers found — none have a
  Drizzle equivalent. These are more than "RLS helpers": several
  (`create_event_atomic`, `apply_club_event_room_blocks`, the saved-games trigger
  chain, etc.) are atomic multi-step **business logic**, not just authorization. See §5.
- **2** pure data-seed migrations (landing events, partly folded into the partners/
  library_games table migrations too) — data, not schema; not applicable to a schema
  translation. See §6.

Migration-by-migration classification (a file can span more than one category):

| Category | Count | Notes |
|---|---|---|
| Table/column/constraint/index DDL (translated into `lib/db/schema/`) | 17 | baseline + equipment/room_default_equipment/reservation_equipment tables + saved_games/saved_game_attendances + events extension columns + partners/library_games tables + event_equipment/table_id columns + index-only migrations |
| RLS policy DDL (`CREATE POLICY`/`ALTER POLICY`/`DROP POLICY`, `ENABLE/DISABLE ROW LEVEL SECURITY`) | ~30 | cataloged in §2, not translated |
| `GRANT`/`REVOKE` (table or function privileges) | ~25 | not applicable to a Drizzle schema; noted where relevant to RLS in §2 |
| `CREATE FUNCTION`/`CREATE TRIGGER` (plpgsql/SQL functions, trigger attachment) | ~15 | cataloged in §5, not translated |
| Extension/schema management (`CREATE EXTENSION`, `CREATE SCHEMA`) | part of baseline + 1 dedicated (`move_btree_gist_to_postgres_schema`) | cataloged in §5 |
| Pure data (`INSERT`/`UPDATE` seed or backfill, no DDL) | 2 dedicated + 2 embedded in table-creation migrations | cataloged in §6 |
| Documentation-only (no SQL) | 1 (`20260527120004_document_leaked_password_protection.sql`) | Supabase Auth dashboard setting, not portable |

(Counts overlap across categories since most files mix DDL, grants and comments —
these are classification buckets for narrative purposes, not a strict partition summing
to 85.)

## 2. Table-by-table status

All 15 tables below are **fully covered** at the schema level (columns/types/defaults/
constraints/FKs/indexes). "RLS (final state)" lists the policies active after all 85
migrations are applied in order — **none of these are translated into schema code**;
they are the exact input KIM-418 needs to write the equivalent service-layer checks.
Historical policies that were later dropped are listed as "(historical, superseded)"
for completeness/audit only.

### `profiles`
- Columns: `id` (uuid, PK — see §5 for the dropped `auth.users` FK), `member_number`
  (varchar(20), unique), `email`, `role` (enum, default `member`), `created_at`,
  `updated_at`, `is_active` (default false), `no_show_count` (default 0),
  `blocked_until`, `auth_email` (unique index `profiles_auth_email_key`), `full_name`,
  `active_from`, `psw_changed`, `phone`, `password_hash` (nullable, transitional
  Auth.js credential storage), `clerk_user_id` (nullable external identity key
  for Clerk, unique when present). Existing `profiles.id` UUID values remain the
  domain identity and continue to own all application foreign keys.
- RLS (final state): `profiles_admin_delete` (DELETE, `internal.is_admin()`),
  `profiles_admin_insert` (INSERT, `internal.is_admin()`), `profiles_admin_update`
  (UPDATE, `internal.is_admin()`), `profiles_member_select` (SELECT,
  `internal.is_admin() OR (id = auth.uid() AND internal.is_active_member())` —
  absorbed the separate `profiles_admin_select` policy in
  `20260528000002_kim391_consolidate_profiles_select_policy.sql`).
- Historical (superseded): `profiles_admin_select` (dropped, merged into `_member_select`).
- Trigger: `profiles_updated_at` (BEFORE UPDATE → `handle_updated_at()`) — not translated, see §5.

### `rooms`
- Columns: `id`, `name`, `table_count` (default 0), `description`, `created_at`.
- RLS (final state): `rooms_admin_delete`/`_insert`/`_update` (`internal.is_admin()`),
  `rooms_public_select` (SELECT, `anon`+`authenticated`, `USING (true)`).

### `tables`
- Columns: `id`, `room_id` (FK → rooms, CASCADE), `name`, `type` (enum, default
  `small`), `qr_code`, `pos_x`, `pos_y`, `created_at`, `qr_code_inf`.
- Index: `tables_room_id_idx`.
- RLS (final state): `tables_admin_delete`/`_insert`/`_update` (`internal.is_admin()`),
  `tables_public_select` (SELECT, `anon`+`authenticated`, `USING (true)`).
- Note: `20260417000007_fix_double_table_qr_code_inf.sql` is a data backfill
  (nulls out `qr_code_inf` for non-`removable_top` rows), not a schema change.

### `reservations`
- Columns: `id`, `table_id` (FK → tables, CASCADE), `user_id` (FK → profiles, CASCADE
  — see §5 for the dropped `auth.users` FK), `date`, `start_time`, `end_time`,
  `surface` (enum, nullable), `status` (enum, default `pending`), `created_at`,
  `activated_at`.
- Check: `reservation_times_valid` (`end_time > start_time`).
- Indexes (7): `reservations_date_idx`, `reservations_table_date_idx`,
  `reservations_user_id_idx`, `reservations_activation_lookup_idx`,
  `reservations_pending_date_idx` (partial, `status = 'pending'`),
  `reservations_pending_no_show_idx` (partial, `status = 'pending' AND activated_at IS NULL`),
  `reservations_user_date_status_idx` (partial, `status IN ('pending','active')`).
- **Not in `lib/db/schema/reservations.ts`** — delivered instead as raw SQL in
  `lib/db/migrations/0001_exclusion_constraints.sql` (no Drizzle builder for
  `EXCLUDE`): `reservations_no_pending_active_overlap_top` and `_bottom` (superseded
  the baseline's single `reservations_no_active_overlap` constraint in
  `20260619000001_kim375_atomic_reservation_overlap_constraints.sql`).
- RLS (final state): `reservations_delete`/`_insert`/`_select`/`_update`, all
  `(user_id = auth.uid() AND internal.is_active_member()) OR internal.is_admin()`.
- Trigger: `reservations_validate_saved_game` (BEFORE INSERT/UPDATE →
  `validate_reservation_against_saved_game()`) and `record_saved_game_attendance_after_activation`
  (AFTER UPDATE OF status) — business logic, not translated, see §5.

### `equipment`
- Columns: `id`, `name`, `description`, `created_at`.
- RLS (final state): `equipment_admin_delete`/`_insert`/`_update` (`internal.is_admin()`),
  `equipment_select` (SELECT, `authenticated`, `USING (true)`).

### `room_default_equipment`
- Columns: `room_id` (FK → rooms, CASCADE), `equipment_id` (FK → equipment, CASCADE).
  Composite PK `(room_id, equipment_id)`.
- Index: `room_default_equipment_equipment_id_idx`.
- RLS (final state): `room_default_equipment_admin_delete`/`_insert` (`internal.is_admin()`
  — no `_admin_update` policy exists), `room_default_equipment_select` (SELECT,
  `authenticated`, `USING (true)`).

### `reservation_equipment`
- Columns: `reservation_id` (FK → reservations, CASCADE), `equipment_id` (FK →
  equipment, **RESTRICT** — the one FK in this schema that isn't CASCADE). Composite
  PK `(reservation_id, equipment_id)`.
- Index: `reservation_equipment_equipment_id_idx`.
- RLS history is the most convoluted of any table — full timeline:
  1. `20260417000025-036`: table created service-role-only; several "intentionally
     no-op" placeholder policy files (`_select`/`_insert`/`_delete`) that were never
     real (comment-only), later formally dropped as no-ops, `authenticated` grant
     revoked.
  2. `20260528000006_supabase_linter_fixes.sql`: table opened up to `authenticated`
     via 4 own-reservation-scoped policies (`_authenticated_select/_insert/_update/_delete`,
     each `EXISTS (... reservations.user_id = auth.uid())`) plus `_admin_all`
     (`TO authenticated`, `internal.is_admin()`) and `_service_role_all`.
  3. `20260602000002`: added the matching table-level `GRANT SELECT, INSERT, UPDATE,
     DELETE TO authenticated` (RLS policies alone don't grant table access).
  4. `20260602000007_kim391_fix_reservation_equipment_admin_policy_binding.sql`:
     `_admin_all` dropped and recreated `TO service_role` instead of `authenticated`
     (so admin mutations route through the dedicated admin client, not the ORed
     policy set).
  - **Final state**: `reservation_equipment_authenticated_select/_insert/_update/_delete`
    (own-reservation scoped), `reservation_equipment_admin_all` (service_role),
    `reservation_equipment_service_role_all` (service_role, redundant with `_admin_all`).

### `events`
- Columns: baseline (`id`, `title`, `description`, `date`, `start_time`, `end_time`,
  `created_by`, `created_at`) + 13 columns added in
  `20260703000001_oir202_extend_events_for_public_landing.sql` for bilingual public
  landing content (`title_es/en`, `blurb_es/en`, `description_es/en`, `date_kind`,
  `end_date`, `recurrence_label_es/en`, `image_url`, `link_url`, `category_es/en`).
- Checks: `events_valid_time_range`, `events_valid_date_kind` (`date_kind IN
  ('single','range','recurring')`), `events_valid_end_date`,
  `events_bilingual_titles_paired` (`(title_es IS NULL) = (title_en IS NULL)`,
  added in `20260704000004`).
- Indexes: `events_date_idx`, `events_created_by_idx`.
- `created_by` originally FK'd to `auth.users(id)` — redirected to `profiles(id)` here,
  see §5.
- RLS (final state): `events_admin_delete`/`_insert`/`_update` (`internal.is_admin()`),
  `events_select` (SELECT, `authenticated`, `USING (true)`), `events_select_public`
  (SELECT, `anon`, `USING (title_es IS NOT NULL AND title_en IS NOT NULL)` — dropped
  and recreated identically in `20260704000001_oir202_repair_events_anon_grant.sql`
  to repair a remote environment where the grant/policy from `20260703000001` never
  actually took effect).
- Table grant: `anon` was `REVOKE ALL` in `20260617000001_kim383_multi_day_events.sql`
  then re-`GRANT SELECT` (not `ALL`) in `20260703000001` so `events_select_public`
  could take effect.

### `event_room_blocks`
- Columns: baseline (`id`, `event_id` FK → events CASCADE, `room_id` FK → rooms
  CASCADE, `date`, `start_time`, `end_time`, `all_day` default false) + `table_id`
  (nullable FK → tables CASCADE, added in
  `20260704000006_oir208_table_blocks_and_materials.sql` — NULL = whole-room block,
  non-null = single-table block).
- Check: `event_room_blocks_valid_time_range`.
- Indexes: `event_room_blocks_event_id_idx`, `event_room_blocks_room_id_idx`,
  unique index `event_room_blocks_unique_block` (`event_id, room_id, date,
  start_time, end_time`, added in `20260617000001`).
- RLS (final state): `event_room_blocks_admin_delete`/`_insert`/`_update`
  (`internal.is_admin()`), `event_room_blocks_select` (SELECT, `authenticated`,
  `USING (true)`).
- Trigger: `event_blocks_cancel_saved_games` (AFTER INSERT/UPDATE OF room_id,date →
  `cancel_saved_games_for_event_block()`) — business logic, not translated, see §5.
- Also `REVOKE ALL ON TABLE public.event_room_blocks FROM anon` in `20260617000001`
  (defense-in-depth; no corresponding anon policy exists, so no re-grant was needed).

### `event_equipment`
- Columns: `event_id` (FK → events, CASCADE), `equipment_id` (FK → equipment,
  CASCADE), `quantity` (integer, default 1, `CHECK (quantity > 0)`). Composite PK
  `(event_id, equipment_id)`.
- RLS: table has RLS **enabled** but **no policies were ever defined** — internal
  logistics only, accessible exclusively via the service-role client (which bypasses
  RLS). `GRANT ALL ... TO service_role` only.

### `saved_games`
- Columns: `id`, `table_id` (FK → tables, CASCADE), `user_id` (FK → profiles,
  CASCADE), `start_date`, `end_date`, `status` (plain `text`, not an enum — see §7),
  `attendance_count` (default 0), `renewed_from_id` (nullable, unique, self-FK →
  `saved_games.id`, `ON DELETE SET NULL`), `created_at`, `updated_at`.
- Checks: `saved_games_valid_status` (`status IN ('active','cancelled','completed')`),
  `saved_games_valid_dates` (`end_date >= start_date`), `saved_games_max_duration`
  (`end_date < start_date + interval '3 months'`),
  `saved_games_attendance_nonnegative` (`attendance_count >= 0`).
- **Not in `lib/db/schema/saved-games.ts`** — delivered as raw SQL in
  `lib/db/migrations/0001_exclusion_constraints.sql`: `saved_games_no_active_overlap`
  (`EXCLUDE USING gist` on `table_id` + `daterange(start_date, end_date)` `WHERE
  status = 'active'`).
- Indexes: `saved_games_user_dates_idx`, `saved_games_table_dates_idx` (both partial,
  `WHERE status = 'active'`).
- RLS (final state): `saved_games_select` (SELECT, `authenticated`,
  `auth.uid() = user_id OR internal.is_admin()`). No INSERT/UPDATE/DELETE policies —
  writes go through the service-role client and/or the triggers below.
- Triggers: `saved_games_validate` (BEFORE INSERT/UPDATE OF table_id,start_date,
  end_date,status → `validate_saved_game()`) — business logic, not translated,
  see §5.

### `saved_game_attendances`
- Columns: `id`, `saved_game_id` (FK → saved_games, CASCADE), `play_reservation_id`
  (unique, FK → reservations, CASCADE), `attended_on`, `scanned_at`.
- Index: `saved_game_attendances_saved_game_id_idx`.
- RLS (final state): `saved_game_attendances_select` (SELECT, `authenticated`, via
  `EXISTS` against `saved_games` ownership/admin).
- Trigger: `saved_game_attendance_count` (AFTER INSERT →
  `increment_saved_game_attendance()`) — business logic, not translated, see §5.

### `activation_tokens`
- Columns: `id`, `profile_id` (unique, FK → profiles, CASCADE), `token_hash`
  (unique), `expires_at`, `used_at`, `created_by` (FK → profiles, `SET NULL`),
  `created_at`, `updated_at`.
- Index: `activation_tokens_created_by_idx`.
- RLS history: `activation_tokens_anon_select_by_hash` (created in `20260528000006`,
  dropped in `20260602000001` — anon direct access removed, validation happens
  server-side via the admin client), `activation_tokens_authenticated_select_own`
  (created in `20260528000006`, dropped in `20260602000008`),
  `activation_tokens_authenticated_update_own` (created in `20260528000006`, dropped
  in `20260602000005`).
- **Final state**: only `activation_tokens_service_role_all` remains
  (`FOR ALL TO service_role USING (true) WITH CHECK (true)`). Table-level grants to
  `anon`/`authenticated` were fully revoked in `20260602000008` — this table is
  service-role/admin-client only end to end.
- Trigger: `activation_tokens_updated_at` (BEFORE UPDATE → `handle_updated_at()`) —
  not translated, see §5.

### `partners`
- Columns: `id`, `name`, `img_url`, `link_url`, `desc_es`, `desc_en`, `sort_order`
  (default 0), `active` (default true), `created_at`, `updated_at`.
- RLS (final state): `partners_select_active` (SELECT, `anon`+`authenticated`,
  `USING (active = true)`). No write policies — admin-client only.
- Seed data (19 rows) not translated — see §6.

### `library_games`
- Columns: `id`, `title`, `category_es`, `category_en`, `players`, `play_time`,
  `weight` (`numeric(2,1)`), `sort_order` (default 0), `active` (default true),
  `created_at`, `updated_at`, `img_url` (nullable, added in `20260704000005`).
- RLS (final state): `library_games_select_active` (SELECT, `anon`+`authenticated`,
  `USING (active = true)`). No write policies — admin-client only.
- Seed data (8 rows) not translated — see §6.

## 3. Storage (not a table — cataloged for completeness)

- `table-qr-codes` bucket (referenced by policies in the baseline `--- Dumped schema
  changes for auth and storage ---` section; bucket creation itself is not in these
  migrations, only its `storage.objects` policies): `qr_codes_public_read` (dropped in
  `20260417000004_fix_function_search_paths.sql` — "public buckets serve objects by
  URL without a policy"), `qr_codes_service_delete`/`_update`/`_write` (all
  `auth.role() = 'service_role'`).
- `landing-media` bucket, created in `20260704000005_oir207_landing_media_bucket.sql`
  (`INSERT INTO storage.buckets ...`, public read, 5 MB limit, image mime types
  only) with `landing_media_select_public` policy (`anon`+`authenticated` SELECT).
- Supabase Storage has no Drizzle/Neon equivalent — this is F3's job (Vercel Blob
  migration, see Linear KIM-393..422, Supabase→Neon migration), not F1.

## 4. Exclusion constraints (Drizzle limitation)

`drizzle-orm` 0.45.x's pg-core schema builder has **no `EXCLUDE` constraint API**
(confirmed: no `exclude`/`exclusion` export anywhere under
`node_modules/drizzle-orm/pg-core/`). All three `EXCLUDE USING gist` constraints in
the source migrations are instead delivered as a hand-authored `drizzle-kit` "custom"
SQL migration: `lib/db/migrations/0001_exclusion_constraints.sql` (generated via
`drizzle-kit generate --custom`, then filled in by hand). It also installs
`btree_gist`/`pgcrypto` extensions (into `public` rather than Supabase's `extensions`
schema, since Neon has no equivalent schema-separation convention already in place —
this is a judgment call, see §7).

## 5. Supabase-specific constructs skipped (not portable, cataloged for KIM-418 / follow-up)

**Auth (`auth.*` schema, Supabase Auth/GoTrue-managed):**
- `auth.uid()`, `auth.role()` — used throughout every RLS policy listed in §2. No
  direct Neon equivalent; KIM-418 must replace each with an equivalent service-layer
  session check (current session's user id / role, from whatever Auth.js session
  primitive KIM-416 lands on).
- `auth.users` table — referenced by 2 dropped FKs (`profiles.id`,
  `reservations.user_id`) — see §7.
- `on_auth_user_created` trigger (AFTER INSERT ON `auth.users` → `handle_new_user()`)
  — creates a `profiles` row automatically on Supabase Auth signup. Under Auth.js
  there is no `auth.users` table to attach this trigger to; profile creation becomes
  an application-level concern in the Auth.js signup/activation flow (KIM-416).

**RLS helper functions (`internal` schema, created in
`20260527150001_kim393_move_rls_helpers_to_internal_schema.sql`):**
- `internal.is_admin()` — `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND
  role = 'admin')`.
- `internal.is_active_member()` — `EXISTS (SELECT 1 FROM profiles WHERE id =
  auth.uid() AND is_active = true)`.
- These two predicates are the exact spec KIM-418 needs: every RLS policy in §2 that
  says `internal.is_admin()` or `internal.is_active_member()` is a 1:1 candidate for
  a service-layer function with that same logic, scoped to the caller's session
  instead of `auth.uid()`.

**Business-logic SECURITY DEFINER functions and triggers — IMPORTANT, larger than
just RLS:** several of these are not authorization helpers but atomic, multi-step
business operations invoked via Supabase RPC (`supabase.rpc(...)`) from the app's
service layer, and/or Postgres triggers enforcing invariants with
`pg_advisory_xact_lock`-based concurrency guards. Dropping RLS is a scoped, well-
understood problem (KIM-418); **reimplementing this logic in TypeScript/Drizzle
queries with equivalent atomicity and concurrency safety is a separate, likely
larger effort** that this issue does not cover and that isn't yet assigned to an
issue. Flagging for solution-architect / product-manager triage:
- `create_event_atomic` / `update_event_atomic` (baseline; legacy single-room event
  RPCs) and `create_event_with_blocks` / `update_event_with_blocks`
  (`20260617000001`, multi-room/multi-day) and `apply_club_event_room_blocks`
  (`20260704000004`, then extended with `p_materials` in `20260704000006`) — each
  does INSERT/UPDATE + cascading reservation cancellation in one transaction.
- `mark_no_show_reservations` (final version in `20260619000002`) and the dropped
  `cancel_expired_pending_reservations` (removed in `20260526000001` per KIM-366,
  replaced by lazy evaluation at query time — already ported to app code per that
  issue, not a gap here).
- `get_database_time()` — trivial (`SELECT now()`), easy to replace with the
  application server's own clock or a lightweight query.
- `handle_updated_at()` — generic `NEW.updated_at = now()` trigger, attached to
  `profiles` and `activation_tokens`. No Drizzle "on update" column helper exists in
  this version; needs either an app-level `updatedAt: new Date()` on every mutating
  query, or a hand-written trigger (same pattern as `0001_exclusion_constraints.sql`).
- The full saved-games trigger chain (`validate_saved_game`,
  `increment_saved_game_attendance`, `cancel_saved_games_for_event_block`,
  `validate_reservation_against_saved_game`,
  `record_saved_game_attendance_on_activation` — `20260619000006` through
  `20260619000019`): these enforce "one active saved-game per table per date range",
  "no bottom-surface reservation while a saved game is active", and "auto-count
  attendance on activation", each behind an advisory lock keyed on `table_id` to
  serialize concurrent writers. This is real concurrency-sensitive business logic,
  not a rubber-stamp translation — recommend a dedicated follow-up issue scoped with
  the same care as KIM-418, not a footnote inside a later PR.

**Extensions / schemas (declared in the baseline, not all re-created for Neon):**
- `pg_net` (`extensions` schema) — Supabase-specific async HTTP/webhook extension.
  Not referenced by any function body in these 85 migrations. Skip.
- `btree_gist` — needed (GIST index support for `uuid`/date-range exclusion
  constraints). Moved from `public` to `extensions` in Supabase
  (`20260527120003_move_btree_gist_to_postgres_schema.sql`); re-declared into
  `public` for Neon in `0001_exclusion_constraints.sql` — see §7.
- `pg_graphql` (`graphql` schema) — Supabase PostgREST/GraphQL feature. This app
  uses Next.js Route Handlers, not PostgREST/GraphQL. Skip.
- `pg_stat_statements` (`extensions` schema) — generic Postgres query-stats
  extension, optional/operational, not required by application code. Skip (can be
  added independently on Neon later if desired for observability).
- `pgcrypto` (`extensions` schema) — needed (`gen_random_uuid()`, used by every
  table's `id` default). Re-declared into `public` for Neon — see §7.
- `supabase_vault` (`vault` schema) — Supabase Vault/pgsodium secrets management.
  Not referenced by any function body in these 85 migrations (only the `CREATE
  EXTENSION` line exists). Skip.
- `uuid-ossp` (`extensions` schema) — installed in the baseline but never actually
  used (every `id` column uses `gen_random_uuid()` from `pgcrypto`, not
  `uuid_generate_v4()`). Skip.
- `internal` schema — see "RLS helper functions" above; not re-created (no tables
  live there, only the two RLS-only functions).

**Realtime:**
- `ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres"` (baseline) — the
  publication itself, with no `ADD TABLE` statements anywhere in these 85 migrations
  (i.e., no table was ever actually put on `supabase_realtime`). Supabase Realtime
  has no Neon equivalent. Skip — appears to have been unused infrastructure already.

## 6. Data (not schema — not applicable to a schema translation, listed for completeness)

- `20260703000002_oir202_seed_public_landing_events.sql` — 24-row seed of real club
  events for the public landing page (translated ES/EN copy).
- `20260704000002_oir204_partners_table.sql` — includes a 19-row `INSERT` seeding
  the `partners` table (embedded in the same file as the `CREATE TABLE`).
- `20260704000003_oir205_library_games_table.sql` — includes an 8-row `INSERT`
  seeding `library_games` (same pattern).
- `20260417000007_fix_double_table_qr_code_inf.sql` — one-off data backfill
  (`UPDATE ... SET qr_code_inf = NULL WHERE type != 'removable_top'`).

None of the above affect table shape; they are out of scope for a Drizzle *schema*
(seeding, if desired on Neon, is a separate concern — e.g. a `pnpm db:seed` script —
not part of this issue).

## 7. Translation ambiguities / judgment calls

1. **`auth.users` foreign keys dropped/redirected.** Supabase's `profiles.id` FK'd to
   `auth.users(id) ON DELETE CASCADE`, and `reservations.user_id` carried **two** FKs
   (one to `auth.users(id)`, one to `profiles(id)` — `reservations_user_id_fkey` and
   `reservations_user_id_fkey_profiles` respectively). `auth.users` is a Supabase
   Auth-managed table with no Neon/Drizzle equivalent. This schema drops the
   `auth.users` FK entirely and keeps only the `profiles` FK on `reservations`.
   `events.created_by` originally only had an `auth.users` FK (no `profiles` FK
   existed) — this schema **redirects** it to `profiles(id) ON DELETE SET NULL`
   instead of dropping it outright, since `profiles` becomes the durable identity
   table under the target Auth.js stack (per Linear KIM-393..422, Supabase→Neon migration,
   F2: "copy bcrypt hashes ... to profiles.password_hash"). **Reviewer should
   double-check**: this assumes `profiles` remains the single source of truth for
   user identity post-cutover; if KIM-416 (Auth.js) introduces a separate `users`
   table instead of extending `profiles`, these FK targets need to be revisited.
2. **`profiles.id` has no default.** In Supabase, `id` was always assigned by
   `auth.users.id` at signup (via the `handle_new_user()` trigger). With that
   linkage gone, nothing in this schema populates `profiles.id` — deliberately left
   for KIM-416 to decide (app-generated `gen_random_uuid()` default vs. an
   Auth.js-provided id) rather than guessed at here.
3. **`btree_gist`/`pgcrypto` extension target schema.** Supabase moved `btree_gist`
   into a dedicated `extensions` schema (security hardening specific to Supabase's
   multi-tenant Postgres model) and used a schema-qualified operator class
   (`extensions.gist_uuid_ops`) in the exclusion constraints. This schema installs
   `btree_gist` into `public` instead (see `0001_exclusion_constraints.sql`) since
   Neon has no equivalent pre-existing `extensions`-schema convention. **Reviewer
   should double-check** this against whatever Neon/Vercel Postgres project
   conventions exist at cutover time — if a dedicated schema is preferred, the
   `CREATE EXTENSION ... WITH SCHEMA` clause and the operator-class references need
   updating together. `pgcrypto` itself is created in `0000_fine_magma.sql` (moved
   there from `0001` — see note below) since it's needed by `gen_random_uuid()`
   defaults from the very first `CREATE TABLE`, not just by the exclusion
   constraints in `0001`.
4. **`saved_games.status` is `text`, not an enum**, faithfully matching the source
   (`CHECK (status IN ('active','cancelled','completed'))` rather than a Postgres
   enum type, unlike `reservations.status`/`role`/etc.). Kept as-is for fidelity,
   though a future cleanup could promote it to an enum — out of scope here.
5. **`role` enum name.** Named `role` for 1:1 fidelity with the source
   (`public.role`), even though it's a generic name. Not touched/renamed since this
   is a straight translation exercise.
6. **No `relations()` helpers.** This schema defines tables/columns/constraints only
   — no Drizzle `relations()` config for the query-builder's relational API. Adding
   these is safe, additive, and can be done later without affecting the DDL; skipped
   here to keep this issue's diff focused on faithful DDL translation.
7. **Reservation `user_id` "profiles-only" note.** Kept the profiles-scoped FK name
   pattern (`reservations_user_id_...`) rather than introducing a new name, since
   Drizzle auto-generates FK constraint names from `table_column_foreignTable_foreignColumn_fk`
   — the generated name (`reservations_user_id_profiles_id_fk`) differs cosmetically
   from the original `reservations_user_id_fkey_profiles` but is semantically
   identical. Cosmetic constraint-name drift like this exists across most FKs/PKs
   (Drizzle's naming convention differs from `pg_dump`'s) — mentioned once here
   rather than repeated per table; no behavioral difference.

## 8. What a human reviewer should double-check before this schema is applied to Neon

1. **Do not run this against a real database** without a full read of
   the Linear KIM-393..422 F2 plan first — this issue is schema
   authoring only (`drizzle-kit generate`, no `push`/`migrate` was run).
2. Confirm the `auth.users` FK removal/redirect decisions in §7.1 match whatever
   KIM-416 (Auth.js) actually builds for user identity — if it diverges from
   "profiles is the root identity table", the FK targets in `reservations.ts` and
   `events.ts` need to change together.
3. Decide `profiles.id` default strategy (§7.2) as part of KIM-416, then update
   `lib/db/schema/profiles.ts` accordingly (currently: no default, matches nothing
   in Supabase since `auth.users` used to own id generation).
4. Confirm the `btree_gist`/`pgcrypto` extension target schema decision (§7.3)
   against actual Neon/Vercel Postgres project conventions before running
   `0001_exclusion_constraints.sql`.
5. Read §5 in full before scoping KIM-418 — several of the functions listed there
   are business logic with concurrency guards (advisory locks), not just RLS
   authorization checks, and need their own reimplementation plan and tests, not a
   drive-by port.
6. Verify `reservation_equipment`'s convoluted RLS history (§2, the six-migration
   timeline) has been read in full — the *final* state (own-reservation-scoped CRUD
   for `authenticated`, `service_role` for admin) is what KIM-418 must replicate;
   several *intermediate* states in that history were themselves temporary/broken
   (e.g. RLS policies with no matching table `GRANT`).
7. This document and the schema files were produced by static review of the SQL
   text only — no live database was queried or introspected (per this issue's hard
   constraints). Cross-check against the actual deployed Supabase schema if drift
   between migration history and live state is suspected (see
   `20260704000001_oir202_repair_events_anon_grant.sql`, which exists specifically
   because such drift happened once before).
