import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ActivationForm } from '@/components/auth/activation-form'
import { apiClient } from '@/lib/api/client'

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: vi.fn() },
}))

const mockPost = vi.mocked(apiClient.post)

const CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD = 'Password1'

async function fillAndSubmit(password: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('password'), password)
  await user.type(screen.getByLabelText('confirmPassword'), password)
  await user.click(screen.getByRole('button', { name: 'activationAction' }))
}

describe('ActivationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps a AUTH_PASSWORD_REJECTED server code to its translated message key, not the raw code (#313 defect class)', async () => {
    mockPost.mockRejectedValueOnce({ message: 'AUTH_PASSWORD_REJECTED', statusCode: 400 })

    render(<ActivationForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('errors.servicePasswordRejected')
    expect(alert.textContent).not.toContain('AUTH_PASSWORD_REJECTED')
  })

  it('maps AUTH_ACTIVATION_LINK_USED to its translated message key', async () => {
    mockPost.mockRejectedValueOnce({ message: 'AUTH_ACTIVATION_LINK_USED', statusCode: 400 })

    render(<ActivationForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('errors.serviceActivationLinkUsed')
    })
  })

  it('falls back to the generic translated message for an unmapped error', async () => {
    mockPost.mockRejectedValueOnce({ message: 'Some unexpected server text', statusCode: 500 })

    render(<ActivationForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('activationInvalidBody')
  })
})
