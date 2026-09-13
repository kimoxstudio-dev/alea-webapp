import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UsersSection } from '@/components/admin/users-section'
import type { User } from '@/lib/types'

// #399 — pending-state buttons must reserve the loader icon's space without
// running its animation while idle. A fixed-size wrapper span (`h-4 w-4
// shrink-0`) is always mounted so the button's width never changes; the
// DiceLoader itself (and its infinite CSS animation) only mounts while the
// action is actually pending. These tests assert both halves of that
// mechanism directly rather than a pixel width — jsdom has no layout
// engine, so a width assertion would be meaningless.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}))

// Two users, both with a no-show count and a block, so both row-action
// buttons render on both rows — needed to prove the per-row/per-action
// discrimination on the shared `patchMutation.variables` (not just the
// fixed-slot loader mechanism) actually holds.
const mockUser: User = {
  id: 'user-1',
  memberNumber: 'M-001',
  fullName: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: null,
  role: 'member',
  isActive: true,
  noShowCount: 2,
  blockedUntil: '2026-12-31T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const mockUser2: User = {
  ...mockUser,
  id: 'user-2',
  memberNumber: 'M-002',
  fullName: 'Grace Hopper',
  email: 'grace@example.com',
}

const usersData = {
  data: [mockUser, mockUser2],
  total: 2,
  totalPages: 1,
}

const { patchMutationState, updateMutationState, deleteMutationState } = vi.hoisted(() => ({
  patchMutationState: { isPending: false, variables: undefined as { id: string; action: string } | undefined, mutate: vi.fn() },
  updateMutationState: { isPending: false, mutate: vi.fn() },
  deleteMutationState: { isPending: false, mutate: vi.fn() },
}))

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminUsers: () => ({ data: usersData, isLoading: false, isError: false }),
  useAdminUpdateUser: () => updateMutationState,
  useAdminDeleteUser: () => deleteMutationState,
  useAdminPatchUser: () => patchMutationState,
  useAdminGenerateActivationLink: () => ({ isPending: false, mutateAsync: vi.fn(), variables: undefined }),
  useAdminGenerateRecoveryLink: () => ({ isPending: false, mutateAsync: vi.fn(), variables: undefined }),
  useAdminImportUsers: () => ({ isPending: false, isError: false, mutate: vi.fn() }),
}))

// The fixed-size wrapper span is what keeps the button's width constant —
// it must be present in every state.
function getIconSlot(button: HTMLElement) {
  return button.querySelector('span.shrink-0')
}

// The DiceLoader itself only mounts while pending, so its animation doesn't
// run on idle rows.
function queryLoader(button: HTMLElement) {
  return within(button).queryByTestId('dice-loader')
}

describe('UsersSection — pending buttons reserve loader space without animating while idle (#399)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    patchMutationState.isPending = false
    patchMutationState.variables = undefined
    updateMutationState.isPending = false
    deleteMutationState.isPending = false
  })

  it('reset-no-shows button: icon slot reserved but loader unmounted when idle', () => {
    render(<UsersSection />)
    const [button] = screen.getAllByRole('button', { name: 'resetNoShows' })
    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
    expect(button).not.toBeDisabled()
  })

  it('reset-no-shows button: loader mounts while that row is pending', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'reset_no_shows' }
    render(<UsersSection />)
    const [button] = screen.getAllByRole('button', { name: 'resetNoShows' })
    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
  })

  it('reset-no-shows button on a different row stays unmounted while another row is pending (id discrimination)', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'reset_no_shows' }
    render(<UsersSection />)
    const [, otherRowButton] = screen.getAllByRole('button', { name: 'resetNoShows' })
    expect(queryLoader(otherRowButton)).toBeNull()
  })

  it('reset-no-shows button on the pending row stays unmounted while a different action is pending for that same row (action discrimination)', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'unblock' }
    render(<UsersSection />)
    const [resetButton] = screen.getAllByRole('button', { name: 'resetNoShows' })
    expect(queryLoader(resetButton)).toBeNull()
  })

  it('unblock button: icon slot reserved but loader unmounted when idle', () => {
    render(<UsersSection />)
    const [button] = screen.getAllByRole('button', { name: 'unblockUser' })
    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
  })

  it('unblock button: loader mounts while that row is pending', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'unblock' }
    render(<UsersSection />)
    const [button] = screen.getAllByRole('button', { name: 'unblockUser' })
    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
  })

  it('unblock button on a different row stays unmounted while another row is pending (id discrimination)', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'unblock' }
    render(<UsersSection />)
    const [, otherRowButton] = screen.getAllByRole('button', { name: 'unblockUser' })
    expect(queryLoader(otherRowButton)).toBeNull()
  })

  it('unblock button on the pending row stays unmounted while a different action is pending for that same row (action discrimination)', () => {
    patchMutationState.isPending = true
    patchMutationState.variables = { id: mockUser.id, action: 'reset_no_shows' }
    render(<UsersSection />)
    const [unblockButton] = screen.getAllByRole('button', { name: 'unblockUser' })
    expect(queryLoader(unblockButton)).toBeNull()
  })

  it('edit-dialog save button: icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<UsersSection />)
    const [editButton] = screen.getAllByRole('button', { name: 'editUser' })
    await user.click(editButton)
    const button = screen.getByRole('button', { name: 'save' })
    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
  })

  it('edit-dialog save button: loader mounts while saving', async () => {
    updateMutationState.isPending = true
    const user = userEvent.setup()
    render(<UsersSection />)
    const [editButton] = screen.getAllByRole('button', { name: 'editUser' })
    await user.click(editButton)
    const button = screen.getByRole('button', { name: 'save' })
    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
  })

  it('delete-confirmation button: icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<UsersSection />)
    const [deleteButton] = screen.getAllByRole('button', { name: 'deleteUser' })
    await user.click(deleteButton)
    const button = screen.getByRole('button', { name: 'delete' })
    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(queryLoader(button)).toBeNull()
  })

  it('delete-confirmation button: loader mounts while deleting', async () => {
    deleteMutationState.isPending = true
    const user = userEvent.setup()
    render(<UsersSection />)
    const [deleteButton] = screen.getAllByRole('button', { name: 'deleteUser' })
    await user.click(deleteButton)
    const button = screen.getByRole('button', { name: 'delete' })
    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
  })
})

// #395 — `overflow-y-auto` alone leaves `overflow-x` computed as `auto` per
// the CSS spec, which is the horizontal scrollbar from the bug screenshot.
// `overflow-x-hidden` is the class that actually fixes done-when #1.
describe('UsersSection — import dialog does not leak horizontal overflow (#395)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('import-members DialogContent carries overflow-x-hidden alongside overflow-y-auto', async () => {
    const user = userEvent.setup()
    render(<UsersSection />)
    await user.click(screen.getByRole('button', { name: 'openImportMembers' }))

    const dialogContent = screen.getByRole('dialog')

    expect(dialogContent).toHaveClass('overflow-y-auto', 'overflow-x-hidden')
  })
})
