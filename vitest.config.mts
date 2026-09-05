import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    teardownTimeout: 10000,
    // Keep file execution sequential; parallel workers add memory pressure here.
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    env: {
      // Pin tests to a known IANA timezone so service code and test helpers agree.
      // The service defaults to the server's system timezone when this is unset;
      // test helpers fall back to 'Europe/Madrid' — pinning here keeps them in sync.
      CLUB_TIMEZONE: 'Europe/Madrid',
    },
    include: ['__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['node_modules', '.next', '**/*.d.ts'],
      include: [
        'lib/server/**/*.ts',
        'app/api/**/*.ts',
        'lib/auth/auth-context.tsx',
      ],
      // Explicitly measure every file matched by `include`, not just files
      // touched by an imported test. Without this, an untested route (e.g.
      // an app/api/**/*.ts handler with zero test imports) is silently
      // dropped from the report instead of counting as 0% — inflating the
      // aggregate percentage and hiding real gaps from the thresholds below.
      all: true,
      // Global thresholds: baseline floor across all measured files (80.57% actual lines).
      // Untested API routes (0% coverage) are allowed at global floor; they must be
      // improved separately as part of KIM-408+. Per-glob overrides below preserve
      // the high bar for security-critical auth layer so regressions are caught.
      thresholds: {
        lines: 80,
        functions: 85,
        branches: 75,
        statements: 80,
        // Auth layer: measured at 85-100% lines across all routes.
        // Per-glob overrides hold the strong bar here so regressions trigger alerts.
        'lib/server/auth-service.ts': {
          lines: 85,
          functions: 85,
          branches: 63,
          statements: 85,
        },
        'lib/server/auth.ts': {
          lines: 100,
          functions: 100,
          branches: 93,
          statements: 100,
        },
        'app/api/auth/**/*.ts': {
          lines: 87,
          functions: 85,
          branches: 75,
          statements: 87,
        },
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './') },
  },
})
