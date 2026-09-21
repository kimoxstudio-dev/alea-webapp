import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LoginForm } from '@/components/auth/login-form'
import { useSignIn } from '@clerk/nextjs/legacy'
import { ClerkAPIResponseError } from '@clerk/nextjs/errors'

vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => (key: string) =>
    namespace ? `${namespace}.${key}` : key,
}))

const mockPush = vi.fn()
const mockRefresh = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
  usePathname: () => '/es/rooms',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@clerk/nextjs/legacy', () => ({
  useSignIn: vi.fn(),
}))

const { isSignedInState } = vi.hoisted(() => ({
  isSignedInState: { value: false },
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: isSignedInState.value }),
}))

const mockUseSignIn = vi.mocked(useSignIn)
const mockSignInCreate = vi.fn()
const mockSetActive = vi.fn()

async function fillAndSubmit() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('auth.memberNumber'), '1234')
  await user.type(screen.getByLabelText('auth.password'), 'secret')
  await user.click(screen.getByRole('button', { name: 'auth.login' }))
}

describe('LoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isSignedInState.value = false
    mockUseSignIn.mockReturnValue({
      isLoaded: true,
      signIn: { create: mockSignInCreate },
      setActive: mockSetActive,
    } as unknown as ReturnType<typeof useSignIn>)
  })

  it('uses Clerk navigation after a successful sign-in', async () => {
    mockSignInCreate.mockResolvedValue({ status: 'complete', createdSessionId: 'sess-1' })

    render(<LoginForm locale="es" />)
    await fillAndSubmit()

    expect(mockSetActive).toHaveBeenCalledWith({
      session: 'sess-1',
      navigate: expect.any(Function),
    })

    const navigate = mockSetActive.mock.calls[0][0].navigate
    const decorateUrl = vi.fn(() => '#after-login')
    navigate({ decorateUrl })

    expect(decorateUrl).toHaveBeenCalledWith('/es/rooms')
    expect(window.location.hash).toBe('#after-login')
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  // #405: a re-submit while already authenticated (session established by
  // an earlier successful submit that's still settling its redirect) must
  // never call signIn.create() — that would throw Clerk's `session_exists`
  // error, surface a false "invalid credentials" message, and burn the
  // authLogin rate limit on a session the user already holds. It must
  // instead redirect straight away, same as a normal successful sign-in.
  it('redirects immediately without calling signIn.create() when already signed in', async () => {
    isSignedInState.value = true

    render(<LoginForm locale="es" />)
    await fillAndSubmit()

    expect(mockSignInCreate).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockPush).toHaveBeenCalledWith('/es/rooms')
    expect(mockRefresh).toHaveBeenCalled()
  })

  // Defense-in-depth for the isSignedIn guard: isSignedIn is React state
  // that updates asynchronously after setActive() resolves, so a resubmit
  // can still reach signIn.create() in the narrow window before that state
  // update commits (the guard's own render still saw isSignedIn=false).
  // Clerk throws its documented `session_exists` error code for that case
  // — this must redirect the same way the guard does, not surface the
  // generic "invalid credentials" message.
  it('redirects instead of showing an error when signIn.create() throws Clerk\'s session_exists error', async () => {
    mockSignInCreate.mockRejectedValue(
      new ClerkAPIResponseError('Session already exists', {
        data: [{ code: 'session_exists', message: 'You are already signed in.' }],
        status: 422,
      }),
    )

    render(<LoginForm locale="es" />)
    await fillAndSubmit()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mockPush).toHaveBeenCalledWith('/es/rooms')
    expect(mockRefresh).toHaveBeenCalled()
  })

  it('does not call router.refresh() when sign-in does not complete', async () => {
    mockSignInCreate.mockResolvedValue({ status: 'needs_second_factor', createdSessionId: null })

    render(<LoginForm locale="es" />)
    await fillAndSubmit()

    expect(await screen.findByRole('alert')).toHaveTextContent('auth.errors.invalidCredentials')
    expect(mockPush).not.toHaveBeenCalled()
    expect(mockRefresh).not.toHaveBeenCalled()
  })
})
