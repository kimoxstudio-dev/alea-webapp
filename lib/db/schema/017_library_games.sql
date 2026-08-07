-- public.library_games, reconstructed from:
--   20260704000003_oir205_library_games_table.sql (table)
--   20260704000005_oir207_landing_media_bucket.sql ("img_url" column)
-- Seed data (the current 8 featured games) is intentionally not reproduced
-- here — out of scope for #296 (no data migration).

CREATE TABLE IF NOT EXISTS "library_games" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "title" text NOT NULL,
    "category_es" text NOT NULL,
    "category_en" text NOT NULL,
    "players" text NOT NULL,
    "play_time" text NOT NULL,
    "weight" numeric(2,1) NOT NULL,
    "sort_order" integer NOT NULL DEFAULT 0,
    "active" boolean NOT NULL DEFAULT true,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    "img_url" text
);
