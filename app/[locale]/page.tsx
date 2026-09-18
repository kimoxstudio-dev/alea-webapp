import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import { getCurrentClubDate } from '@/lib/club-time'
import { listClubEvents, type ListClubEventsResult } from '@/lib/server/club-events-service'
import { listPartners } from '@/lib/server/partners-service'
import { listLibraryGames } from '@/lib/server/library-games-service'
import type { LibraryGame, Partner } from '@/lib/types'
import { LandingView } from '@/components/landing/landing-view'

interface HomePageProps {
  params: Promise<{ locale: string }>
}

const EMPTY_CLUB_EVENTS: ListClubEventsResult = { upcoming: [], past: [] }

/**
 * The public landing page must always render, even if a data source is
 * down — a single failing fetch should never hard-500 the whole page.
 * Each loader degrades to an empty result and logs server-side so the
 * failure is still visible in observability, while the relevant landing
 * section falls back to its own empty state.
 */
async function loadClubEvents(): Promise<ListClubEventsResult> {
  try {
    // Cache successful public reads only, never the empty error fallback.
    // A date-specific key reclassifies upcoming/past events at club midnight.
    return await unstable_cache(listClubEvents, ['landing-club-events', getCurrentClubDate()], {
      revalidate: 60,
      tags: ['landing-club-events'],
    })()
  } catch (err) {
    console.error('[HomePage] Failed to load club events for the public landing page', err)
    return EMPTY_CLUB_EVENTS
  }
}

async function loadPartners(): Promise<Partner[]> {
  try {
    return await unstable_cache(listPartners, ['landing-partners'], {
      revalidate: 60,
      tags: ['landing-partners'],
    })()
  } catch (err) {
    console.error('[HomePage] Failed to load partners for the public landing page', err)
    return []
  }
}

async function loadLibraryGames(): Promise<LibraryGame[]> {
  try {
    return await unstable_cache(listLibraryGames, ['landing-library-games'], {
      revalidate: 60,
      tags: ['landing-library-games'],
    })()
  } catch (err) {
    console.error('[HomePage] Failed to load library games for the public landing page', err)
    return []
  }
}

export async function generateMetadata({ params }: HomePageProps): Promise<Metadata> {
  const { locale } = await params
  const t = await getTranslations({ locale, namespace: 'home' })

  return { title: `Alea — ${t('hero.titleA')} ${t('hero.titleB')} ${t('hero.titleC')}` }
}

export default async function HomePage({ params }: HomePageProps) {
  const { locale } = await params

  // Authenticated users deliberately view this same public landing page —
  // it doubles as the club's marketing/info entry point. This route lives
  // outside the `(app)` route group, so Clerk/AuthProvider/Header/Footer
  // are never part of its tree at all — there is no redirect to /rooms for
  // signed-in users. Do NOT add one back.

  const [{ upcoming, past }, partners, games] = await Promise.all([
    loadClubEvents(),
    loadPartners(),
    loadLibraryGames(),
  ])

  return (
    <LandingView
      locale={locale}
      upcomingEvents={upcoming}
      pastEvents={past}
      partners={partners}
      games={games}
    />
  )
}
