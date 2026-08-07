-- public.equipment, reconstructed from
-- supabase/migrations/20260417000005_create_equipment_table.sql.

CREATE TABLE IF NOT EXISTS "equipment" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "name" text NOT NULL,
    "description" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);
