import { ClerkProvider } from '@clerk/nextjs'
import { AuthProvider } from '@/lib/auth/auth-context'
import { Providers } from '@/lib/providers'
import { Header } from '@/components/layout/header'
import { Footer } from '@/components/layout/footer'
import { NavigationProgress } from '@/components/ui/navigation-progress'
import { getSessionFromServerCookies } from '@/lib/server/auth'
import { getCurrentUser } from '@/lib/server/auth-service'

interface AppLayoutProps {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}

export default async function AppLayout({ children, params }: AppLayoutProps) {
  const { locale } = await params

  const session = await getSessionFromServerCookies()
  let initialUser = null

  if (session) {
    try {
      initialUser = await getCurrentUser(session)
    } catch {
      initialUser = null
    }
  }

  return (
    <ClerkProvider telemetry={{ disabled: true }}>
      <Providers>
        <AuthProvider initialUser={initialUser}>
          <NavigationProgress />
          <Header locale={locale} />
          <main id="main-content" className="flex-1">
            {children}
          </main>
          <Footer locale={locale} />
        </AuthProvider>
      </Providers>
    </ClerkProvider>
  )
}
