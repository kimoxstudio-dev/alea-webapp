import { index, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { rooms } from './rooms'
import { reservations } from './reservations'

/**
 * public.equipment (20260417000005_create_equipment_table.sql)
 */
export const equipment = pgTable('equipment', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/**
 * public.room_default_equipment — join table: equipment permanently assigned
 * as a room default (locks that equipment to the room).
 * (20260417000006_create_room_default_equipment_table.sql,
 *  index added in 20260528000006_supabase_linter_fixes.sql)
 *
 * `equipmentId` carries a UNIQUE constraint (KIM-434 PR1 hotfix,
 * 0002_room_default_equipment_equipment_unique.sql): the exclusivity rule
 * enforced in `setRoomDefaultEquipment()` (a piece of equipment can be the
 * default for at most one room at a time, surfaced to callers as
 * `EQUIPMENT_LOCKED_TO_ANOTHER_ROOM`) was previously only checked
 * application-side via a SELECT-then-INSERT, which is race-able by two
 * concurrent admins. The unique constraint gives a real DB-level guarantee:
 * a concurrent conflicting INSERT now fails with a Postgres unique-violation
 * (23505) instead of silently succeeding.
 */
export const roomDefaultEquipment = pgTable(
  'room_default_equipment',
  {
    roomId: uuid('room_id')
      .notNull()
      .references(() => rooms.id, { onDelete: 'cascade' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.equipmentId] }),
    index('room_default_equipment_equipment_id_idx').on(t.equipmentId),
    unique('room_default_equipment_equipment_id_unique').on(t.equipmentId),
  ],
)

/**
 * public.reservation_equipment — join table: equipment attached to a specific
 * reservation. `equipment_id` uses ON DELETE RESTRICT (equipment in active use
 * by a reservation cannot be deleted), unlike the CASCADE used elsewhere.
 * (20260417000025_create_reservation_equipment_table.sql,
 *  index added in 20260528000006_supabase_linter_fixes.sql)
 */
export const reservationEquipment = pgTable(
  'reservation_equipment',
  {
    reservationId: uuid('reservation_id')
      .notNull()
      .references(() => reservations.id, { onDelete: 'cascade' }),
    equipmentId: uuid('equipment_id')
      .notNull()
      .references(() => equipment.id, { onDelete: 'restrict' }),
  },
  (t) => [
    primaryKey({ columns: [t.reservationId, t.equipmentId] }),
    index('reservation_equipment_equipment_id_idx').on(t.equipmentId),
  ],
)
