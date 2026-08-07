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
