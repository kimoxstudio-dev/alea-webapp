-- public.reservations, reconstructed (final shape) from:
--   20260417000003_baseline.sql (base columns, original single EXCLUDE
--     constraint "reservations_no_active_overlap")
--   20260527120003_move_btree_gist_to_postgres_schema.sql (recreated the
--     same EXCLUDE constraint after an extension schema move)
--   20260619000001_kim375_atomic_reservation_overlap_constraints.sql
--     (DROPPED "reservations_no_active_overlap" and replaced it with two
--     surface-aware EXCLUDE constraints — this is the final, current shape
--     reproduced below; the earlier single constraint is NOT reproduced)
--
-- Scope note: "user_id" originally carried TWO foreign keys — one to
-- "auth"."users"("id") (Supabase Auth) and one to "profiles"("id"). Only the
-- "profiles" FK is reproduced here; "auth.users" has no equivalent in this
-- database (see 003_profiles.sql for the same auth-cutover rationale).
--
-- Out of scope here: RLS policies, GRANTs, and the
-- cancel_expired_pending_reservations / mark_no_show_reservations RPC
-- functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "reservations" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "table_id" uuid NOT NULL,
    "user_id" uuid NOT NULL,
    "date" date NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "surface" "table_surface",
    "status" "reservation_status" DEFAULT 'pending'::"reservation_status" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "activated_at" timestamp with time zone,
    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reservation_times_valid" CHECK (("end_time" > "start_time")),
    CONSTRAINT "reservations_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE CASCADE,
    CONSTRAINT "reservations_user_id_fkey_profiles" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "reservations_no_pending_active_overlap_top" EXCLUDE USING gist (
        "table_id" WITH =,
        tsrange(("date" + "start_time"), ("date" + "end_time"), '[)') WITH &&
    ) WHERE (("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"])) AND ("surface" IS NULL OR "surface" = 'top'::"table_surface")),
    CONSTRAINT "reservations_no_pending_active_overlap_bottom" EXCLUDE USING gist (
        "table_id" WITH =,
        tsrange(("date" + "start_time"), ("date" + "end_time"), '[)') WITH &&
    ) WHERE (("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"])) AND ("surface" IS NULL OR "surface" = 'bottom'::"table_surface"))
);

CREATE INDEX IF NOT EXISTS "reservations_activation_lookup_idx" ON "reservations" USING btree ("table_id", "date", "user_id", "status");
CREATE INDEX IF NOT EXISTS "reservations_date_idx" ON "reservations" USING btree ("date");
CREATE INDEX IF NOT EXISTS "reservations_pending_date_idx" ON "reservations" USING btree ("date", "start_time") WHERE ("status" = 'pending'::"reservation_status");
CREATE INDEX IF NOT EXISTS "reservations_pending_no_show_idx" ON "reservations" USING btree ("date", "end_time") WHERE (("status" = 'pending'::"reservation_status") AND ("activated_at" IS NULL));
CREATE INDEX IF NOT EXISTS "reservations_table_date_idx" ON "reservations" USING btree ("table_id", "date");
CREATE INDEX IF NOT EXISTS "reservations_user_date_status_idx" ON "reservations" USING btree ("user_id", "date", "status") WHERE ("status" = ANY (ARRAY['pending'::"reservation_status", 'active'::"reservation_status"]));
CREATE INDEX IF NOT EXISTS "reservations_user_id_idx" ON "reservations" USING btree ("user_id");
