---
name: apply-neon-schema-review-patterns
description: Recurring correctness/atomicity gaps found in scripts/apply-neon-schema.mjs across PR #338 review rounds — check for these in future changes to this file
metadata:
  type: project
---

`scripts/apply-neon-schema.mjs` is a hand-rolled DB migration/drift-detection
CLI script (no framework), so it is easy to introduce non-atomic writes or
check-ordering bugs that a framework migration tool would prevent by
construction. Two real correctness bugs were caught in this file by an
exhaustive `/code-review` pass that the manual security read (secrets/CORS/
input-validation focused) missed entirely, on PR #338's second commit
(2026-08-22):

1. **Non-atomic side effects on an abort path.** A DB write (a ledger-row
   `DELETE` for the `--allow-removed` bypass) was executed as soon as it was
   classified as safe, before *later* independent checks in the same
   function had a chance to abort the run. A later abort still left that
   write committed — breaking the script's own documented "abort before any
   statements are executed" invariant. **How to check next time:** in any
   script/function with multiple sequential abort conditions (`process.exit`
   calls) mixed with DB writes, verify every write is deferred until *all*
   abort conditions preceding it in execution order have already passed —
   not just the ones the write's own code block was written to guard against.

2. **Ordering-induced dead code / unreachable safety-bypass flag.** A newly
   added `--allow-removed <file>` bypass flag was checked by a bypass-check
   function that itself ran *after* an unrelated earlier check
   (`assertDatabaseIsCleanOrOwned`'s "unexpected table" step) which, for the
   flag's own primary documented use case, would already fail and exit
   before the bypass logic was ever reached. **How to check next time:**
   when a new CLI flag or bypass path is added to an existing multi-step
   validation pipeline, trace whether any *earlier* step in that pipeline can
   independently reject the exact scenario the new flag exists to permit. A
   regression test that avoids triggering the earlier step (as the original
   PR's own test for `--allow-removed` did, by not including the removed
   file's table in mocked `publicTables`) will pass while the bug ships.

Neither of these are "security" issues in the traditional secrets/injection/
auth sense — they're data-integrity/reliability bugs in a migration tool
touching a real database. Flag them anyway; this repo's security-reviewer
role owns the mandatory `/code-review` pass and these are exactly the class
of bug it exists to catch that a conventions-focused manual read won't.

See also [[mandatory-code-review-before-pr-open]] (global memory) — this is
a concrete instance of why that step earns its keep even on a "just fix two
review comments" follow-up commit.

## Round 3 (2026-08-22) — the fixer reintroduced the same bug class it fixed

`be0d32a`'s fix for Finding 2 (validate `--allow-removed` against the
loaded ledger *before* the preflight bypass can be honored) needed the
ledger loaded early, and its author solved that by moving
`ensureLedgerTable()` — a real `CREATE TABLE` write — to run before
`assertDatabaseIsCleanOrOwned()`, the read-only preflight whose whole job
is "abort with zero mutations if this database isn't ours." That
reintroduced exactly the class of defect this file's round 1 already
fixed once (non-atomic mutation ahead of a later abort check) — a
preflight failure against a foreign/unowned database would still leave a
stray `schema_migrations` table behind in it. Manual read alone caught
this (traced call order against the preflight's own docstring); the
automated `/code-review` pass on the same commit independently flagged
the identical line. **How to check next time:** whenever a fix for one
finding needs data that used to be read *after* a gate, check whether the
fix's author also moved an accompanying *write* earlier to get that data —
loading data early is fine, mutating early is not. Split "read what you
need" from "write when it's safe" into separate calls if the fix conflates
them.

Fix applied: split `assertLedgerTableShape(sql)` into a read-only
`getLedgerTableColumns(sql)` + synchronous `assertLedgerTableShape(columns)`,
so the shape/`--allow-removed` checks stay read-only pre-preflight, and
`ensureLedgerTable()` moved back to after preflight passes. A second
`/code-review` pass on the fix-of-the-fix found no live bug, only a
maintainability note (the "no abort after ledger is written" invariant
isn't enforced by a guard, just true today) — addressed with a warning
comment at the call site rather than more structural change, since the
reviewer itself couldn't produce a live failure scenario.

Separately: this worktree's `node_modules` was essentially empty (only
vitest's own cache dirs) even though `vitest`/`npx vitest` ran fine —
Node's `require()` resolution walks up ancestor directories and silently
found the *main checkout's* `node_modules`, masking the gap. The pre-push
hook's `pnpm typecheck`/`next build` steps do not do that upward walk and
failed with `next: command not found` until `pnpm install` was run
directly in the worktree (safe — this prohibition is scoped to the shared
main checkout, not an agent's own isolated worktree). **How to check next
time:** if a worktree's own tooling (build/typecheck via package.json
scripts) fails with a "command not found" for a package that's clearly a
dependency, don't assume the dependency is missing from the project —
check whether `node_modules/.bin/<cmd>` exists in *that specific worktree*
before concluding anything about the code itself.
