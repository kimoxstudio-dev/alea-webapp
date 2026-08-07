-- Neon schema setup (#296).
-- Extensions needed by the structural DDL below. Both are standard Postgres
-- contrib extensions available on Neon (no Supabase-specific extensions are
-- carried over — pg_net/pg_graphql/pg_stat_statements/supabase_vault are
-- Supabase platform internals and are intentionally not reproduced here).

-- gen_random_uuid() default values used across (nearly) every table's "id"
-- column. Native in Postgres 13+, but installing pgcrypto explicitly keeps
-- this schema portable to older Postgres versions too.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Provides the "gist_uuid_ops" operator class used by the GIST EXCLUDE
-- constraints on public.reservations and public.saved_games (overlap
-- prevention).
CREATE EXTENSION IF NOT EXISTS "btree_gist";
