---
name: stale-test-encodes-old-error-message-shape
description: A pre-existing green test can assert the exact pre-fix buggy behavior (e.g. raw error.message leak); a follow-up fix round must update it, not just add new tests
metadata:
  type: feedback
---

When a code-review follow-up round changes how a caught error is mapped to a response (e.g. stops leaking raw Postgres `error.message` in favor of a constraint-name → normalized-code map), always grep the existing test file for an assertion that encodes the OLD shape before writing new tests. In saved-games-service.test.ts (#301 round4), a test literally asserted `{ message: 'check constraint violated', statusCode: 400 }` — i.e. it hard-coded the pre-fix behavior as the expected result. It happened to still be green only because the round4 diff hadn't been applied yet when first read; once the fix landed it would fail, so it had to be rewritten (not just left alongside new tests) to assert the new per-constraint-name mapping.

**Why:** if left in place, an old assertion like this either (a) fails and gets misdiagnosed as a QA regression rather than recognized as intentionally-stale coverage, or (b) if the implementer "fixes" it by reverting behavior to keep it green, it silently re-introduces the leak. Either way it defeats the purpose of the round.

**How to apply:** before writing new tests for a "stop leaking X / map by constraint name instead" fix, search the test file for assertions on the literal old value (raw message text, unconditional catch-all boolean checks like `error.code === '23505'` mirrored in a test's mock setup) and update them to reflect the new mapping — same technique as [[verify-regression-test-catches-bug-via-git-show]]: temporarily revert the source fix locally, confirm the updated tests fail against the old logic, then restore.
