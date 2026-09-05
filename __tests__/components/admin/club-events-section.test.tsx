import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClubEventsSection } from '@/components/admin/club-events-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'es',
}))

// jsdom has no ResizeObserver — Radix's Checkbox (rendered for "visible on
// landing" / "blocks rooms" / the schedule row's "all day" toggle) measures
// itself with one on mount.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- test-only jsdom polyfill
global.ResizeObserver = ResizeObserverMock

const mockCreateMutateAsync = vi.fn()

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminClubEvents: () => ({ data: { upcoming: [], past: [] }, isLoading: false }),
  useAdminCreateClubEvent: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
  useAdminUpdateClubEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminDeleteClubEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminRooms: () => ({ data: [], isLoading: false }),
  useAdminRoomTables: () => ({ data: [], isLoading: false }),
  useAdminEquipment: () => ({ data: [], isLoading: false }),
  useAdminUploadImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

/**
 * `ClubEventsSection` is the riskiest consumer of the shared
 * `useRequiredFieldFocus` hook (#313 code-review round 2, finding 4): it's
 * the only one with dynamic compound ref keys (`schedule:${index}:${field}`,
 * one set per room-block schedule row) and the only one where the refs live
 * in a child component (`ScheduleRow`) wired through a passed-down
 * ref-getter, rather than a ref registered directly in the form component
 * itself (contrast `EquipmentSection`/`PartnersSection`, both flat single-row
 * forms). This test proves the compound-key routing actually reaches the
 * right row's input — it would fail if `scheduleFieldKey`/`getFieldRef`
 * misrouted a second row's error/focus onto the first row (or vice versa).
 */
describe('ClubEventsSection — schedule-row required-field focus routing (#313)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('focuses and marks invalid the second schedule row date, not the first, when only the second is left blank', async () => {
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    await user.click(screen.getByRole('button', { name: 'clubEvents.createEvent' }))

    await user.type(screen.getByLabelText('clubEvents.titleEs'), 'Poker Night')
    fireEvent.change(screen.getByLabelText('clubEvents.date'), { target: { value: '2026-06-01' } })

    // Enable the room-block sub-flow and add a second schedule row.
    await user.click(screen.getByRole('checkbox', { name: 'clubEvents.blocksRooms' }))
    await user.click(screen.getByRole('button', { name: 'clubEvents.addSchedule' }))

    // Fill the FIRST row completely (date + start + end) so it's valid...
    const dateInputs = screen.getAllByLabelText('date')
    const startInputs = screen.getAllByLabelText('clubEvents.startTime')
    const endInputs = screen.getAllByLabelText('clubEvents.endTime')
    expect(dateInputs).toHaveLength(2)

    fireEvent.change(dateInputs[0]!, { target: { value: '2026-06-01' } })
    fireEvent.change(startInputs[0]!, { target: { value: '18:00' } })
    fireEvent.change(endInputs[0]!, { target: { value: '20:00' } })

    // ...and leave the SECOND row's date blank.
    await user.click(screen.getByRole('button', { name: 'save' }))

    // The second row's date input — not the first's — must be the one
    // flagged and focused.
    expect(dateInputs[1]).toHaveAttribute('aria-invalid', 'true')
    expect(dateInputs[1]).toHaveFocus()
    expect(dateInputs[0]).not.toHaveAttribute('aria-invalid', 'true')

    // The mutation (which would persist an incomplete schedule row) must
    // never fire.
    expect(mockCreateMutateAsync).not.toHaveBeenCalled()
  })
})
