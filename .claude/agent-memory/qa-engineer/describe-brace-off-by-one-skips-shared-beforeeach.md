---
name: describe-brace-off-by-one-skips-shared-beforeeach
description: an extra stray closing brace before a trailing describe block silently makes it a sibling top-level describe instead of nested, so it never inherits the outer beforeEach reset
metadata:
  type: feedback
---

A test file's outer `describe('X', () => { beforeEach(() => mock.reset()); ... })`
can accidentally close one brace too early right before its last nested
`describe`, e.g.:

```ts
describe('X', () => {
  beforeEach(() => mock.reset())
  describe('A', () => { ... })
  describe('B', () => { ... })
})          // <- closes X here, one level too early

describe('C', () => { ... })   // now a SIBLING top-level describe, not nested in X
```

This still parses and runs fine — no syntax error, tests inside `C` execute
normally — but `C` never runs `X`'s `beforeEach`, so any shared mock
(`createSqlMock()`-style) never gets reset before `C`'s tests. Handlers
registered by an EARLIER test elsewhere in the file (in `A` or `B`) can then
leak forward into `C`'s tests if any of those earlier handlers used a broad
`match` (e.g. `stmt.table === 'x'` with no other condition).

**Why:** discovered 2026-08-31 in `oir208-unified-events.test.ts` (#304) —
tests that passed in isolation (`-t "test name"`) failed with a confusing
`Cannot read properties of undefined (reading 'slice')` only when run as
part of the full file, because a catch-all `event_room_blocks` handler from
an unrelated, much-earlier "Availability" reservation test leaked in.

**How to apply:**
- When a test in a file behaves differently in isolation (`-t "exact name"`)
  vs. in the full run, suspect describe-nesting/shared-mock-reset before
  suspecting real cross-test state. Bisect with `-t "regexA|regexB"` to
  narrow which earlier test's registration is leaking.
- Count `describe(` opens vs `})` closes visually around any trailing block,
  especially near the end of a large (1000+ line) file where indentation
  drift makes an extra/missing brace easy to miss on a quick read.
- Prefer one `beforeEach` per file when every describe shares the same mock
  reset need — nesting depth doesn't matter as long as it's a true ancestor.
