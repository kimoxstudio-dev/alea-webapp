import { redirect } from 'next/navigation'

interface RegisterPageProps {
  params: Promise<{ locale: string }>
}

export default async function RegisterPage({ params }: RegisterPageProps) {
  const { locale } = await params
  redirect(`/${locale}/login`)
}
