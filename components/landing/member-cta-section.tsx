import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

interface MemberCtaSectionProps {
  locale: string
}

export async function MemberCtaSection({ locale }: MemberCtaSectionProps) {
  const t = await getTranslations('home')

  const benefits = [1, 2, 3, 4].map((n) => t(`register.benefit${n}`))

  return (
    <section className="mod-cta-section" id="join">
      <div className="mod-cta-card">
        <div className="mod-cta-text">
          <span className="mod-kicker">{t('register.title')}</span>
          <h2 className="mod-h2">
            20 € <span className="mod-cta-period">/ {locale === 'en' ? 'month' : 'mes'}</span>
          </h2>
          <p className="mod-cta-body">{t('register.body')}</p>
          <ul className="mod-benefits">
            {benefits.map((benefit) => (
              <li key={benefit}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <path d="M5 12 L 10 17 L 19 7" stroke="#c8a25b" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>{benefit}</span>
              </li>
            ))}
          </ul>
          <div className="mod-cta-buttons">
            <Link className="mod-btn mod-btn-primary mod-btn-lg" href={`/${locale}/sign-in`}>
              {t('cta.join')} →
            </Link>
            <Link className="mod-btn mod-btn-ghost" href={`/${locale}/sign-in`}>
              {t('cta.members')}
            </Link>
          </div>
        </div>
        <div className="mod-cta-art">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://alealaspalmas.es/wp-content/uploads/2025/10/image-removebg-preview.png"
            alt="Personajes Alea"
          />
        </div>
      </div>
    </section>
  )
}
