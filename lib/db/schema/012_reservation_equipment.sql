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
