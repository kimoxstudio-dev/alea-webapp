import type { ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivationForm } from '@/components/auth/activation-form'
import { RecoveryForm } from '@/components/auth/recovery-form'
import esMessages from '@/messages/es.json'

const routerPushMock = vi.fn()

const apiClientMock = vi.hoisted(() => ({
  post: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
}))

vi.mock('@/lib/api/client', () => ({
  apiClient: apiClientMock,
}))

function renderWithIntl(ui: ReactNode) {
  return render(
    <NextIntlClientProvider locale="es" messages={esMessages}>
      {ui}
    </NextIntlClientProvider>,
  )
}

describe('password setup flows', () => {
  beforeEach(() => {
    apiClientMock.post.mockReset()
    routerPushMock.mockReset()
  })

  it('redirects to login after a successful activation', async () => {
    apiClientMock.post.mockResolvedValueOnce({ ok: true })
    renderWithIntl(<ActivationForm locale="es" token="activation-token" />)

    fireEvent.change(screen.getByLabelText('Contraseña'), {
      target: { value: 'Password123' },
    })
    fireEvent.change(screen.getByLabelText('Confirmar contraseña'), {
      target: { value: 'Password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Activar cuenta' }))

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/auth/activate', {
        token: 'activation-token',
        password: 'Password123',
      })
    })
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/es/login'))
  })

  it('redirects to login after a successful recovery', async () => {
    apiClientMock.post.mockResolvedValueOnce({ ok: true })
    renderWithIntl(<RecoveryForm locale="es" token="recovery-token" />)

    fireEvent.change(screen.getByLabelText('Contraseña'), {
      target: { value: 'Password123' },
    })
    fireEvent.change(screen.getByLabelText('Confirmar contraseña'), {
      target: { value: 'Password123' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Guardar nueva contraseña' }))

    await waitFor(() => {
      expect(apiClientMock.post).toHaveBeenCalledWith('/auth/recover', {
        token: 'recovery-token',
        password: 'Password123',
      })
    })
    await waitFor(() => expect(routerPushMock).toHaveBeenCalledWith('/es/login'))
  })
})
