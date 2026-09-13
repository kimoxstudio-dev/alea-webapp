'use client'

import { useTranslations } from 'next-intl'
import type { ClubEvent } from '@/lib/types'
import { formatClubEventDate, getClubEventTone } from '@/lib/club-events-format'

interface EventCardProps {
  event: ClubEvent
  locale: string
  onSelect: (event: ClubEvent) => void
}

export function EventCard({ event, locale, onSelect }: EventCardProps) {
  const t = useTranslations('home')
  const title = locale === 'en' ? event.titleEn : event.titleEs
  const blurb = locale === 'en' ? event.blurbEn : event.blurbEs
  const dateLabel = formatClubEventDate(event, locale)
  const tone = getClubEventTone(event.id)

  return (
    <article className={`mod-event mod-event-${tone}`}>
      <button
        type="button"
        className="mod-event-btn"
        onClick={() => onSelect(event)}
        draggable="false"
        onDragStart={(e) => e.preventDefault()}
      >
        <span className="mod-event-img">
          {event.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.imageUrl} alt="" loading="lazy" draggable="false" onDragStart={(e) => e.preventDefault()} />
          ) : (
            <span className="mod-event-img-placeholder" aria-hidden="true" />
          )}
          <span className="mod-event-date-pill">{dateLabel}</span>
        </span>
        <span className="mod-event-body">
          <span className="mod-event-h3">{title}</span>
          <span className="mod-event-blurb">{blurb}</span>
          <span className="mod-event-foot">
            <span className="mod-event-meta" />
            <span className="mod-event-link">
              {t('events.cta')} <span aria-hidden="true">→</span>
            </span>
          </span>
        </span>
      </button>
    </article>
  )
}
