import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { CheckInActivator } from '@/components/check-in/check-in-activator'
import { locales } from '@/lib/i18n/config'
import { markExpiredReservationsAsNoShow } from '@/lib/server/reservation-no-show'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('checkin')
  return { title: `${t('title')} — Alea` }
}

type CheckInSearchParams = Record<string, string | string[] | undefined>

interface CheckInPageProps {
  params: Promise<{ locale: string; tableId: string }>
  searchParams: Promise<CheckInSearchParams>
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function CheckInPage({ params, searchParams }: CheckInPageProps) {
  const { locale, tableId } = await params
  const resolvedSearchParams = await searchParams
  const sideParam = typeof resolvedSearchParams.side === 'string' ? resolvedSearchParams.side : undefined

  if (!(locales as readonly string[]).includes(locale)) {
    redirect('/')
  }

  if (!UUID_REGEX.test(tableId)) {
    redirect(`/${locale}/rooms`)
  }

  const session = await getSessionFromServerCookies()
  if (!session) {
    // Preserve the FULL query string on the redirect target (not just
    // `side`), mirroring middleware.ts's use of `request.nextUrl.search`.
    const preservedQuery = new URLSearchParams()
    for (const [key, value] of Object.entries(resolvedSearchParams)) {
      if (Array.isArray(value)) {
        for (const item of value) preservedQuery.append(key, item)
      } else if (value !== undefined) {
        preservedQuery.set(key, value)
      }
    }
    const checkInPath = `/${locale}/check-in/${tableId}${
      preservedQuery.size > 0 ? `?${preservedQuery.toString()}` : ''
    }`
    const signInParams = new URLSearchParams({ redirect_url: checkInPath })
    redirect(`/${locale}/sign-in?${signInParams.toString()}`)
  }

  try {
    await markExpiredReservationsAsNoShow()
  } catch (error) {
    console.error('Failed to mark no-show reservations on check-in load', error)
  }

  return (
    <main id="main-content">
      <CheckInActivator tableId={tableId} side={sideParam} />
    </main>
  )
}
