/**
 * lib/db/schema — F1 Drizzle schema barrel export.
 *
 * Translated from the 85 Supabase SQL migrations in supabase/migrations/.
 * See Linear KIM-417 for the full coverage report:
 * table-by-table status, all RLS policies (deferred to KIM-418), Supabase-
 * specific constructs skipped, and judgment calls made during translation.
 *
 * NOT included here (see coverage doc + lib/db/schema/manual-sql/):
 *   - RLS policies (KIM-418 replaces these with service-layer checks)
 *   - Exclusion constraints (no Drizzle pg-core builder) — raw SQL
 *   - Triggers / plpgsql functions (no Drizzle builder) — raw SQL / deferred
 *   - Supabase Storage buckets, Realtime, auth.* schema, extensions.* setup
 */
export * from './enums'
export * from './profiles'
export * from './rooms'
export * from './tables'
export * from './reservations'
export * from './equipment'
export * from './events'
export * from './saved-games'
export * from './activation-tokens'
export * from './partners'
export * from './library-games'
