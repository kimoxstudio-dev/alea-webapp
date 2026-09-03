'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import type { ClubEvent } from '@/lib/types'
import { formatClubEventDate, getClubEventTone } from '@/lib/club-events-format'

interface EventDetailsDialogProps {
  event: ClubEvent | null
  locale: string
  variant: 'upcoming' | 'past'
  onOpenChange: (open: boolean) => void
}

export function EventDetailsDialog({ event, locale, variant, onOpenChange }: EventDetailsDialogProps) {
  const t = useTranslations('home')

  useEffect(() => {
    if (!event) return
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener('keydown', onKey)
    }
  }, [event, onOpenChange])

  if (!event) return null

  const title = locale === 'en' ? event.titleEn : event.titleEs
  const blurb = locale === 'en' ? event.blurbEn : event.blurbEs
  const description =
    (locale === 'en' ? event.descriptionEn : event.descriptionEs) ?? blurb
  const dateLabel = formatClubEventDate(event, locale)
  const tone = getClubEventTone(event.id)

  return (
    <div className={`mod-modal-backdrop mod-modal-${tone}`} onClick={() => onOpenChange(false)}>
      <div
        className="mod-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button className="mod-modal-close" onClick={() => onOpenChange(false)} aria-label={t('modal.close')}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M6 6 L 18 18 M18 6 L 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
        <div className="mod-modal-hero">
          {event.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.imageUrl} alt={title} />
          ) : (
            <div className="mod-modal-hero-placeholder" aria-hidden="true" />
          )}
          <div className="mod-modal-hero-overlay">
            <span className="mod-modal-tag">
              {variant === 'upcoming' ? t('eventStatus.upcoming') : t('eventStatus.past')}
            </span>
            <h2 id="modal-title">{title}</h2>
            <p className="mod-modal-blurb">{blurb}</p>
          </div>
        </div>
        <div className="mod-modal-body">
          <div className="mod-modal-grid">
            <div className="mod-modal-meta">
              <div className="mod-modal-meta-row">
                <span className="mod-modal-meta-label">{t('modal.when')}</span>
                <span className="mod-modal-meta-value">{dateLabel}</span>
              </div>
              <div className="mod-modal-meta-row">
                <span className="mod-modal-meta-label">{t('modal.where')}</span>
                <span className="mod-modal-meta-value">
                  <a href={t('business.mapsUrl')} target="_blank" rel="noopener noreferrer">
                    {t('business.address')}
                  </a>
                </span>
              </div>
            </div>
            <div className="mod-modal-content">
              <h3>{t('modal.what')}</h3>
              {/* The remaining when/who/price/organizer/bullets detail from the source
                  design is embedded as formatted text in `description` — the events
                  schema (lib/db/schema/) has no dedicated columns for those fields. */}
              <p>{description}</p>
            </div>
          </div>
          {variant === 'upcoming' && (
            <div className="mod-modal-actions">
              {event.linkUrl && (
                <a className="mod-btn mod-btn-primary mod-btn-lg" href={event.linkUrl} target="_blank" rel="noopener noreferrer">
                  {t('modal.signup')} →
                </a>
              )}
              <a className="mod-btn mod-btn-ghost" href={t('business.mapsUrl')} target="_blank" rel="noopener noreferrer">
                {t('modal.directions')}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
