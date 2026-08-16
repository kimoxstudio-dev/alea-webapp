import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import Image from 'next/image'
import { LoginForm } from '@/components/auth/login-form'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { getCurrentUser } from '@/lib/server/auth-service'
import { resolveSafeRedirect } from '@/lib/safe-redirect'

/**
 * Alea's own sign-in screen (#299 pass 3 frontend rework).
 *
 * Previously rendered Clerk's prebuilt `<SignIn/>` widget completely
 * unstyled. Replaced with a custom, Clerk-backed form (`LoginForm`, built on
 * `useSignIn()`) so the member is only ever asked for their member number —
 * never the `alea-` prefix Clerk's username is built from internally — and
 * so the screen genuinely reads as this app's own, not a dropped-in widget.
 * The atmospheric two-zone layout below is this app's pre-existing
 * (pre-Clerk) sign-in design, restored as-is rather than reinvented.
 *
 * `[[...sign-in]]` is kept as the route segment shape even though no Clerk
 * component owns routing here anymore — it's harmless (Next just matches
 * `/sign-in/**` to this same page) and avoids an unrelated route-rename.
 *
 * No `signUpUrl`/sign-up affordance: this club has no public self-service
 * registration (closed issue #206), and a custom form doesn't have Clerk's
 * widget-level sign-up link to begin with.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('auth')
  return { title: `${t('login')} — Alea` }
}

interface SignInPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ redirect_url?: string }>
}

export default async function SignInPage({ params, searchParams }: SignInPageProps) {
  const [{ locale }, { redirect_url: redirectUrl }] = await Promise.all([params, searchParams])

  const session = await getSessionFromServerCookies()
  if (session) {
    let authenticated = false
    try {
      await getCurrentUser(session)
      authenticated = true
    } catch {
      // ignore stale/invalid session, render sign-in form
    }
    if (authenticated) {
      redirect(resolveSafeRedirect(redirectUrl, `/${locale}/rooms`))
    }
  }

  const t = await getTranslations('auth')

  return (
    <div className="h-dvh flex flex-col lg:flex-row overflow-hidden">
      {/* LEFT ZONE — atmosphere and brand */}
      <div className="relative hidden lg:flex lg:w-[45%] xl:w-[50%] flex-col items-center justify-center p-14 overflow-hidden">
        {/* Ember radial glow centred on the logo */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 60% 55% at 50% 50%, rgba(255, 183, 123, 0.04) 0%, transparent 65%)',
          }}
          aria-hidden="true"
        />

        {/* Corner ornaments — absolute */}
        <div aria-hidden="true" className="absolute top-10 left-10 w-8 h-8 border-l border-t"
          style={{ borderColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }} />
        <div aria-hidden="true" className="absolute top-10 right-10 w-8 h-8 border-r border-t"
          style={{ borderColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }} />
        <div aria-hidden="true" className="absolute bottom-10 left-10 w-8 h-8 border-l border-b"
          style={{ borderColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }} />
        <div aria-hidden="true" className="absolute bottom-10 right-10 w-8 h-8 border-r border-b"
          style={{ borderColor: 'color-mix(in srgb, var(--primary) 22%, transparent)' }} />

        {/* Identity block — centred medallion */}
        <div className="relative z-10 flex flex-col items-center text-center gap-6">
          {/* Logo */}
          <Image
            src="/alea-logo.png"
            alt="Alea"
            width={180}
            height={180}
            className="w-[clamp(130px,14vw,180px)] h-auto drop-shadow-[0_0_24px_rgba(255,183,123,0.12)]"
            priority
          />

          {/* Overline */}
          <p
            className="text-[9px] tracking-[0.4em] uppercase font-medium"
            style={{ color: 'color-mix(in srgb, var(--primary) 55%, transparent)' }}
          >
            Asociación Cultural
          </p>

          {/* Rule */}
          <div
            className="w-10 h-px"
            style={{ background: 'color-mix(in srgb, var(--primary) 35%, transparent)' }}
          />

          {/* Subtitle */}
          <p className="text-sm text-muted-foreground leading-relaxed max-w-[18rem]">
            {t('loginSubtitle')}
          </p>
        </div>
      </div>

      {/* VERTICAL DIVIDER */}
      <div
        className="hidden lg:block w-px self-stretch"
        style={{ background: 'color-mix(in srgb, var(--border) 55%, transparent)' }}
        aria-hidden="true"
      />

      {/* RIGHT ZONE — sign-in panel */}
      <div
        className="flex-1 flex items-center justify-center p-8 lg:p-14 relative overflow-y-auto"
        style={{
          background:
            'color-mix(in srgb, var(--background-secondary) 55%, var(--background))',
        }}
      >
        {/* Subtle ember glow centre */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 55% 50% at 50% 50%, rgba(255, 183, 123, 0.022) 0%, transparent 65%)',
          }}
          aria-hidden="true"
        />

        <div className="relative z-10 w-full max-w-[22rem]">
          {/* Mobile brand header — hidden on lg+ */}
          <div className="lg:hidden flex flex-col items-center text-center mb-10 gap-4">
            <Image
              src="/alea-logo.png"
              alt="Alea"
              width={120}
              height={120}
              className="w-[100px] h-auto drop-shadow-[0_0_16px_rgba(255,183,123,0.12)]"
              priority
            />
            <p
              className="text-[9px] tracking-[0.4em] uppercase font-medium"
              style={{ color: 'color-mix(in srgb, var(--primary) 55%, transparent)' }}
            >
              Asociación Cultural
            </p>
            <div
              className="w-8 h-px"
              style={{ background: 'color-mix(in srgb, var(--primary) 35%, transparent)' }}
            />
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('loginSubtitle')}
            </p>
          </div>

          {/* Desktop form label */}
          <div className="hidden lg:block mb-8">
            <p
              className="text-[10px] tracking-[0.35em] uppercase font-medium"
              style={{ color: 'color-mix(in srgb, var(--primary) 55%, transparent)' }}
            >
              {t('login')}
            </p>
          </div>

          <LoginForm locale={locale} redirectUrl={redirectUrl} />

          <p className="mt-7 text-center text-xs text-muted-foreground/60">
            {t('loginHelp')}
          </p>
        </div>
      </div>
    </div>
  )
}
