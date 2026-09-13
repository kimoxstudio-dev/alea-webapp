import { redirect } from 'next/navigation'

/**
 * Legacy Supabase-password login route (#299 pass 3).
 *
 * The bespoke `LoginForm` UI it used to render posted to
 * `app/api/auth/login/route.ts`, which called `login()` from
 * `lib/server/auth-service.ts` — deleted in pass 2 (no password column left
 * to check against; Clerk is now the only credential store). This page is
 * kept only as a redirect so any stale bookmark/link to `/login` still lands
 * somewhere useful, mirroring how `/register` redirects post-#206.
 */
interface LoginPageProps {
  params: Promise<{ locale: string }>
}

export default async function LoginPage({ params }: LoginPageProps) {
  const { locale } = await params
  redirect(`/${locale}/sign-in`)
}
