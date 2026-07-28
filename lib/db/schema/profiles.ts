import { sql } from 'drizzle-orm'
import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { roleEnum } from './enums'

/**
 * public.profiles — member/admin identity table.
 *
 * Supabase-era `id` referenced `auth.users(id) ON DELETE CASCADE` (a Supabase
 * Auth-managed table with no Drizzle/Neon equivalent). That FK is intentionally
 * NOT translated here — see Linear KIM-417, "Supabase
 * Auth linkage" ambiguity. Under the target Clerk stack, `profiles` remains
 * the root domain identity table and keeps its UUID primary key so existing
 * foreign keys do not need to be rewritten. `clerk_user_id` links that domain
 * identity to Clerk without making Clerk's string ID the application PK.
 *
 * Trigger `profiles_updated_at` (BEFORE UPDATE -> handle_updated_at()) has no
 * Drizzle schema-builder equivalent (no trigger support) — see Linear KIM-417.
 *
 * `passwordHash` has NO Supabase-era equivalent (Supabase Auth stored
 * `auth.users.encrypted_password` in its own managed table, not on
 * `profiles`). It remains nullable for the transitional Auth.js runtime
 * until Clerk replaces that runtime in KIM-451. Existing rows therefore
 * do not need a value; see Linear KIM-417.
 */
export const profiles = pgTable(
  'profiles',
  {
    id: uuid('id').primaryKey(),
    memberNumber: varchar('member_number', { length: 20 }).notNull().unique(),
    email: text('email'),
    role: roleEnum('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean('is_active').notNull().default(false),
    noShowCount: integer('no_show_count').notNull().default(0),
    blockedUntil: timestamp('blocked_until', { withTimezone: true }),
    authEmail: text('auth_email').notNull(),
    fullName: text('full_name'),
    activeFrom: timestamp('active_from', { withTimezone: true }),
    pswChanged: timestamp('psw_changed', { withTimezone: true }),
    phone: text('phone'),
    passwordHash: text('password_hash'),
    clerkUserId: text('clerk_user_id'),
  },
  (t) => [
    uniqueIndex('profiles_auth_email_key').on(t.authEmail),
    uniqueIndex('profiles_clerk_user_id_key')
      .on(t.clerkUserId)
      .where(sql`${t.clerkUserId} is not null`),
  ],
)
