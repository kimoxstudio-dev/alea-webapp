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
