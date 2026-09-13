import { getTranslations } from 'next-intl/server'
import { Reveal } from './reveal'

export async function AboutSection() {
  const t = await getTranslations('home')

  const bullets = [1, 2, 3, 4].map((n) => t(`about.bullet${n}`))

  return (
    <section className="mod-about" id="about">
      <div className="mod-about-grid">
        <Reveal className="mod-about-text">
          <span className="mod-kicker">{t('about.kicker')}</span>
          <h2 className="mod-h2">{t('about.title')}</h2>
          <p className="mod-lead">{t('about.body')}</p>
          <p className="mod-lead">{t('about.body2')}</p>
          <ul className="mod-list">
            {bullets.map((bullet) => (
              <li key={bullet}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <polygon points="12,3 21,8 21,16 12,21 3,16 3,8" fill="none" stroke="#c8a25b" strokeWidth="1.6" />
                  <circle cx="12" cy="12" r="3" fill="#c8a25b" />
                </svg>
                <span>{bullet}</span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={140} className="mod-about-img">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/image-12-e1761825612963.jpg"
            alt="Mago de Alea"
          />
          <div className="mod-about-img-tag">
            <strong>{t('business.address')}</strong>
            <span>Schamann · LPGC · {t('hero.badgeOpen')}</span>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
