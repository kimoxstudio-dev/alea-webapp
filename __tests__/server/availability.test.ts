// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import type { GameTable } from '@/lib/types'
import type { Tables } from '@/lib/supabase/types'
import { resolveDate, normalizeTime, generateDaySlots, buildAvailability } from '@/lib/server/availability'

type ReservationRow = Tables<'reservations'>

function makeReservationRow(overrides?: Partial<ReservationRow>): ReservationRow {
  return {
    id: 'r1',
    table_id: 't1',
    user_id: 'u1',
    date: '2025-06-15',
    start_time: '10:00:00',
    end_time: '12:00:00',
    status: 'active',
    surface: null,
    created_at: '2025-06-15T09:00:00Z',
    ...overrides,
  }
}

function makeGameTable(overrides?: Partial<GameTable>): GameTable {
  return {
    id: 't1',
    roomId: 'room-1',
    name: 'Mesa 1',
    type: 'small',
    qrCode: 'QR-1',
    position: { x: 0, y: 0 },
    ...overrides,
  }
}

describe('resolveDate', () => {
  beforeEach(() => {
    // Pin clock to a fixed instant within the historical flake window:
    // 2025-06-15T23:30:00Z = June 15 23:30 UTC
    // Atlantic/Canary is UTC+1 in June (WEST), so local time is June 16 00:30
    // getCurrentClubDate() will return "2025-06-16" at this UTC instant
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-15T23:30:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns today when input is null', () => {
    // At this fixed instant (2025-06-15T23:30:00Z), club-local date is 2025-06-16
    expect(resolveDate(null)).toBe('2025-06-16')
  })

  it('returns today when input is undefined', () => {
    expect(resolveDate(undefined)).toBe('2025-06-16')
  })

  it('returns today when input is empty string', () => {
    expect(resolveDate('')).toBe('2025-06-16')
  })

  it('returns today when input is whitespace only', () => {
    expect(resolveDate('   ')).toBe('2025-06-16')
  })

  it('returns the date when a valid YYYY-MM-DD is provided', () => {
    expect(resolveDate('2025-06-15')).toBe('2025-06-15')
  })

  it('throws 400 ServiceError for DD-MM-YYYY format', () => {
    expect(() => resolveDate('15-06-2025')).toThrow(
      expect.objectContaining({ name: 'ServiceError', statusCode: 400 }),
    )
  })

  it('throws 400 ServiceError for non-date string', () => {
    expect(() => resolveDate('not-a-date')).toThrow(
      expect.objectContaining({ name: 'ServiceError', statusCode: 400 }),
    )
  })

  it('throws 400 ServiceError for month 13 (invalid calendar date)', () => {
    expect(() => resolveDate('2025-13-01')).toThrow(
      expect.objectContaining({ name: 'ServiceError', statusCode: 400 }),
    )
  })
})

describe('normalizeTime', () => {
  it('slices time string to HH:MM', () => {
    expect(normalizeTime('09:00:00')).toBe('09:00')
  })

  it('returns unchanged string when already HH:MM', () => {
    expect(normalizeTime('09:00')).toBe('09:00')
  })

  it('handles boundary time 00:00', () => {
    expect(normalizeTime('00:00:00')).toBe('00:00')
  })

  it('handles boundary time 23:59', () => {
    expect(normalizeTime('23:59:00')).toBe('23:59')
  })
})

describe('generateDaySlots', () => {
  it('generates 48 half-hour slots for an empty reserved list', () => {
    const slots = generateDaySlots([])
    expect(slots).toHaveLength(48)
  })

  it('first slot starts at 00:00 and last half-hour slot ends at 24:00', () => {
    const slots = generateDaySlots([])
    expect(slots[0]).toMatchObject({ startTime: '00:00', endTime: '00:30', available: true })
    expect(slots[47]).toMatchObject({ startTime: '23:30', endTime: '24:00', available: true })
  })

  it('each slot has startTime, endTime and available fields', () => {
    const slots = generateDaySlots([])
    for (const slot of slots) {
      expect(slot).toHaveProperty('startTime')
      expect(slot).toHaveProperty('endTime')
      expect(slot).toHaveProperty('available')
    }
  })

  it('marks the slot covering the reserved range as unavailable', () => {
    const slots = generateDaySlots([{ start: '10:00', end: '11:00' }])
    const slot = slots.find((s) => s.startTime === '10:00')
    expect(slot?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '10:30')?.available).toBe(false)
  })

  it('leaves slots outside the reserved range as available', () => {
    const slots = generateDaySlots([{ start: '10:00', end: '11:00' }])
    expect(slots.find((s) => s.startTime === '09:00')?.available).toBe(true)
    expect(slots.find((s) => s.startTime === '11:00')?.available).toBe(true)
  })

  it('marks multiple reserved slots correctly', () => {
    const slots = generateDaySlots([
      { start: '09:00', end: '10:00' },
      { start: '14:00', end: '15:00' },
    ])
    expect(slots.find((s) => s.startTime === '09:00')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '09:30')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '14:00')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '14:30')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '10:00')?.available).toBe(true)
  })

  it('treats slot end as exclusive so adjacent bookings stay available', () => {
    const slots = generateDaySlots([{ start: '17:00', end: '18:00' }])
    expect(slots.find((s) => s.startTime === '17:00')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '18:00')?.available).toBe(true)
  })

  it('marks partial overlaps on both touched slots', () => {
    const slots = generateDaySlots([{ start: '10:30', end: '12:30' }])
    expect(slots.find((s) => s.startTime === '10:00')?.available).toBe(true)
    expect(slots.find((s) => s.startTime === '10:30')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '11:00')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '11:30')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '12:00')?.available).toBe(false)
    expect(slots.find((s) => s.startTime === '12:30')?.available).toBe(true)
  })
})

describe('buildAvailability', () => {
  it('returns all slots available when there are no reservations', () => {
    const table = makeGameTable()
    const result = buildAvailability(table, '2025-06-15', [])

    expect(result.tableId).toBe('t1')
    expect(result.date).toBe('2025-06-15')
    expect(result.slots).toHaveLength(48)
    expect(result.slots.every((s) => s.available)).toBe(true)
  })

  it('marks the slot blocked by a reservation as unavailable', () => {
    const table = makeGameTable()
    const reservation = makeReservationRow({ start_time: '10:00:00', end_time: '11:00:00' })
    const result = buildAvailability(table, '2025-06-15', [reservation])

    const blockedSlot = result.slots.find((s) => s.startTime === '10:00')
    expect(blockedSlot?.available).toBe(false)
  })

  it('leaves slots outside a reservation range as available', () => {
    const table = makeGameTable()
    const reservation = makeReservationRow({ start_time: '10:00:00', end_time: '11:00:00' })
    const result = buildAvailability(table, '2025-06-15', [reservation])

    expect(result.slots.find((s) => s.startTime === '09:00')?.available).toBe(true)
    expect(result.slots.find((s) => s.startTime === '11:00')?.available).toBe(true)
  })

  it('does not add top/bottom/conflicts for non-removable-top tables', () => {
    const table = makeGameTable({ type: 'small' })
    const result = buildAvailability(table, '2025-06-15', [])

    expect(result.top).toBeUndefined()
    expect(result.bottom).toBeUndefined()
    expect(result.conflicts).toBeUndefined()
  })

  it('adds top, bottom and conflicts for removable_top tables', () => {
    const table = makeGameTable({ type: 'removable_top' })
    const result = buildAvailability(table, '2025-06-15', [])

    expect(result.top).toBeDefined()
    expect(result.bottom).toBeDefined()
    expect(result.conflicts).toBeDefined()
    expect(result.top).toHaveLength(48)
    expect(result.bottom).toHaveLength(48)
  })

  it('separates top and bottom surface reservations for removable_top tables', () => {
    const table = makeGameTable({ type: 'removable_top' })
    const topReservation = makeReservationRow({ start_time: '10:00:00', end_time: '11:00:00', surface: 'top' })
    const result = buildAvailability(table, '2025-06-15', [topReservation])

    expect(result.top?.find((s) => s.startTime === '10:00')?.available).toBe(false)
    expect(result.bottom?.find((s) => s.startTime === '10:00')?.available).toBe(true)
  })

  it('top-surface reservation also blocks the overall card-level slot', () => {
    const table = makeGameTable({ type: 'removable_top' })
    const topReservation = makeReservationRow({ start_time: '10:00:00', end_time: '11:00:00', surface: 'top' })
    const result = buildAvailability(table, '2025-06-15', [topReservation])

    // overall card-level slot must be blocked even for a surface-specific reservation
    expect(result.slots.find((s) => s.startTime === '10:00')?.available).toBe(false)
    // only the targeted section should be unavailable
    expect(result.top?.find((s) => s.startTime === '10:00')?.available).toBe(false)
    expect(result.bottom?.find((s) => s.startTime === '10:00')?.available).toBe(true)
  })

  it('reservation with null surface marks both top and bottom sections as reserved', () => {
    const table = makeGameTable({ type: 'removable_top' })
    const wholeTableReservation = makeReservationRow({ start_time: '10:00:00', end_time: '12:00:00', surface: null })
    const result = buildAvailability(table, '2025-06-15', [wholeTableReservation])

    // Null surface = whole-table reservation: both sections must be blocked
    expect(result.top?.find((s) => s.startTime === '10:00')?.available).toBe(false)
    expect(result.bottom?.find((s) => s.startTime === '10:00')?.available).toBe(false)
    // Card-level slot must also be blocked
    expect(result.slots.find((s) => s.startTime === '10:00')?.available).toBe(false)
  })

  it('bottom-only reservation does not mark top section as reserved', () => {
    const table = makeGameTable({ type: 'removable_top' })
    const bottomReservation = makeReservationRow({ start_time: '14:00:00', end_time: '15:00:00', surface: 'bottom' })
    const result = buildAvailability(table, '2025-06-15', [bottomReservation])

    expect(result.bottom?.find((s) => s.startTime === '14:00')?.available).toBe(false)
    expect(result.top?.find((s) => s.startTime === '14:00')?.available).toBe(true)
  })
})
