import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

interface LandingFooterSectionProps {
  locale: string
}

export async function LandingFooterSection({ locale }: LandingFooterSectionProps) {
  const t = await getTranslations('home')

  const address = t('business.address')
  const email = t('business.email')
  const instagram = t('business.instagram')
  const facebook = t('business.facebook')
  const mapsUrl = t('business.mapsUrl')
  const publicSite = t('business.publicSite')

  return (
    <footer className="mod-footer" id="contact">
      <div className="mod-foot-grid">
        <div>
          <div className="mod-logo">
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
          </div>
          <p className="mod-foot-tag">
            {t('hero.tagline')} · {t('hero.location')}
          </p>
          <p className="mod-foot-tag">{t('hero.badgeOpen')}</p>
          <p className="mod-egg-hint">{t('easter.hint')}</p>
        </div>
        <div>
          <h5>{t('footer.find')}</h5>
          <p>
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer">
              {address}
            </a>
          </p>
        </div>
        <div>
          <h5>{t('footer.write')}</h5>
          <p>
            <a href={`mailto:${email}`}>{email}</a>
          </p>
        </div>
        <div>
          <h5>{t('footer.follow')}</h5>
          <p>
            <a href={instagram} target="_blank" rel="noopener noreferrer">
              Instagram
            </a>
          </p>
          <p>
            <a href={facebook} target="_blank" rel="noopener noreferrer">
              Facebook
            </a>
          </p>
          <p>
            <a href={publicSite} target="_blank" rel="noopener noreferrer">
              alealaspalmas.es
            </a>
          </p>
        </div>
      </div>
      <div className="mod-foot-bottom" style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>{t('footer.rights')}</span>
        <Link href={`/${locale}/sign-in`} style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px dotted rgba(244,234,213,0.3)' }}>
          {t('footer.admin')}
        </Link>
      </div>
    </footer>
  )
}
