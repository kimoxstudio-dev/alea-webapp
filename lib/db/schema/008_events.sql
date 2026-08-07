-- public.events, reconstructed from:
--   20260417000003_baseline.sql (base columns)
--   20260703000001_oir202_extend_events_for_public_landing.sql
--     (bilingual/display columns for the public landing page)
--
-- Scope note: "events.created_by" originally FK'd "auth"."users"("id")
-- (Supabase Auth). That table has no equivalent in this database (see
-- 003_profiles.sql), and "created_by" is an admin/profile identifier in
-- practice, so it now FKs "profiles"("id") instead.
--
-- Out of scope here: RLS policies, GRANTs, and the create_event_atomic /
-- update_event_atomic / create_event_with_blocks / update_event_with_blocks
-- RPC functions (business logic, not table structure).

CREATE TABLE IF NOT EXISTS "events" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "title" text NOT NULL,
    "description" text,
    "date" date NOT NULL,
    "start_time" time without time zone NOT NULL,
    "end_time" time without time zone NOT NULL,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "title_es" text,
    "title_en" text,
    "blurb_es" text,
    "blurb_en" text,
    "description_es" text,
    "description_en" text,
    "date_kind" text DEFAULT 'single' NOT NULL,
    "end_date" date,
    "recurrence_label_es" text,
    "recurrence_label_en" text,
    "image_url" text,
    "link_url" text,
    "category_es" text,
    "category_en" text,
    CONSTRAINT "events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "events_valid_time_range" CHECK (("end_time" > "start_time")),
    CONSTRAINT "events_valid_date_kind" CHECK (("date_kind" IN ('single', 'range', 'recurring'))),
    CONSTRAINT "events_valid_end_date" CHECK (("end_date" IS NULL OR "end_date" >= "date")),
    CONSTRAINT "events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "events_date_idx" ON "events" USING btree ("date");
CREATE INDEX IF NOT EXISTS "events_created_by_idx" ON "events" USING btree ("created_by");
