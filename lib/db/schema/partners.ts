import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * public.partners — sponsors/collaborators shown on the public landing page.
 * (20260704000002_oir204_partners_table.sql)
 *
 * Public SELECT is restricted to active=true rows; writes go exclusively
 * through the admin/service-role client (lib/server/partners-service.ts) —
 * no INSERT/UPDATE/DELETE RLS policies were ever defined. See Linear KIM-418.
 */
export const partners = pgTable('partners', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  imgUrl: text('img_url').notNull(),
  linkUrl: text('link_url'),
  descEs: text('desc_es'),
  descEn: text('desc_en'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
