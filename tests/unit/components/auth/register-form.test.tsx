import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RegisterForm } from '@/components/auth/register-form'

// Mock next-intl's getTranslations to return a simple translator function
vi.mock('next-intl/server', () => ({
  getTranslations: () => (key: string) => {
    const translations: Record<string, string> = {
      registerUnavailableTitle: 'Registration is temporarily unavailable',
      registerUnavailableBody: 'We have paused self-service registration while the authentication cutover is being finalized. Please sign in with an existing account or contact the association to request access.',
      login: 'Sign In',
      hasAccount: 'Already have an account?',
    }
    return translations[key] || key
  },
}))

describe('RegisterForm', () => {
  it('renders disabled-state message with i18n keys', async () => {
    render(await RegisterForm({ locale: 'en' }))

    expect(screen.getByText('Registration is temporarily unavailable')).toBeInTheDocument()
    expect(
      screen.getByText(
        'We have paused self-service registration while the authentication cutover is being finalized. Please sign in with an existing account or contact the association to request access.'
      )
    ).toBeInTheDocument()
  })

  it('renders login links pointing to the correct locale', async () => {
    render(await RegisterForm({ locale: 'en' }))

    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(2)

    // Both links should point to /en/login
    links.forEach((link) => {
      expect(link.getAttribute('href')).toMatch(/\/en\/login/)
    })
  })

  it('uses the locale param in login link hrefs', async () => {
    render(await RegisterForm({ locale: 'es' }))

    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThanOrEqual(2)

    // Both links should point to /es/login
    links.forEach((link) => {
      expect(link.getAttribute('href')).toMatch(/\/es\/login/)
    })
  })

  it('does not render form inputs or submit button', async () => {
    render(await RegisterForm({ locale: 'en' }))

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /register/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/member number/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
  })
})
