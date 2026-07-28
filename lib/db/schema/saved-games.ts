import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { check, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { tables } from './tables'
import { profiles } from './profiles'
import { reservations } from './reservations'

/**
 * public.saved_games — a member's recurring "saved" claim on a
 * removable-top table's bottom surface across a date range.
 * (20260619000003_kim384_create_saved_games.sql)
 *
 * `saved_games_no_active_overlap` (EXCLUDE USING gist on table_id +
 * daterange(start_date, end_date) WHERE status = 'active') has no Drizzle
 * pg-core builder — preserved as raw SQL. See lib/db/schema/manual-sql/ and Linear KIM-417.
 *
 * Business-rule triggers (validate_saved_game, increment_saved_game_attendance,
 * cancel_saved_games_for_event_block, etc. — 20260619000006..19) are plpgsql
 * and likewise have no Drizzle schema-builder equivalent; see Linear KIM-417.
 */
export const savedGames = pgTable(
  'saved_games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tableId: uuid('table_id')
      .notNull()
      .references(() => tables.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull().default('active'),
    attendanceCount: integer('attendance_count').notNull().default(0),
    renewedFromId: uuid('renewed_from_id')
      .unique()
      .references((): AnyPgColumn => savedGames.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('saved_games_valid_status', sql`${t.status} IN ('active', 'cancelled', 'completed')`),
    check('saved_games_valid_dates', sql`${t.endDate} >= ${t.startDate}`),
    check(
      'saved_games_max_duration',
      sql`${t.endDate} < (${t.startDate} + interval '3 months')`,
    ),
    check('saved_games_attendance_nonnegative', sql`${t.attendanceCount} >= 0`),
    index('saved_games_user_dates_idx')
      .on(t.userId, t.startDate, t.endDate)
      .where(sql`${t.status} = 'active'`),
    index('saved_games_table_dates_idx')
      .on(t.tableId, t.startDate, t.endDate)
      .where(sql`${t.status} = 'active'`),
  ],
)

/**
 * public.saved_game_attendances — one row per reservation-activation "check-in"
 * that counted toward a saved game's attendance streak.
 * (20260619000004_kim384_create_saved_game_attendances.sql)
 */
export const savedGameAttendances = pgTable(
  'saved_game_attendances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    savedGameId: uuid('saved_game_id')
      .notNull()
      .references(() => savedGames.id, { onDelete: 'cascade' }),
    playReservationId: uuid('play_reservation_id')
      .notNull()
      .unique()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    attendedOn: date('attended_on').notNull(),
    scannedAt: timestamp('scanned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('saved_game_attendances_saved_game_id_idx').on(t.savedGameId)],
)
