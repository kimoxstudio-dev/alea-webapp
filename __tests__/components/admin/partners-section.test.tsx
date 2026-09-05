import { render, screen } from '@testing-library/react'
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

vi.mock('@/lib/hooks/use-admin', () => ({
  useAdminPartners: () => ({ data: [], isLoading: false }),
  useAdminCreatePartner: () => ({ mutateAsync: mockCreateMutateAsync, isPending: false }),
  useAdminUpdatePartner: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAdminDeletePartner: () => ({ mutateAsync: vi.fn(), isPending: false }),
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
    expect(screen.getByLabelText('partners.linkUrl')).toHaveAttribute('aria-invalid', 'true')
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
