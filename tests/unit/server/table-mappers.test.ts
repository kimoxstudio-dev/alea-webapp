// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toGameTable } from '@/lib/server/tables/table-mappers'
import type { tables } from '@/lib/db/schema'

type TableRow = typeof tables.$inferSelect

describe('table mappers', () => {
  describe('toGameTable', () => {
    it('maps a complete table row to GameTable with all fields', () => {
      const row: TableRow = {
        id: 'table-123',
        roomId: 'room-main',
        name: 'Mesa 1',
        type: 'large',
        qrCode: 'QR-MESA-1-001',
        qrCodeInf: 'QR-INF-MESA-1-001',
        posX: 100,
        posY: 200,
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T14:30:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table).toEqual({
        id: 'table-123',
        roomId: 'room-main',
        name: 'Mesa 1',
        type: 'large',
        qrCode: 'QR-MESA-1-001',
        qrCodeInf: 'QR-INF-MESA-1-001',
        position: { x: 100, y: 200 },
      })
    })

    it('converts snake_case column names to camelCase', () => {
      const row: TableRow = {
        id: 'table-convert',
        roomId: 'room-test',
        name: 'Test Table',
        type: 'small',
        qrCode: 'QR-TEST',
        qrCodeInf: null,
        posX: 50,
        posY: 75,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      // Verify snake_case to camelCase conversion (input is already camelCase from Drizzle, output verifies camelCase mapping)
      expect(table).toHaveProperty('roomId', 'room-test')
      expect(table).toHaveProperty('qrCode', 'QR-TEST')
      expect(table).toHaveProperty('qrCodeInf', null)
    })

    it('defaults qr_code_inf to null when not provided', () => {
      const row: TableRow = {
        id: 'table-no-inf',
        roomId: 'room-1',
        name: 'No Inf Table',
        type: 'removable_top',
        qrCode: 'QR-MAIN',
        qrCodeInf: null,
        posX: 0,
        posY: 0,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.qrCodeInf).toBeNull()
    })

    it('defaults qr_code to empty string', () => {
      const row: TableRow = {
        id: 'table-empty-qr',
        roomId: 'room-2',
        name: 'Empty QR Table',
        type: 'small',
        qrCode: null,
        qrCodeInf: null,
        posX: 10,
        posY: 20,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.qrCode).toBe('')
    })

    it('omits position when pos_x is null', () => {
      const row: TableRow = {
        id: 'table-no-pos-x',
        roomId: 'room-3',
        name: 'No X Position',
        type: 'large',
        qrCode: 'QR-003',
        qrCodeInf: null,
        posX: null,
        posY: 100,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toBeUndefined()
    })

    it('omits position when pos_y is null', () => {
      const row: TableRow = {
        id: 'table-no-pos-y',
        roomId: 'room-4',
        name: 'No Y Position',
        type: 'small',
        qrCode: 'QR-004',
        qrCodeInf: null,
        posX: 50,
        posY: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toBeUndefined()
    })

    it('omits position when both pos_x and pos_y are null', () => {
      const row: TableRow = {
        id: 'table-no-pos',
        roomId: 'room-5',
        name: 'No Position',
        type: 'removable_top',
        qrCode: 'QR-005',
        qrCodeInf: null,
        posX: null,
        posY: null,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toBeUndefined()
    })

    it('includes position when both pos_x and pos_y are zero', () => {
      const row: TableRow = {
        id: 'table-zero-pos',
        roomId: 'room-6',
        name: 'Zero Position',
        type: 'large',
        qrCode: 'QR-006',
        qrCodeInf: null,
        posX: 0,
        posY: 0,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toEqual({ x: 0, y: 0 })
    })

    it('handles all table types', () => {
      const types: Array<'small' | 'large' | 'removable_top'> = ['small', 'large', 'removable_top']

      types.forEach((type) => {
        const row: TableRow = {
          id: `table-${type}`,
          roomId: 'room-types',
          name: `${type} Table`,
          type,
          qrCode: `QR-${type}`,
          qrCodeInf: null,
          posX: 100,
          posY: 200,
          createdAt: new Date('2024-06-20T00:00:00.000Z'),
          updatedAt: new Date('2024-06-20T00:00:00.000Z'),
        }

        const table = toGameTable(row)

        expect(table.type).toBe(type)
      })
    })

    it('preserves large position coordinates', () => {
      const row: TableRow = {
        id: 'table-large-pos',
        roomId: 'room-large',
        name: 'Large Position Table',
        type: 'large',
        qrCode: 'QR-LARGE-POS',
        qrCodeInf: null,
        posX: 9999,
        posY: 8888,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toEqual({ x: 9999, y: 8888 })
    })

    it('preserves negative position coordinates', () => {
      const row: TableRow = {
        id: 'table-neg-pos',
        roomId: 'room-neg',
        name: 'Negative Position Table',
        type: 'small',
        qrCode: 'QR-NEG-POS',
        qrCodeInf: null,
        posX: -100,
        posY: -200,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.position).toEqual({ x: -100, y: -200 })
    })

    it('handles qr_code_inf as non-null value', () => {
      const row: TableRow = {
        id: 'table-with-inf',
        roomId: 'room-inf',
        name: 'Table with QR Inf',
        type: 'removable_top',
        qrCode: 'QR-MAIN-FULL',
        qrCodeInf: 'QR-INF-FULL',
        posX: 50,
        posY: 60,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.qrCodeInf).toBe('QR-INF-FULL')
      expect(table.qrCode).toBe('QR-MAIN-FULL')
    })

    it('creates correct id and roomId mappings', () => {
      const row: TableRow = {
        id: 'table-mapping-test',
        roomId: 'room-mapping-test',
        name: 'Mapping Test',
        type: 'large',
        qrCode: 'QR-MAP',
        qrCodeInf: null,
        posX: 10,
        posY: 20,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }

      const table = toGameTable(row)

      expect(table.id).toBe('table-mapping-test')
      expect(table.roomId).toBe('room-mapping-test')
    })

    it('preserves all mapped fields without mutation', () => {
      const originalRow: TableRow = {
        id: 'table-immutable',
        roomId: 'room-immutable',
        name: 'Immutable Test',
        type: 'small',
        qrCode: 'QR-IMMUTABLE',
        qrCodeInf: null,
        posX: 33,
        posY: 44,
        createdAt: new Date('2024-06-20T00:00:00.000Z'),
        updatedAt: new Date('2024-06-20T00:00:00.000Z'),
      }
      
      // Create a copy to verify no mutation
      const rowBefore = { ...originalRow }

      const table = toGameTable(originalRow)

      // Verify the input row was not mutated
      expect(originalRow).toEqual(rowBefore)
      
      // Verify all fields are present in output
      expect(table.id).toBe('table-immutable')
      expect(table.roomId).toBe('room-immutable')
      expect(table.name).toBe('Immutable Test')
      expect(table.type).toBe('small')
      expect(table.qrCode).toBe('QR-IMMUTABLE')
      expect(table.qrCodeInf).toBeNull()
      expect(table.position).toEqual({ x: 33, y: 44 })
    })
  })
})
