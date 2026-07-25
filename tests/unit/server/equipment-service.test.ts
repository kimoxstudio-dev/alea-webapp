// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTransactionAwareMockBuilder,
  createAdminSession,
  createMemberSession,
  selectMock,
  insertMock,
  updateMock,
  deleteMock,
  resetFixtures,
  setFixture,
  getFixtureState,
  createMockServiceError,
  MockServiceError,
} from '@/tests/unit/mocks/drizzle-mock'

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createTransactionAwareMockBuilder()),
  getDrizzleAdminDb: vi.fn(() => createTransactionAwareMockBuilder()),
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('returns all equipment rows', async () => {
    setFixture('equipment', [equipmentRow])
    const { listEquipment } = await loadModule()
    const result = await listEquipment()
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('Projector')
  })

  it('returns an empty array when no equipment exists', async () => {
    setFixture('equipment', [])
    const { listEquipment } = await loadModule()
    const result = await listEquipment()
    expect(result).toEqual([])
  })

  it('throws 500 when the database query fails', async () => {
    selectMock.mockRejectedValueOnce(new Error('DB error'))
    const { listEquipment } = await loadModule()
    await expect(listEquipment()).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── createEquipment ───────────────────────────────────────────────────────────
describe('createEquipment', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
  })

  it('inserts and returns the new equipment', async () => {
    const newEquipment = { id: 'eq-new-1', name: 'Projector', createdAt: new Date() }
    insertMock.mockResolvedValueOnce([newEquipment])
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()
    const result = await createEquipment(adminSession, { name: 'Projector' })
    expect(result).toMatchObject({ name: 'Projector' })
  })

  it('throws 403 when session role is not admin', async () => {
    const { createEquipment } = await loadModule()
    const memberSession = createMemberSession()
    await expect(createEquipment(memberSession, { name: 'Projector' })).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('throws 500 when the database insert fails', async () => {
    insertMock.mockRejectedValueOnce(new Error('insert failed'))
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('updates and returns the equipment', async () => {
    const updatedEquipment = { id: 'eq-1', name: 'Updated Projector', createdAt: new Date() }
    updateMock.mockResolvedValueOnce([updatedEquipment])
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
    updateMock.mockRejectedValueOnce(new Error('update failed'))
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('deletes equipment and returns void', async () => {
    deleteMock.mockResolvedValueOnce([equipmentRow])
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()
    await expect(deleteEquipment(adminSession, 'eq-1')).resolves.toBeUndefined()
  })

  it('throws 403 when session role is not admin', async () => {
    const { deleteEquipment } = await loadModule()
    const memberSession = createMemberSession()
    await expect(deleteEquipment(memberSession, 'eq-1')).rejects.toMatchObject({
      statusCode: 403,
    })
  })

  it('throws 500 when the database delete fails', async () => {
    deleteMock.mockRejectedValueOnce(new Error('delete failed'))
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
    resetFixtures()
    vi.clearAllMocks()
  })

  it('returns equipment for a room', async () => {
    // The query does an innerJoin between room_default_equipment and equipment,
    // so the fixture should return the joined result with equipment fields
    const roomEquipment = [
      { id: 'eq-1', name: 'Dice Set', description: 'Standard dice', createdAt: new Date('2025-01-01') },
      { id: 'eq-2', name: 'Cards', description: 'Playing cards', createdAt: new Date('2025-01-02') },
    ]
    setFixture('room_default_equipment', roomEquipment)
    const { getRoomDefaultEquipment } = await loadModule()
    const result = await getRoomDefaultEquipment('room-1')
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('Dice Set')
  })

  it('returns an empty array when room has no defaults', async () => {
    setFixture('room_default_equipment', [])
    const { getRoomDefaultEquipment } = await loadModule()
    const result = await getRoomDefaultEquipment('room-1')
    expect(result).toEqual([])
  })

  it('throws 500 when the database query fails', async () => {
    selectMock.mockRejectedValueOnce(new Error('DB error'))
    const { getRoomDefaultEquipment } = await loadModule()
    await expect(getRoomDefaultEquipment('room-1')).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── setRoomDefaultEquipment ───────────────────────────────────────────────────
describe('setRoomDefaultEquipment', () => {
  beforeEach(() => {
    resetFixtures()
    vi.clearAllMocks()
    selectMock.mockReturnValue(Promise.resolve([]))
    deleteMock.mockReturnValue(Promise.resolve([]))
    insertMock.mockReturnValue(Promise.resolve([]))
  })

  it('clears defaults when equipmentIds is empty', async () => {
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', [])).resolves.toBeUndefined()
  })

  it('inserts new defaults when no conflicts exist', async () => {
    setFixture('room_default_equipment', [])
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1', 'eq-2'])).resolves.toBeUndefined()
    expect(insertMock).toHaveBeenCalled()
  })

  it('throws 400 EQUIPMENT_LOCKED_TO_ANOTHER_ROOM when equipment belongs to another room', async () => {
    // Setup: equipment eq-1 is locked to room-99
    setFixture('room_default_equipment', [{ id: 'rde-conflict', equipmentId: 'eq-1', roomId: 'room-99' }])
    // Clear the global selectMock so fixture is used instead
    selectMock.mockClear()
    selectMock.mockReturnValue(Promise.resolve([{ equipmentId: 'eq-1', roomId: 'room-99' }]))
    
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
    setFixture('room_default_equipment', [{ id: 'rde-same-room', equipmentId: 'eq-1', roomId: 'room-1' }])
    
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Same room — should not be treated as a conflict
    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).resolves.toBeUndefined()
  })

  it('throws 500 when the conflict-check query fails', async () => {
    setFixture('room_default_equipment', [])
    selectMock.mockImplementation(() => Promise.reject(new Error('DB failure')))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the delete step fails', async () => {
    setFixture('room_default_equipment', [])
    deleteMock.mockImplementation(() => Promise.reject(new Error('delete failed')))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the insert step fails', async () => {
    setFixture('room_default_equipment', [])
    insertMock.mockImplementation(() => Promise.reject(new Error('insert failed')))
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
    setFixture(roomEquipmentTable, [{ id: 'rde-existing', roomId: 'room-1', equipmentId: 'eq-original' }])
    
    selectMock.mockReturnValue(Promise.resolve([])) // no conflicts
    insertMock.mockImplementation(() => Promise.reject(new Error('insert failed for test')))
    
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Try to set new defaults, but INSERT fails inside the transaction
    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({
      statusCode: 500,
    })
    
    // Verify rollback: the original equipment is still there
    // The DELETE inside the failed transaction did not commit
    const stateAfterRollback = getFixtureState(roomEquipmentTable)
    expect(stateAfterRollback).toEqual([{ id: 'rde-existing', roomId: 'room-1', equipmentId: 'eq-original' }])
  })

  it('translates unique-constraint violation (concurrent race) to 400 EQUIPMENT_LOCKED_TO_ANOTHER_ROOM', async () => {
    // This test simulates two concurrent admins both passing the exclusivity
    // check (SELECT finds no conflict), then both trying to INSERT the same
    // equipment. One succeeds, the other's INSERT throws a 23505
    // unique-constraint violation. The service should translate this into
    // the existing business error instead of surfacing a raw 500.
    setFixture('room_default_equipment', [])
    deleteMock.mockReturnValue(Promise.resolve([])) // delete succeeds
    // Simulate the unique-constraint violation from Postgres/node-postgres
    insertMock.mockImplementation(() =>
      Promise.reject({
        code: '23505',
        constraint: 'room_default_equipment_equipment_id_unique',
      }),
    )
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
    setFixture('room_default_equipment', [])
    deleteMock.mockReturnValue(Promise.resolve([]))
    // Simulate a different unique-constraint violation (e.g., some other table)
    insertMock.mockImplementation(() =>
      Promise.reject({
        code: '23505',
        constraint: 'some_other_unique_constraint',
      }),
    )
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
