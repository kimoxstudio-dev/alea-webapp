import {
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { profiles } from './profiles'
import { rooms } from './rooms'
import { tables } from './tables'
import { equipment } from './equipment'

/**
 * public.events — internal room-blocking calendar AND (since OIR-202) public
 * marketing landing content, reusing the same table (see
 * 20260703000001_oir202_extend_events_for_public_landing.sql). A row is
 * public landing content once title_es/title_en are both set; internal
 * admin-created room-blocking events only ever populate the legacy
 * single-locale `title`.
 *
 * `created_by` originally referenced `auth.users(id) ON DELETE SET NULL`
 * (Supabase Auth-managed, no Neon equivalent). Adapted here to reference
 * `public.profiles(id) ON DELETE SET NULL` instead — profiles is the durable
 * identity table in the target schema. This is a judgment call; see
 * Linear KIM-417.
 */
export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    description: text('description'),
    date: date('date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    createdBy: uuid('created_by').references(() => profiles.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // OIR-202: bilingual public-landing metadata
    titleEs: text('title_es'),
    titleEn: text('title_en'),
    blurbEs: text('blurb_es'),
    blurbEn: text('blurb_en'),
    descriptionEs: text('description_es'),
    descriptionEn: text('description_en'),
    dateKind: text('date_kind').notNull().default('single'),
    endDate: date('end_date'),
    recurrenceLabelEs: text('recurrence_label_es'),
    recurrenceLabelEn: text('recurrence_label_en'),
    imageUrl: text('image_url'),
    linkUrl: text('link_url'),
    categoryEs: text('category_es'),
    categoryEn: text('category_en'),
  },
  (t) => [
    check('events_valid_time_range', sql`${t.endTime} > ${t.startTime}`),
    check('events_valid_date_kind', sql`${t.dateKind} IN ('single', 'range', 'recurring')`),
    check('events_valid_end_date', sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.date}`),
    check(
      'events_bilingual_titles_paired',
      sql`(${t.titleEs} IS NULL) = (${t.titleEn} IS NULL)`,
    ),
    index('events_date_idx').on(t.date),
    index('events_created_by_idx').on(t.createdBy),
  ],
)

/**
 * public.event_room_blocks — dates/rooms (optionally a single table) an event
 * blocks out from reservations.
 * (baseline; `table_id` added in 20260704000006_oir208_table_blocks_and_materials.sql)
 */
export const eventRoomBlocks = pgTable(
  'event_room_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    // OIR-208: NULL blocks the whole room; a concrete table_id scopes the
    // block (and reservation-cancellation predicate) to a single table.
    tableId: uuid('table_id').references(() => tables.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check('event_room_blocks_valid_time_range', sql`${t.endTime} > ${t.startTime}`),
    index('event_room_blocks_event_id_idx').on(t.eventId),
    index('event_room_blocks_room_id_idx').on(t.roomId),
    uniqueIndex('event_room_blocks_unique_block').on(
      t.eventId,
      t.roomId,
      t.date,
      t.startTime,
      t.endTime,
    ),
  ],
)

/**
 * public.event_equipment — materials/logistics needed for an event.
 * Internal-only join table; never exposed to the public landing (see
 * 20260704000006_oir208_table_blocks_and_materials.sql). No RLS policies were
 * ever defined for this table in Supabase (service_role-only via GRANT) — see
 * coverage doc.
 */
export const eventEquipment = pgTable(
  'event_equipment',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'cascade' }),
    quantity: integer('quantity').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.equipmentId] }),
    check('event_equipment_quantity_positive', sql`${t.quantity} > 0`),
  ],
)
