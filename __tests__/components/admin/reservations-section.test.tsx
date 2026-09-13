import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReservationsSection } from '@/components/admin/reservations-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const { cancelReservationState } = vi.hoisted(() => ({
  cancelReservationState: { isPending: false },
}))

// An active reservation is needed so the cancel confirmation dialog is
// reachable — the cancel trigger only renders for 'active'/'pending' rows.
const reservationFixture = [{
  id: 'res-1',
  tableId: 'table-1',
  userId: 'user-1',
  date: '2026-06-01',
  startTime: '18:00',
  endTime: '20:00',
  status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
}]

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminReservations: () => ({ data: reservationFixture, isLoading: false }),
  useAdminCancelReservation: () => ({ mutateAsync: vi.fn(), isPending: cancelReservationState.isPending }),
}))

// #408 — same fixed-slot fix as #399/#404, applied to this file's
// `min-w-[100px]` cancel-confirmation site.
describe('ReservationsSection — pending buttons reserve loader space without animating while idle (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    cancelReservationState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('cancel-confirmation button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<ReservationsSection />)

    await user.click(screen.getByRole('button', { name: 'cancelReservation' }))
    const button = screen.getByRole('button', { name: 'confirm' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
    expect(button).not.toHaveAttribute('aria-busy', 'true')
  })

  it('cancel-confirmation button: loader mounts while cancelling', async () => {
    cancelReservationState.isPending = true
    const user = userEvent.setup()
    render(<ReservationsSection />)

    await user.click(screen.getByRole('button', { name: 'cancelReservation' }))
    const button = screen.getByRole('button', { name: 'confirm' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
