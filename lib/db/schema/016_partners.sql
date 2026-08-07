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
