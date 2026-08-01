import { act, renderHook, waitFor } from '@testing-library/react'
import type { User } from '@/lib/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const routerPushMock = vi.fn()
const clerkSignOutMock = vi.fn()
const signInPasswordMock = vi.fn()
const signInFinalizeMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPushMock }),
  usePathname: () => '/es/rooms',
}))

vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isLoaded: true, userId: 'clerk-user-1' }),
  useClerk: () => ({ signOut: clerkSignOutMock }),
  useSignIn: () => ({
    fetchStatus: 'idle',
    signIn: {
      password: signInPasswordMock,
      finalize: signInFinalizeMock,
      status: 'complete',
    },
  }),
}))

const apiClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))

vi.mock('@/lib/api/client', () => ({
  apiClient: apiClientMock,
}))

function createUser(overrides?: Partial<User>): User {
  return {
    id: '1',
    memberNumber: '100001',
    role: 'admin',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('AuthProvider', () => {
  beforeEach(() => {
    apiClientMock.get.mockReset()
    apiClientMock.post.mockReset()
    routerPushMock.mockReset()
    clerkSignOutMock.mockReset()
    signInPasswordMock.mockReset()
    signInFinalizeMock.mockReset()
  })

  it('hydrates from /auth/me when no initial user is provided', async () => {
    const user = createUser()
    apiClientMock.get.mockResolvedValueOnce(user)

    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    )

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.user).toEqual(user)
    expect(result.current.isAuthenticated).toBe(true)
  })

  it('falls back to an unauthenticated state when /auth/me fails', async () => {
    apiClientMock.get.mockRejectedValueOnce(new Error('Unauthorized'))

    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider>{children}</AuthProvider>
    )

    const { result } = renderHook(() => useAuth(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.user).toBeNull()
    expect(result.current.isAuthenticated).toBe(false)
  })

  it('uses the provided initial user without calling /auth/me', async () => {
    const user = createUser({ role: 'member' })

    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider initialUser={user}>{children}</AuthProvider>
    )

    const { result } = renderHook(() => useAuth(), { wrapper })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.user).toEqual(user)
    expect(apiClientMock.get).not.toHaveBeenCalled()
  })

  it('updates the auth state on login and logout', async () => {
    const loggedInUser = createUser()

    signInPasswordMock.mockResolvedValueOnce({ error: null })
    signInFinalizeMock.mockResolvedValueOnce({ error: null })
    apiClientMock.get.mockResolvedValueOnce(loggedInUser)

    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider initialUser={null}>{children}</AuthProvider>
    )

    const { result } = renderHook(() => useAuth(), { wrapper })

    await act(async () => {
      await result.current.login('100001', 'Admin123')
    })

    expect(result.current.user).toEqual(loggedInUser)
    expect(signInPasswordMock).toHaveBeenCalledWith({
      identifier: '100001@members.alea.internal',
      password: 'Admin123',
    })
    expect(signInFinalizeMock).toHaveBeenCalledOnce()

    await act(async () => {
      await result.current.logout()
    })

    expect(result.current.user).toBeNull()
    expect(result.current.isAuthenticated).toBe(false)
    expect(clerkSignOutMock).toHaveBeenCalledOnce()
    expect(routerPushMock).toHaveBeenCalledWith('/es/login')
  })

  it('reject register() immediately without calling setUser', async () => {
    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider initialUser={null}>{children}</AuthProvider>
    )

    const { result } = renderHook(() => useAuth(), { wrapper })

    let registerError: unknown
    await act(async () => {
      try {
        await result.current.register('100099', 'Password123')
      } catch (error) {
        registerError = error
      }
    })

    expect(registerError).toEqual(new Error('Self-registration is disabled'))
    expect(result.current.user).toBeNull()
    expect(apiClientMock.post).not.toHaveBeenCalled()
  })

  it('signs Clerk out when the authenticated identity is unmapped or suspended', async () => {
    signInPasswordMock.mockResolvedValueOnce({ error: null })
    signInFinalizeMock.mockResolvedValueOnce({ error: null })
    apiClientMock.get.mockRejectedValueOnce(new Error('Unauthorized'))

    const { AuthProvider, useAuth } = await import('@/lib/auth/auth-context')
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AuthProvider initialUser={null}>{children}</AuthProvider>
    )
    const { result } = renderHook(() => useAuth(), { wrapper })

    let loginError: unknown
    await act(async () => {
      try {
        await result.current.login('100099', 'Password123')
      } catch (error) {
        loginError = error
      }
    })

    expect(loginError).toEqual(new Error('Invalid credentials'))
    await waitFor(() => expect(clerkSignOutMock).toHaveBeenCalledOnce())
    await waitFor(() => expect(result.current.user).toBeNull())
  })
})
