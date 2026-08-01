'use client'

import { useAuth as useClerkAuth, useClerk, useSignIn } from '@clerk/nextjs'
import { createContext, useCallback, useContext, useState, useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import type { User } from '@/lib/types'
import { apiClient } from '@/lib/api/client'
import { endpoints } from '@/lib/api/endpoints'

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (identifier: string, password: string) => Promise<void>
  logout: () => Promise<void>
  register: (memberNumber: string, password: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children, initialUser }: { children: React.ReactNode; initialUser?: User | null }) {
  const [user, setUser] = useState<User | null>(initialUser ?? null)
  const [isLoading, setIsLoading] = useState(initialUser === undefined)
  const clerk = useClerk()
  const { isLoaded: isClerkLoaded, userId } = useClerkAuth()
  const { signIn, fetchStatus: signInFetchStatus } = useSignIn()
  const router = useRouter()
  const pathname = usePathname()

  const locale = pathname.match(/^\/([a-z]{2})(?:\/|$)/)?.[1] ?? 'es'

  const checkAuth = useCallback(async () => {
    try {
      const data = await apiClient.get<User>(endpoints.auth.me)
      setUser(data)
      return data
    } catch {
      setUser(null)
      return null
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialUser !== undefined || !isClerkLoaded) return
    if (!userId) {
      setUser(null)
      setIsLoading(false)
      return
    }
    checkAuth()
  }, [checkAuth, initialUser, isClerkLoaded, userId])

  const login = async (identifier: string, password: string) => {
    if (!signIn || signInFetchStatus === 'fetching') {
      throw new Error('Clerk sign-in is not ready')
    }

    const { error } = await signIn.password({
      identifier: `${identifier.trim()}@members.alea.internal`,
      password,
    })

    if (error || signIn.status !== 'complete') {
      throw new Error('Invalid credentials')
    }

    const { error: finalizeError } = await signIn.finalize()
    if (finalizeError) {
      throw new Error('Invalid credentials')
    }
    const mappedUser = await checkAuth()
    if (!mappedUser) {
      await clerk.signOut()
      throw new Error('Invalid credentials')
    }
  }

  const logout = async () => {
    await clerk.signOut()
    setUser(null)
    router.push(`/${locale}/login`)
  }

  const register = async (memberNumber: string, password: string) => {
    const data = await apiClient.post<User>(endpoints.auth.register, { memberNumber, password })
    setUser(data)
  }

  return (
    <AuthContext.Provider value={{ user, isLoading, isAuthenticated: !!user, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  )
}

// AUTH_FALLBACK is used when useAuth() is called outside AuthProvider.
// Promise.reject is used explicitly (rather than async + throw) so the rejection
// is always async regardless of whether the caller awaits the return value.
const AUTH_FALLBACK: AuthContextValue = {
  user: null,
  isLoading: false,
  isAuthenticated: false,
  login: () => Promise.reject(new Error('useAuth must be used within AuthProvider')),
  logout: () => Promise.reject(new Error('useAuth must be used within AuthProvider')),
  register: () => Promise.reject(new Error('useAuth must be used within AuthProvider')),
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  return ctx ?? AUTH_FALLBACK
}
