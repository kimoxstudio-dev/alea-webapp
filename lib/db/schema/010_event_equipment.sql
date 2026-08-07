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
