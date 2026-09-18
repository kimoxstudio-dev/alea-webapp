// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  revalidateTag: vi.fn(), requireAdmin: vi.fn(), security: vi.fn(), rateLimit: vi.fn(),
  create: vi.fn(), update: vi.fn(), remove: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidateTag: mocks.revalidateTag }))
vi.mock('@/lib/server/auth', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/server/security', () => ({
  enforceMutationSecurity: mocks.security,
  enforceRateLimit: mocks.rateLimit,
  RATE_LIMIT_POLICIES: { adminMutation: {} },
}))
vi.mock('@/lib/server/club-events-service', () => ({
  createClubEvent: mocks.create, updateClubEvent: mocks.update, deleteClubEvent: mocks.remove,
}))
vi.mock('@/lib/server/partners-service', () => ({
  createPartner: mocks.create, updatePartner: mocks.update, deletePartner: mocks.remove,
}))
vi.mock('@/lib/server/library-games-service', () => ({
  createLibraryGame: mocks.create, updateLibraryGame: mocks.update, deleteLibraryGame: mocks.remove,
}))

import * as events from '@/app/api/club-events/route'
import * as event from '@/app/api/club-events/[id]/route'
import * as partners from '@/app/api/partners/route'
import * as partner from '@/app/api/partners/[id]/route'
import * as games from '@/app/api/library-games/route'
import * as game from '@/app/api/library-games/[id]/route'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.security.mockReturnValue(null)
  mocks.rateLimit.mockResolvedValue(null)
  mocks.requireAdmin.mockResolvedValue({
    session: { id: 'admin', role: 'admin' },
    applyCookies: (response: NextResponse) => response,
  })
  mocks.create.mockResolvedValue({ id: 'item' })
  mocks.update.mockResolvedValue({ id: 'item' })
  mocks.remove.mockResolvedValue(undefined)
})

describe.each([
  ['club-events', events, event, 'landing-club-events'],
  ['partners', partners, partner, 'landing-partners'],
  ['library-games', games, game, 'landing-library-games'],
] as const)('%s public cache invalidation', (path, collection, item, tag) => {
  const invoke = (method: 'POST' | 'PUT' | 'DELETE') => {
    const request = new NextRequest(`http://localhost/api/${path}`, {
      method, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ title: 'updated' }) }),
    })
    return method === 'POST'
      ? collection.POST(request)
      : item[method](request, { params: Promise.resolve({ id: 'item' }) })
  }

  it.each(['POST', 'PUT', 'DELETE'] as const)('%s invalidates after a successful write', async (method) => {
    expect((await invoke(method)).status).toBe(method === 'POST' ? 201 : method === 'DELETE' ? 204 : 200)
    expect(mocks.revalidateTag).toHaveBeenCalledExactlyOnceWith(tag)
    const mutation = method === 'POST' ? mocks.create : method === 'PUT' ? mocks.update : mocks.remove
    expect(mutation.mock.invocationCallOrder[0]).toBeLessThan(mocks.revalidateTag.mock.invocationCallOrder[0]!)
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('%s handles cache invalidation on service errors', async (method) => {
    const mutation = method === 'POST' ? mocks.create : method === 'PUT' ? mocks.update : mocks.remove
    mutation.mockRejectedValueOnce(new Error('write rejected'))
    expect((await invoke(method)).status).toBe(500)
    if (path === 'club-events') {
      expect(mocks.revalidateTag).toHaveBeenCalledExactlyOnceWith(tag)
    } else {
      expect(mocks.revalidateTag).not.toHaveBeenCalled()
    }
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('%s preserves the rejected admin gate', async (method) => {
    mocks.requireAdmin.mockResolvedValue(new NextResponse(null, { status: 403 }))
    expect((await invoke(method)).status).toBe(403)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.revalidateTag).not.toHaveBeenCalled()
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('%s preserves the rejected security gate', async (method) => {
    mocks.security.mockReturnValue(new NextResponse(null, { status: 403 }))
    expect((await invoke(method)).status).toBe(403)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.revalidateTag).not.toHaveBeenCalled()
  })

  it.each(['POST', 'PUT', 'DELETE'] as const)('%s preserves the rejected rate-limit gate', async (method) => {
    mocks.rateLimit.mockResolvedValue(new NextResponse(null, { status: 429 }))
    expect((await invoke(method)).status).toBe(429)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.revalidateTag).not.toHaveBeenCalled()
  })
})
