/**
 * qa/e2e/db.mjs — shared Neon connection helper for the E2E runners (#312).
 *
 * The runners used to write/read DB fixtures through Supabase's PostgREST
 * layer with a service-role key (RLS bypass). There is no REST layer over
 * Neon in this app, so fixtures now go through a direct Postgres connection
 * instead — the same pattern `lib/db/client.ts` and `scripts/seed-dev.mjs`
 * already use: `@neondatabase/serverless`'s tagged-template `neon()`
 * function against `process.env.DATABASE_URL`.
 *
 * Callers must always use the tagged-template form —
 * `sql\`SELECT * FROM foo WHERE id = ${id}\`` — which the underlying driver
 * auto-parameterizes. String-concatenating a query on top of this would
 * defeat that and reintroduce SQL injection risk.
 */
import './env.mjs'; // runs dotenv.config() against .env.e2e.local — declared, not order-dependent
import { neon } from '@neondatabase/serverless';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Add it to .env.e2e.local before running the E2E runners.');
}

// Heuristic-only defense in depth, mirroring scripts/seed-dev.mjs's own
// DATABASE_URL "prod" check: the connection string carries no reliable
// environment marker, but refusing on an obvious "prod" hint costs nothing.
// These runners do privileged INSERT/DELETE fixture writes, same as seed-dev.
if (/prod/i.test(databaseUrl)) {
  throw new Error(
    '[qa/e2e] Refusing to run: DATABASE_URL appears to reference a production database ' +
      '(matched "prod"). Point .env.e2e.local at the dev database only.'
  );
}

export const sql = neon(databaseUrl);

/**
 * Delete-and-swallow for `finally`-block fixture cleanup. The Neon driver
 * rejects on any SQL/network error (unlike the old Supabase REST `fetch()`
 * calls, which always resolved with a status code) — an unwrapped DELETE
 * that fails (e.g. an ON DELETE RESTRICT FK) would abort the rest of
 * cleanup and hide the real test failure behind a cleanup error instead.
 */
export async function tryDelete(strings, ...values) {
  try {
    await sql(strings, ...values);
  } catch (error) {
    console.error(JSON.stringify({ cleanupError: String(error) }));
  }
}
