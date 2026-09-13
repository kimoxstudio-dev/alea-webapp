// @vitest-environment node
/**
 * Regression guard for #414.
 *
 * The public landing page (`app/[locale]/page.tsx`) was pulled out of the
 * webapp chrome: Clerk, `AuthProvider`, `Header` and `Footer` now live only
 * in `app/[locale]/(app)/layout.tsx`, and every authenticated route moved
 * into the `(app)` route group so it still gets that chrome. Nothing
 * asserted this split before — a revert of either half (re-wrapping
 * `app/[locale]/layout.tsx` in `ClerkProvider` again, or dragging a route
 * back out of `(app)`) would leave the whole suite green.
 *
 * This is a source scan, not a runtime render: it reads the layout files
 * and enumerates `page.tsx` files on disk directly, the same style
 * `__tests__/server/member-row-scoping-enforcement.test.ts` uses for its
 * own structural enforcement.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const REPO_ROOT = join(__dirname, '..', '..')
const APP_ROOT = join(REPO_ROOT, 'app')
const LOCALE_DIR = join(APP_ROOT, '[locale]')
const LANDING_COMPONENTS_DIR = join(REPO_ROOT, 'components', 'landing')

const CHROME_MARKERS = ['@clerk/nextjs', 'auth-context', 'layout/header', 'layout/footer', 'getSessionFromServerCookies']

/**
 * #414 Phase 2: with `middleware.ts` now excluding the landing route from
 * `clerkMiddleware()` entirely, `auth()`/`currentUser()` throw at runtime
 * (not build time) if called outside a Clerk-wrapped request. A stray Clerk
 * import creeping into the landing page's render tree is no longer just a
 * bundle-size regression — it's a runtime 500 for every visitor.
 *
 * This must also catch INDIRECT entry points into that same runtime path —
 * not just a direct `@clerk/nextjs` import. `getSessionFromServerCookies`
 * (lib/server/auth) calls `getClerkSession()` internally, and `requireAuth`/
 * `requireAdmin` (lib/server/auth) call that in turn — any of these landing
 * back on the landing page reproduces the exact runtime 500 this test
 * guards against, the same way the just-deleted `app/page.tsx` did.
 */
const CLERK_MARKERS = [
  '@clerk/nextjs',
  'getClerkSession',
  'getClerkUser',
  'getSessionFromServerCookies',
  'requireAuth',
  'requireAdmin',
  'lib/server/session',
]

// The layout scan must catch every indirect entry point CLERK_MARKERS covers
// (getClerkSession/getClerkUser/requireAuth/requireAdmin/lib/server/session),
// not just the narrower CHROME_MARKERS list — a stray import of any of them
// in app/[locale]/layout.tsx reproduces the same runtime-500-on-landing bug.
const LAYOUT_MARKERS = [...new Set([...CHROME_MARKERS, ...CLERK_MARKERS])]

describe('landing route stays scoped off Clerk/webapp chrome (#414)', () => {
  it.each(['layout.tsx', join('[locale]', 'layout.tsx')])(
    'app/%s references none of the webapp-chrome imports',
    (relativePath) => {
      const source = readFileSync(join(APP_ROOT, relativePath), 'utf-8')

      for (const marker of LAYOUT_MARKERS) {
        expect(source, `app/${relativePath} unexpectedly references "${marker}"`).not.toContain(marker)
      }
    },
  )

  it('app/[locale]/(app)/layout.tsx exists and contains all webapp-chrome markers', () => {
    const layoutPath = join(LOCALE_DIR, '(app)', 'layout.tsx')
    const source = readFileSync(layoutPath, 'utf-8')

    for (const marker of CHROME_MARKERS) {
      expect(source, `app/[locale]/(app)/layout.tsx is missing "${marker}"`).toContain(marker)
    }
  })

  function walkFiles(dir: string): string[] {
    const filePaths: string[] = []
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      if (statSync(fullPath).isDirectory()) {
        filePaths.push(...walkFiles(fullPath))
      } else {
        filePaths.push(fullPath)
      }
    }
    return filePaths
  }

  it('every page.tsx under app/[locale] other than the landing page itself lives under (app)/', () => {
    const pagePaths = walkFiles(LOCALE_DIR)
      .filter((fullPath) => fullPath.endsWith('page.tsx'))
      .map((fullPath) => relative(LOCALE_DIR, fullPath))

    // Sanity check that the walk actually found something — an empty result
    // would make every assertion below vacuously true.
    expect(pagePaths.length).toBeGreaterThan(1)

    const landingPage = 'page.tsx'
    const nonLandingPages = pagePaths.filter((p) => p !== landingPage)

    expect(nonLandingPages.length).toBeGreaterThan(0)
    for (const pagePath of nonLandingPages) {
      expect(pagePath.startsWith('(app)' + '/'), `${pagePath} is not under (app)/`).toBe(true)
    }

    // The landing page itself must NOT be under (app) — it's the one route
    // deliberately excluded from the webapp chrome.
    expect(pagePaths).toContain(landingPage)
  })

  it('app/[locale]/page.tsx references none of the Clerk imports (#414 Phase 2)', () => {
    const source = readFileSync(join(LOCALE_DIR, 'page.tsx'), 'utf-8')

    for (const marker of CLERK_MARKERS) {
      expect(source, `app/[locale]/page.tsx unexpectedly references "${marker}"`).not.toContain(marker)
    }
  })

  it('every file under components/landing/ references none of the Clerk imports (#414 Phase 2)', () => {
    const landingFiles = walkFiles(LANDING_COMPONENTS_DIR)

    // Sanity check the walk actually found something.
    expect(landingFiles.length).toBeGreaterThan(0)

    for (const fullPath of landingFiles) {
      const source = readFileSync(fullPath, 'utf-8')
      const relativePath = relative(LANDING_COMPONENTS_DIR, fullPath)

      for (const marker of CLERK_MARKERS) {
        expect(source, `components/landing/${relativePath} unexpectedly references "${marker}"`).not.toContain(marker)
      }
    }
  })
})
