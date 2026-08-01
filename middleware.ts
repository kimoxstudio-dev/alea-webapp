import createMiddleware from 'next-intl/middleware'
import { clerkMiddleware } from '@clerk/nextjs/server'
import { NextResponse, type NextRequest } from 'next/server'
import { ensureCsrfCookie } from './lib/server/shared/security-edge'
import { locales, defaultLocale } from './lib/i18n/config'

const handleI18nRouting = createMiddleware({
  locales,
  defaultLocale,
  localePrefix: 'always',
})

export default clerkMiddleware(async (_auth, request: NextRequest) => {
  const response = request.nextUrl.pathname.startsWith('/api')
    ? NextResponse.next()
    : handleI18nRouting(request)
  return ensureCsrfCookie(request, response)
})

export const config = {
  matcher: ['/((?!_next|_vercel|.*\\..*).*)', '/(api|trpc)(.*)'],
}
