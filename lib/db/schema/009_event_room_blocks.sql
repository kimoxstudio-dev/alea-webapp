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
