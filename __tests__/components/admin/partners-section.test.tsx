import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnersSection } from '@/components/admin/partners-section'

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

const mockCreateMutateAsync = vi.fn()

const { createPartnerState, updatePartnerState, deletePartnerState } = vi.hoisted(() => ({
  createPartnerState: { isPending: false },
  updatePartnerState: { isPending: false },
  deletePartnerState: { isPending: false },
}))

// A row is needed so the edit/delete dialogs (#404 tests below) are
// reachable — the #313 tests above only interact with the create dialog and
// are unaffected by a row being present.
const partnerFixture = [{
  id: 'p-1',
  name: 'Acme Games',
  imageUrl: 'https://example.com/logo.png',
  linkUrl: 'https://acme.example.com',
  descriptionEs: null,
  descriptionEn: null,
  sortOrder: 0,
  active: true,
}]

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminPartners: () => ({ data: partnerFixture, isLoading: false }),
  useAdminCreatePartner: () => ({ mutateAsync: mockCreateMutateAsync, isPending: createPartnerState.isPending }),
  useAdminUpdatePartner: () => ({ mutateAsync: vi.fn(), isPending: updatePartnerState.isPending }),
  useAdminDeletePartner: () => ({ mutateAsync: vi.fn(), isPending: deletePartnerState.isPending }),
  useAdminUploadImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

describe('PartnersSection — URL field validation (#313)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('blocks submitting the create form with an invalid linkUrl and shows the inline error, not a native browser bubble', async () => {
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.createPartner' }))

    await user.type(screen.getByLabelText('partners.name'), 'Acme Games')
    await user.type(screen.getByLabelText('partners.imageUrl'), 'https://example.com/logo.png')
    await user.type(screen.getByLabelText('partners.linkUrl'), 'not-a-url')

    await user.click(screen.getByRole('button', { name: 'save' }))

    // The translated, app-controlled field-level message must appear...
    expect(await screen.findByRole('alert')).toHaveTextContent('invalidUrl')
    // ...anchored to the linkUrl input specifically.
    const linkUrlInput = screen.getByLabelText('partners.linkUrl')
    expect(linkUrlInput).toHaveAttribute('aria-invalid', 'true')
    // Focus must move to linkUrl specifically — not just "the only input",
    // since this form has three fields, proving the ref-keying targets the
    // actual offending field rather than always focusing the first one.
    expect(linkUrlInput).toHaveFocus()
    // ...and the mutation (which would persist an invalid URL) must never fire.
    expect(mockCreateMutateAsync).not.toHaveBeenCalled()
  })

  it('submits once the linkUrl is a valid absolute http(s) URL', async () => {
    mockCreateMutateAsync.mockResolvedValueOnce({ id: 'p-1' })
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.createPartner' }))

    await user.type(screen.getByLabelText('partners.name'), 'Acme Games')
    await user.type(screen.getByLabelText('partners.imageUrl'), 'https://example.com/logo.png')
    await user.type(screen.getByLabelText('partners.linkUrl'), 'https://acme.example.com')

    await user.click(screen.getByRole('button', { name: 'save' }))

    expect(mockCreateMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ linkUrl: 'https://acme.example.com' }),
    )
  })
})

// #404 — same fixed-slot fix as #399/EquipmentSection, applied to this
// file's `min-w-[80px]` floor pattern.
describe('PartnersSection — pending buttons reserve loader space without animating while idle (#404)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createPartnerState.isPending = false
    updatePartnerState.isPending = false
    deletePartnerState.isPending = false
  })

  function getIconSlot(button: HTMLElement) {
    return button.querySelector('span.shrink-0')
  }

  function queryLoader(button: HTMLElement) {
    return within(button).queryByTestId('dice-loader')
  }

  it('create-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.createPartner' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('create-dialog save button: loader mounts while creating', async () => {
    createPartnerState.isPending = true
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.createPartner' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('edit-dialog save button: icon slot reserved with correct sizing but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.editPartner' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('edit-dialog save button: loader mounts while saving', async () => {
    updatePartnerState.isPending = true
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.editPartner' }))
    const button = screen.getByRole('button', { name: 'save' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  it('delete-dialog button (destructive variant): icon slot reserved but loader unmounted when idle', async () => {
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.deletePartner' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).toHaveClass('h-4', 'w-4', 'shrink-0')
    expect(getIconSlot(button)).toHaveClass('absolute')
    expect(button).toHaveClass('relative')
    expect(queryLoader(button)).toBeNull()
  })

  it('delete-dialog button (destructive variant): loader mounts while deleting', async () => {
    deletePartnerState.isPending = true
    const user = userEvent.setup()
    render(<PartnersSection />)

    await user.click(screen.getByRole('button', { name: 'partners.deletePartner' }))
    const button = screen.getByRole('button', { name: 'delete' })

    expect(getIconSlot(button)).not.toBeNull()
    expect(queryLoader(button)).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
  })
})
