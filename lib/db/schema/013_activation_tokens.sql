-- public.activation_tokens, reconstructed from
-- supabase/migrations/20260417000003_baseline.sql.
-- "activation_tokens_created_by_idx" was added later in
-- 20260528000006_supabase_linter_fixes.sql (unindexed FK fix).
--
-- Out of scope here: RLS policies, GRANTs, and the
-- "activation_tokens_updated_at" trigger (handle_updated_at() trigger
-- function).

CREATE TABLE IF NOT EXISTS "activation_tokens" (
    "id" uuid DEFAULT gen_random_uuid() NOT NULL,
    "profile_id" uuid NOT NULL,
    "token_hash" text NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_by" uuid,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "activation_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "activation_tokens_profile_id_key" UNIQUE ("profile_id"),
    CONSTRAINT "activation_tokens_token_hash_key" UNIQUE ("token_hash"),
    CONSTRAINT "activation_tokens_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "activation_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS "activation_tokens_created_by_idx" ON "activation_tokens" USING btree ("created_by");
