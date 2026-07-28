-- Custom SQL migration file, put your code below! --

-- F1 (KIM-417): EXCLUDE USING gist constraints.
--
-- Drizzle ORM's pg-core schema builder (drizzle-orm 0.45.x) has no builder
-- for PostgreSQL EXCLUDE constraints, so these three constraints — faithfully
-- translated from the Supabase migration history — are hand-written here as
-- a drizzle-kit "custom" SQL migration instead of being expressed in
-- lib/db/schema/*.ts. See Linear KIM-417 for details.
--
-- Requires the "btree_gist" extension (for the uuid equality operator class
-- used alongside the range "&&" operator in a GIST index). Supabase installed
-- btree_gist in the "extensions" schema
-- (supabase/migrations/20260527120003_move_btree_gist_to_postgres_schema.sql)
-- with search_path including that schema; on Neon, install directly into
-- "public" (or whatever schema is on the connection's search_path) so
-- "gist_uuid_ops" resolves without a schema-qualified operator class name.
--
-- "pgcrypto" (gen_random_uuid(), used throughout lib/db/schema) is now
-- created in 0000_fine_magma.sql instead of here -- it must exist before the
-- first CREATE TABLE with a gen_random_uuid() default, not just before this
-- migration's EXCLUDE constraints. See Linear KIM-417.

CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- reservations: no two pending/active reservations may overlap in time for
-- the same table + matching surface (NULL surface = whole table, so it
-- conflicts with both top and bottom bookings).
-- Faithful translation of the final state after
-- supabase/migrations/20260619000001_kim375_atomic_reservation_overlap_constraints.sql
-- (which replaced the single "reservations_no_active_overlap" EXCLUDE
-- constraint from the baseline with these two surface-aware constraints).
ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_pending_active_overlap_top"
  EXCLUDE USING gist (
    "table_id" WITH =,
    tsrange("date" + "start_time", "date" + "end_time", '[)') WITH &&
  )
  WHERE (
    "status" IN ('pending', 'active')
    AND ("surface" IS NULL OR "surface" = 'top')
  );

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_no_pending_active_overlap_bottom"
  EXCLUDE USING gist (
    "table_id" WITH =,
    tsrange("date" + "start_time", "date" + "end_time", '[)') WITH &&
  )
  WHERE (
    "status" IN ('pending', 'active')
    AND ("surface" IS NULL OR "surface" = 'bottom')
  );

-- saved_games: a table cannot have two overlapping *active* saved-game date
-- ranges. Faithful translation of
-- supabase/migrations/20260619000003_kim384_create_saved_games.sql.
ALTER TABLE "saved_games"
  ADD CONSTRAINT "saved_games_no_active_overlap"
  EXCLUDE USING gist (
    "table_id" WITH =,
    daterange("start_date", "end_date", '[]') WITH &&
  )
  WHERE ("status" = 'active');
