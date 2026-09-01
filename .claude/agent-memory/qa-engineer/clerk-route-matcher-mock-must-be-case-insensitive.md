---
name: clerk-route-matcher-mock-must-be-case-insensitive
description: middleware.test.ts's createRouteMatcher mock needs the 'i' regex flag to actually reach case-variant-locale code paths, matching real Clerk behavior
metadata:
  type: feedback
---

In `__tests__/app/middleware.test.ts`, the `@clerk/nextjs/server` mock reimplements `createRouteMatcher` by compiling each pattern string into `new RegExp(`^${pattern}$`)`. Real Clerk's `createRouteMatcher` compiles case-insensitive regexes (documented in `middleware.ts`'s `localeFromPathname` comment). Without adding the `'i'` flag to the mock's `RegExp`, a case-variant path like `/EN/admin` never matches `isProtectedRoute` under test at all — so a regression test aimed at exercising the `localeFromPathname` fallback-to-`defaultLocale` branch would silently test nothing (the request falls through as an ordinary unprotected route instead of reaching the fallback logic).

**Why:** discovered while adding regression tests for #330 round 2 findings (PR #339 follow-up, 2026-08-22). Verified via a throwaway `node -e` regex check: same pattern with/without `'i'` gives opposite match results for `/EN/admin`. Confirms the general trap: a hand-rolled mock of a third-party matcher/router can drift from the real library's actual matching semantics (case sensitivity, anchoring, escaping) in ways that make a test compile and pass while exercising nothing real — same family as [[sql-mock-substring-dispatch-trap]] but for route matchers instead of SQL mocks.

**How to apply:** before trusting any test that depends on a mocked routing/matching library, check the mock's exact regex/flags/anchoring against a comment or doc that states the real library's actual semantics (or the library's own source/docs). If the task descriptions says "X should still match case-insensitively" or similar, verify the mock actually replicates that — don't assume a passing green test means the code path was reached. When in doubt, do a quick `node -e` sanity check of the regex behavior in isolation, the way `verify-regression-test-catches-bug-via-git-show` recommends verifying against the pre-fix commit.
