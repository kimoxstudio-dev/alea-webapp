---
name: mock-must-keep-real-error-class-alongside-mocked-factory
description: vi.mock('@/lib/server/service-error', ...) that only stubs serviceError() and omits the ServiceError class breaks any `error instanceof ServiceError` check in the code under test
metadata:
  type: feedback
---

When mocking `@/lib/server/service-error` (or any module exporting both a
throwing helper function and the error class it throws), a factory that
only returns `{ serviceError: vi.fn(...) }` and omits the `ServiceError`
class leaves the named import `ServiceError` as `undefined` in the module
under test. Vitest doesn't even give you `undefined` cleanly — accessing an
unlisted export on a `vi.mock`-replaced module throws `[vitest] No "X"
export is defined on the "..." mock` the moment the code references it.

Several services (e.g. `club-events-service.ts`) do
`if (error instanceof ServiceError) throw error` inside error-handling
paths — with the export missing, this throws Vitest's proxy error instead
of taking either intended branch, and the resulting failure is confusing:
it looks like a totally unrelated 500 ("Internal server error") because the
outer catch's fallback (`mapClubEventWriteError`) ends up handling the proxy
error instead.

**Why:** discovered 2026-08-31 during #304 (club-events-service Neon
migration) test rewrite — a "rejects a block whose table_id doesn't belong
to room_id" test that should 400 was getting a 500 instead, and the root
cause was entirely in test mocking, not service logic.

**How to apply:** when a service module imports both a `serviceError(...)`
helper AND the `ServiceError` class it throws (check for
`import { serviceError, ServiceError } from '@/lib/server/service-error'`),
mock it with `vi.importActual` to keep the real class:

```ts
vi.mock('@/lib/server/service-error', async () => {
  const actual = await vi.importActual<typeof import('@/lib/server/service-error')>('@/lib/server/service-error')
  return {
    ServiceError: actual.ServiceError,
    serviceError: vi.fn((message: string, statusCode: number) => {
      throw new actual.ServiceError(message, statusCode)
    }),
  }
})
```

Grep for `instanceof ServiceError` in the service file being tested before
writing this mock — if present, the plain-object mock (`new Error(...) as
ServiceError`) is silently wrong even though it looks fine for tests that
never reach that instanceof branch.
