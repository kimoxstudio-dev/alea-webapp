ALTER TABLE "profiles" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
-- KIM-420 confirms the target Neon database is rebuilt from scratch with
-- development seed data, so this transactional index build has no live
-- production-write window. Drizzle wraps migrations in a transaction, which
-- makes CREATE INDEX CONCURRENTLY invalid in this migration stream.
CREATE UNIQUE INDEX "profiles_clerk_user_id_key" ON "profiles" USING btree ("clerk_user_id") WHERE "profiles"."clerk_user_id" is not null;
