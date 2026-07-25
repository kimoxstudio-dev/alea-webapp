// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

type SessionUser = { id: string; role: 'admin' | 'member'; email?: string }

function createAdminSession(): SessionUser {
  return { id: 'admin-1', role: 'admin', email: 'admin@example.com' }
}

function createMemberSession(): SessionUser {
  return { id: 'member-1', role: 'member', email: 'member@example.com' }
}

// ── Mock state ─────────────────────────────────────────────────────────────────
// These mocks return promises that resolve/reject based on test setup
const selectMock = vi.fn()
const insertMock = vi.fn()
const updateMock = vi.fn()
const deleteMock = vi.fn()

// Create a mock that can be both awaited and has a .returning() method
function createInsertValuesMock() {
  return {
    returning: vi.fn(() => insertMock()),
    // Allow awaiting on the object itself (for cases without .returning())
    then: (onFulfilled: any, onRejected: any) => insertMock().then(onFulfilled, onRejected),
    catch: (onRejected: any) => insertMock().catch(onRejected),
  } as any
}

function createDeleteWhereReturningMock() {
  return {
    returning: vi.fn(() => deleteMock()),
    // Also allow awaiting directly
    then: (onFulfilled: any, onRejected: any) => deleteMock().then(onFulfilled, onRejected),
    catch: (onRejected: any) => deleteMock().catch(onRejected),
  } as any
}

function createSelectWhereMock() {
  return vi.fn(() => selectMock())
}

// Helper to create a chainable Drizzle-like query builder
function createDrizzleQueryBuilder() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        orderBy: createSelectWhereMock(),
        innerJoin: vi.fn(() => ({
          where: createSelectWhereMock(),
        })),
        where: createSelectWhereMock(),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => createInsertValuesMock()),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(() => updateMock()),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => createDeleteWhereReturningMock()),
    })),
  }
}

vi.mock('@/lib/db', () => ({
  getDrizzleDb: vi.fn(() => createDrizzleQueryBuilder()),
  getDrizzleAdminDb: vi.fn(() => createDrizzleQueryBuilder()),
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
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns mapped equipment list on success', async () => {
    selectMock.mockReturnValue(Promise.resolve([equipmentRow]))
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'eq-1', name: 'Projector', description: 'HD projector' })
  })

  it('returns empty array when no equipment exists', async () => {
    selectMock.mockReturnValue(Promise.resolve([]))
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result).toEqual([])
  })

  it('throws 500 ServiceError when query throws', async () => {
    selectMock.mockReturnValue(Promise.reject(new Error('DB error')))
    const { listEquipment } = await loadModule()

    await expect(listEquipment()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
  })

  it('maps description: null to null (not empty string)', async () => {
    selectMock.mockReturnValue(Promise.resolve([{ ...equipmentRow, description: null }]))
    const { listEquipment } = await loadModule()

    const result = await listEquipment()

    expect(result[0].description).toBeNull()
  })
})

// ── createEquipment ───────────────────────────────────────────────────────────
describe('createEquipment', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    insertMock.mockReturnValue(Promise.resolve([equipmentRow]))
  })

  it('returns created equipment on success', async () => {
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await createEquipment(adminSession, { name: 'Projector', description: 'HD projector' })

    expect(result).toMatchObject({ id: 'eq-1', name: 'Projector' })
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
    insertMock.mockReturnValue(Promise.resolve([{ ...equipmentRow, name: 'Projector' }]))
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Should not throw — whitespace-only is actually empty after trim
    await expect(createEquipment(adminSession, { name: '   ' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 500 when insert throws error', async () => {
    insertMock.mockReturnValue(Promise.reject(new Error('insert failed')))
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, { name: 'Projector' })).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when insert returns empty array (unexpected)', async () => {
    insertMock.mockReturnValue(Promise.resolve([]))
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(createEquipment(adminSession, { name: 'Projector' })).rejects.toMatchObject({ statusCode: 500 })
  })

  it('stores null description when description is falsy', async () => {
    insertMock.mockReturnValue(Promise.resolve([{ ...equipmentRow, description: null }]))
    const { createEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await createEquipment(adminSession, { name: 'Projector', description: '' })

    expect(result.description).toBeNull()
  })
})

// ── updateEquipment ───────────────────────────────────────────────────────────
describe('updateEquipment', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    updateMock.mockReturnValue(Promise.resolve([{ ...equipmentRow, name: 'Updated' }]))
  })

  it('returns updated equipment on success', async () => {
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await updateEquipment(adminSession, 'eq-1', { name: 'Updated' })

    expect(result).toMatchObject({ name: 'Updated' })
  })

  it('throws 400 when name is explicitly set to empty string', async () => {
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', { name: '' })).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 400 when no updatable fields are provided', async () => {
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', {})).rejects.toMatchObject({ statusCode: 400 })
  })

  it('throws 404 when equipment not found (empty array)', async () => {
    updateMock.mockReturnValue(Promise.resolve([]))
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'nonexistent', { name: 'X' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 500 when DB throws error', async () => {
    updateMock.mockReturnValue(Promise.reject(new Error('DB error')))
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(updateEquipment(adminSession, 'eq-1', { name: 'X' })).rejects.toMatchObject({ statusCode: 500 })
  })

  it('sets description to null when passed null', async () => {
    updateMock.mockReturnValue(Promise.resolve([{ ...equipmentRow, description: null }]))
    const { updateEquipment } = await loadModule()
    const adminSession = createAdminSession()

    const result = await updateEquipment(adminSession, 'eq-1', { description: null })

    expect(result.description).toBeNull()
  })
})

// ── deleteEquipment ───────────────────────────────────────────────────────────
describe('deleteEquipment', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    deleteMock.mockReturnValue(Promise.resolve([{ id: 'eq-1' }]))
  })

  it('resolves without error when deletion succeeds', async () => {
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'eq-1')).resolves.toBeUndefined()
  })

  it('throws 404 when no row was deleted (equipment not found)', async () => {
    deleteMock.mockReturnValue(Promise.resolve([]))
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'nonexistent')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('throws 500 when DB throws error', async () => {
    deleteMock.mockReturnValue(Promise.reject(new Error('constraint violation')))
    const { deleteEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(deleteEquipment(adminSession, 'eq-1')).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── getRoomDefaultEquipment ───────────────────────────────────────────────────
describe('getRoomDefaultEquipment', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns equipment items for a room', async () => {
    selectMock.mockReturnValue(Promise.resolve([equipmentRow]))
    const { getRoomDefaultEquipment } = await loadModule()

    const result = await getRoomDefaultEquipment('room-1')

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'eq-1', name: 'Projector' })
  })

  it('returns empty array when room has no default equipment', async () => {
    selectMock.mockReturnValue(Promise.resolve([]))
    const { getRoomDefaultEquipment } = await loadModule()

    const result = await getRoomDefaultEquipment('room-1')

    expect(result).toHaveLength(0)
  })

  it('throws 500 when query throws error', async () => {
    selectMock.mockReturnValue(Promise.reject(new Error('RLS denied')))
    const { getRoomDefaultEquipment } = await loadModule()

    await expect(getRoomDefaultEquipment('room-1')).rejects.toMatchObject({ statusCode: 500 })
  })
})

// ── setRoomDefaultEquipment ───────────────────────────────────────────────────
describe('setRoomDefaultEquipment', () => {
  beforeEach(() => {
    vi.resetModules()
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
    selectMock.mockReturnValue(Promise.resolve([]))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1', 'eq-2'])).resolves.toBeUndefined()
    expect(insertMock).toHaveBeenCalled()
  })

  it('throws 400 EQUIPMENT_LOCKED_TO_ANOTHER_ROOM when equipment belongs to another room', async () => {
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
    selectMock.mockReturnValue(Promise.resolve([{ equipmentId: 'eq-1', roomId: 'room-1' }]))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    // Same room — should not be treated as a conflict
    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).resolves.toBeUndefined()
  })

  it('throws 500 when the conflict-check query fails', async () => {
    selectMock.mockReturnValue(Promise.reject(new Error('DB failure')))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the delete step fails', async () => {
    selectMock.mockReturnValue(Promise.resolve([]))
    deleteMock.mockReturnValue(Promise.reject(new Error('delete failed')))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
  })

  it('throws 500 when the insert step fails', async () => {
    selectMock.mockReturnValue(Promise.resolve([]))
    insertMock.mockReturnValue(Promise.reject(new Error('insert failed')))
    const { setRoomDefaultEquipment } = await loadModule()
    const adminSession = createAdminSession()

    await expect(setRoomDefaultEquipment(adminSession, 'room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
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
