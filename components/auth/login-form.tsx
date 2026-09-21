'use client'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuth } from '@clerk/nextjs'
import { isClerkAPIResponseError } from '@clerk/nextjs/errors'
import { useSignIn } from '@clerk/nextjs/legacy'
import { DiceLoader } from '@/components/ui/dice-loader'
import { loginSchema, type LoginFormData } from '@/lib/validations/auth'
import { resolveSafeRedirect } from '@/lib/safe-redirect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PasswordInput } from '@/components/ui/password-input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  useFormField,
} from '@/components/ui/form'

/**
 * Custom, Alea-branded sign-in form backed by Clerk's headless `useSignIn()`
 * hook (#299 pass 3 frontend rework).
 *
 * Clerk's prebuilt `<SignIn/>` widget manages its own internal form state
 * and has no clean way to transform whatever the member types before
 * calling Clerk — but the member must only ever see/type their bare member
 * number, never the `alea-` prefix that the Clerk username is actually
 * built from (`toClerkUsername()` in `lib/server/auth-service.ts`). So this
 * form collects the member number + password with this app's own styling
 * (mirrors `register-form.tsx`'s conventions) and prepends the prefix only
 * right before calling `signIn.create()` — the prefix never reaches the DOM,
 * clipboard, or browser autofill under any other value than what Clerk
 * itself is given.
 */
const CLERK_USERNAME_PREFIX = 'alea-'

function TranslatedFormMessage({ message }: { message: string | undefined }) {
  const { formMessageId } = useFormField()
  const tField = useTranslations('auth')
  if (!message) return null
  return (
    <p id={formMessageId} role="alert" className="text-xs text-destructive mt-1">
      {tField(message as Parameters<typeof tField>[0])}
    </p>
  )
}

interface LoginFormProps {
  locale: string
  redirectUrl?: string
}

export function LoginForm({ locale, redirectUrl }: LoginFormProps) {
  const t = useTranslations('auth')
  const router = useRouter()
  const { isLoaded, signIn, setActive } = useSignIn()
  const { isSignedIn } = useAuth()
  const [serverError, setServerError] = useState<string | null>(null)
  const [recoveryHelpVisible, setRecoveryHelpVisible] = useState(false)

  const form = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      identifier: '',
      password: '',
    },
  })

  const { isSubmitting } = form.formState

  const onSubmit = async (data: LoginFormData) => {
    setServerError(null)
    setRecoveryHelpVisible(false)

    // #405: right after a successful sign-in, the URL can transiently stay
    // on /sign-in while client routing settles even though the session is
    // already established. Re-submitting in that window used to call
    // signIn.create() with a session already active — Clerk throws its
    // `session_exists` error for that, which fell into the catch below and
    // was mapped to a false "invalid credentials" message, plus burned the
    // authLogin rate limit (lib/server/security.ts) on a session the user
    // already holds. Checking isSignedIn up front avoids ever making that
    // call: short-circuit straight to the redirect instead.
    if (isSignedIn) {
      const target = resolveSafeRedirect(redirectUrl, `/${locale}/rooms`)
      router.push(target)
      router.refresh()
      return
    }

    if (!isLoaded || !signIn || !setActive) {
      setServerError(t('errors.invalidCredentials'))
      return
    }

    try {
      const attempt = await signIn.create({
        identifier: `${CLERK_USERNAME_PREFIX}${data.identifier.trim()}`,
        password: data.password,
      })

      if (attempt.status !== 'complete' || !attempt.createdSessionId) {
        setServerError(t('errors.invalidCredentials'))
        return
      }

      const target = resolveSafeRedirect(redirectUrl, `/${locale}/rooms`)
      await setActive({
        session: attempt.createdSessionId,
        navigate: ({ decorateUrl }) => {
          window.location.assign(decorateUrl(target))
        },
      })
    } catch (error) {
      // Defense-in-depth for the isSignedIn guard above: isSignedIn is React
      // state that updates asynchronously after setActive() resolves, so a
      // resubmit lands here (rather than being caught by the guard) in the
      // narrow window before that state update commits. `session_exists` is
      // Clerk's own documented error code for "already signed in"
      // (@clerk/shared's ERROR_CODES.SESSION_EXISTS) — redirect the same way
      // the guard does instead of showing a false "invalid credentials".
      if (isClerkAPIResponseError(error) && error.errors.some((e) => e.code === 'session_exists')) {
        const target = resolveSafeRedirect(redirectUrl, `/${locale}/rooms`)
        router.push(target)
        router.refresh()
        return
      }
      setServerError(t('errors.invalidCredentials'))
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="space-y-6">
        {serverError && (
          <div
            role="alert"
            className="pl-4 py-3 pr-3 text-sm rounded-r-md"
            style={{
              borderLeft: '2px solid color-mix(in srgb, var(--destructive) 80%, transparent)',
              background: 'color-mix(in srgb, var(--destructive) 8%, transparent)',
              color: 'color-mix(in srgb, var(--destructive) 85%, var(--card-foreground))',
            }}
          >
            {serverError}
          </div>
        )}

        <FormField
          control={form.control}
          name="identifier"
          render={({ field }) => (
            <FormItem className="space-y-1.5">
              <FormLabel
                className="text-xs tracking-wide uppercase font-medium"
                style={{ color: 'color-mix(in srgb, var(--primary) 60%, var(--muted-foreground))' }}
              >
                {t('memberNumber')}
              </FormLabel>
              <FormControl>
                <Input
                  type="text"
                  autoComplete="username"
                  placeholder={t('identifierPlaceholder')}
                  className="h-11"
                  {...field}
                />
              </FormControl>
              <TranslatedFormMessage message={form.formState.errors.identifier?.message} />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem className="space-y-1.5">
              <FormLabel
                className="text-xs tracking-wide uppercase font-medium"
                style={{ color: 'color-mix(in srgb, var(--primary) 60%, var(--muted-foreground))' }}
              >
                {t('password')}
              </FormLabel>
              <FormControl>
                <PasswordInput
                  autoComplete="current-password"
                  className="h-11"
                  {...field}
                />
              </FormControl>
              <TranslatedFormMessage message={form.formState.errors.password?.message} />
            </FormItem>
          )}
        />

        <Button
          type="submit"
          className="w-full h-11 font-cinzel tracking-widest text-xs mt-2"
          disabled={isSubmitting || !isLoaded}
        >
          {isSubmitting ? (
            <span className="inline-flex items-center gap-2.5">
              <DiceLoader size="sm" />
              <span>{t('login')}</span>
            </span>
          ) : (
            t('login')
          )}
        </Button>

        <div className="pt-1 flex flex-col items-center gap-2">
          <button
            type="button"
            className="text-xs text-muted-foreground/55 transition-colors duration-200 hover:text-primary/65 underline-offset-4 hover:underline"
            onClick={() => setRecoveryHelpVisible((v) => !v)}
          >
            {t('forgotPassword')}
          </button>
          {recoveryHelpVisible && (
            <p
              className="text-xs text-muted-foreground/70 pl-3"
              style={{ borderLeft: '1px solid color-mix(in srgb, var(--primary) 25%, transparent)' }}
            >
              {t('forgotPasswordContactAdmin')}
            </p>
          )}
        </div>
      </form>
    </Form>
  )
}
