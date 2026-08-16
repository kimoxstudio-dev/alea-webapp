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

interface CheckInPageProps {
  params: Promise<{ locale: string; tableId: string }>
  searchParams: Promise<{ side?: string }>
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default async function CheckInPage({ params, searchParams }: CheckInPageProps) {
  const { locale, tableId } = await params
  const { side: sideParam } = await searchParams

  if (!(locales as readonly string[]).includes(locale)) {
    redirect('/')
  }

  if (!UUID_REGEX.test(tableId)) {
    redirect(`/${locale}/rooms`)
  }

  const session = await getSessionFromServerCookies()
  if (!session) {
    redirect(`/${locale}/sign-in?redirect_url=/${locale}/check-in/${tableId}${sideParam === 'inf' ? '?side=inf' : ''}`)
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
