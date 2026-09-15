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
 * Call this from `onMouseEnter`/`onFocus` on a CTA that navigates to
 * `/sign-in`, so the fetch happens during the hover/focus dwell time instead
 * of entirely after the click. Dynamically importing `@clerk/nextjs` — the
 * same module `ClerkProvider` is imported from — warms the browser's fetch
 * of that chunk without mounting the provider anywhere new.
 *
 * Idempotent per page load: only the first call actually triggers the
 * import, so repeated hovers on the same or different CTA instances are a
 * no-op after that.
 */
export function preloadClerkOnIntent(): void {
  if (started) return
  started = true
  void import('@clerk/nextjs')
}
