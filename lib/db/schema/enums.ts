import { pgEnum } from 'drizzle-orm/pg-core'

/**
 * lib/db/schema — F1 Drizzle schema, translated from the 85 Supabase SQL
 * migrations in supabase/migrations/. See Linear KIM-417
 * for the full coverage report (tables, RLS policies deferred to KIM-418,
 * Supabase-specific constructs skipped, and judgment calls made).
 *
 * This file: Postgres enum types (from supabase/migrations/20260417000003_baseline.sql).
 */

/** public.reservation_status */
export const reservationStatusEnum = pgEnum('reservation_status', [
  'active',
  'cancelled',
  'completed',
  'pending',
  'no_show',
])

/** public.role — member vs admin. Distinct from Postgres roles (anon/authenticated),
 * which do not exist as a concept in the Neon target (RLS is being removed, see
 * Linear KIM-393..422, Supabase→Neon migration, "RLS -> service-layer parity gate"). */
export const roleEnum = pgEnum('role', ['member', 'admin'])

/** public.table_surface — top/bottom half of a removable-top table. */
export const tableSurfaceEnum = pgEnum('table_surface', ['top', 'bottom'])

/** public.table_type */
export const tableTypeEnum = pgEnum('table_type', ['small', 'large', 'removable_top'])
