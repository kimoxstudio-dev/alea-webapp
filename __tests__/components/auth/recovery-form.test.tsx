import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RecoveryForm } from '@/components/auth/recovery-form'
import { apiClient } from '@/lib/api/client'

// next-intl's `t` returns the raw key (no translation files needed) — lets
// the assertions below check that the CORRECT translation key was selected
// for a given server error code, without loading messages/*.json.
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

// A password that passes this app's own 8-char client checklist but is the
// kind of value Clerk's real (15+ char) policy rejects (#313 repro).
const CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD = 'Password1'

async function fillAndSubmit(password: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('password'), password)
  await user.type(screen.getByLabelText('confirmPassword'), password)
  await user.click(screen.getByRole('button', { name: 'recoveryAction' }))
}

describe('RecoveryForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps a AUTH_PASSWORD_REJECTED server code to its translated message key, not the raw code (#313)', async () => {
    mockPost.mockRejectedValueOnce({ message: 'AUTH_PASSWORD_REJECTED', statusCode: 400 })

    render(<RecoveryForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('errors.servicePasswordRejected')
    // The defect this fixes: the raw machine code must never reach the DOM.
    expect(alert.textContent).not.toContain('AUTH_PASSWORD_REJECTED')
  })

  it('falls back to the generic translated message for an unmapped error', async () => {
    mockPost.mockRejectedValueOnce({ message: 'Some unexpected server text', statusCode: 500 })

    render(<RecoveryForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('recoveryInvalidBody')
  })

  it('maps AUTH_RECOVERY_LINK_EXPIRED to its translated message key', async () => {
    mockPost.mockRejectedValueOnce({ message: 'AUTH_RECOVERY_LINK_EXPIRED', statusCode: 400 })

    render(<RecoveryForm locale="es" token="tok-1" />)
    await fillAndSubmit(CLIENT_VALID_BUT_SERVER_REJECTED_PASSWORD)

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe('errors.serviceRecoveryLinkExpired')
    })
  })
})
