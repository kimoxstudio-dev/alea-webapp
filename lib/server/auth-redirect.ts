import 'server-only'

type PageSearchParams = Record<string, string | string[] | undefined>

/**
 * Builds the local sign-in URL for a protected Server Component while keeping
 * the full destination intact. Resource-level page guards must share this
 * behavior so removing the middleware gate cannot lose a deep link or query.
 */
export function localizedSignInUrl(
  locale: string,
  pathname: string,
  searchParams: PageSearchParams = {},
): string {
  const query = new URLSearchParams()

  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') {
      query.set(key, value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, item)
      }
    }
  }

  const destination = query.size > 0 ? `${pathname}?${query}` : pathname
  return `/${locale}/sign-in?redirect_url=${encodeURIComponent(destination)}`
}
