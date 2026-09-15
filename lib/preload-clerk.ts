let started = false

/**
 * Starts loading Clerk's client JS chunk ahead of navigation to `/sign-in`.
 *
 * `ClerkProvider` only mounts under the `(app)` route group layout
 * (`app/[locale]/(app)/layout.tsx`) — the landing page never loads it, to
 * keep that indexed route light for SEO/Core Web Vitals. That means the
 * first click on a "Reservar sala" CTA is also the first moment the browser
 * starts fetching Clerk's client SDK, which shows up as a multi-second delay
 * before the sign-in form becomes usable.
 *
 * Call this from `onMouseEnter`/`onFocus`/`onTouchStart` on a CTA that
 * navigates to `/sign-in`, so the fetch happens during the hover/focus/touch
 * dwell time instead of entirely after the click. Dynamically importing
 * `@clerk/nextjs` — the same module `ClerkProvider` is imported from — warms
 * the browser's fetch of that chunk without mounting the provider anywhere
 * new; this assumes the package has no problematic top-level side effects
 * beyond that fetch, which holds today but isn't statically guaranteed.
 *
 * Idempotent per page load: only the first successful call actually
 * triggers the import, so repeated hovers on the same or different CTA
 * instances are a no-op after that. If the import fails, the flag resets so
 * a later intent signal can retry. Skips the import entirely (without
 * flipping the flag) when the user has data-saver mode on, re-checking that
 * condition on every call.
 */
export function preloadClerkOnIntent(): void {
  if (started) return

  const connection = (
    navigator as Navigator & {
      connection?: { saveData?: boolean }
    }
  ).connection

  if (connection?.saveData) return

  started = true
  void import('@clerk/nextjs').catch(() => {
    started = false
  })
}
