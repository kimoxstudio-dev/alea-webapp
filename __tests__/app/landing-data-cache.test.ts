// @vitest-environment node
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, promises as fs } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncrementalCache } from 'next/dist/server/lib/incremental-cache'

const { events, partners, games } = vi.hoisted(() => ({
  events: vi.fn(), partners: vi.fn(), games: vi.fn(),
}))
vi.mock('@/lib/server/club-events-service', () => ({ listClubEvents: events }))
vi.mock('@/lib/server/partners-service', () => ({ listPartners: partners }))
vi.mock('@/lib/server/library-games-service', () => ({ listLibraryGames: games }))
vi.mock('@/components/landing/landing-view', () => ({ LandingView: () => null }))
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn() }))

let HomePage: typeof import('@/app/[locale]/page').default
let Cache: typeof IncrementalCache
let cache: IncrementalCache
let tagsManifest: Map<string, number>

beforeAll(async () => {
  // Use Next's actual cache and serializer, not a mocked memoization wrapper.
  vi.stubGlobal('AsyncLocalStorage', AsyncLocalStorage)
  Cache = (await import('next/dist/server/lib/incremental-cache')).IncrementalCache
  tagsManifest = (await import('next/dist/server/lib/incremental-cache/tags-manifest.external')).tagsManifest
  HomePage = (await import('@/app/[locale]/page')).default
})

beforeEach(() => {
  vi.clearAllMocks()
  tagsManifest.clear()
  // Next stores Date.now() but checks expiry against the performance clock.
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - performance.timeOrigin)
  cache = new Cache({
    dev: false,
    requestHeaders: {},
    flushToDisk: false,
    serverDistDir: '/unused-landing-cache-test',
    maxMemoryCacheSize: 1024 * 1024,
    fetchCacheKeyPrefix: randomUUID(),
    fs: { ...fs, existsSync, readFileSync, mkdir: (dir) => fs.mkdir(dir, { recursive: true }) },
    getPrerenderManifest: () => ({
      version: 4, routes: {}, dynamicRoutes: {}, notFoundRoutes: [],
      preview: { previewModeId: 'test', previewModeSigningKey: 'test', previewModeEncryptionKey: 'test' },
    }),
  })
  vi.stubGlobal('__incrementalCache', cache)
  events.mockResolvedValue({ upcoming: [{ id: 'event' }], past: [] })
  partners.mockResolvedValue([{ id: 'partner' }])
  games.mockResolvedValue([{ id: 'game' }])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(() => vi.unstubAllGlobals())

const render = (locale = 'es') => HomePage({ params: Promise.resolve({ locale }) })

describe('landing public data cache', () => {
  it('shares successful public reads across visits and locales', async () => {
    await render()
    const page = await render('en')

    expect(events).toHaveBeenCalledTimes(1)
    expect(partners).toHaveBeenCalledTimes(1)
    expect(games).toHaveBeenCalledTimes(1)
    expect(page.props).toMatchObject({
      locale: 'en', upcomingEvents: [{ id: 'event' }], partners: [{ id: 'partner' }], games: [{ id: 'game' }],
    })
  })

  it('keeps healthy sections and retries a failed source on the next visit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    partners.mockRejectedValueOnce(new Error('temporary outage'))
    expect((await render()).props).toMatchObject({ partners: [], games: [{ id: 'game' }] })
    expect((await render()).props.partners).toEqual([{ id: 'partner' }])
    expect(partners).toHaveBeenCalledTimes(2)
    expect(games).toHaveBeenCalledTimes(1)
  })

  it('reclassifies events at club midnight without expiring unrelated content', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // vitest config pins the club timezone to Europe/Madrid (UTC+1 in January).
    vi.setSystemTime(new Date('2026-01-05T22:59:59Z'))
    await render()
    events.mockResolvedValue({ upcoming: [], past: [{ id: 'event' }] })
    vi.setSystemTime(new Date('2026-01-05T23:00:01Z'))
    expect((await render()).props).toMatchObject({ upcomingEvents: [], pastEvents: [{ id: 'event' }] })
    expect(events).toHaveBeenCalledTimes(2)
    expect(partners).toHaveBeenCalledTimes(1)
  })

  it('refreshes public data after the one-minute lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now()
    await render()
    vi.setSystemTime(now + 61_000)
    await render()
    expect(events).toHaveBeenCalledTimes(2)
    expect(partners).toHaveBeenCalledTimes(2)
    expect(games).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['landing-club-events', events],
    ['landing-partners', partners],
    ['landing-library-games', games],
  ] as const)('invalidates %s after an administrative change', async (tag, loader) => {
    await render()
    await cache.revalidateTag(tag)
    await render('en')
    expect(loader).toHaveBeenCalledTimes(2)
    for (const other of [events, partners, games].filter((item) => item !== loader)) {
      expect(other).toHaveBeenCalledTimes(1)
    }
  })
})
