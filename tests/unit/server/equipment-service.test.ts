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

/**
 * Swap the admin `db` for the NEXT `getDrizzleAdminDb()` call only.
 *
 * The state-driven store always persists what it is told to insert, so a few
 * defensive branches in the service (`INSERT ... RETURNING` coming back with
 * no row) are unreachable through `seed()` / `failNextQuery()` alone. Those
 * outcomes are real at the driver level, just not expressible in an in-memory
 * store, so this narrowly overrides one builder for one call and leaves every
 * other query on the real state-driven mock.
 *
 * Must be called AFTER `loadModule()`: `vi.resetModules()` re-runs the
 * `vi.mock('@/lib/db')` factory, so the service and this helper only share the
 * same mock instance once the module has been (re)loaded.
 */
async function overrideNextAdminDb(partial: Record<string, unknown>): Promise<void> {
  const dbModule = await import('@/lib/db')
  vi.mocked(dbModule.getDrizzleAdminDb).mockReturnValueOnce({
    ...createStatefulDrizzleDb(),
    ...partial,
  } as unknown as ReturnType<typeof dbModule.getDrizzleAdminDb>)
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

  it('returns mapped equipment list on success', async () => {
    seedTable('equipment', [equipmentRow])
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'eq-1', name: 'Projector', description: 'HD projector' })
    expect(result[0].createdAt).toBe('2025-01-01T00:00:00.000Z')
  })

  it('returns empty array when no equipment exists', async () => {
    seedTable('equipment', [])
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result).toEqual([])
  })

  it('throws 500 ServiceError when query throws', async () => {
    failNextQuery({ op: 'select', table: 'equipment' })
    const { listEquipment } = await loadModule()

    await expect(listEquipment()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
  })

  it('maps description: null to null (not empty string)', async () => {
    seedTable('equipment', [{ ...equipmentRow, description: null }])
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result[0].description).toBeNull()
  })
})

// ── createEquipment ───────────────────────────────────────────────────────────
describe('createEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns created equipment on success', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await createEquipment(adminSession, { name: 'Projector', description: 'HD projector' })

    expect(result).toMatchObject({ name: 'Projector', description: 'HD projector' })
    expect(typeof result.id).toBe('string')
    // The row is really persisted by the insert, not just echoed back.
    expect(getRows('equipment')).toHaveLength(1)
    expect(getRows('equipment')[0]).toMatchObject({ name: 'Projector', description: 'HD projector' })
  })

  it('throws 403 when session role is not admin', async () => {
    const { createEquipment } = await loadModule()
    const memberSession = createMemberSession()

    await expect(createEquipment(memberSession, { name: 'Projector' })).rejects.toMatchObject({
      statusCode: 403,
    })
    // The guard runs before any write reaches the database.
    expect(getRows('equipment')).toHaveLength(0)
  })

  it('throws 400 when name is empty string', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, { name: '' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('throws 400 when name is missing (undefined)', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, {})).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 400,
    })
  })

  it('trims whitespace from name', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await createEquipment(adminSession, { name: '  Projector  ' })

    expect(result.name).toBe('Projector')
    expect(getRows('equipment')[0].name).toBe('Projector')

    // Whitespace-only is empty after trim, so it is rejected as a missing name.
    await expect(createEquipment(adminSession, { name: '   ' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 500 when insert throws error', async () => {
    failNextQuery({ op: 'insert', table: 'equipment' })
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, { name: 'Projector' })).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when insert returns empty array (unexpected)', async () => {
    const { createEquipment } = await loadModule()
    await overrideNextAdminDb({
      insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(async () => []) })) })),
    })
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, { name: 'Projector' })).rejects.toMatchObject({
      name: 'ServiceError',
      statusCode: 500,
    })
  })

  it('stores null description when description is falsy', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await createEquipment(adminSession, { name: 'Projector', description: '' })

    expect(result.description).toBeNull()
    expect(getRows('equipment')[0].description).toBeNull()
  })
})

// ── updateEquipment ───────────────────────────────────────────────────────────
describe('updateEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns updated equipment on success', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await updateEquipment(adminSession, 'eq-1', { name: 'Updated' })

    expect(result).toMatchObject({ id: 'eq-1', name: 'Updated' })
    expect(getRows('equipment')[0].name).toBe('Updated')
  })

  it('throws 403 when session role is not admin', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const memberSession = createMemberSession()

    await expect(updateEquipment(memberSession, 'eq-1', { name: 'Updated' })).rejects.toMatchObject({
      statusCode: 403,
    })
    // The guard runs before any write reaches the database.
    expect(getRows('equipment')[0].name).toBe('Projector')
  })

  it('throws 400 when name is explicitly set to empty string', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', { name: '' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 400 when no updatable fields are provided', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', {})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 404 when equipment not found (empty array)', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'nonexistent', { name: 'X' })).rejects.toMatchObject({
      statusCode: 404,
    })
  })

  it('throws 500 when DB throws error', async () => {
    seedTable('equipment', [equipmentRow])
    failNextQuery({ op: 'update', table: 'equipment' })
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', { name: 'X' })).rejects.toMatchObject({ statusCode: 500 })
  })

  it('sets description to null when passed null', async () => {
    seedTable('equipment', [equipmentRow])
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await updateEquipment(adminSession, 'eq-1', { description: null })

    expect(result.description).toBeNull()
    expect(getRows('equipment')[0].description).toBeNull()
  })
})

// ── deleteEquipment ───────────────────────────────────────────────────────────
describe('deleteEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('resolves without error when deletion succeeds', async () => {
    seedTable('equipment', [equipmentRow])
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'eq-1')).resolves.toBeUndefined()
    expect(getRows('equipment')).toHaveLength(0)
  })

  it('throws 403 when session role is not admin', async () => {
    seedTable('equipment', [equipmentRow])
    const { deleteEquipment } = await loadModule()
    const memberSession = createMemberSession()

    await expect(deleteEquipment(memberSession, 'eq-1')).rejects.toMatchObject({ statusCode: 403 })
    // The guard runs before the delete reaches the database.
    expect(getRows('equipment')).toHaveLength(1)
  })

  it('throws 404 when no row was deleted (equipment not found)', async () => {
    seedTable('equipment', [equipmentRow])
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'nonexistent')).rejects.toMatchObject({ statusCode: 404 })
    expect(getRows('equipment')).toHaveLength(1)
  })

  it('throws 500 when DB throws error', async () => {
    seedTable('equipment', [equipmentRow])
    failNextQuery({ op: 'delete', table: 'equipment' })
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'eq-1')).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── getRoomDefaultEquipment ───────────────────────────────────────────────────
describe('getRoomDefaultEquipment', () => {
  beforeEach(() => {
    resetDb()
    vi.clearAllMocks()
  })

  it('returns equipment items for a room', async () => {
    // Real innerJoin between room_default_equipment and equipment now, so
    // both sides of the relation must be seeded (the old sequence-driven
    // mock let the fixture stand in directly for the joined result — the
    // new state-driven mock evaluates the join for real). A third row on
    // another room proves the roomId filter is actually applied.
    seed({
      equipment: [
        equipmentRow,
        { id: 'eq-2', name: 'Cards', description: 'Playing cards', createdAt: new Date('2025-01-02T00:00:00.000Z') },
        { id: 'eq-3', name: 'Other gear', description: null, createdAt: new Date('2025-01-03T00:00:00.000Z') },
      ],
      room_default_equipment: [
        { roomId: 'room-1', equipmentId: 'eq-1' },
        { roomId: 'room-1', equipmentId: 'eq-2' },
        { roomId: 'room-2', equipmentId: 'eq-3' },
      ],
    })
    const { getRoomDefaultEquipment } = await loadModule()

    const result = await getRoomDefaultEquipment('room-1')

    expect(result).toHaveLength(2)
    expect(result.map((row) => row.name).sort()).toEqual(['Cards', 'Projector'])
    expect(result.find((row) => row.id === 'eq-1')).toMatchObject({ id: 'eq-1', name: 'Projector' })
  })

  it('returns empty array when room has no default equipment', async () => {
    seed({ equipment: [equipmentRow], room_default_equipment: [] })
    const { getRoomDefaultEquipment } = await loadModule()

    const result = await getRoomDefaultEquipment('room-1')

    expect(result).toHaveLength(0)
  })

  it('throws 500 when query throws error', async () => {
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
    seedTable('room_default_equipment', [{ roomId: 'room-1', equipmentId: 'eq-1' }])
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', [])).resolves.toBeUndefined()
    expect(getRows('room_default_equipment')).toHaveLength(0)
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
