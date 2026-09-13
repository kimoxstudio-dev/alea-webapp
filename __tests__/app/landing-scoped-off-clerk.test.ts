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

const APP_ROOT = join(__dirname, '..', '..', 'app')
const LOCALE_DIR = join(APP_ROOT, '[locale]')

const CHROME_MARKERS = ['@clerk/nextjs', 'auth-context', 'layout/header', 'layout/footer', 'getSessionFromServerCookies']

describe('landing route stays scoped off Clerk/webapp chrome (#414)', () => {
  it.each(['layout.tsx', join('[locale]', 'layout.tsx')])(
    'app/%s references none of the webapp-chrome imports',
    (relativePath) => {
      const source = readFileSync(join(APP_ROOT, relativePath), 'utf-8')

      for (const marker of CHROME_MARKERS) {
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

  it('every page.tsx under app/[locale] other than the landing page itself lives under (app)/', () => {
    const pagePaths: string[] = []

    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const fullPath = join(dir, entry)
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath)
        } else if (entry === 'page.tsx') {
          pagePaths.push(relative(LOCALE_DIR, fullPath))
        }
      }
    }
    walk(LOCALE_DIR)

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
})
