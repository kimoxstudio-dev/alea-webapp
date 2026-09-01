import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { GameTable } from '@/lib/types'

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// Mock the auth context
vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: { id: 'user-123', email: 'test@example.com' },
  }),
}))

// Mock club-time so getCurrentClubDate returns a fixed date.
// This freezes "today" to 2025-01-15 at 00:05, so nowMinutes = 5 and
// all mock slots (09:00 onward) pass the > nowMinutes filter deterministically.
vi.mock('@/lib/club-time', async () => {
  const actual = await vi.importActual<typeof import('@/lib/club-time')>('@/lib/club-time')
  return {
    ...actual,
    getCurrentClubDate: () => '2025-01-15',
  }
})

// Declare mock functions using vi.hoisted() so they're available during vi.mock() hoisting
const { mockMutateAsync, mockSavedGameMutateAsync } = vi.hoisted(() => {
  const mockMutateAsyncFn = vi.fn()
  return {
    mockMutateAsync: {
      fn: mockMutateAsyncFn,
    },
    mockSavedGameMutateAsync: { fn: vi.fn() },
  }
})

// Mock the hooks
vi.mock('@/lib/hooks/use-reservations', () => ({
  useTableAvailability: () => ({
    data: {
      tableId: 't1',
      date: '2025-01-15',
      slots: [
        { startTime: '09:00', endTime: '09:30', available: true },
        { startTime: '09:30', endTime: '10:00', available: true },
        { startTime: '10:00', endTime: '10:30', available: true },
        { startTime: '10:30', endTime: '11:00', available: true },
        { startTime: '11:00', endTime: '11:30', available: true },
        { startTime: '11:30', endTime: '12:00', available: true },
        { startTime: '12:00', endTime: '12:30', available: true },
        { startTime: '23:30', endTime: '24:00', available: true },
      ],
      top: undefined,
      bottom: undefined,
    },
    isLoading: false,
  }),
  useAvailableRoomEquipment: () => ({
    data: [
      { id: 'eq-1', name: 'Projector', description: 'Ceiling projector', available: true, conflictReason: null },
      { id: 'eq-2', name: 'Speaker Kit', description: 'Portable speakers', available: false, conflictReason: 'EQUIPMENT_ALREADY_RESERVED' },
    ],
    isLoading: false,
  }),
  useCreateReservation: () => ({
    mutateAsync: mockMutateAsync.fn,
    isPending: false,
  }),
  useCreateSavedGame: () => ({ mutateAsync: mockSavedGameMutateAsync.fn, isPending: false }),
}))

// Import after mocks are set up
import { ReservationDialog } from '@/components/rooms/reservation-dialog'

const mockTable: GameTable = {
  id: 't1',
  roomId: 'room-1',
  name: 'Table 1',
  type: 'large',
  qrCode: 'QR_T1',
  position: { x: 0, y: 0 },
}

describe('ReservationDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockMutateAsync.fn = vi.fn()
    mockSavedGameMutateAsync.fn = vi.fn()
    // Freeze only the Date constructor to 2025-01-15T00:05:00Z (00:05 UTC).
    // nowMinutes = 0*60+5 = 5, so all mock slots (09:00 = 540 min onward) pass
    // the `slot > nowMinutes` filter deterministically.
    // toFake: ['Date'] leaves setTimeout/setInterval real so waitFor and
    // userEvent async interactions continue to work normally.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2025-01-15T00:05:00.000Z'))
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('renders dialog when open is true', () => {
    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('uses translated availability labels in slot aria-labels', () => {
    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    expect(screen.getAllByRole('button', { name: /\d{2}:\d{2} — available/ }).length).toBeGreaterThan(0)
  })

  it('renders half-hour slot options', () => {
    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: '11:30 — available' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '12:30 — available' })).toBeInTheDocument()
  })

  it('allows selecting 24:00 as the end boundary after choosing the last slot', async () => {
    const user = userEvent.setup()
    mockMutateAsync.fn = vi.fn().mockResolvedValueOnce({
      id: 'res-midnight',
      tableId: 't1',
      userId: 'user-123',
      date: '2025-01-15',
      startTime: '23:30',
      endTime: '24:00',
      status: 'pending',
      surface: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)
    await user.click(screen.getByRole('button', { name: '23:30 — available' }))
    await user.click(screen.getByRole('button', { name: '24:00 — available' }))
    await user.click(screen.getByRole('button', { name: 'makeReservation' }))

    await waitFor(() => {
      expect(mockMutateAsync.fn).toHaveBeenCalledWith(expect.objectContaining({
        startTime: '23:30',
        endTime: '24:00',
        date: dateString,
      }))
    })
  })

  it('does not render when table is null', () => {
    render(
      <ReservationDialog
        table={null}
        open={true}
        onClose={vi.fn()}
      />
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('displays slot conflict error when mutation throws a 409 conflict', async () => {
    const user = userEvent.setup()
    mockMutateAsync.fn = vi.fn().mockRejectedValueOnce({
      message: 'Time slot is already reserved',
      statusCode: 409,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    // Select date (tomorrow to avoid past date validation)
    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    // Click on time slots to select start and end times
    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    if (timeButtons.length >= 2) {
      await user.click(timeButtons[0]) // Start time
      await user.click(timeButtons[1]) // End time
    }

    // Submit
    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    await user.click(submitButton)

    // Wait for error to appear
    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
      expect(alert).toHaveTextContent('errors.conflictTime')
    })
  })

  it('displays userSlotConflict error when mutation throws USER_ALREADY_HAS_RESERVATION_IN_SLOT error', async () => {
    const user = userEvent.setup()
    mockMutateAsync.fn = vi.fn().mockRejectedValueOnce({
      message: 'USER_ALREADY_HAS_RESERVATION_IN_SLOT',
      statusCode: 409,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    // Select date (tomorrow to avoid past date validation)
    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    // Click on time slots to select start and end times
    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    if (timeButtons.length >= 2) {
      await user.click(timeButtons[0]) // Start time
      await user.click(timeButtons[1]) // End time
    }

    // Submit
    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    await user.click(submitButton)

    // Wait for error to appear
    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
      expect(alert).toHaveTextContent('errors.userSlotConflict')
    })
  })

  it('does not display error when mutation succeeds', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mockMutateAsync.fn = vi.fn().mockResolvedValueOnce({
      id: 'res-123',
      tableId: 't1',
      userId: 'user-123',
      date: '2025-01-15',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      surface: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={onClose}
      />
    )

    // Select date (tomorrow to avoid past date validation)
    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    // Click on time slots to select start and end times
    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    if (timeButtons.length >= 2) {
      await user.click(timeButtons[0]) // Start time
      await user.click(timeButtons[1]) // End time
    }

    // Submit
    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    await user.click(submitButton)

    // Error should not appear
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    // Success message should appear
    await waitFor(() => {
      const status = screen.getByRole('status')
      expect(status).toBeInTheDocument()
    })
  })

  it('submits selected equipment ids with the reservation payload', async () => {
    const user = userEvent.setup()
    mockMutateAsync.fn = vi.fn().mockResolvedValueOnce({
      id: 'res-123',
      tableId: 't1',
      userId: 'user-123',
      date: '2025-01-15',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      surface: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      equipment: [],
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    await user.click(timeButtons[0]!)
    await user.click(timeButtons[1]!)
    await user.click(screen.getByRole('checkbox', { name: 'Projector' }))
    await user.click(screen.getByRole('button', { name: 'makeReservation' }))

    await waitFor(() => {
      expect(mockMutateAsync.fn).toHaveBeenCalledWith(expect.objectContaining({
        equipmentIds: ['eq-1'],
      }))
    })
  })

  it('renders unavailable equipment guidance when overlaps exist', async () => {
    const user = userEvent.setup()

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    await user.click(timeButtons[0]!)
    await user.click(timeButtons[1]!)

    expect(screen.getByText('equipmentUnavailable')).toBeInTheDocument()
    expect(screen.getByText('equipmentUnavailableReason')).toBeInTheDocument()
  })

  it('clears error when closing dialog after failed submission', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    mockMutateAsync.fn = vi.fn().mockRejectedValueOnce({
      message: 'Time slot is already reserved',
      statusCode: 409,
    })

    const { unmount } = render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={onClose}
      />
    )

    // Select date (tomorrow to avoid past date validation)
    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    // Click on time slots to select start and end times
    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    if (timeButtons.length >= 2) {
      await user.click(timeButtons[0]) // Start time
      await user.click(timeButtons[1]) // End time
    }

    // Submit
    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    await user.click(submitButton)

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument()
    })

    // Close dialog
    const cancelButton = screen.getByRole('button', { name: 'cancel' })
    await user.click(cancelButton)

    expect(onClose).toHaveBeenCalled()

    // Unmount and re-render to verify error state is cleared
    unmount()

    mockMutateAsync.fn = vi.fn().mockResolvedValueOnce({
      id: 'res-456',
      tableId: 't1',
      userId: 'user-123',
      date: '2025-01-16',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      surface: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    // Verify no error alert is present in the fresh dialog
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('submit button is disabled when time range not selected', () => {
    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    expect(submitButton).toBeDisabled()
  })

  it('displays surface selector for removable_top tables', () => {
    const removableTable: GameTable = {
      ...mockTable,
      type: 'removable_top',
    }

    render(
      <ReservationDialog
        table={removableTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByLabelText('selectSurface')).toBeInTheDocument()
  })

  it('does not display surface selector for large tables', () => {
    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    expect(screen.queryByLabelText('selectSurface')).not.toBeInTheDocument()
  })

  it('calls mutateAsync with correct parameters on submission', async () => {
    const user = userEvent.setup()
    mockMutateAsync.fn = vi.fn().mockResolvedValueOnce({
      id: 'res-123',
      tableId: 't1',
      userId: 'user-123',
      date: '2025-01-15',
      startTime: '10:00',
      endTime: '11:00',
      status: 'pending',
      surface: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
    })

    render(
      <ReservationDialog
        table={mockTable}
        open={true}
        onClose={vi.fn()}
      />
    )

    // Select date (tomorrow to avoid past date validation)
    const dateInput = screen.getByLabelText('selectDate') as HTMLInputElement
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const dateString = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`

    await user.clear(dateInput)
    await user.type(dateInput, dateString)

    // Click on time slots to select start and end times
    const timeButtons = screen.getAllByRole('button', { name: /\d{2}:\d{2}.*/ })
    if (timeButtons.length >= 2) {
      await user.click(timeButtons[0]) // Start time
      await user.click(timeButtons[1]) // End time
    }

    // Submit
    const submitButton = screen.getByRole('button', { name: 'makeReservation' })
    await user.click(submitButton)

    // Verify mutateAsync was called with correct structure
    await waitFor(() => {
      expect(mockMutateAsync.fn).toHaveBeenCalledWith(
        expect.objectContaining({
          tableId: 't1',
          date: dateString,
          startTime: expect.any(String),
          endTime: expect.any(String),
        })
      )
    })
  })

  it('displays the bottomReservationConflict i18n message when saved-game creation throws SAVED_GAME_BOTTOM_RESERVATION_CONFLICT (#301 round-4 fix)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const removableTable = { ...mockTable, type: 'removable_top' as const }
    mockSavedGameMutateAsync.fn = vi.fn().mockRejectedValueOnce({
      message: 'SAVED_GAME_BOTTOM_RESERVATION_CONFLICT',
      statusCode: 409,
    })

    render(<ReservationDialog table={removableTable} open onClose={vi.fn()} />)

    await user.click(screen.getByRole('radio', { name: 'savedGame.name' }))
    await user.click(screen.getByRole('button', { name: 'savedGame.create' }))

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
      // next-intl is mocked to `(key) => key`, so the rendered text is the
      // raw i18n key path — this proves the new branch (added ahead of the
      // pre-existing SAVED_GAME_CONFLICT branch) picks the distinct
      // `bottomReservationConflict` key and not `conflict` or `generic`.
      expect(alert).toHaveTextContent('savedGame.errors.bottomReservationConflict')
    })
  })

  it('falls through to the generic SAVED_GAME_CONFLICT message for a plain conflict code (regression guard for the new branch ordering)', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const removableTable = { ...mockTable, type: 'removable_top' as const }
    mockSavedGameMutateAsync.fn = vi.fn().mockRejectedValueOnce({
      message: 'SAVED_GAME_CONFLICT',
      statusCode: 409,
    })

    render(<ReservationDialog table={removableTable} open onClose={vi.fn()} />)

    await user.click(screen.getByRole('radio', { name: 'savedGame.name' }))
    await user.click(screen.getByRole('button', { name: 'savedGame.create' }))

    await waitFor(() => {
      const alert = screen.getByRole('alert')
      expect(alert).toBeInTheDocument()
      expect(alert).toHaveTextContent('savedGame.errors.conflict')
    })
  })

  it('creates a Saved Game from dates without selecting a time range', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const removableTable = { ...mockTable, type: 'removable_top' as const }
    render(<ReservationDialog table={removableTable} open onClose={vi.fn()} />)

    await user.click(screen.getByRole('radio', { name: 'savedGame.name' }))
    await user.click(screen.getByRole('button', { name: 'savedGame.create' }))

    expect(mockSavedGameMutateAsync.fn).toHaveBeenCalledWith({
      tableId: 't1',
      startDate: '2025-01-15',
      endDate: '2025-04-14',
    })
    expect(screen.queryByText('selectTime')).not.toBeInTheDocument()
  })
})
