import { asc, eq, inArray } from 'drizzle-orm'
import { getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { equipment, roomDefaultEquipment } from '@/lib/db/schema'
import { ServiceError, serviceError } from '@/lib/server/shared/service-error'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { Equipment } from '@/lib/types'
import type { SessionUser } from '@/lib/server/auth/auth'

export type { Equipment }

/**
 * KIM-434 (F3c) pilot service: this is the first service migrated to the
 * Drizzle/Neon seam (see `lib/db/index.ts` header for the full stack
 * rationale). Equipment is public-read/admin-write catalog data — it is
 * NOT member-row-scoped, so `assertMemberRowsScoped()` does not apply here.
 */

type EquipmentRow = {
  id: string
  name: string
  description: string | null
  createdAt: Date
}

// Privilege checks (role === 'admin') live here in the service layer, not in
// route handlers (repo convention). Neon/Drizzle has no RLS, so this
// in-function check is the only authorization guard for these mutations —
// mirrors the equipment_admin_insert/update/delete and
// room_default_equipment_admin_insert/delete Supabase RLS policies
// (is_admin()) this service used to rely on.
function requireAdminSession(session: SessionUser): void {
  if (session.role !== 'admin') serviceError('Forbidden', 403)
}

/**
 * Runs a Drizzle query, translating any thrown DB/driver error into a
 * uniform 500 ServiceError. Business-logic outcomes (e.g. "no row
 * returned" -> 404, validation -> 400) are handled by callers, outside this
 * wrapper, so their specific status codes aren't swallowed into a 500.
 */
async function runQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query
  } catch {
    serviceError('Internal server error', 500)
  }
}

/**
 * Name of the DB-level unique constraint added on
 * `room_default_equipment.equipment_id` (KIM-434 PR1 hotfix, see
 * lib/db/migrations/0002_room_default_equipment_equipment_unique.sql and the
 * schema comment in lib/db/schema/equipment.ts). Used to recognize a
 * Postgres 23505 (unique_violation) raised specifically by this constraint,
 * so it can be translated into the existing EQUIPMENT_LOCKED_TO_ANOTHER_ROOM
 * business error instead of surfacing as an unhandled 500.
 */
const ROOM_DEFAULT_EQUIPMENT_UNIQUE_CONSTRAINT = 'room_default_equipment_equipment_id_unique'

/**
 * `node-postgres` (the driver behind the Drizzle/Neon seam) throws raw
 * `pg` `DatabaseError` instances with a `code`/`constraint` shape on
 * constraint violations; it does not wrap them. Duck-typed here rather than
 * importing `pg`'s error class to keep this check dependency-light.
 */
function isEquipmentExclusivityViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { code, constraint } = error as { code?: unknown; constraint?: unknown }
  return code === '23505' && constraint === ROOM_DEFAULT_EQUIPMENT_UNIQUE_CONSTRAINT
}

function toEquipment(row: EquipmentRow): Equipment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

export async function listEquipment(): Promise<Equipment[]> {
  const db = getDrizzleDb()
  const rows = await runQuery(db.select().from(equipment).orderBy(asc(equipment.name)))

  return rows.map(toEquipment)
}

export async function createEquipment(
  session: SessionUser,
  body: { name?: unknown; description?: unknown },
): Promise<Equipment> {
  requireAdminSession(session)
  const name = String(body.name ?? '').trim()
  if (!name) {
    serviceError('Equipment name is required', 400)
  }

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db
      .insert(equipment)
      .values({
        name,
        description: body.description ? String(body.description) : null,
      })
      .returning(),
  )

  if (!row) {
    serviceError('Internal server error', 500)
  }

  return toEquipment(row)
}

export async function updateEquipment(
  session: SessionUser,
  id: string,
  body: { name?: unknown; description?: unknown },
): Promise<Equipment> {
  requireAdminSession(session)
  const updates: Partial<{ name: string; description: string | null }> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    if (!name) {
      serviceError('Equipment name cannot be empty', 400)
    }
    updates.name = name
  }
  if (body.description !== undefined) {
    updates.description = body.description === null ? null : String(body.description) || null
  }

  if (Object.keys(updates).length === 0) {
    serviceError('No updatable fields provided', 400)
  }

  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db.update(equipment).set(updates).where(eq(equipment.id, id)).returning(),
  )

  if (!row) {
    serviceError('Equipment not found', 404)
  }

  return toEquipment(row)
}

export async function deleteEquipment(session: SessionUser, id: string): Promise<void> {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()
  const [row] = await runQuery(
    db.delete(equipment).where(eq(equipment.id, id)).returning({ id: equipment.id }),
  )

  if (!row) {
    serviceError('Equipment not found', 404)
  }
}

export async function getRoomDefaultEquipment(roomId: string): Promise<Equipment[]> {
  const db = getDrizzleDb()
  const rows = await runQuery(
    db
      .select({
        id: equipment.id,
        name: equipment.name,
        description: equipment.description,
        createdAt: equipment.createdAt,
      })
      .from(roomDefaultEquipment)
      .innerJoin(equipment, eq(roomDefaultEquipment.equipmentId, equipment.id))
      .where(eq(roomDefaultEquipment.roomId, roomId)),
  )

  return rows.map(toEquipment)
}

export async function setRoomDefaultEquipment(
  session: SessionUser,
  roomId: string,
  equipmentIds: string[],
): Promise<void> {
  requireAdminSession(session)
  const db = getDrizzleAdminDb()

  try {
    // The conflict-check SELECT, the DELETE of this room's existing
    // defaults, and the INSERT of the new set all run inside a single
    // transaction: if the INSERT fails for any reason (bad equipment id, FK
    // violation, dropped connection, unique-constraint race loss below), the
    // DELETE rolls back too instead of leaving the room's defaults silently
    // cleared with no equipment re-inserted.
    await db.transaction(async (tx) => {
      if (equipmentIds.length > 0) {
        // Enforce exclusivity: reject any equipment already locked to a
        // different room. This SELECT-then-write check narrows the race
        // between two concurrent admins but does not close it by itself --
        // two concurrent transactions can both pass this SELECT before
        // either INSERTs. The real guarantee comes from the
        // `room_default_equipment_equipment_id_unique` DB constraint (see
        // lib/db/schema/equipment.ts): the losing concurrent transaction's
        // INSERT throws a 23505 unique-violation, translated back into
        // EQUIPMENT_LOCKED_TO_ANOTHER_ROOM in the catch block below.
        const existingDefaults = await tx
          .select({
            equipmentId: roomDefaultEquipment.equipmentId,
            roomId: roomDefaultEquipment.roomId,
          })
          .from(roomDefaultEquipment)
          .where(inArray(roomDefaultEquipment.equipmentId, equipmentIds))

        const conflicts = existingDefaults.filter((row) => row.roomId !== roomId)

        if (conflicts.length > 0) {
          serviceError(ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM, 400)
        }
      }

      // Delete existing defaults for this room
      await tx.delete(roomDefaultEquipment).where(eq(roomDefaultEquipment.roomId, roomId))

      if (equipmentIds.length === 0) {
        return
      }

      await tx.insert(roomDefaultEquipment).values(
        equipmentIds.map((equipmentId) => ({ roomId, equipmentId })),
      )
    })
  } catch (error) {
    // Business-logic outcomes (EQUIPMENT_LOCKED_TO_ANOTHER_ROOM thrown
    // above) already carry their own status code -- rethrow unchanged
    // instead of falling through to the generic 500 below.
    if (error instanceof ServiceError) {
      throw error
    }
    if (isEquipmentExclusivityViolation(error)) {
      serviceError(ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM, 400)
    }
    serviceError('Internal server error', 500)
  }
}
