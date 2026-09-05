import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EquipmentSection } from '@/components/admin/equipment-section'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

const mockCreateMutateAsync = vi.fn()

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminEquipment: () => ({ data: [], isLoading: false }),
  useAdminCreateEquipment: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
  useAdminUpdateEquipment: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminDeleteEquipment: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
