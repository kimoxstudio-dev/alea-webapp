'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'

interface LandingNavProps {
  locale: string
}

function LangToggle({ locale, className }: { locale: string; className?: string }) {
  const t = useTranslations('nav')
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const otherLocale = locale === 'es' ? 'en' : 'es'
  const pathWithoutLocale = pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '')
  const qs = searchParams.toString()
  const href = `/${otherLocale}${pathWithoutLocale}${qs ? `?${qs}` : ''}`

  return (
    <Link href={href} className={`alea-lang-toggle ${className ?? ''}`} aria-label={t('switchLocale', { locale: otherLocale })}>
      <span className={locale === 'es' ? 'on' : undefined}>ES</span>
      <span aria-hidden="true">·</span>
      <span className={locale === 'en' ? 'on' : undefined}>EN</span>
    </Link>
  )
}

export function LandingNav({ locale }: LandingNavProps) {
  const t = useTranslations('home')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const links = [
    { href: '#about', label: t('nav.about') },
    { href: '#events', label: t('nav.events') },
    { href: '#culture', label: t('nav.culture') },
    { href: '#partners', label: t('nav.partners') },
    { href: '#contact', label: t('nav.contact') },
  ]

  return (
    <>
      <header className="mod-nav">
        <a href="#top" className="mod-logo" data-egg-tap title="Alea Las Palmas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://alealaspalmas.es/wp-content/uploads/2025/11/logo_final_sin_fondo.png"
            alt="Alea"
            width={40}
            height={40}
          />
          <span>
            <strong>ALEA</strong>
            <em>Las Palmas</em>
          </span>
        </a>

        <nav className={`mod-nav-links ${open ? 'open' : ''}`} aria-hidden={!open}>
          <LangToggle locale={locale} className="alea-lang-toggle-in-menu" />
          {links.map((link) => (
            <a key={link.href} href={link.href} onClick={() => setOpen(false)}>
              {link.label}
            </a>
          ))}
        </nav>

        <Link className="mod-cta" href={`/${locale}/sign-in`}>
          {t('cta.join')} →
        </Link>

        <button
          className={`mod-burger ${open ? 'open' : ''}`}
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      <LangToggle locale={locale} />
    </>
  )
}
