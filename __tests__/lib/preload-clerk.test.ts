// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'

// `preloadClerkOnIntent` keeps module-level state (`started`), and the
// mocked `@clerk/nextjs` module is cached once resolved — so each test
// registers its own fresh mock via `vi.doMock` and resets the module
// registry before re-importing, to get a clean `started` flag and a mock
// that will actually be invoked again.
async function setup() {
  vi.resetModules()
  const importClerkMock = vi.fn(() => Promise.resolve({}))
  vi.doMock('@clerk/nextjs', () => importClerkMock())
  const mod = await import('@/lib/preload-clerk')
  return { preloadClerkOnIntent: mod.preloadClerkOnIntent, importClerkMock }
}

function stubConnection(saveData: boolean | undefined) {
  Object.defineProperty(navigator, 'connection', {
    configurable: true,
    value: saveData === undefined ? undefined : { saveData },
  })
}

describe('preloadClerkOnIntent', () => {
  afterEach(() => {
    // @ts-expect-error — cleaning up a test-only property
    delete navigator.connection
    vi.doUnmock('@clerk/nextjs')
    vi.restoreAllMocks()
  })

  it('triggers the dynamic import on the first call', async () => {
    stubConnection(undefined)
    const { preloadClerkOnIntent, importClerkMock } = await setup()

    preloadClerkOnIntent()

    await vi.waitFor(() => expect(importClerkMock).toHaveBeenCalledTimes(1))
  })

  it('is a no-op on the second call (idempotent per page load)', async () => {
    stubConnection(undefined)
    const { preloadClerkOnIntent, importClerkMock } = await setup()

    preloadClerkOnIntent()
    await vi.waitFor(() => expect(importClerkMock).toHaveBeenCalledTimes(1))

    preloadClerkOnIntent()
    preloadClerkOnIntent()

    expect(importClerkMock).toHaveBeenCalledTimes(1)
  })

  it('does not start the import when navigator.connection.saveData is true', async () => {
    stubConnection(true)
    const { preloadClerkOnIntent, importClerkMock } = await setup()

    preloadClerkOnIntent()

    expect(importClerkMock).not.toHaveBeenCalled()
  })

  it('still preloads when navigator.connection is undefined (Safari has no Network Information API)', async () => {
    stubConnection(undefined)
    const { preloadClerkOnIntent, importClerkMock } = await setup()

    preloadClerkOnIntent()

    await vi.waitFor(() => expect(importClerkMock).toHaveBeenCalledTimes(1))
  })

  it('re-checks saveData on every call: preloads once saveData turns off', async () => {
    stubConnection(true)
    const { preloadClerkOnIntent, importClerkMock } = await setup()

    preloadClerkOnIntent()
    expect(importClerkMock).not.toHaveBeenCalled()

    stubConnection(false)
    preloadClerkOnIntent()

    await vi.waitFor(() => expect(importClerkMock).toHaveBeenCalledTimes(1))
  })

  it('resets the started flag and allows a retry when the import rejects', async () => {
    stubConnection(undefined)
    vi.resetModules()
    const importClerkMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('network blocked')))
      .mockImplementation(() => Promise.resolve({}))
    vi.doMock('@clerk/nextjs', () => importClerkMock())
    const { preloadClerkOnIntent } = await import('@/lib/preload-clerk')

    preloadClerkOnIntent()
    await vi.waitFor(() => expect(importClerkMock).toHaveBeenCalledTimes(1))

    // Retry until the rejected promise's `.catch()` handler has reset
    // `started` — calling before the reset lands is a harmless no-op.
    await vi.waitFor(() => {
      preloadClerkOnIntent()
      expect(importClerkMock).toHaveBeenCalledTimes(2)
    })
  })
})
