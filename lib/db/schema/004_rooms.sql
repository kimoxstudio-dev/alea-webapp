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
