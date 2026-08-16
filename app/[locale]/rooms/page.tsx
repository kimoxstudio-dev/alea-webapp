import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { RoomsView } from '@/components/rooms/rooms-view'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { getCurrentUser } from '@/lib/server/auth-service'
import { markExpiredReservationsAsNoShow } from '@/lib/server/reservation-no-show'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('rooms')
  return { title: `${t('title')} — Alea` }
}

interface RoomsPageProps {
  params: Promise<{ locale: string }>
}

export default async function RoomsPage({ params }: RoomsPageProps) {
  const { locale } = await params
  const session = await getSessionFromServerCookies()
  if (!session) {
    return redirect(`/${locale}/sign-in`)
  }

  try {
    await getCurrentUser(session)
  } catch {
    return redirect(`/${locale}/sign-in`)
  }

  try {
    await markExpiredReservationsAsNoShow()
  } catch (error) {
    console.error('Failed to mark no-show reservations on rooms load', error)
  }

  return <RoomsView />
}
