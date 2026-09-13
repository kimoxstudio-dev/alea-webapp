import { render, screen, fireEvent, within } from '@testing-library/react'
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

const { createClubEventState, deleteClubEventState } = vi.hoisted(() => ({
  createClubEventState: { isPending: false },
  deleteClubEventState: { isPending: false },
}))

// A row is needed so the delete dialog (#408 tests below) is reachable.
const clubEventFixture = {
  id: 'ce-1',
  titleEs: 'Poker Night',
  titleEn: 'Poker Night',
  blurbEs: '',
  blurbEn: '',
  descriptionEs: null,
  descriptionEn: null,
  dateKind: 'single' as const,
  startDate: '2026-06-01',
  endDate: null,
  recurrenceLabelEs: null,
  recurrenceLabelEn: null,
  imageUrl: null,
  linkUrl: null,
  categoryEs: null,
  categoryEn: null,
  status: 'upcoming' as const,
  blocksRooms: false,
  roomBlocks: [],
  visibleOnLanding: false,
  materials: [],
}

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminClubEvents: () => ({ data: { upcoming: [clubEventFixture], past: [] }, isLoading: false }),
  useAdminCreateClubEvent: () => ({ mutateAsync: mockCreateMutateAsync, isPending: createClubEventState.isPending }),
  useAdminUpdateClubEvent: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminDeleteClubEvent: () => ({ mutateAsync: vi.fn(), isPending: deleteClubEventState.isPending }),
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

  // kx-reviewer round 1, finding 1: the server-side whole-hour restriction
  // was removed (club events must support arbitrary times, e.g. 14:15), but
  // the native time inputs still carried `step={3600}` — the UI half of the
  // same restriction, which makes the browser flag any non-`:00` value as
  // `stepMismatch`/invalid regardless of the server accepting it.
  it('schedule start/end time inputs do not constrain to whole hours', async () => {
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    await user.click(screen.getByRole('button', { name: 'clubEvents.createEvent' }))
    await user.click(screen.getByRole('checkbox', { name: 'clubEvents.blocksRooms' }))

    const startInput = screen.getByLabelText('clubEvents.startTime')
    const endInput = screen.getByLabelText('clubEvents.endTime')

    expect(startInput).not.toHaveAttribute('step', '3600')
    expect(endInput).not.toHaveAttribute('step', '3600')
    expect(startInput).toHaveAttribute('step', '60')
    expect(endInput).toHaveAttribute('step', '60')
  })
})

// #408 — same fixed-slot fix as #399/#404, applied to this file's two
// `min-w-[80px]` sites: ClubEventFormDialog's save button (shared between
// create and edit — same JSX either way, so covering it via the create
// flow covers the edit flow identically) and DeleteClubEventDialog's
// delete button.
describe('ClubEventsSection — pending buttons reserve loader space without animating while idle (#408)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createClubEventState.isPending = false
    deleteClubEventState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('create/edit-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    await user.click(screen.getByRole('button', { name: 'clubEvents.createEvent' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
    expect(button).not.toHaveAttribute('aria-busy', 'true')
  })

  it('create/edit-dialog save button: loader mounts while creating', async () => {
    createClubEventState.isPending = true
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    await user.click(screen.getByRole('button', { name: 'clubEvents.createEvent' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('delete-dialog button (destructive variant): icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    // The row's delete trigger and the dialog's confirm button share the
    // same accessible name ('delete') — the trigger stays in the DOM once
    // the dialog opens, so scope the lookup to the dialog itself.
    await user.click(screen.getByRole('button', { name: 'delete' }))
    const dialog = screen.getByRole('dialog')
    const button = within(dialog).getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
  })

  it('delete-dialog button (destructive variant): loader mounts while deleting', async () => {
    deleteClubEventState.isPending = true
    const user = userEvent.setup()
    render(<ClubEventsSection />)

    await user.click(screen.getByRole('button', { name: 'delete' }))
    const dialog = screen.getByRole('dialog')
    const button = within(dialog).getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
