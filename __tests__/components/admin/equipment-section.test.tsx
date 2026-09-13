import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EquipmentSection } from '@/components/admin/equipment-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const mockCreateMutateAsync = vi.fn()

const { createEquipmentState, updateEquipmentState, deleteEquipmentState } = vi.hoisted(() => ({
  createEquipmentState: { isPending: false },
  updateEquipmentState: { isPending: false },
  deleteEquipmentState: { isPending: false },
}))

const equipmentFixture = [{ id: 'eq-1', name: 'Projector', description: null }]

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminEquipment: () => ({ data: equipmentFixture, isLoading: false }),
  useAdminCreateEquipment: () => ({ mutateAsync: mockCreateMutateAsync, isPending: createEquipmentState.isPending }),
  useAdminUpdateEquipment: () => ({ mutateAsync: vi.fn(), isPending: updateEquipmentState.isPending }),
  useAdminDeleteEquipment: () => ({ mutateAsync: vi.fn(), isPending: deleteEquipmentState.isPending }),
}))

describe('EquipmentSection — required-field validation (#313)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks submitting the create form with a blank required name and shows a translated error, not a native browser bubble', async () => {
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.createEquipment' }))
    // Name left blank — submit anyway.
    await user.click(screen.getByRole('button', { name: 'save' }))

    // The translated, app-controlled message must appear...
    expect(await screen.findByRole('alert')).toHaveTextContent('requiredField')
    // ...and the mutation (which would create a blank-named record) must
    // never fire — the whole point of validating before submit.
    expect(mockCreateMutateAsync).not.toHaveBeenCalled()

    // The form opts out of native HTML validation entirely (no English
    // "Please fill out this field" bubble competing with the message above).
    const nameInput = screen.getByLabelText('equipment.equipmentName')
    expect(nameInput.closest('form')).toHaveAttribute('novalidate')

    // Focus must move to the offending field so a keyboard/screen-reader
    // user lands on it without having to hunt for the error.
    expect(nameInput).toHaveFocus()
  })

  it('submits once the required name is filled in', async () => {
    mockCreateMutateAsync.mockResolvedValueOnce({ id: 'eq-1', name: 'Projector', description: null })
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.createEquipment' }))
    await user.type(screen.getByLabelText('equipment.equipmentName'), 'Projector')
    await user.click(screen.getByRole('button', { name: 'save' }))

    expect(mockCreateMutateAsync).toHaveBeenCalledWith({ name: 'Projector', description: undefined })
  })
})

// #404 — same fixed-slot fix as #399, applied to the `min-w-[80px]` floor
// pattern (a floor doesn't provably hold against a long enough pending
// label, unlike a fixed-size slot). Also drops the label swap (`save` ->
// `saving`), matching #399's decision to keep label text constant.
describe('EquipmentSection — pending buttons reserve loader space without animating while idle (#404)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createEquipmentState.isPending = false
    updateEquipmentState.isPending = false
    deleteEquipmentState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('create-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.createEquipment' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('create-dialog save button: loader mounts while creating', async () => {
    createEquipmentState.isPending = true
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.createEquipment' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('edit-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.editEquipment' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('edit-dialog save button: loader mounts while saving', async () => {
    updateEquipmentState.isPending = true
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.editEquipment' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('delete-dialog button (destructive variant): icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.deleteEquipment' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('delete-dialog button (destructive variant): loader mounts while deleting', async () => {
    deleteEquipmentState.isPending = true
    const user = userEvent.setup()
    render(<EquipmentSection />)

    await user.click(screen.getByRole('button', { name: 'equipment.deleteEquipment' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
