---
name: verify-regression-test-catches-bug-via-git-show
description: before trusting a new regression test's pass as meaningful, confirm the old (pre-fix) code would actually have failed it — use git show <old-sha>:path to check, without touching the working tree
metadata:
  type: feedback
---

When writing regression tests for review findings already fixed by
software-engineer (i.e. the fix is already in the worktree you're testing
against), a green test only proves the current code passes — it does not by
itself prove the test would have caught the bug before the fix. Since
qa-engineer must never edit `scripts/*.mjs` or other production files (not
even temporarily to verify a test fails-then-passes), the safe way to confirm
a test is a real regression guard is `git show <pre-fix-sha>:path/to/file.mjs`
piped through `grep`/reading — compare the exact logic (e.g. an `if
(filesToApply.length === 0)` gate, a missing cross-check, a missing
try/catch) against what the new test exercises, entirely read-only.

**Why:** used on PR #338 round 2 (#328, `apply-neon-schema.mjs`) — before
writing 4 new tests for 4 claimed findings, confirmed via `git show
bb5959c:scripts/apply-neon-schema.mjs` that all 4 behaviors (unconditional
re-verification, --allow-removed ledger cross-check, `assertLedgerTableShape`,
deferred-DELETE try/catch) were genuinely absent/different in the pre-fix
commit — not just cosmetic comment changes. This avoids writing a test that
would have passed unchanged before the fix too (a false sense of coverage),
without ever needing to mutate the production file to prove it.

**How to apply:** when a software-engineer handoff cites specific line
ranges/behavior as "now fixed", before writing the test, run `git show
<sha-before-the-fix-commit>:<file>` (or `git diff <before>..<after> --
<file>`) and read the relevant function to confirm the old behavior really
differs in the way the finding claims. If it doesn't (the "fix" is a no-op or
comment-only), that's a red flag to report back rather than write a
test that can never fail.
