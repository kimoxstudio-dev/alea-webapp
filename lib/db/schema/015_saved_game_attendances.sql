-- public.saved_game_attendances, reconstructed from:
--   20260619000004_kim384_create_saved_game_attendances.sql (table)
--   20260619000005_kim384_saved_game_indexes.sql (index)

CREATE TABLE IF NOT EXISTS "saved_game_attendances" (
    "id" uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    "saved_game_id" uuid NOT NULL REFERENCES "saved_games"("id") ON DELETE CASCADE,
    "play_reservation_id" uuid NOT NULL UNIQUE REFERENCES "reservations"("id") ON DELETE CASCADE,
    "attended_on" date NOT NULL,
    "scanned_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "saved_game_attendances_saved_game_id_idx" ON "saved_game_attendances" ("saved_game_id");
