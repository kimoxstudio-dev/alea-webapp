// @vitest-environment node
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { isNoShowExpired, markExpiredReservationsAsNoShow } from '@/lib/server/reservation-no-show'

describe('reservation no-show lazy evaluation', () => {
  describe('isNoShowExpired', () => {
    const longSlot = {
      date: '2026-06-19',
      start_time: '16:00:00',
      end_time: '18:00:00',
    }

    it('marks a reservation as expired when now exceeds the deadline (59-minute no-show threshold)', () => {
      // Uses local getNoShowDeadline which returns start + 59min (capped at end)
      // For this 2-hour slot: deadline is 2026-06-19T14:59:00.000Z (independent of pending-reservation-expiry logic)
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.000Z'))).toBe(false)
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.001Z'))).toBe(true)
    })

    it('caps the deadline at the reservation end for short slots', () => {
      const shortSlot = { ...longSlot, end_time: '16:30:00' }
      // For short slots: 59min from start (14:59:00Z) exceeds end (14:30:00Z), so deadline is capped at end
      expect(isNoShowExpired(shortSlot, new Date('2026-06-19T14:30:00.000Z'))).toBe(false)
      expect(isNoShowExpired(shortSlot, new Date('2026-06-19T14:30:00.001Z'))).toBe(true)
    })

    it('keeps the reservation valid at the exact deadline and expires it one millisecond later', () => {
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.000Z'))).toBe(false)
      expect(isNoShowExpired(longSlot, new Date('2026-06-19T14:59:00.001Z'))).toBe(true)
    })
  })

  describe('markExpiredReservationsAsNoShow', () => {
    beforeEach(() => {
      vi.resetModules()
      vi.clearAllMocks()
    })

    it('is an async function that returns a number', async () => {
      // Mock the dependencies
      vi.doMock('@/lib/server/database-time', () => ({
        getDatabaseNow: vi.fn(async () => new Date('2026-12-31T17:00:00.000Z')),
      }))

      vi.doMock('@/lib/supabase/server', () => ({
        createSupabaseServerAdminClient: vi.fn(() => ({
          from: vi.fn((table: string) => {
            if (table === 'reservations') {
              return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                is: vi.fn().mockReturnThis(),
                update: vi.fn().mockReturnThis(),
              }
            }
            throw new Error(`Unexpected table: ${table}`)
          }),
        })),
      }))

      const { markExpiredReservationsAsNoShow: testFn } = await import('@/lib/server/reservation-no-show')

      const result = await testFn()
      expect(typeof result).toBe('number')
      expect(result >= 0).toBe(true)
    })

    it('uses createSupabaseServerAdminClient to query reservations', async () => {
      const createAdminClientMock = vi.fn()

      vi.doMock('@/lib/server/database-time', () => ({
        getDatabaseNow: vi.fn(async () => new Date('2026-12-31T17:00:00.000Z')),
      }))

      vi.doMock('@/lib/supabase/server', () => ({
        createSupabaseServerAdminClient: createAdminClientMock.mockReturnValue({
          from: vi.fn((table: string) => {
            if (table === 'reservations') {
              return {
                select: vi.fn().mockReturnThis(),
                eq: vi.fn().mockReturnThis(),
                is: vi.fn().mockReturnThis(),
                update: vi.fn().mockReturnThis(),
              }
            }
            throw new Error(`Unexpected table: ${table}`)
          }),
        }),
      }))

      const { markExpiredReservationsAsNoShow: testFn } = await import('@/lib/server/reservation-no-show')
      await testFn()

      // Verify admin client was created
      expect(createAdminClientMock).toHaveBeenCalled()
    })

    it('handles errors in query response', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      vi.doMock('@/lib/server/database-time', () => ({
        getDatabaseNow: vi.fn(async () => new Date('2026-12-31T17:00:00.000Z')),
      }))

      vi.doMock('@/lib/supabase/server', () => ({
        createSupabaseServerAdminClient: vi.fn(() => ({
          from: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
        })),
      }))

      const { markExpiredReservationsAsNoShow: testFn } = await import('@/lib/server/reservation-no-show')

      // Function should complete without throwing
      const result = await testFn()
      expect(typeof result).toBe('number')
      expect(result >= 0).toBe(true)

      consoleErrorSpy.mockRestore()
    })
  })
})
