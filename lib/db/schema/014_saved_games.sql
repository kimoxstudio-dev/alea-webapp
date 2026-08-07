-- public.saved_games, reconstructed from:
--   20260619000003_kim384_create_saved_games.sql (table + inline constraints)
--   20260619000005_kim384_saved_game_indexes.sql (partial indexes)
--
-- Out of scope here: RLS policies, GRANTs, and the validate_saved_game() /
-- increment_saved_game_attendance() / cancel_saved_games_for_event_block()
-- trigger functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "saved_games" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "table_id" uuid NOT NULL REFERENCES "tables"("id") ON DELETE CASCADE,
    "user_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
    "start_date" date NOT NULL,
    "end_date" date NOT NULL,
    "status" text NOT NULL DEFAULT 'active',
    "attendance_count" integer NOT NULL DEFAULT 0,
    "renewed_from_id" uuid UNIQUE REFERENCES "saved_games"("id") ON DELETE SET NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "saved_games_valid_status" CHECK ("status" IN ('active', 'cancelled', 'completed')),
    CONSTRAINT "saved_games_valid_dates" CHECK ("end_date" >= "start_date"),
    CONSTRAINT "saved_games_max_duration" CHECK ("end_date" < ("start_date" + interval '3 months')),
    CONSTRAINT "saved_games_attendance_nonnegative" CHECK ("attendance_count" >= 0),
    CONSTRAINT "saved_games_no_active_overlap" EXCLUDE USING gist (
        "table_id" WITH =,
        daterange("start_date", "end_date", '[]') WITH &&
    ) WHERE ("status" = 'active')
);

CREATE INDEX IF NOT EXISTS "saved_games_user_dates_idx" ON "saved_games" ("user_id", "start_date", "end_date") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "saved_games_table_dates_idx" ON "saved_games" ("table_id", "start_date", "end_date") WHERE "status" = 'active';
