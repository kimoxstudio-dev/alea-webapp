'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Sword, ExternalLink } from 'lucide-react'

interface FooterProps {
  locale: string
}

export function Footer({ locale }: FooterProps) {
  const t = useTranslations('footer')
  const tAuth = useTranslations('auth')
  const pathname = usePathname()

  const associationUrl = process.env.NEXT_PUBLIC_ASSOCIATION_URL || null

  // The public landing page (locale root, e.g. `/es` or `/en`) renders its own
  // design footer (LandingFooterSection); skip the global one there so it
  // isn't duplicated. Every other route (incl. authenticated ones) keeps it.
  const isLocaleRoot = /^\/[a-z]{2}$/.test(pathname)
  if (isLocaleRoot) return null

  return (
    <footer className="border-t border-border bg-background-secondary mt-auto" role="contentinfo">
      <div className="container mx-auto max-w-7xl px-4 py-10">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">

          {/* Brand column */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Sword className="h-5 w-5 text-primary" aria-hidden="true" />
              <span className="font-cinzel text-lg font-bold text-gradient-gold">ALEA</span>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('tagline')}
            </p>
          </div>

          {/* Navigation column */}
          <nav aria-label={t('links')}>
            <h3 className="font-cinzel text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
              {t('links')}
            </h3>
            <ul className="space-y-2">
              <li>
                <Link
                  href={`/${locale}`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {t('home')}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/rooms`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {t('rooms')}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/reservations`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {t('reservations')}
                </Link>
              </li>
              <li>
                <Link
                  href={`/${locale}/faq`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {t('faq')}
                </Link>
              </li>
              <li>
                <a
                  href={associationUrl ?? '#'}
                  {...(associationUrl ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {t('association')}
                  {associationUrl && <ExternalLink className="h-3 w-3" aria-hidden="true" />}
                </a>
              </li>
            </ul>
          </nav>

          {/* Contact column */}
          <div>
            <h3 className="font-cinzel text-sm font-semibold text-foreground mb-3 uppercase tracking-wider">
              {t('contact')}
            </h3>
            <ul className="space-y-2">
              <li>
                <Link
                  href={`/${locale}/sign-in`}
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                >
                  {tAuth('login')}
                </Link>
              </li>
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-8 pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} Alea — {t('rights')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('madeWithLove')}
          </p>
        </div>
      </div>
    </footer>
  )
}
