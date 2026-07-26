// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createStatefulDrizzleDb,
  createAdminSession,
  createMemberSession,
  resetDb,
  seed,
  seedTable,
  getRows,
  failNextQuery,
  createMockServiceError,
  MockServiceError,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createStatefulDrizzleDb()),
  getDrizzleAdminDb: vi.fn(() => createStatefulDrizzleDb()),
}))

vi.mock('@/lib/server/shared/service-error', () => ({
  ServiceError: MockServiceError,
  serviceError: createMockServiceError(),
}))

// ── Re-import helper (reset module cache between tests) ────────────────────────
async function loadModule() {
  vi.resetModules()
  return import('@/lib/server/equipment/equipment-service')
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
const equipmentRow = {
  id: 'eq-1',
  name: 'Projector',
  description: 'HD projector',
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
}

// ── listEquipment ─────────────────────────────────────────────────────────────
describe('listEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns all equipment rows', async () => {
    seedTable('equipment', [equipmentRow])
    const { listEquipment } = await loadModule()
    const result = await listEquipment()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Projector')
  })

  it('returns an empty array when no equipment exists', async () => {
    seedTable('equipment', [])
    const { listEquipment } = await loadModule()
    const result = await listEquipment()
    expect(result).toEqual([])
  })

  it('throws 500 when the database query fails', async () => {
    failNextQuery({ op: 'select', table: 'equipment' })
    const { listEquipment } = await loadModule()
    await expect(listEquipment()).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── createEquipment ───────────────────────────────────────────────────────────
describe('createEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('inserts and returns the new equipment', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()
    const result = await createEquipment(adminSession, { name: 'Projector' })
    expect(result).toMatchObject({ name: 'Projector' })
    expect(getRows('equipment')).toHaveLength(1)
  })

  it('throws 403 when session role is not admin', async () => {
    const { createEquipment } = await loadModule()
    const memberSession = createMemberSession()
    await expect(createEquipment(memberSession, { name: 'Projector' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('throws 500 when the database insert fails', async () => {
    failNextQuery({ op: 'insert', table: 'equipment' })
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()
    await expect(createEquipment(adminSession, { name: 'Projector' })).rejects.toMatchObject({
      statusCode: 500,
    })
  })
})

// ── updateEquipment ───────────────────────────────────────────────────────────
describe('updateEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('updates and returns the equipment', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()
    const result = await updateEquipment(adminSession, 'eq-1', { name: 'Updated Projector' })
    expect(result).toMatchObject({ name: 'Updated Projector' })
  })

  it('throws 403 when session role is not admin', async () => {
    const { updateEquipment } = await loadModule()
    const memberSession = createMemberSession()
    await expect(updateEquipment(memberSession, 'eq-1', { name: 'Updated' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('throws 500 when the database update fails', async () => {
    seedTable('equipment', [equipmentRow])
    failNextQuery({ op: 'update', table: 'equipment' })
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()
    await expect(updateEquipment(adminSession, 'eq-1', { name: 'Updated' })).rejects.toMatchObject({
      statusCode: 500,
    })
  })
})

// ── deleteEquipment ───────────────────────────────────────────────────────────
describe('deleteEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('deletes equipment and returns void', async () => {
    seedTable('equipment', [equipmentRow])
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()
    await expect(deleteEquipment(adminSession, 'eq-1')).resolves.toBeUndefined()
    expect(getRows('equipment')).toHaveLength(0)
  })

  it('throws 403 when session role is not admin', async () => {
    const { deleteEquipment } = await loadModule()
    const memberSession = createMemberSession()
    await expect(deleteEquipment(memberSession, 'eq-1')).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('throws 500 when the database delete fails', async () => {
    seedTable('equipment', [equipmentRow])
    failNextQuery({ op: 'delete', table: 'equipment' })
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()
    await expect(deleteEquipment(adminSession, 'eq-1')).rejects.toMatchObject({
      statusCode: 500,
    })
  })
})

// ── getRoomDefaultEquipment ───────────────────────────────────────────────────
describe('getRoomDefaultEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns equipment for a room', async () => {
    // Real innerJoin between room_default_equipment and equipment now, so
    // both sides of the relation must be seeded (the old sequence-driven
    // mock let the fixture stand in directly for the joined result — the
    // new state-driven mock evaluates the join for real).
    seed({
      equipment: [
        { id: 'eq-1', name: 'Dice Set', description: 'Standard dice', createdAt: new Date('2025-01-01') },
        { id: 'eq-2', name: 'Cards', description: 'Playing cards', createdAt: new Date('2025-01-02') },
      ],
      room_default_equipment: [
        { roomId: 'room-1', equipmentId: 'eq-1' },
        { roomId: 'room-1', equipmentId: 'eq-2' },
      ],
    })
    const { getRoomDefaultEquipment } = await loadModule()
    const result = await getRoomDefaultEquipment('room-1')
    expect(result).toHaveLength(2)
    expect(result.map((row) => row.name).sort()).toEqual(['Cards', 'Dice Set'])
  })

  it('returns an empty array when room has no defaults', async () => {
    seed({ equipment: [], room_default_equipment: [] })
    const { getRoomDefaultEquipment } = await loadModule()
    const result = await getRoomDefaultEquipment('room-1')
    expect(result).toEqual([])
  })

  it('throws 500 when the database query fails', async () => {
    failNextQuery({ op: 'select', table: 'room_default_equipment' })
    const { getRoomDefaultEquipment } = await loadModule()
    await expect(getRoomDefaultEquipment('room-1')).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── setRoomDefaultEquipment ───────────────────────────────────────────────────
describe('setRoomDefaultEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
    seed({ equipment: [{ id: 'eq-1', name: 'Projector', description: null, createdAt: new Date() }] })
  })

  it('clears defaults when equipmentIds is empty', async () => {
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', [])).resolves.toBeUndefined()
  })

  it('inserts new defaults when no conflicts exist', async () => {
    seedTable('room_default_equipment', [])
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1', 'eq-2'])).resolves.toBeUndefined()
    expect(getRows('room_default_equipment')).toHaveLength(2)
  })

  it('throws 400 EQUIPMENT_LOCKED_TO_ANOTHER_ROOM when equipment belongs to another room', async () => {
    // Setup: equipment eq-1 is locked to room-99
    seedTable('room_default_equipment', [{ roomId: 'room-99', equipmentId: 'eq-1' }])

    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
      message: 'EQUIPMENT_LOCKED_TO_ANOTHER_ROOM',
    })
  })

  it('allows re-assigning equipment already locked to the same room', async () => {
    // Setup: equipment eq-1 is already assigned to room-1
    seedTable('room_default_equipment', [{ roomId: 'room-1', equipmentId: 'eq-1' }])

    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Same room — should not be treated as a conflict
    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).resolves.toBeUndefined()
  })

  it('throws 500 when the conflict-check query fails', async () => {
    seedTable('room_default_equipment', [])
    failNextQuery({ op: 'select', table: 'room_default_equipment' })
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the delete step fails', async () => {
    seedTable('room_default_equipment', [])
    failNextQuery({ op: 'delete', table: 'room_default_equipment' })
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the insert step fails', async () => {
    seedTable('room_default_equipment', [])
    failNextQuery({ op: 'insert', table: 'room_default_equipment' })
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('rejects INSERT inside transaction and rolls back (data-loss prevention)', async () => {
    // This test verifies transaction rollback semantics: if INSERT fails inside
    // the transaction, the DELETE that preceded it should not persist.
    //
    // Setup: room-1 already has equipment 'eq-original' assigned
    // Action: try to replace with 'eq-1' (INSERT fails)
    // Verification: the original equipment is still there after rollback

    const roomEquipmentTable = 'room_default_equipment'
    seed({
      equipment: [
        { id: 'eq-1', name: 'Projector', description: null, createdAt: new Date() },
        { id: 'eq-original', name: 'Original', description: null, createdAt: new Date() },
      ],
      room_default_equipment: [{ roomId: 'room-1', equipmentId: 'eq-original' }],
    })

    failNextQuery({ op: 'insert', table: roomEquipmentTable, error: new Error('insert failed for test') })

    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Try to set new defaults, but INSERT fails inside the transaction
    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
      statusCode: 500,
    })

    // Verify rollback: the original equipment is still there
    // The DELETE inside the failed transaction did not commit
    const stateAfterRollback = getRows(roomEquipmentTable)
    expect(stateAfterRollback).toEqual([{ roomId: 'room-1', equipmentId: 'eq-original' }])
  })

  it('translates unique-constraint violation (concurrent race) to 400 EQUIPMENT_LOCKED_TO_ANOTHER_ROOM', async () => {
    // This test simulates two concurrent admins both passing the exclusivity
    // check (SELECT finds no conflict), then both trying to INSERT the same
    // equipment. One succeeds, the other's INSERT throws a 23505
    // unique-constraint violation. The service should translate this into
    // the existing business error instead of surfacing a raw 500.
    seedTable('room_default_equipment', [])
    // failNextQuery only preserves Error instances verbatim (a plain object
    // spec is stringified into a generic mock error), so the injected error
    // must itself be an Error carrying the pg-style `code`/`constraint` shape
    // isEquipmentExclusivityViolation() duck-types against.
    failNextQuery({
      op: 'insert',
      table: 'room_default_equipment',
      error: Object.assign(new Error('unique violation'), {
        code: '23505',
        constraint: 'room_default_equipment_equipment_id_unique',
      }),
    })
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
      message: 'EQUIPMENT_LOCKED_TO_ANOTHER_ROOM',
    })
  })

  it('does NOT translate a unique-constraint with different constraint name to 400', async () => {
    // Negative test: isEquipmentExclusivityViolation should only match the
    // specific constraint, not all unique violations. A different constraint
    // name should fall through to the generic 500 path.
    seedTable('room_default_equipment', [])
    // Simulate a different unique-constraint violation (e.g., some other table)
    failNextQuery({
      op: 'insert',
      table: 'room_default_equipment',
      error: Object.assign(new Error('unique violation'), {
        code: '23505',
        constraint: 'some_other_unique_constraint',
      }),
    })
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500, // generic error, not 400
      message: 'Internal server error',
    })
  })

  describe('Member-role session denial for requireAdminSession', () => {
    it('createEquipment throws 403 when session role is member', async () => {
      const { createEquipment } = await loadModule()
      const memberSession = createMemberSession()
      await expect(createEquipment(memberSession, { name: 'Projector' })).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 403,
      })
    })

    it('updateEquipment throws 403 when session role is member', async () => {
      const { updateEquipment } = await loadModule()
      const memberSession = createMemberSession()
      await expect(updateEquipment(memberSession, 'eq-1', { name: 'Updated' })).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 403,
      })
    })

    it('deleteEquipment throws 403 when session role is member', async () => {
      const { deleteEquipment } = await loadModule()
      const memberSession = createMemberSession()
      await expect(deleteEquipment(memberSession, 'eq-1')).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 403,
      })
    })

    it('setRoomDefaultEquipment throws 403 when session role is member', async () => {
      const { setRoomDefaultEquipment } = await loadModule()
      const memberSession = createMemberSession()
      await expect(setRoomDefaultEquipment(memberSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
        name: 'ServiceError',
        statusCode: 403,
      })
    })
  })
})
