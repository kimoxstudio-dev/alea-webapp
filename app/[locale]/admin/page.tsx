import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { localizedSignInUrl } from '@/lib/server/auth-redirect'
import { AdminDashboard } from '@/components/admin/admin-dashboard'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin')
  return { title: `${t('dashboard')} — Alea` }
}

interface AdminPageProps {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AdminPage({ params, searchParams }: AdminPageProps) {
  const [{ locale }, query] = await Promise.all([params, searchParams])
  const session = await getSessionFromServerCookies()

  if (!session) {
    return redirect(localizedSignInUrl(locale, `/${locale}/admin`, query))
  }

  if (session.role !== 'admin') {
    return redirect(`/${locale}`)
  }

  return (
    <main id="main-content">
      <AdminDashboard />
    </main>
  )
}
