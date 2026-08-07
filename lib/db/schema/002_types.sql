-- Enum types, reconstructed from supabase/migrations/20260417000003_baseline.sql.
-- No later migration altered these enums.
--
-- Postgres has no "CREATE TYPE IF NOT EXISTS", so each type is wrapped in a
-- DO block that swallows duplicate_object (re-running this file against a
-- database that already has these types is a safe no-op).

DO $$ BEGIN
    CREATE TYPE "reservation_status" AS ENUM (
        'active',
        'cancelled',
        'completed',
        'pending',
        'no_show'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "role" AS ENUM (
        'member',
        'admin'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "table_surface" AS ENUM (
        'top',
        'bottom'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "table_type" AS ENUM (
        'small',
        'large',
        'removable_top'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
