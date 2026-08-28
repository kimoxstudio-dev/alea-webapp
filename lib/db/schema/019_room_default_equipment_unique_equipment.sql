-- Adds a UNIQUE constraint on "room_default_equipment"."equipment_id" so a
-- single piece of equipment can never be a default for more than one room
-- at the same time.
--
-- Why this is needed (post-merge review on #346, P1 finding by Oiranca):
-- `setRoomDefaultEquipment` (lib/server/equipment-service.ts) does a
-- preflight `SELECT ... WHERE equipment_id = ANY(...)` to check whether any
-- of the requested equipment IDs already default to a different room, and
-- rejects the request with EQUIPMENT_LOCKED_TO_ANOTHER_ROOM if so. That
-- SELECT-then-write check is a classic TOCTOU race: two concurrent requests
-- can both run the SELECT, both see no conflict, and both proceed to assign
-- the same equipment_id to two different rooms, because nothing at the
-- database level actually prevents it. Application-level checks cannot
-- close this race by themselves; only a database constraint enforced
-- atomically by Postgres can. This constraint is that enforcement: it turns
-- the race into a guaranteed unique-violation (Postgres error code 23505)
-- for whichever transaction commits second, which
-- lib/server/equipment-service.ts catches and maps to
-- EQUIPMENT_LOCKED_TO_ANOTHER_ROOM. The preflight SELECT is kept as a cheap
-- fast-path for the common non-racing case; this constraint is the real
-- safety net for the race itself.
--
-- Root cause / gap in scripts/apply-neon-schema.mjs (same gap already
-- documented in 018_drop_profiles_id_fkey.sql, restated here because it
-- applies identically to this file): this script's only unit of change
-- detection is "does this table exist yet" (via CREATE TABLE IF NOT EXISTS
-- and the preflight's expected-table check) — it has no mechanism to
-- detect or apply an ALTER against a table that already exists. On a fresh
-- database created straight from 001-019, "room_default_equipment" doesn't
-- exist yet when this file runs, so this ALTER applies cleanly right after
-- 007_room_default_equipment.sql's CREATE TABLE. But on the live dev/prod
-- Neon database, "room_default_equipment" already exists from before this
-- file was added, so apply-neon-schema.mjs will keep no-oping on
-- 007_room_default_equipment.sql's CREATE TABLE IF NOT EXISTS and this
-- file's ALTER will never automatically run against it. Merely adding this
-- schema file does NOT retroactively add the constraint to the live
-- database — someone (a human, per this repo's "Database Migrations —
-- User-Only Execution" rule) has to run this ALTER manually against that
-- database before the constraint actually exists there. Until that happens,
-- the concurrency race above is still open in practice, even though the
-- application-level catch for the eventual 23505 is already in place. The
-- underlying gap in apply-neon-schema.mjs itself (no ALTER-on-existing-table
-- detection) is intentionally NOT fixed here — same as 018's note, that is
-- its own follow-up, out of scope for this file.
--
-- Idempotent form: Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so this
-- guards on pg_constraint instead. Safe to run repeatedly and safe to run
-- on a database that already has the constraint.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'room_default_equipment_equipment_id_key'
  ) THEN
    ALTER TABLE "room_default_equipment" ADD CONSTRAINT "room_default_equipment_equipment_id_key" UNIQUE ("equipment_id");
  END IF;
END $$;
