import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { MyReservationsView } from '@/components/reservations/my-reservations-view'
import { getSessionFromServerCookies } from '@/lib/server/auth'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('reservations')
  return { title: `${t('title')} — Alea` }
}

interface ReservationsPageProps {
  params: Promise<{ locale: string }>
}

export default async function ReservationsPage({ params }: ReservationsPageProps) {
  const { locale } = await params
  const session = await getSessionFromServerCookies()
  if (!session) {
    redirect(`/${locale}/sign-in`)
  }
  return <MyReservationsView />
}
