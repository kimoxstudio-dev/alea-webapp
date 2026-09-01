---
name: redirect-mock-does-not-throw-check-early-return
description: this repo's next/navigation redirect mock is a plain non-throwing vi.fn(); a page missing an explicit `return redirect(...)` will fall through further code under test even though production works fine (real redirect() throws NEXT_REDIRECT)
metadata:
  type: feedback
---

`__tests__/app/*.test.tsx` (e.g. `auth-pages.test.tsx`, `check-in-page.test.tsx`) mock `next/navigation`'s
`redirect` as a bare `vi.fn()` that does not throw. In production, Next's real `redirect()` throws
`NEXT_REDIRECT` and execution never continues past the call. Some pages guard against this correctly with
an explicit `return redirect(...)` (e.g. `app/[locale]/rooms/page.tsx`); others (e.g.
`app/[locale]/check-in/[tableId]/page.tsx` as of commit 4600763) call `redirect(...)` with no `return`,
relying on the real throw to stop execution — under the non-throwing test mock, code after the call (e.g.
`markExpiredReservationsAsNoShow()`, the JSX return) still executes.

**Why:** discovered while writing regression tests for #330 follow-up (check-in redirect query-param
preservation, 2026-08-22). Not a production bug — real `redirect()` always throws — but it means a test
must not assert "downstream mock X was NOT called after redirect" for pages lacking the explicit
`return`, or the assertion will be flaky/wrong depending on whether the page happens to guard the call.

**How to apply:** before writing assertions like `expect(someMock).not.toHaveBeenCalled()` after a
redirect branch, check whether the page under test has `return redirect(...)` or a bare `redirect(...)`
call. If bare, only assert on the redirect call's arguments — don't assume nothing after it ran.
