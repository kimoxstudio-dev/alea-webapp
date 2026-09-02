---
name: script-main-autorun-import-guard
description: scripts/*.mjs one-off scripts must guard main() behind an import.meta.url check, or importing them for unit tests executes live side effects (real process.exit, real DB calls)
metadata:
  type: feedback
---

Before writing any test that imports a file under `scripts/*.mjs` in this repo, check whether its
top-level `main().catch(...)` invocation is guarded with:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { ... ; process.exit(1); });
}
```

`scripts/seed-dev.mjs` has this guard (added deliberately for testability — see its test file
`__tests__/scripts/seed-dev.test.ts`, which calls exported functions directly without triggering
`main()`). `scripts/apply-neon-schema.mjs` did NOT have it as of the #328 branch
(`fix/apply-neon-schema-drift-detection-328`, e1296f1) even though that same commit added an
`export function computeChecksum` specifically "so qa-engineer can unit test it directly."

**Why this matters:** without the guard, `import('./scripts/apply-neon-schema.mjs')` alone runs
`main()` immediately as a module side effect — confirmed via a throwaway `node --input-type=module`
repro: it printed the DATABASE_URL-missing error and called a REAL `process.exit(1)`, before any
test mocking could apply. In a checkout with `.env.local` present (true of the main repo checkout,
confirmed 5291-byte file, DATABASE_URL not in shell env so it's sourced from there), the same import
would instead call `neon(realDatabaseUrl)` and issue live queries against the real Neon dev
database — a direct violation of "never execute against a real database" from every QA/security
agent prompt in this repo. Git worktrees do NOT copy untracked files, so `.env.local` does not exist
in a fresh `git worktree add` checkout, which is why the repro above was safe to run there but would
not be safe in the shared main checkout.

**How to apply:** if a `scripts/*.mjs` file you need to test lacks this guard, do not attempt to
route around it with fragile process.exit-mocking/unhandled-rejection tricks (a wrong scenario setup
can make production code fall through past a mocked no-op `process.exit` into a code path that
wouldn't run in reality, silently invalidating the test's own assertions, or worse, leaves a real
crash risk if a mock is ever misordered ahead of import). Send it back as a blocking finding —
request the guard + an `export` on `main` (if the test needs to invoke `main` itself), mirroring
`scripts/seed-dev.mjs` exactly. This is a zero-behavior-change infra fix (`import.meta.url` still
equals `file://${process.argv[1]}` when run directly via `node scripts/foo.mjs`), so it is a
reasonable, low-friction ask, not scope creep. See [[sql-mock-substring-dispatch-trap]] for the
sibling lesson on why fragile test-mock workarounds produce false confidence in this repo.
