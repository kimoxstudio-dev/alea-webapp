import { sql } from '@/lib/db/client'
import { serviceError } from '@/lib/server/service-error'
import { ERROR_CODES } from '@/lib/types/error-codes'
import type { Equipment } from '@/lib/types'

export type { Equipment }

type EquipmentRow = {
  id: string
  name: string
  description: string | null
  created_at: string | Date
}

type RoomDefaultEquipmentRow = {
  equipment_id: string
  room_id: string
}

function toEquipment(row: EquipmentRow): Equipment {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

export async function listEquipment(): Promise<Equipment[]> {
  let rows: EquipmentRow[]
  try {
    rows = await sql`
      SELECT id, name, description, created_at
      FROM equipment
      ORDER BY name ASC
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return rows.map(toEquipment)
}

export async function createEquipment(body: { name?: unknown; description?: unknown }): Promise<Equipment> {
  const name = String(body.name ?? '').trim()
  if (!name) {
    serviceError('Equipment name is required', 400)
  }

  const description = body.description ? String(body.description) : null
  let rows: EquipmentRow[]
  try {
    rows = await sql`
      INSERT INTO equipment (name, description)
      VALUES (${name}, ${description})
      RETURNING id, name, description, created_at
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const equipment = rows[0]
  if (!equipment) {
    serviceError('Internal server error', 500)
  }

  return toEquipment(equipment)
}

export async function updateEquipment(
  id: string,
  body: { name?: unknown; description?: unknown },
): Promise<Equipment> {
  let name: string | undefined
  if (body.name !== undefined) {
    name = String(body.name).trim()
    if (!name) {
      serviceError('Equipment name cannot be empty', 400)
    }
  }

  const description = body.description === undefined
    ? undefined
    : body.description === null
      ? null
      : String(body.description) || null

  if (name === undefined && description === undefined) {
    serviceError('No updatable fields provided', 400)
  }

  let rows: EquipmentRow[]
  try {
    rows = await sql`
      UPDATE equipment
      SET
        name = CASE WHEN ${name === undefined} THEN name ELSE ${name ?? null} END,
        description = CASE WHEN ${description === undefined} THEN description ELSE ${description ?? null} END
      WHERE id = ${id}
      RETURNING id, name, description, created_at
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  const equipment = rows[0]
  if (!equipment) {
    serviceError('Equipment not found', 404)
  }

  return toEquipment(equipment)
}

export async function deleteEquipment(id: string): Promise<void> {
  let rows: Array<{ id: string }>
  try {
    rows = await sql`
      DELETE FROM equipment
      WHERE id = ${id}
      RETURNING id
    ` as Array<{ id: string }>
  } catch {
    serviceError('Internal server error', 500)
  }

  if (!rows[0]) {
    serviceError('Equipment not found', 404)
  }
}

export async function getRoomDefaultEquipment(roomId: string): Promise<Equipment[]> {
  let rows: EquipmentRow[]
  try {
    rows = await sql`
      SELECT equipment.id, equipment.name, equipment.description, equipment.created_at
      FROM room_default_equipment
      INNER JOIN equipment ON equipment.id = room_default_equipment.equipment_id
      WHERE room_default_equipment.room_id = ${roomId}
    ` as EquipmentRow[]
  } catch {
    serviceError('Internal server error', 500)
  }

  return rows.map(toEquipment)
}

export async function setRoomDefaultEquipment(roomId: string, equipmentIds: string[]): Promise<void> {
  if (equipmentIds.length > 0) {
    let existingDefaults: RoomDefaultEquipmentRow[]
    try {
      existingDefaults = await sql`
        SELECT equipment_id, room_id
        FROM room_default_equipment
        WHERE equipment_id = ANY(${equipmentIds})
      ` as RoomDefaultEquipmentRow[]
    } catch {
      serviceError('Internal server error', 500)
    }

    if (existingDefaults.some((row) => row.room_id !== roomId)) {
      serviceError(ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM, 400)
    }
  }

  try {
    await sql`
      DELETE FROM room_default_equipment
      WHERE room_id = ${roomId}
    `
  } catch {
    serviceError('Internal server error', 500)
  }

  if (equipmentIds.length === 0) {
    return
  }

  try {
    await sql`
      INSERT INTO room_default_equipment (room_id, equipment_id)
      SELECT ${roomId}::uuid, UNNEST(${equipmentIds}::uuid[])
    `
  } catch {
    serviceError('Internal server error', 500)
  }
}
