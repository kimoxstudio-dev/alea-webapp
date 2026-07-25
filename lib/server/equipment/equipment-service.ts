import { asc, eq, inArray } from 'drizzle-orm'
import { getDrizzleAdminDb, getDrizzleDb } from '@/lib/db'
import { equipment, roomDefaultEquipment } from '@/lib/db/schema'
import { serviceError } from '@/lib/server/shared/service-error'
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

  if (equipmentIds.length > 0) {
    // Enforce exclusivity: reject any equipment already locked to a different room
    const existingDefaults = await runQuery(
      db
        .select({
          equipmentId: roomDefaultEquipment.equipmentId,
          roomId: roomDefaultEquipment.roomId,
        })
        .from(roomDefaultEquipment)
        .where(inArray(roomDefaultEquipment.equipmentId, equipmentIds)),
    )

    const conflicts = existingDefaults.filter((row) => row.roomId !== roomId)

    if (conflicts.length > 0) {
      serviceError(ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM, 400)
    }
  }

  // Delete existing defaults for this room
  await runQuery(db.delete(roomDefaultEquipment).where(eq(roomDefaultEquipment.roomId, roomId)))

  if (equipmentIds.length === 0) {
    return
  }

  await runQuery(
    db.insert(roomDefaultEquipment).values(
      equipmentIds.map((equipmentId) => ({ roomId, equipmentId })),
    ),
  )
}
