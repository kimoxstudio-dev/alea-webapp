import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

interface RegisterFormProps { locale: string }

// Self-registration is disabled while the Clerk migration is in progress — the
// /api/auth/register route unconditionally returns 410 Gone. This renders the
// disabled-state explanation instead of a live sign-up form so users never
// believe they successfully registered/authenticated (see GitHub issue #284).
export async function RegisterForm({ locale }: RegisterFormProps) {
  const t = await getTranslations('auth')

  return (
    <>
      <div className="space-y-4 text-center">
        <div className="rounded-md border border-primary/30 bg-primary/10 px-4 py-4 text-sm text-foreground">
          <p className="font-medium">{t('registerUnavailableTitle')}</p>
          <p className="mt-2 text-muted-foreground">{t('registerUnavailableBody')}</p>
        </div>
        <Link
          href={`/${locale}/login`}
          className="inline-flex w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('login')}
        </Link>
      </div>
      <div className="mt-6 text-center text-sm">
        <span className="text-muted-foreground">{t('hasAccount')}</span>{' '}
        <Link
          href={`/${locale}/login`}
          className="text-primary hover:text-primary/80 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          {t('login')}
        </Link>
      </div>
    </>
  )
}
