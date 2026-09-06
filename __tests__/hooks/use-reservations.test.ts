import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the API client
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(() => Promise.resolve({})),
  },
}))

// Mock the endpoints
vi.mock('@/lib/api/endpoints', () => ({
  endpoints: {
    tables: {
      availability: (tableId: string, date: string) => `/tables/${tableId}/availability?date=${date}`,
    },
    rooms: {
      tablesAvailability: (roomId: string, date: string) => `/rooms/${roomId}/availability?date=${date}`,
    },
  },
}))

// Capture the options passed to useQuery by mocking @tanstack/react-query
let capturedUseQueryCalls: Array<{ options: any; hook: string }> = []

const createMockQueryResult = () => ({
  data: undefined,
  isLoading: false,
  isError: false,
  error: null,
  isPending: false,
  isSuccess: false,
  status: 'pending' as const,
  isFetching: false,
  failureCount: 0,
  failureReason: null,
  dataUpdatedAt: 0,
  errorUpdatedAt: 0,
})

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query')
  return {
    ...actual,
    useQuery: (options: any) => {
      capturedUseQueryCalls.push({ options, hook: 'useQuery' })
      return createMockQueryResult()
    },
    useMutation: vi.fn((config: any) => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      isSuccess: false,
      error: null,
      status: 'idle' as const,
      reset: vi.fn(),
    })),
    useQueryClient: vi.fn(() => ({
      invalidateQueries: vi.fn(),
    })),
  }
})

// Now import the hooks after mocking
import { useTableAvailability, useRoomAvailability } from '@/lib/hooks/use-reservations'
import { renderHook } from '@testing-library/react'

describe('useTableAvailability polling configuration', () => {
  beforeEach(() => {
    capturedUseQueryCalls = []
  })

  it('should set staleTime: 0 and refetchInterval: 30_000', () => {
    const tableId = 'table-1'
    const date = '2025-06-15'

    renderHook(() => useTableAvailability(tableId, date))

    // Find the call for useTableAvailability
    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)

    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    const options = lastCall.options

    // Verify the polling configuration
    expect(options.staleTime).toBe(0)
    expect(options.refetchInterval).toBe(30_000)
  })

  it('should not be enabled when tableId is null', () => {
    capturedUseQueryCalls = []
    renderHook(() => useTableAvailability(null, '2025-06-15'))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(false)
  })

  it('should not be enabled when date is null', () => {
    capturedUseQueryCalls = []
    renderHook(() => useTableAvailability('table-1', null))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(false)
  })

  it('should be enabled when both tableId and date are provided', () => {
    capturedUseQueryCalls = []
    renderHook(() => useTableAvailability('table-1', '2025-06-15'))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(true)
  })
})

describe('useRoomAvailability polling configuration', () => {
  beforeEach(() => {
    capturedUseQueryCalls = []
  })

  it('should set staleTime: 0 and refetchInterval: 60_000', () => {
    const roomId = 'room-1'
    const date = '2025-06-15'

    renderHook(() => useRoomAvailability(roomId, date))

    // Find the call for useRoomAvailability
    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)

    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    const options = lastCall.options

    // Verify the polling configuration
    expect(options.staleTime).toBe(0)
    expect(options.refetchInterval).toBe(60_000)
  })

  it('should not be enabled when roomId is null', () => {
    capturedUseQueryCalls = []
    renderHook(() => useRoomAvailability(null, '2025-06-15'))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(false)
  })

  it('should not be enabled when date is null', () => {
    capturedUseQueryCalls = []
    renderHook(() => useRoomAvailability('room-1', null))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(false)
  })

  it('should be enabled when both roomId and date are provided', () => {
    capturedUseQueryCalls = []
    renderHook(() => useRoomAvailability('room-1', '2025-06-15'))

    expect(capturedUseQueryCalls.length).toBeGreaterThan(0)
    const lastCall = capturedUseQueryCalls[capturedUseQueryCalls.length - 1]
    expect(lastCall.options.enabled).toBe(true)
  })
})

// Business logic unit tests for removable_top tables
