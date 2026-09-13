'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { ClubEvent } from '@/lib/types'
import { LandingNav } from './landing-nav'
import { HeroSection } from './hero-section'
import { Ticker } from './ticker'
import { EventsSection } from './events-section'
import { EventDetailsDialog } from './event-details-dialog'
import { CustomCursor } from './custom-cursor'
import { HexGridBackground } from './hex-grid-background'
import { EasterEgg } from './easter-egg'
import { DiceRain } from './dice-rain'
import { MeepleHunt } from './meeple-hunt'
import { MeepleEgg } from './meeple-egg'
import { useShake } from '@/lib/hooks/use-shake'
import { useTapCount } from '@/lib/hooks/use-tap-count'

const NAT20_RAIN_DURATION_MS = 7500

interface LandingClientProps {
  locale: string
  upcomingEvents: ClubEvent[]
  pastEvents: ClubEvent[]
  gameLibrarySlot: ReactNode
  aboutSlot: ReactNode
  cultureSlot: ReactNode
  partnersSlot: ReactNode
  ctaSlot: ReactNode
  footerSlot: ReactNode
}

/**
 * Client boundary for the landing page: owns the event-details modal state
 * shared between the hero D20 roller and the events/past-events carousels,
 * and renders the custom cursor. Server-rendered sections that don't need
 * this shared state are passed in as slots so they stay server components.
 */
export function LandingClient({
  locale,
  upcomingEvents,
  pastEvents,
  gameLibrarySlot,
  aboutSlot,
  cultureSlot,
  partnersSlot,
  ctaSlot,
  footerSlot,
}: LandingClientProps) {
  const [selectedEvent, setSelectedEvent] = useState<ClubEvent | null>(null)
  const selectedVariant = selectedEvent && upcomingEvents.some((e) => e.id === selectedEvent.id) ? 'upcoming' : 'past'

  const [eggOpen, setEggOpen] = useState(false)
  const [rain, setRain] = useState(false)
  const [meepleOpen, setMeepleOpen] = useState(false)

  const triggerNat20 = useCallback(() => {
    setEggOpen(true)
    setRain(true)
    setTimeout(() => setRain(false), NAT20_RAIN_DURATION_MS)
  }, [])

  const triggerMeeple = useCallback(() => setMeepleOpen(true), [])

  useShake(triggerNat20)
  useTapCount('[data-egg-tap]', 5, 1800, triggerNat20)

  useEffect(() => {
    const handler = () => triggerNat20()
    window.addEventListener('alea:nat20', handler)
    return () => window.removeEventListener('alea:nat20', handler)
  }, [triggerNat20])

  return (
    <div className="modern-root">
      <HexGridBackground />
      <CustomCursor variant="die" color="#e6c281" />
      <LandingNav locale={locale} />
      <main id="main-content">
        <HeroSection locale={locale} upcomingEvents={upcomingEvents} onPickEvent={setSelectedEvent} />
        <Ticker locale={locale} />
        <EventsSection events={upcomingEvents} locale={locale} variant="upcoming" onSelectEvent={setSelectedEvent} />
        {gameLibrarySlot}
        <EventsSection events={pastEvents} locale={locale} variant="past" onSelectEvent={setSelectedEvent} />
        {aboutSlot}
        {cultureSlot}
        {partnersSlot}
        {ctaSlot}
      </main>
      {footerSlot}

      <EventDetailsDialog
        event={selectedEvent}
        locale={locale}
        variant={selectedVariant}
        onOpenChange={(open) => {
          if (!open) setSelectedEvent(null)
        }}
      />

      <EasterEgg open={eggOpen} onClose={() => setEggOpen(false)} />
      <DiceRain active={rain} />
      <MeepleHunt onCatch={triggerMeeple} />
      <MeepleEgg open={meepleOpen} onClose={() => setMeepleOpen(false)} />
    </div>
  )
}
