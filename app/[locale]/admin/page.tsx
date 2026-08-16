import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { redirect } from 'next/navigation'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { AdminDashboard } from '@/components/admin/admin-dashboard'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin')
  return { title: `${t('dashboard')} — Alea` }
}

interface AdminPageProps {
  params: Promise<{ locale: string }>
}

export default async function AdminPage({ params }: AdminPageProps) {
  const { locale } = await params
  const session = await getSessionFromServerCookies()

  if (!session) {
    redirect(`/${locale}/sign-in`)
  }

  if (session.role !== 'admin') {
    redirect(`/${locale}`)
  }

  return (
    <main id="main-content">
      <AdminDashboard />
    </main>
  )
}
