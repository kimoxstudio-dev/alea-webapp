// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ERROR_CODES } from '@/lib/types/error-codes'
import {
  createSqlMock,
  hasExactOrderBy,
  hasExactSelectColumns,
  whereColumnHasOperator,
  whereConditionCount,
  whereHasColumn,
} from '../helpers/sql-mock'

const sqlMock = createSqlMock()

vi.mock('@/lib/db/client', () => ({ sql: sqlMock.sql }))

async function loadService() {
  vi.resetModules()
  return import('@/lib/server/equipment-service')
}

const equipmentRow = {
  id: 'eq-1',
  name: 'Projector',
  description: 'HD projector',
  created_at: '2025-01-01T00:00:00.000Z',
}

function addEquipmentListHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT equipment ordered by name',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'equipment' &&
      stmt.whereClause === null &&
      hasExactSelectColumns(stmt, 'id, name, description, created_at') &&
      hasExactOrderBy(stmt, 'name asc'),
    respond,
  })
}

function addRoomDefaultsHandler(respond: () => unknown) {
  sqlMock.addHandler({
    name: 'SELECT equipment joined to room defaults',
    verb: 'select',
    match: (stmt) =>
      stmt.table === 'room_default_equipment' &&
      whereColumnHasOperator(stmt, 'room_id', '=') &&
      whereConditionCount(stmt) === 1 &&
      hasExactSelectColumns(stmt, 'equipment.id, equipment.name, equipment.description, equipment.created_at'),
    respond,
  })
}

describe('equipment-service (Neon raw SQL)', () => {
  beforeEach(() => {
    vi.resetModules()
    sqlMock.reset()
  })

  describe('listEquipment', () => {
    it('maps ordered rows', async () => {
      addEquipmentListHandler(() => [equipmentRow, { ...equipmentRow, id: 'eq-2', name: 'Speaker', description: null }])

      const { listEquipment } = await loadService()
      await expect(listEquipment()).resolves.toEqual([
        { id: 'eq-1', name: 'Projector', description: 'HD projector', createdAt: equipmentRow.created_at },
        { id: 'eq-2', name: 'Speaker', description: null, createdAt: equipmentRow.created_at },
      ])
    })

    it('maps a database failure to 500', async () => {
      addEquipmentListHandler(() => { throw new Error('connection reset') })

      const { listEquipment } = await loadService()
      await expect(listEquipment()).rejects.toMatchObject({ name: 'ServiceError', statusCode: 500 })
    })

    it('normalizes Neon timestamptz values to ISO strings', async () => {
      const createdAt = new Date(equipmentRow.created_at)
      addEquipmentListHandler(() => [{ ...equipmentRow, created_at: createdAt }])

      const { listEquipment } = await loadService()
      await expect(listEquipment()).resolves.toEqual([
        { id: 'eq-1', name: 'Projector', description: 'HD projector', createdAt: createdAt.toISOString() },
      ])
    })
  })

  describe('createEquipment', () => {
    function addInsertHandler(respond: (values: unknown[]) => unknown) {
      sqlMock.addHandler({
        name: 'INSERT equipment returning row',
        verb: 'insert',
        match: (stmt) => stmt.table === 'equipment' && stmt.returning,
        respond: (stmt) => respond(stmt.values),
      })
    }

    it('validates a non-empty name before querying', async () => {
      const { createEquipment } = await loadService()
      await expect(createEquipment({ name: '  ' })).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('inserts normalized values and maps the returned row', async () => {
      addInsertHandler(([name, description]) => [{ ...equipmentRow, name, description }])

      const { createEquipment } = await loadService()
      await expect(createEquipment({ name: ' Projector ', description: '' })).resolves.toMatchObject({
        id: 'eq-1', name: 'Projector', description: null,
      })
    })

    it('maps insert failure and missing RETURNING row to 500', async () => {
      addInsertHandler(() => { throw new Error('connection reset') })
      const { createEquipment } = await loadService()
      await expect(createEquipment({ name: 'Projector' })).rejects.toMatchObject({ statusCode: 500 })

      sqlMock.reset()
      addInsertHandler(() => [])
      await expect(createEquipment({ name: 'Projector' })).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('updateEquipment', () => {
    function addUpdateHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'UPDATE equipment by id returning row',
        verb: 'update',
        match: (stmt) => stmt.table === 'equipment' && stmt.returning && whereColumnHasOperator(stmt, 'id', '=') && whereConditionCount(stmt) === 1,
        respond,
      })
    }

    it('rejects an empty name and an empty update before querying', async () => {
      const { updateEquipment } = await loadService()
      await expect(updateEquipment('eq-1', { name: '' })).rejects.toMatchObject({ statusCode: 400 })
      await expect(updateEquipment('eq-1', {})).rejects.toMatchObject({ statusCode: 400 })
      expect(sqlMock.sql).not.toHaveBeenCalled()
    })

    it('preserves omitted fields and clears an explicit empty description', async () => {
      addUpdateHandler(() => [{ ...equipmentRow, description: null }])

      const { updateEquipment } = await loadService()
      await expect(updateEquipment('eq-1', { description: '' })).resolves.toMatchObject({ description: null })
    })

    it('maps database failures to 500 and missing rows to 404', async () => {
      addUpdateHandler(() => { throw new Error('connection reset') })
      const { updateEquipment } = await loadService()
      await expect(updateEquipment('eq-1', { name: 'Speaker' })).rejects.toMatchObject({ statusCode: 500 })

      sqlMock.reset()
      addUpdateHandler(() => [])
      await expect(updateEquipment('missing', { name: 'Speaker' })).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('deleteEquipment', () => {
    function addDeleteHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'DELETE equipment by id returning id',
        verb: 'delete',
        match: (stmt) => stmt.table === 'equipment' && stmt.returning && whereColumnHasOperator(stmt, 'id', '=') && whereConditionCount(stmt) === 1,
        respond,
      })
    }

    it('deletes a matching row', async () => {
      addDeleteHandler(() => [{ id: 'eq-1' }])
      const { deleteEquipment } = await loadService()
      await expect(deleteEquipment('eq-1')).resolves.toBeUndefined()
    })

    it('maps failures to 500 and missing rows to 404', async () => {
      addDeleteHandler(() => { throw new Error('connection reset') })
      const { deleteEquipment } = await loadService()
      await expect(deleteEquipment('eq-1')).rejects.toMatchObject({ statusCode: 500 })

      sqlMock.reset()
      addDeleteHandler(() => [])
      await expect(deleteEquipment('missing')).rejects.toMatchObject({ statusCode: 404 })
    })
  })

  describe('getRoomDefaultEquipment', () => {
    it('returns only equipment joined to the requested room', async () => {
      addRoomDefaultsHandler(() => [equipmentRow])
      const { getRoomDefaultEquipment } = await loadService()
      await expect(getRoomDefaultEquipment('room-1')).resolves.toEqual([
        { id: 'eq-1', name: 'Projector', description: 'HD projector', createdAt: equipmentRow.created_at },
      ])
    })

    it('maps database failures to 500', async () => {
      addRoomDefaultsHandler(() => { throw new Error('connection reset') })
      const { getRoomDefaultEquipment } = await loadService()
      await expect(getRoomDefaultEquipment('room-1')).rejects.toMatchObject({ statusCode: 500 })
    })
  })

  describe('setRoomDefaultEquipment', () => {
    function addConflictHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'SELECT room-default conflicts by equipment ids',
        verb: 'select',
        match: (stmt) => stmt.table === 'room_default_equipment' && whereHasColumn(stmt, 'equipment_id') && whereConditionCount(stmt) === 1,
        respond,
      })
    }

    function addRoomDefaultsDeleteHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'DELETE room defaults by room id',
        verb: 'delete',
        match: (stmt) => stmt.table === 'room_default_equipment' && whereColumnHasOperator(stmt, 'room_id', '=') && whereConditionCount(stmt) === 1,
        respond,
      })
    }

    function addRoomDefaultsInsertHandler(respond: () => unknown) {
      sqlMock.addHandler({
        name: 'INSERT room defaults from equipment ids',
        verb: 'insert',
        match: (stmt) => stmt.table === 'room_default_equipment' && stmt.values.length === 2,
        respond,
      })
    }

    it('clears defaults without conflict lookup when ids are empty', async () => {
      addRoomDefaultsDeleteHandler(() => [])
      const { setRoomDefaultEquipment } = await loadService()
      await expect(setRoomDefaultEquipment('room-1', [])).resolves.toBeUndefined()
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('rejects equipment locked to another room before deleting defaults', async () => {
      addConflictHandler(() => [{ equipment_id: 'eq-1', room_id: 'room-2' }])
      const { setRoomDefaultEquipment } = await loadService()
      await expect(setRoomDefaultEquipment('room-1', ['eq-1'])).rejects.toMatchObject({
        statusCode: 400, message: ERROR_CODES.EQUIPMENT_LOCKED_TO_ANOTHER_ROOM,
      })
      expect(sqlMock.sql).toHaveBeenCalledTimes(1)
    })

    it('allows same-room equipment and replaces defaults in delete/insert order', async () => {
      addConflictHandler(() => [{ equipment_id: 'eq-1', room_id: 'room-1' }])
      addRoomDefaultsDeleteHandler(() => [])
      addRoomDefaultsInsertHandler(() => [])

      const { setRoomDefaultEquipment } = await loadService()
      await expect(setRoomDefaultEquipment('room-1', ['eq-1', 'eq-2'])).resolves.toBeUndefined()
      expect(sqlMock.sql).toHaveBeenCalledTimes(3)
    })

    it('maps conflict, delete, and insert failures to 500', async () => {
      addConflictHandler(() => { throw new Error('connection reset') })
      const { setRoomDefaultEquipment } = await loadService()
      await expect(setRoomDefaultEquipment('room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })

      sqlMock.reset()
      addConflictHandler(() => [])
      addRoomDefaultsDeleteHandler(() => { throw new Error('connection reset') })
      await expect(setRoomDefaultEquipment('room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })

      sqlMock.reset()
      addConflictHandler(() => [])
      addRoomDefaultsDeleteHandler(() => [])
      addRoomDefaultsInsertHandler(() => { throw new Error('connection reset') })
      await expect(setRoomDefaultEquipment('room-1', ['eq-1'])).rejects.toMatchObject({ statusCode: 500 })
    })
  })
})
