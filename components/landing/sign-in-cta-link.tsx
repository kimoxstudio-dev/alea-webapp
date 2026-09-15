'use client'

import Link from 'next/link'
import type { ComponentProps, FocusEvent, MouseEvent, TouchEvent } from 'react'
import { preloadClerkOnIntent } from '@/lib/preload-clerk'

type SignInCtaLinkProps = ComponentProps<typeof Link>

/**
 * A `next/link` that also warms Clerk's client JS on hover/focus/touch.
 *
 * Every CTA on the landing page pointing at `/sign-in` renders through this
 * component instead of a plain `Link`, so the Clerk-preload behavior lives
 * in one place — see `lib/preload-clerk.ts` for why this exists.
 */
export function SignInCtaLink({
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...rest
}: SignInCtaLinkProps) {
  return (
    <Link
      {...rest}
      onMouseEnter={(event: MouseEvent<HTMLAnchorElement>) => {
        preloadClerkOnIntent()
        onMouseEnter?.(event)
      }}
      onFocus={(event: FocusEvent<HTMLAnchorElement>) => {
        preloadClerkOnIntent()
        onFocus?.(event)
      }}
      onTouchStart={(event: TouchEvent<HTMLAnchorElement>) => {
        preloadClerkOnIntent()
        onTouchStart?.(event)
      }}
    />
  )
}
