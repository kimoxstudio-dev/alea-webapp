---
name: neon-migration-tests-also-check-cross-file-callers
description: when rewriting one service's test file after its Supabase-to-Neon migration, grep other test files for calls into that same service — they can hold stale Supabase mocks that now silently try a real DB connection
metadata:
  type: feedback
---

When a `lib/server/*.ts` migrates from Supabase to raw-SQL Neon (`sql` from
`lib/db/client.ts`), fixing that service's own dedicated test file is not
enough. Other test files that exercise the same service through the
Supabase mock (e.g. a cross-cutting test suite like
`oir208-unified-events.test.ts` that imports several services and mocks
`@/lib/supabase/server` globally) keep mocking the old client shape, which
no longer intercepts anything — the real (unmocked) `sql` tagged-template
from `lib/db/client.ts` runs, producing a real network-fetch error
(`NeonDbError: Error connecting to database: TypeError: fetch failed`)
instead of a clean assertion failure.

**Why:** found during #302 (rooms-service Neon migration QA). The dedicated
`rooms-service.test.ts` rewrite was fine, but `pnpm exec vitest run` (full
suite) still failed 2 tests in `oir208-unified-events.test.ts` because that
file's `getRoomTablesAvailability respects/blocks` tests called into
rooms-service without ever mocking `@/lib/db/client`.

**How to apply:**
1. After rewriting the dedicated test file for a migrated service, `grep -rl
   "from '@/lib/server/<service>'" __tests__/` (or the `import('@/lib/server/<service>')`
   dynamic form) to find every other test file that also exercises it.
2. Run the FULL suite (`pnpm exec vitest run`, not just the target file) —
   this class of failure only shows up there, not in a single-file run.
3. Fix it the same way as the dedicated file: add a `vi.mock('@/lib/db/client', ...)`
   with `createSqlMock()`/`sql-mock.ts` handlers scoped to just the affected
   tests, without touching the rest of that file's existing (still-valid)
   Supabase mocks for other not-yet-migrated services.
4. This counts as "your own test file" work (qa-engineer owns all test
   files), not scope creep — fixing it is required before reporting a clean
   full-suite pass. See [[fake-sql-mock-needs-per-query-shape-handler]] for
   the sibling "SQL mocks need per-statement handlers" trap.
