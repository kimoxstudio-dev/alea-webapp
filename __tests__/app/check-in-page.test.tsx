import { describe, it, expect, beforeEach, vi } from 'vitest'

const redirectMock = vi.fn()
const getSessionFromServerCookiesMock = vi.fn()
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

vi.mock('@/lib/server/reservation-no-show', () => ({
  markExpiredReservationsAsNoShow: markExpiredReservationsAsNoShowMock,
}))

// Regression coverage for #330 follow-up (commit 4600763): the sign-in
// redirect built by the check-in page must preserve the FULL query string,
// not just `side`, mirroring middleware.ts's use of `request.nextUrl.search`.
describe('check-in page sign-in redirect', () => {
  const TABLE_ID = '11111111-1111-1111-1111-111111111111'

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    markExpiredReservationsAsNoShowMock.mockResolvedValue(0)
  })

  it('preserves every query param (not just side) when redirecting an unauthenticated request to sign-in', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)

    const { default: CheckInPage } = await import('@/app/[locale]/check-in/[tableId]/page')
    await CheckInPage({
      params: Promise.resolve({ locale: 'es', tableId: TABLE_ID }),
      searchParams: Promise.resolve({ side: 'inf', foo: 'bar' }),
    })

    // redirect_url must carry BOTH side=inf and foo=bar, URL-encoded as a
    // single query value on the /sign-in redirect — not just `side`.
    expect(redirectMock).toHaveBeenCalledWith(
      `/es/sign-in?redirect_url=%2Fes%2Fcheck-in%2F${TABLE_ID}%3Fside%3Dinf%26foo%3Dbar`
    )
  })

  it('preserves repeated query keys as multiple values, matching URLSearchParams array semantics', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)

    const { default: CheckInPage } = await import('@/app/[locale]/check-in/[tableId]/page')
    await CheckInPage({
      params: Promise.resolve({ locale: 'es', tableId: TABLE_ID }),
      // Next.js resolves a repeated query key (e.g. ?tag=a&tag=b) to an array.
      searchParams: Promise.resolve({ tag: ['a', 'b'] }),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      `/es/sign-in?redirect_url=%2Fes%2Fcheck-in%2F${TABLE_ID}%3Ftag%3Da%26tag%3Db`
    )
  })

  it('does not append a query string to the redirect target when there are no query params', async () => {
    getSessionFromServerCookiesMock.mockResolvedValueOnce(null)

    const { default: CheckInPage } = await import('@/app/[locale]/check-in/[tableId]/page')
    await CheckInPage({
      params: Promise.resolve({ locale: 'es', tableId: TABLE_ID }),
      searchParams: Promise.resolve({}),
    })

    expect(redirectMock).toHaveBeenCalledWith(
      `/es/sign-in?redirect_url=%2Fes%2Fcheck-in%2F${TABLE_ID}`
    )
  })
})
