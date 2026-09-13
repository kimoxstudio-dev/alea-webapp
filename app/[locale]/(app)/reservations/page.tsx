import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { MyReservationsView } from '@/components/reservations/my-reservations-view'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { localizedSignInUrl } from '@/lib/server/auth-redirect'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reservations')
  return { title: `${t('title')} — Alea` }
}

interface ReservationsPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function ReservationsPage({ params, searchParams }: ReservationsPageProps) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const session = await getSessionFromServerCookies()
  if (!session) {
    return redirect(localizedSignInUrl(locale, `/${locale}/reservations`, query))
  }
  return <MyReservationsView />
}
