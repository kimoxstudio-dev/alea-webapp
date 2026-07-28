import { boolean, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * public.library_games — featured "ludoteca" games shown on the public
 * landing page. (20260704000003_oir205_library_games_table.sql;
 * img_url added in 20260704000005_oir207_landing_media_bucket.sql)
 *
 * Public SELECT is restricted to active=true rows; writes go exclusively
 * through the admin/service-role client (lib/server/library-games-service.ts)
 * — no INSERT/UPDATE/DELETE RLS policies were ever defined. See Linear KIM-418.
 */
export const libraryGames = pgTable('library_games', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  categoryEs: text('category_es').notNull(),
  categoryEn: text('category_en').notNull(),
  players: text('players').notNull(),
  playTime: text('play_time').notNull(),
  weight: numeric('weight', { precision: 2, scale: 1 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  imgUrl: text('img_url'),
})
