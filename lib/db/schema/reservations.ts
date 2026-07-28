import { check, date, index, pgTable, timestamp, time, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { reservationStatusEnum, tableSurfaceEnum } from './enums'
import { profiles } from './profiles'
import { tables } from './tables'

/**
 * public.reservations
 * (baseline 20260417000003; overlap-guard EXCLUDE constraints evolved across
 * 20260527120003, 20260619000001_kim375_atomic_reservation_overlap_constraints)
 *
 * Two things from the SQL history are intentionally NOT expressed in this
 * schema file (Drizzle pg-core has no EXCLUDE-constraint builder as of
 * drizzle-orm 0.45):
 *   - EXCLUDE USING gist reservations_no_pending_active_overlap_top
 *   - EXCLUDE USING gist reservations_no_pending_active_overlap_bottom
 * Both are preserved as raw SQL — see lib/db/schema/manual-sql/ and Linear KIM-417.
 *
 * `user_id` originally carried TWO foreign keys in Supabase: one to
 * `auth.users(id)` (Supabase Auth-managed, no Neon equivalent — dropped, see
 * Linear KIM-417) and one to `public.profiles(id)` (kept below, mirrors
 * `reservations_user_id_fkey_profiles`).
 */
export const reservations = pgTable(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    surface: tableSurfaceEnum('surface'),
    status: reservationStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
  },
  (t) => [
    check('reservation_times_valid', sql`${t.endTime} > ${t.startTime}`),
    index('reservations_date_idx').on(t.date),
    index('reservations_table_date_idx').on(t.tableId, t.date),
    index('reservations_user_id_idx').on(t.userId),
    index('reservations_activation_lookup_idx').on(t.tableId, t.date, t.userId, t.status),
    index('reservations_pending_date_idx')
      .on(t.date, t.startTime)
      .where(sql`${t.status} = 'pending'`),
    index('reservations_pending_no_show_idx')
      .on(t.date, t.endTime)
      .where(sql`${t.status} = 'pending' AND ${t.activatedAt} IS NULL`),
    index('reservations_user_date_status_idx')
      .on(t.userId, t.date, t.status)
      .where(sql`${t.status} IN ('pending', 'active')`),
  ],
)
