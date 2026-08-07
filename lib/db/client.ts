import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

/**
 * Raw-SQL Neon connection helper (#296).
 *
 * This intentionally does NOT wrap `sql` in any string-concatenation query
 * builder. Callers must always use the tagged-template form —
 * `sql\`SELECT * FROM foo WHERE id = ${id}\`` — which the underlying driver
 * auto-parameterizes. Building queries via string concatenation on top of
 * this would defeat that protection and reintroduce SQL injection risk.
 */

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Add it to your environment (.env.local) before using lib/db."
  );
}

/**
 * Tagged-template SQL query function backed by Neon's HTTP driver.
 * Neon's serverless driver is HTTP-based, so no connection pool is needed
 * or managed here.
 */
export const sql: NeonQueryFunction<false, false> = neon(databaseUrl);
