import { describe, it, expect, beforeEach, vi } from 'vitest'

const redirectMock = vi.fn()
const getSessionFromServerCookiesMock = vi.fn()
const getCurrentUserMock = vi.fn()
const markExpiredReservationsAsNoShowMock = vi.fn()

vi.mock('next/navigation', () => ({
  redirect: redirectMock,
}))

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => ((key: string) => key)),
}))

vi.mock('@/lib/server/auth', () => ({
  getSessionFromServerCookies: getSessionFromServerCookiesMock,
}))

vi.mock('@/lib/server/auth-service', () => ({
  getCurrentUser: getCurrentUserMock,
}))

vi.mock('@/lib/server/reservation-no-show', () => ({
  markExpiredReservationsAsNoShow: markExpiredReservationsAsNoShowMock,
}))

describe('auth page guards', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    markExpiredReservationsAsNoShowMock.mockResolvedValue(0)
  })

  it('login page redirects to sign-in (legacy shim)', async () => {
    const { default: LoginPage } = await import('@/app/[locale]/login/page')
    await LoginPage({ params: Promise.resolve({ locale: 'es' }) })

    // /login is a legacy redirect to /sign-in (same pattern as /register post-#206)
    expect(redirectMock).toHaveBeenCalledWith('/es/sign-in')
  })

  it('rooms page redirects unauthenticated users to sign-in', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)

    const { default: RoomsPage } = await import('@/app/[locale]/rooms/page')
    await RoomsPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ date: '2026-08-22', court: '1' }),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      '/es/sign-in?redirect_url=%2Fes%2Frooms%3Fdate%3D2026-08-22%26court%3D1',
    )
    expect(getCurrentUserMock).not.toHaveBeenCalled()
    expect(markExpiredReservationsAsNoShowMock).not.toHaveBeenCalled()
  })

  it('rooms page redirects stale sessions to sign-in', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce({ id: 'session-1', role: 'member' })
    getCurrentUserMock.mockRejectedValueOnce(new Error('stale'))

    const { default: RoomsPage } = await import('@/app/[locale]/rooms/page')
    await RoomsPage({ params: Promise.resolve({ locale: 'es' }), searchParams: Promise.resolve({}) })

    expect(redirectMock).toHaveBeenCalledWith('/es/sign-in?redirect_url=%2Fes%2Frooms')
    expect(markExpiredReservationsAsNoShowMock).not.toHaveBeenCalled()
  })

  it('rooms page marks expired reservations before rendering for a valid session', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce({ id: 'session-1', role: 'member' })
    getCurrentUserMock.mockResolvedValueOnce({ id: 'user-1' })

    const { default: RoomsPage } = await import('@/app/[locale]/rooms/page')
    await RoomsPage({ params: Promise.resolve({ locale: 'es' }), searchParams: Promise.resolve({}) })

    expect(markExpiredReservationsAsNoShowMock).toHaveBeenCalledOnce()
  })

  it('rooms page renders even when no-show expiry fails', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce({ id: 'session-1', role: 'member' })
    getCurrentUserMock.mockResolvedValueOnce({ id: 'user-1' })
    markExpiredReservationsAsNoShowMock.mockRejectedValueOnce(new Error('RPC failed'))

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { default: RoomsPage } = await import('@/app/[locale]/rooms/page')
    const result = await RoomsPage({ params: Promise.resolve({ locale: 'es' }), searchParams: Promise.resolve({}) })

    // Page should resolve successfully (best-effort behavior)
    expect(result).toBeDefined()
    // redirect should NOT be called
    expect(redirectMock).not.toHaveBeenCalled()
    // console.error should have been called to log the failure
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Failed to mark no-show reservations on rooms load',
      expect.any(Error)
    )

    consoleErrorSpy.mockRestore()
  })

  it('root page redirects valid sessions directly to rooms', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce({ id: 'session-1', role: 'member' })
    getCurrentUserMock.mockResolvedValueOnce({ id: 'user-1' })

    const { default: RootPage } = await import('@/app/page')
    await RootPage()

    expect(redirectMock).toHaveBeenCalledWith('/es/rooms')
  })

  it('root page falls through to the public landing page for stale sessions', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce({ id: 'session-1', role: 'member' })
    getCurrentUserMock.mockRejectedValueOnce(new Error('stale'))

    const { default: RootPage } = await import('@/app/page')
    await RootPage()

    expect(redirectMock).toHaveBeenCalledWith('/es')
    expect(redirectMock).not.toHaveBeenCalledWith('/es/login')
  })

  it('root page falls through to the public landing page when there is no session', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)

    const { default: RootPage } = await import('@/app/page')
    await RootPage()

    expect(redirectMock).toHaveBeenCalledWith('/es')
    expect(getCurrentUserMock).not.toHaveBeenCalled()
  })

  it('admin page preserves deep links for signed-out users', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)
    const { default: AdminPage } = await import('@/app/[locale]/admin/page')

    await AdminPage({
      params: Promise.resolve({ locale: 'en' }),
      searchParams: Promise.resolve({ view: 'members' }),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      '/en/sign-in?redirect_url=%2Fen%2Fadmin%3Fview%3Dmembers',
    )
  })

  it('reservations page preserves repeated query values for signed-out users', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)
    const { default: ReservationsPage } = await import('@/app/[locale]/reservations/page')

    await ReservationsPage({
      params: Promise.resolve({ locale: 'es' }),
      searchParams: Promise.resolve({ filter: ['upcoming', 'mine'] }),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      '/es/sign-in?redirect_url=%2Fes%2Freservations%3Ffilter%3Dupcoming%26filter%3Dmine',
    )
  })

  it('check-in page preserves the complete destination for signed-out users', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)
    const { default: CheckInPage } = await import('@/app/[locale]/check-in/[tableId]/page')
    const tableId = 'a6ab66d9-4e4f-4c57-a55e-688e3f7a8b25'

    await CheckInPage({
      params: Promise.resolve({ locale: 'es', tableId }),
      searchParams: Promise.resolve({ side: 'inf', source: 'qr' }),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      `/es/sign-in?redirect_url=${encodeURIComponent(`/es/check-in/${tableId}?side=inf&source=qr`)}`,
    )
  })
})
