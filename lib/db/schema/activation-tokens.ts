import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { profiles } from './profiles'

/**
 * public.activation_tokens — one active account-activation link per imported
 * member profile. (20260417000003_baseline.sql)
 *
 * Access model tightened over the migration history (KIM-391/KIM-602*): the
 * anon SELECT-by-hash policy and the authenticated UPDATE-own policy were
 * both created then later dropped, and table-level GRANTs to anon/
 * authenticated were revoked — this table ends up service_role/admin-client
 * only. See Linear KIM-417 for the full RLS history.
 *
 * Trigger `activation_tokens_updated_at` (BEFORE UPDATE -> handle_updated_at())
 * has no Drizzle schema-builder equivalent — see coverage doc.
 */
export const activationTokens = pgTable(
  'activation_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activation_tokens_created_by_idx').on(t.createdBy)],
)
