-- =====================================================================
-- Consolidated Neon DEV branch schema reset (issue #344)
-- =====================================================================
-- PREPARED SCRIPT — DO NOT EXECUTE WITHOUT EXPLICIT USER PERMISSION.
--
-- Purpose: rebuild the Neon `develop` database branch schema from zero,
-- removing leftover Supabase/Drizzle platform schemas that are not part
-- of the current Neon-native app (see issue #344 for the read-only
-- inspection that found them), then re-applying the full current
-- lib/db/schema/*.sql definitions (001 through 018) in order.
--
-- Scope: Neon DEVELOPMENT branch only. Never run against staging or
-- production. Per this repo's CLAUDE.md ("DDL on the development
-- database" section), executing this script requires the user's
-- explicit permission, given in the current turn, after being shown
-- this exact SQL.
--
-- Before running: the synthetic rows this will destroy are:
--   - public.profiles          (2 rows  — seeded admin + test member)
--   - public.activation_tokens (1 row   — synthetic activation token)
--   - all other 12 app tables are already empty (0 rows)
-- All of the above is synthetic/fictional test data (#299 verification
-- seed), never real member data. DELETE, never TRUNCATE, is the norm
-- elsewhere in this project, but a full schema reset via DROP TABLE
-- necessarily removes the rows along with the tables — flagged here so
-- the loss is explicit before this runs, not a side effect discovered
-- after.
--
-- This entire script must run inside a single transaction so a
-- mid-way failure leaves the database exactly as it was before.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Step 1: drop leftover Supabase/Drizzle platform schemas.
-- None of these are used by the current Neon-native app (which only
-- uses "public", populated exclusively from lib/db/schema/*.sql).
-- Confirmed via read-only inspection (issue #344):
--   auth (111 objects), storage (25), realtime (13), drizzle (3,
--   __drizzle_migrations from the abandoned Drizzle attempt),
--   supabase_migrations, graphql, graphql_public, internal, vault (all
--   empty or Supabase-platform-internal).
-- ---------------------------------------------------------------------
DROP SCHEMA IF EXISTS "auth" CASCADE;
DROP SCHEMA IF EXISTS "storage" CASCADE;
DROP SCHEMA IF EXISTS "realtime" CASCADE;
DROP SCHEMA IF EXISTS "drizzle" CASCADE;
DROP SCHEMA IF EXISTS "supabase_migrations" CASCADE;
DROP SCHEMA IF EXISTS "graphql" CASCADE;
DROP SCHEMA IF EXISTS "graphql_public" CASCADE;
DROP SCHEMA IF EXISTS "internal" CASCADE;
DROP SCHEMA IF EXISTS "vault" CASCADE;

-- ---------------------------------------------------------------------
-- Step 2: drop the "extensions" schema.
-- This schema currently holds pgcrypto, btree_gist, uuid-ossp and
-- pg_stat_statements — extensions the app genuinely needs (pgcrypto for
-- gen_random_uuid(), btree_gist for the GIST EXCLUDE overlap
-- constraints) — but installed in a schema apply-neon-schema.mjs's
-- preflight does not allow (only "public" + Postgres-internal system
-- schemas). Dropping the schema drops the extensions installed in it;
-- Step 4 below (001_extensions.sql) reinstalls the two the app actually
-- uses, into "public" this time, matching what a genuinely fresh
-- database would get from running apply-neon-schema.mjs alone.
-- ---------------------------------------------------------------------
DROP SCHEMA IF EXISTS "extensions" CASCADE;

-- ---------------------------------------------------------------------
-- Step 3: drop the current "public" app tables and enum types.
-- Surgical DROP TABLE/DROP TYPE (not DROP SCHEMA public CASCADE) so
-- schema-level default privileges on "public" are left untouched.
-- Order is the reverse of lib/db/schema/*.sql creation order so FKs
-- never block a drop; CASCADE is still added defensively per statement.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS "schema_migrations" CASCADE;
DROP TABLE IF EXISTS "library_games" CASCADE;
DROP TABLE IF EXISTS "partners" CASCADE;
DROP TABLE IF EXISTS "saved_game_attendances" CASCADE;
DROP TABLE IF EXISTS "saved_games" CASCADE;
DROP TABLE IF EXISTS "activation_tokens" CASCADE;
DROP TABLE IF EXISTS "reservation_equipment" CASCADE;
DROP TABLE IF EXISTS "reservations" CASCADE;
DROP TABLE IF EXISTS "event_equipment" CASCADE;
DROP TABLE IF EXISTS "event_room_blocks" CASCADE;
DROP TABLE IF EXISTS "events" CASCADE;
DROP TABLE IF EXISTS "room_default_equipment" CASCADE;
DROP TABLE IF EXISTS "equipment" CASCADE;
DROP TABLE IF EXISTS "tables" CASCADE;
DROP TABLE IF EXISTS "rooms" CASCADE;
DROP TABLE IF EXISTS "profiles" CASCADE;

DROP TYPE IF EXISTS "role" CASCADE;
DROP TYPE IF EXISTS "table_type" CASCADE;
DROP TYPE IF EXISTS "table_surface" CASCADE;
DROP TYPE IF EXISTS "reservation_status" CASCADE;

-- ---------------------------------------------------------------------
-- Step 4: re-apply the full current lib/db/schema/*.sql, in order.
-- Concatenated verbatim from the working tree at the time this script
-- was generated — do not hand-edit below this line; regenerate instead
-- if lib/db/schema/*.sql changes (see scripts/db-reset/README or the
-- generator invocation recorded in the PR for issue #344).
-- ---------------------------------------------------------------------

-- ===== lib/db/schema/001_extensions.sql =====
-- Neon schema setup (#296).
-- Extensions needed by the structural DDL below. Both are standard Postgres
-- contrib extensions available on Neon (no Supabase-specific extensions are
-- carried over — pg_net/pg_graphql/pg_stat_statements/supabase_vault are
-- Supabase platform internals and are intentionally not reproduced here).

-- gen_random_uuid() default values used across (nearly) every table's "id"
-- column. Native in Postgres 13+, but installing pgcrypto explicitly keeps
-- this schema portable to older Postgres versions too.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Provides the "gist_uuid_ops" operator class used by the GIST EXCLUDE
-- constraints on public.reservations and public.saved_games (overlap
-- prevention).
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- ===== lib/db/schema/002_types.sql =====
-- Enum types, reconstructed from supabase/migrations/20260417000003_baseline.sql.
-- No later migration altered these enums.
--
-- Postgres has no "CREATE TYPE IF NOT EXISTS", so each type is wrapped in a
-- DO block that swallows duplicate_object (re-running this file against a
-- database that already has these types is a safe no-op).

DO $$ BEGIN
    CREATE TYPE "reservation_status" AS ENUM (
        'active',
        'cancelled',
        'completed',
        'pending',
        'no_show'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "role" AS ENUM (
        'member',
        'admin'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "table_surface" AS ENUM (
        'top',
        'bottom'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "table_type" AS ENUM (
        'small',
        'large',
        'removable_top'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ===== lib/db/schema/003_profiles.sql =====
-- public.profiles, reconstructed from supabase/migrations/20260417000003_baseline.sql
-- (final shape as of the latest migration touching this table).
--
-- Scope note: in Supabase, "profiles.id" carried a FOREIGN KEY to
-- "auth"."users"("id") (Supabase Auth's internal table). This migration is
-- part of the Supabase -> Neon + Clerk auth cutover, and "auth.users" has no
-- equivalent in this database, so that FK is intentionally dropped here.
-- "profiles.id" remains the app-level user identifier (still a plain uuid,
-- NOT NULL, primary key) — how it is populated/synced from Clerk is an
-- app-layer concern for a later issue (#298), not a schema change.
--
-- Also out of scope here (per issue #296): RLS policies, GRANTs to
-- Supabase's anon/authenticated/service_role roles, and the
-- "profiles_updated_at" trigger (handle_updated_at() trigger function).

CREATE TABLE IF NOT EXISTS "profiles" (
    "id" uuid NOT NULL,
    "member_number" character varying(20) NOT NULL,
    "email" text,
    "role" "role" DEFAULT 'member'::"role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "no_show_count" integer DEFAULT 0 NOT NULL,
    "blocked_until" timestamp with time zone,
    "auth_email" text NOT NULL,
    "full_name" text,
    "active_from" timestamp with time zone,
    "psw_changed" timestamp with time zone,
    "phone" text,
    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profiles_member_number_key" UNIQUE ("member_number")
);

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_auth_email_key" ON "profiles" USING btree ("auth_email");

-- ===== lib/db/schema/004_rooms.sql =====
-- public.rooms, reconstructed from supabase/migrations/20260417000003_baseline.sql.
-- No later migration altered this table's structure.

CREATE TABLE IF NOT EXISTS "rooms" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "table_count" integer DEFAULT 0 NOT NULL,
    "description" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- ===== lib/db/schema/005_tables.sql =====
-- public.tables, reconstructed from supabase/migrations/20260417000003_baseline.sql.
-- No later migration altered this table's structure ("qr_code_inf" was added
-- in the baseline; migration 20260417000007 only backfilled data, no DDL).

CREATE TABLE IF NOT EXISTS "tables" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "room_id" uuid NOT NULL,
    "name" text NOT NULL,
    "type" "table_type" DEFAULT 'small'::"table_type" NOT NULL,
    "qr_code" text,
    "pos_x" integer,
    "pos_y" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "qr_code_inf" text,
    CONSTRAINT "tables_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tables_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "tables_room_id_idx" ON "tables" USING btree ("room_id");

-- ===== lib/db/schema/006_equipment.sql =====
-- public.equipment, reconstructed from
-- supabase/migrations/20260417000005_create_equipment_table.sql.

CREATE TABLE IF NOT EXISTS "equipment" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- ===== lib/db/schema/007_room_default_equipment.sql =====
-- public.room_default_equipment, reconstructed from
-- supabase/migrations/20260417000006_create_room_default_equipment_table.sql.
-- "room_default_equipment_equipment_id_idx" was added later in
-- 20260528000006_supabase_linter_fixes.sql (unindexed FK fix).

CREATE TABLE IF NOT EXISTS "room_default_equipment" (
    "room_id" uuid NOT NULL,
    "equipment_id" uuid NOT NULL,
    CONSTRAINT "room_default_equipment_pkey" PRIMARY KEY ("room_id", "equipment_id"),
    CONSTRAINT "room_default_equipment_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE,
    CONSTRAINT "room_default_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "room_default_equipment_equipment_id_idx" ON "room_default_equipment" USING btree ("equipment_id");

-- ===== lib/db/schema/008_events.sql =====
-- public.events, reconstructed from:
--   20260417000003_baseline.sql (base columns)
--   20260703000001_oir202_extend_events_for_public_landing.sql
--     (bilingual/display columns for the public landing page)
--
-- Scope note: "events.created_by" originally FK'd "auth"."users"("id")
-- (Supabase Auth). That table has no equivalent in this database (see
-- 003_profiles.sql), and "created_by" is an admin/profile identifier in
-- practice, so it now FKs "profiles"("id") instead.
--
-- Out of scope here: RLS policies, GRANTs, and the create_event_atomic /
-- update_event_atomic / create_event_with_blocks / update_event_with_blocks
-- RPC functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "events" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "title" text NOT NULL,
    "description" text,
    "date" date NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "title_es" text,
    "title_en" text,
    "blurb_es" text,
    "blurb_en" text,
    "description_es" text,
    "description_en" text,
    "date_kind" text DEFAULT 'single' NOT NULL,
    "end_date" date,
    "recurrence_label_es" text,
    "recurrence_label_en" text,
    "image_url" text,
    "link_url" text,
    "category_es" text,
    "category_en" text,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "events_valid_time_range" CHECK (("end_time" > "start_time")),
    CONSTRAINT "events_valid_date_kind" CHECK (("date_kind" IN ('single', 'range', 'recurring'))),
    CONSTRAINT "events_valid_end_date" CHECK (("end_date" IS NULL OR "end_date" >= "date")),
    CONSTRAINT "events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "events_date_idx" ON "events" USING btree ("date");
CREATE INDEX IF NOT EXISTS "events_created_by_idx" ON "events" USING btree ("created_by");

-- ===== lib/db/schema/009_event_room_blocks.sql =====
-- public.event_room_blocks, reconstructed from:
--   20260417000003_baseline.sql (base columns)
--   20260617000001_kim383_multi_day_events.sql (event_room_blocks_unique_block)
--   20260704000006_oir208_table_blocks_and_materials.sql ("table_id" column)

CREATE TABLE IF NOT EXISTS "event_room_blocks" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "event_id" uuid NOT NULL,
    "room_id" uuid NOT NULL,
    "date" date NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "all_day" boolean DEFAULT false NOT NULL,
    "table_id" uuid,
    CONSTRAINT "event_room_blocks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "event_room_blocks_valid_time_range" CHECK (("end_time" > "start_time")),
    CONSTRAINT "event_room_blocks_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
    CONSTRAINT "event_room_blocks_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "rooms"("id") ON DELETE CASCADE,
    CONSTRAINT "event_room_blocks_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "event_room_blocks_event_id_idx" ON "event_room_blocks" USING btree ("event_id");
CREATE INDEX IF NOT EXISTS "event_room_blocks_room_id_idx" ON "event_room_blocks" USING btree ("room_id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_room_blocks_unique_block" ON "event_room_blocks" USING btree ("event_id", "room_id", "date", "start_time", "end_time");

-- ===== lib/db/schema/010_event_equipment.sql =====
-- public.event_equipment, reconstructed from
-- supabase/migrations/20260704000006_oir208_table_blocks_and_materials.sql.

CREATE TABLE IF NOT EXISTS "event_equipment" (
    "event_id" uuid NOT NULL,
    "equipment_id" uuid NOT NULL,
    "quantity" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "event_equipment_pkey" PRIMARY KEY ("event_id", "equipment_id"),
    CONSTRAINT "event_equipment_quantity_check" CHECK (("quantity" > 0)),
    CONSTRAINT "event_equipment_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE,
    CONSTRAINT "event_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE CASCADE
);

-- ===== lib/db/schema/011_reservations.sql =====
-- public.reservations, reconstructed (final shape) from:
--   20260417000003_baseline.sql (base columns, original single EXCLUDE
--     constraint "reservations_no_active_overlap")
--   20260527120003_move_btree_gist_to_postgres_schema.sql (recreated the
--     same EXCLUDE constraint after an extension schema move)
--   20260619000001_kim375_atomic_reservation_overlap_constraints.sql
--     (DROPPED "reservations_no_active_overlap" and replaced it with two
--     surface-aware EXCLUDE constraints — this is the final, current shape
--     reproduced below; the earlier single constraint is NOT reproduced)
--
-- Scope note: "user_id" originally carried TWO foreign keys — one to
-- "auth"."users"("id") (Supabase Auth) and one to "profiles"("id"). Only the
-- "profiles" FK is reproduced here; "auth.users" has no equivalent in this
-- database (see 003_profiles.sql for the same auth-cutover rationale).
--
-- Out of scope here: RLS policies, GRANTs, and the
-- cancel_expired_pending_reservations / mark_no_show_reservations RPC
-- functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "reservations" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "table_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "date" date NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "surface" "table_surface",
    "status" "reservation_status" DEFAULT 'pending'::"reservation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "activated_at" timestamp with time zone,
    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservation_times_valid" CHECK (("end_time" > "start_time")),
    CONSTRAINT "reservations_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE,
    CONSTRAINT "reservations_user_id_fkey_profiles" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "reservations_no_pending_active_overlap_top" EXCLUDE USING gist (
        "table_id" WITH =,
        tsrange(("date" + "start_time"), ("date" + "end_time"), '[)') WITH &&
    ) WHERE (("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"])) AND ("surface" IS NULL OR "surface" = 'top'::"table_surface")),
    CONSTRAINT "reservations_no_pending_active_overlap_bottom" EXCLUDE USING gist (
        "table_id" WITH =,
        tsrange(("date" + "start_time"), ("date" + "end_time"), '[)') WITH &&
    ) WHERE (("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"])) AND ("surface" IS NULL OR "surface" = 'bottom'::"table_surface"))
);

CREATE INDEX IF NOT EXISTS "reservations_activation_lookup_idx" ON "reservations" USING btree ("table_id", "date", "user_id", "status");
CREATE INDEX IF NOT EXISTS "reservations_date_idx" ON "reservations" USING btree ("date");
CREATE INDEX IF NOT EXISTS "reservations_pending_date_idx" ON "reservations" USING btree ("date", "start_time") WHERE ("status" = 'pending'::"reservation_status");
CREATE INDEX IF NOT EXISTS "reservations_pending_no_show_idx" ON "reservations" USING btree ("date", "end_time") WHERE (("status" = 'pending'::"reservation_status") AND ("activated_at" IS NULL));
CREATE INDEX IF NOT EXISTS "reservations_table_date_idx" ON "reservations" USING btree ("table_id", "date");
CREATE INDEX IF NOT EXISTS "reservations_user_date_status_idx" ON "reservations" USING btree ("user_id", "date", "status") WHERE ("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"]));
CREATE INDEX IF NOT EXISTS "reservations_user_id_idx" ON "reservations" USING btree ("user_id");

-- ===== lib/db/schema/012_reservation_equipment.sql =====
-- public.reservation_equipment, reconstructed from
-- supabase/migrations/20260417000025_create_reservation_equipment_table.sql.
-- "reservation_equipment_equipment_id_idx" was added later in
-- 20260528000006_supabase_linter_fixes.sql (unindexed FK fix).

CREATE TABLE IF NOT EXISTS "reservation_equipment" (
    "reservation_id" uuid NOT NULL,
    "equipment_id" uuid NOT NULL,
    CONSTRAINT "reservation_equipment_pkey" PRIMARY KEY ("reservation_id", "equipment_id"),
    CONSTRAINT "reservation_equipment_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE CASCADE,
    CONSTRAINT "reservation_equipment_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "equipment"("id") ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS "reservation_equipment_equipment_id_idx" ON "reservation_equipment" USING btree ("equipment_id");

-- ===== lib/db/schema/013_activation_tokens.sql =====
-- public.activation_tokens, reconstructed from
-- supabase/migrations/20260417000003_baseline.sql.
-- "activation_tokens_created_by_idx" was added later in
-- 20260528000006_supabase_linter_fixes.sql (unindexed FK fix).
--
-- Out of scope here: RLS policies, GRANTs, and the
-- "activation_tokens_updated_at" trigger (handle_updated_at() trigger
-- function).

CREATE TABLE IF NOT EXISTS "activation_tokens" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "profile_id" uuid NOT NULL,
    "token_hash" text NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "activation_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activation_tokens_profile_id_key" UNIQUE ("profile_id"),
    CONSTRAINT "activation_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "activation_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "activation_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "activation_tokens_created_by_idx" ON "activation_tokens" USING btree ("created_by");

-- ===== lib/db/schema/014_saved_games.sql =====
-- public.saved_games, reconstructed from:
--   20260619000003_kim384_create_saved_games.sql (table + inline constraints)
--   20260619000005_kim384_saved_game_indexes.sql (partial indexes)
--
-- Out of scope here: RLS policies, GRANTs, and the validate_saved_game() /
-- increment_saved_game_attendance() / cancel_saved_games_for_event_block()
-- trigger functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "saved_games" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "table_id" uuid NOT NULL REFERENCES "tables"("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
    "start_date" date NOT NULL,
    "end_date" date NOT NULL,
    "status" text NOT NULL DEFAULT 'active',
    "attendance_count" integer NOT NULL DEFAULT 0,
    "renewed_from_id" uuid UNIQUE REFERENCES "saved_games"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "saved_games_valid_status" CHECK ("status" IN ('active', 'cancelled', 'completed')),
    CONSTRAINT "saved_games_valid_dates" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "saved_games_max_duration" CHECK ("end_date" < ("start_date" + interval '3 months')),
    CONSTRAINT "saved_games_attendance_nonnegative" CHECK ("attendance_count" >= 0),
    CONSTRAINT "saved_games_no_active_overlap" EXCLUDE USING gist (
        "table_id" WITH =,
        daterange("start_date", "end_date", '[]') WITH &&
    ) WHERE ("status" = 'active')
);

CREATE INDEX IF NOT EXISTS "saved_games_user_dates_idx" ON "saved_games" ("user_id", "start_date", "end_date") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "saved_games_table_dates_idx" ON "saved_games" ("table_id", "start_date", "end_date") WHERE "status" = 'active';

-- ===== lib/db/schema/015_saved_game_attendances.sql =====
-- public.saved_game_attendances, reconstructed from:
--   20260619000004_kim384_create_saved_game_attendances.sql (table)
--   20260619000005_kim384_saved_game_indexes.sql (index)

CREATE TABLE IF NOT EXISTS "saved_game_attendances" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "saved_game_id" uuid NOT NULL REFERENCES "saved_games"("id") ON DELETE CASCADE,
    "play_reservation_id" uuid NOT NULL UNIQUE REFERENCES "reservations"("id") ON DELETE CASCADE,
    "attended_on" date NOT NULL,
    "scanned_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "saved_game_attendances_saved_game_id_idx" ON "saved_game_attendances" ("saved_game_id");

-- ===== lib/db/schema/016_partners.sql =====
-- public.partners, reconstructed from
-- supabase/migrations/20260704000002_oir204_partners_table.sql.
-- Seed data (the current 20 landing partners) is intentionally not
-- reproduced here — out of scope for #296 (no data migration).

CREATE TABLE IF NOT EXISTS "partners" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "name" text NOT NULL,
    "img_url" text NOT NULL,
    "link_url" text,
    "desc_es" text,
    "desc_en" text,
    "sort_order" integer NOT NULL DEFAULT 0,
    "active" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- ===== lib/db/schema/017_library_games.sql =====
-- public.library_games, reconstructed from:
--   20260704000003_oir205_library_games_table.sql (table)
--   20260704000005_oir207_landing_media_bucket.sql ("img_url" column)
-- Seed data (the current 8 featured games) is intentionally not reproduced
-- here — out of scope for #296 (no data migration).

CREATE TABLE IF NOT EXISTS "library_games" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "title" text NOT NULL,
    "category_es" text NOT NULL,
    "category_en" text NOT NULL,
    "players" text NOT NULL,
    "play_time" text NOT NULL,
    "weight" numeric(2,1) NOT NULL,
    "sort_order" integer NOT NULL DEFAULT 0,
    "active" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "img_url" text
);

-- ===== lib/db/schema/018_drop_profiles_id_fkey.sql =====
-- Drops the leftover "profiles_id_fkey" FOREIGN KEY constraint
-- ("profiles"."id" -> "auth"."users"("id") ON DELETE CASCADE) that still
-- exists on the live Neon development database from the old Supabase
-- baseline (declared in supabase/migrations/20260417000003_baseline.sql,
-- line ~680: ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id")
-- REFERENCES "auth"."users"("id") ON DELETE CASCADE). Constraint name
-- verified against that declaration, not assumed.
--
-- 003_profiles.sql's header comment already states this FK is
-- "intentionally dropped" as part of the Supabase -> Neon + Clerk cutover
-- (#296), and 003_profiles.sql's own CREATE TABLE statement never declares
-- it. But that was only ever true of the declarative schema *file* — on a
-- database where "profiles" already existed (i.e. the live Neon dev
-- database, seeded before this constraint was known to still be present),
-- the constraint was never actually dropped, because 003_profiles.sql only
-- contains "CREATE TABLE IF NOT EXISTS", which no-ops entirely on a table
-- that already exists. It does not run any ALTER on it. So the intended
-- drop described in 003_profiles.sql's comment never reached the live
-- database.
--
-- Root cause / gap in scripts/apply-neon-schema.mjs: this script's only
-- unit of change detection is "does this table exist yet" (via
-- CREATE TABLE IF NOT EXISTS and the preflight's expected-table check) —
-- it has no mechanism to detect or apply an ALTER against a table that
-- already exists. That means any future schema drift between
-- lib/db/schema/*.sql and a live database that was seeded before the
-- drift was introduced will be silently invisible to this script, exactly
-- like this FK was. This migration file (a plain, idempotent ALTER,
-- appended as the next file in file-sort order so it always runs after
-- 003_profiles.sql's CREATE TABLE) is a point fix for this one constraint,
-- not a fix for that gap. The gap itself still needs a follow-up fix to
-- apply-neon-schema.mjs (e.g. detecting and applying pending ALTERs
-- against already-existing tables, or some other drift-detection
-- mechanism) — intentionally NOT implemented here; out of scope for this
-- file, needs its own follow-up.
--
-- IF EXISTS makes this safe to run against a database that never had the
-- constraint in the first place (e.g. a genuinely fresh database created
-- straight from 001-017, which never adds this FK to begin with).

ALTER TABLE "profiles" DROP CONSTRAINT IF EXISTS "profiles_id_fkey";

COMMIT;

-- After COMMIT: run `node scripts/apply-neon-schema.mjs` once more (no
-- flags needed). This script deliberately does NOT create or populate the
-- schema_migrations ledger table itself — that stays apply-neon-schema.mjs's
-- own job, so its checksum logic is never duplicated here. That follow-up
-- run will see a fresh, ledger-less database, harmlessly re-apply every
-- 001-018 file (CREATE TABLE IF NOT EXISTS / DO-block CREATE TYPE / DROP
-- CONSTRAINT IF EXISTS are all no-ops against what this script just
-- created), and then populate schema_migrations for the first time —
-- closing the loop so every later run goes through the normal
-- drift-detected "already up to date" path instead.
