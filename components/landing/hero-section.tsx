'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ClubEvent } from '@/lib/types'
import { D20 } from './d20'
import { formatClubEventDate } from '@/lib/club-events-format'

interface HeroSectionProps {
  locale: string
  upcomingEvents: ClubEvent[]
  onPickEvent: (event: ClubEvent) => void
}

const ROLL_DURATION_MS = 1400

export function HeroSection({ locale, upcomingEvents, onPickEvent }: HeroSectionProps) {
  const t = useTranslations('home')
  const [face, setFace] = useState(20)
  const [rolling, setRolling] = useState(false)
  const [pick, setPick] = useState<ClubEvent | null>(null)
  const [nat20, setNat20] = useState(false)

  const stats = [
    { number: t('stats.membersNumber'), label: t('stats.membersLabel') },
    { number: t('stats.eventsNumber'), label: t('stats.eventsLabel') },
    { number: t('stats.gamesNumber'), label: t('stats.gamesLabel') },
    { number: t('stats.partnersNumber'), label: t('stats.partnersLabel') },
  ]

  const roll = () => {
    if (rolling || upcomingEvents.length === 0) return
    setRolling(true)
    setPick(null)
    setNat20(false)
    const start = Date.now()

    const tick = () => {
      const dt = Date.now() - start
      setFace(1 + Math.floor(Math.random() * 20))
      if (dt < ROLL_DURATION_MS) {
        requestAnimationFrame(tick)
      } else {
        const result = 1 + Math.floor(Math.random() * 20)
        setFace(result)
        if (result === 20) {
          setNat20(true)
          setPick(null)
          window.dispatchEvent(new CustomEvent('alea:nat20'))
        } else {
          const idx = (result - 1) % upcomingEvents.length
          setPick(upcomingEvents[idx] ?? null)
        }
        setRolling(false)
      }
    }
    tick()
  }

  const pickTitle = pick ? (locale === 'en' ? pick.titleEn : pick.titleEs) : null
  const pickDate = pick ? formatClubEventDate(pick, locale) : null

  return (
    <section className="mod-hero" id="top">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="mod-hero-bg-img"
        src="https://alealaspalmas.es/wp-content/uploads/2025/10/fondo-oscuro.png"
        alt=""
        aria-hidden="true"
      />
      <div className="mod-hero-grid">
        <div className="mod-hero-left">
          <span className="mod-eyebrow">
            <span className="mod-dot" /> {t('hero.tagline')} · {t('hero.location')}
          </span>
          <h1 className="mod-hero-title">
            <span className="mod-glow">{t('hero.titleA')}</span>, {t('hero.titleB')},<br />
            <span className="mod-outline">{t('hero.titleC')}</span>
          </h1>
          <p className="mod-hero-sub">{t('hero.subtitle')}</p>
          <div className="mod-hero-badges">
            <span className="mod-badge mod-badge-live">
              <span className="mod-dot" />
              {t('hero.badgeOpen')}
            </span>
            <span className="mod-badge">{t('hero.badgeFee')}</span>
          </div>
          <div className="mod-hero-cta">
            <Link className="mod-btn mod-btn-primary" href={`/${locale}/sign-in`}>
              {t('cta.join')}
            </Link>
            <a className="mod-btn mod-btn-ghost" href="#events">
              {t('cta.discover')}
            </a>
          </div>
          <div className="mod-hero-stats">
            {stats.map((stat) => (
              <div key={stat.label} className="mod-stat">
                <strong>{stat.number}</strong>
                <span>{stat.label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mod-hero-right">
          <div className={`mod-roller ${nat20 ? 'nat20' : ''}`}>
            <span className="mod-roller-glow" />
            <button
              type="button"
              className={`mod-roll-btn ${rolling ? 'rolling' : ''} ${nat20 ? 'crit' : ''}`}
              onClick={roll}
              aria-label="Roll d20"
            >
              <D20 face={face} size={170} palette={['#c8a25b', '#0a0a12']} critical={nat20} />
            </button>
            <span className="mod-roll-cta">
              {t('roll.cta')} <span className="mod-d20-label">d20</span>
            </span>
            <span className="mod-roll-help">{t('roll.help')}</span>
            <button
              type="button"
              className={`mod-pick ${pick || nat20 ? 'show' : ''} ${nat20 ? 'crit' : ''} ${pick && !nat20 ? 'clickable' : ''}`}
              disabled={!pick || nat20}
              onClick={() => {
                if (pick && !nat20) onPickEvent(pick)
              }}
              aria-label={pick && !nat20 && pickTitle ? `${locale === 'en' ? 'See' : 'Ver'} ${pickTitle}` : undefined}
            >
              {nat20 ? (
                <>
                  <span className="mod-pick-tag mod-pick-tag-crit">★ {t('egg.title')} ★</span>
                  <strong>{locale === 'en' ? 'Natural 20' : '20 natural'}</strong>
                  <span>{locale === 'en' ? 'You triggered the secret bonus.' : 'Has activado el bonus secreto.'}</span>
                </>
              ) : (
                pick && (
                  <>
                    <span className="mod-pick-tag">{t('roll.you')}</span>
                    <strong>{pickTitle}</strong>
                    <span>{pickDate}</span>
                    <span className="mod-pick-cue" aria-hidden="true">
                      {locale === 'en' ? 'See event' : 'Ver evento'} →
                    </span>
                  </>
                )
              )}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
