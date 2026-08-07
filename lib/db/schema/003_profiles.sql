-- public.profiles, reconstructed from supabase/migrations/20260417000003_baseline.sql
-- (final shape as of the latest migration touching this table).
--
-- Scope note: in Supabase, "profiles.id" carried a FOREIGN KEY to
-- "auth"."users"("id") (Supabase Auth's internal table). This migration is
-- part of the Supabase -> Neon + Clerk auth cutover, and "auth.users" has no
-- equivalent in this database, so that FK is intentionally dropped here.
-- "profiles.id" remains the app-level user identifier (still a plain uuid,
-- NOT NULL, primary key) — how it is populated/synced from Clerk is an
-- app-layer concern for a later issue (#298), not a schema change.
--
-- Also out of scope here (per issue #296): RLS policies, GRANTs to
-- Supabase's anon/authenticated/service_role roles, and the
-- "profiles_updated_at" trigger (handle_updated_at() trigger function).

CREATE TABLE IF NOT EXISTS "profiles" (
    "id" uuid NOT NULL,
    "member_number" character varying(20) NOT NULL,
    "email" text,
    "role" "role" DEFAULT 'member'::"role" NOT NULL,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "no_show_count" integer DEFAULT 0 NOT NULL,
    "blocked_until" timestamp with time zone,
    "auth_email" text NOT NULL,
    "full_name" text,
    "active_from" timestamp with time zone,
    "psw_changed" timestamp with time zone,
    "phone" text,
    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "profiles_member_number_key" UNIQUE ("member_number")
);

CREATE UNIQUE INDEX IF NOT EXISTS "profiles_auth_email_key" ON "profiles" USING btree ("auth_email");
