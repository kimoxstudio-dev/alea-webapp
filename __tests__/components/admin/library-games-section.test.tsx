import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LibraryGamesSection } from '@/components/admin/library-games-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

// jsdom has no ResizeObserver — Radix's Checkbox (rendered for the "active"
// field) measures itself with one on mount.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-expect-error -- test-only jsdom polyfill
global.ResizeObserver = ResizeObserverMock

const { createGameState, updateGameState, deleteGameState } = vi.hoisted(() => ({
  createGameState: { isPending: false },
  updateGameState: { isPending: false },
  deleteGameState: { isPending: false },
}))

// A row is needed so the edit/delete dialogs are reachable.
const libraryGameFixture = [{
  id: 'lg-1',
  title: 'Catan',
  categoryEs: 'Estrategia',
  categoryEn: 'Strategy',
  players: '3-4',
  playTime: '60-90 min',
  weight: 2.5,
  sortOrder: 0,
  imgUrl: null,
  active: true,
}]

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminLibraryGames: () => ({ data: libraryGameFixture, isLoading: false }),
  useAdminCreateLibraryGame: () => ({ mutateAsync: vi.fn(), isPending: createGameState.isPending }),
  useAdminUpdateLibraryGame: () => ({ mutateAsync: vi.fn(), isPending: updateGameState.isPending }),
  useAdminDeleteLibraryGame: () => ({ mutateAsync: vi.fn(), isPending: deleteGameState.isPending }),
  useAdminUploadImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

// #404 — same fixed-slot fix as #399/EquipmentSection/PartnersSection,
// applied to this file's `min-w-[80px]` floor pattern. No prior test file
// existed for this component; only the width-stability coverage is added
// here, not a full component test suite (out of this fix's scope).
describe('LibraryGamesSection — pending buttons reserve loader space without animating while idle (#404)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createGameState.isPending = false
    updateGameState.isPending = false
    deleteGameState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('create-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.createLibraryGame' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('create-dialog save button: loader mounts while creating', async () => {
    createGameState.isPending = true
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.createLibraryGame' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('edit-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.editLibraryGame' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('edit-dialog save button: loader mounts while saving', async () => {
    updateGameState.isPending = true
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.editLibraryGame' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('delete-dialog button (destructive variant): icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.deleteLibraryGame' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('delete-dialog button (destructive variant): loader mounts while deleting', async () => {
    deleteGameState.isPending = true
    const user = userEvent.setup()
    render(<LibraryGamesSection />)

    await user.click(screen.getByRole('button', { name: 'libraryGames.deleteLibraryGame' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
