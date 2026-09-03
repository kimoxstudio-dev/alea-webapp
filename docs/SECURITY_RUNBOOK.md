# Security Hardening Runbook

## Active controls

- The session cookie is issued and managed entirely by Clerk (`clerkMiddleware()`, `middleware.ts:38`) — its name, `HttpOnly`, `SameSite`, and `Secure` attributes are Clerk's to set, not application code's. `lib/server/session.ts`'s `getClerkSession()`/`requireClerkSession()` read the resolved session (`auth()`/`currentUser()` from `@clerk/nextjs/server`) but never construct or touch the cookie directly.
- The app's own cookie is the CSRF token (`alea-csrf-token`, non-`HttpOnly`, `SameSite=Lax`, `Secure` in production — `lib/server/security-edge.ts`'s `getCsrfCookieOptions()`), issued by `ensureCsrfCookie()` in `middleware.ts:45`.
- Mutating Next.js API routes require all of:
  - same-origin `Origin`
  - trusted Fetch Metadata (`Sec-Fetch-Site` must not be `cross-site`)
  - double-submit CSRF token (`alea-csrf-token` cookie + `x-csrf-token` header)
- Rate limiting is enforced per client IP on:
  - `POST /api/auth/login`
  - `POST /api/auth/register`
  - `POST /api/auth/logout`
  - admin mutation routes
  - reservation mutation routes
- `x-forwarded-for` is only trusted when `TRUST_PROXY_HEADERS=true` and the immediate request source IP in `x-real-ip` belongs to a proxy range explicitly allowlisted via `TRUSTED_PROXY_CIDRS`. Otherwise the app falls back to `x-real-ip` (or `local` when no trusted source IP is present).
- Because `NextRequest` does not expose a verifiable socket peer IP in this runtime, this control assumes the ingress strips and rewrites both `x-real-ip` and `x-forwarded-for` before the request reaches the app.

## Operational notes

- The rate limiter is in-memory and best-effort. It is appropriate for local and single-instance deployments, but shared infrastructure should own the final abuse-control layer.
- If you run a reverse proxy in front of the app, set `TRUST_PROXY_HEADERS=true` and configure `TRUSTED_PROXY_CIDRS` to the source-IP ranges for that proxy/CDN. Do not forward user-controlled `x-forwarded-for` blindly. Also ensure the proxy/CDN strips or overwrites any inbound `x-real-ip` header and sets `x-real-ip` only from a trusted source IP so clients cannot spoof the allowlist check.
- The CSRF cookie stays at `SameSite=Lax` (not `Strict`) to avoid breaking legitimate cross-page navigation and provider callback flows (e.g. Clerk OAuth/SSO redirects landing back on the app). The Clerk-managed session cookie's `SameSite` value is controlled by Clerk, not by this app.
- The CSRF cookie is intentionally readable by the browser because the client must echo it in `x-csrf-token`. The auth session cookie remains `HttpOnly`.

## Incident response

### Session compromise

1. Revoke the affected sessions from the Clerk Dashboard → Users → the affected user → Sessions tab → revoke each active session. There is no single "revoke all sessions for this user" call wired into this codebase — the app's own `logout()` (`lib/server/auth-service.ts:666-680`) only revokes the **current caller's own session** (it resolves the target via `getClerkSession()` → Clerk's `auth()`, which is scoped to the request making the call, at `client.sessions.revokeSession(clerkSession.sessionId)`, line 674) — it cannot target another user's session and is not a tool for incident response against someone else's account.
2. If the account itself needs to be locked out immediately (e.g. credential compromise, not just a stolen session), ban the user from the Clerk Dashboard → Users → the affected user → Ban. This blocks new sign-ins without needing to enumerate sessions.
3. Review recent auth, reservation, and admin mutation activity for the impacted users.
4. If the blast radius is unclear, rotate `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in the Clerk Dashboard (Configure → API Keys) and redeploy.
5. Confirm clients receive a fresh session cookie (Clerk-issued) and a fresh CSRF cookie (`alea-csrf-token`) after recovery.

### Clerk secret key or environment secret compromise

1. Rotate `CLERK_SECRET_KEY` immediately via Clerk Dashboard → Configure → API Keys → regenerate secret key.
2. Rotate `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` if exposure scope is uncertain (Dashboard → Configure → API Keys → publishable key).
3. Redeploy with the new secrets.
4. Audit privileged Neon database reads and writes that could have occurred using a compromised server-side identity while the key was exposed. Unlike Supabase's RLS-bypassing service-role key, `CLERK_SECRET_KEY` does not itself grant direct database access — it authenticates calls to the Clerk Backend API (user/session management). Database privilege checks live in the service layer (see `CLAUDE.md`'s "Key conventions"), not in Clerk, so also audit `DATABASE_URL` exposure separately if that connection string could have leaked in the same incident.

### CSRF or abuse-control bypass suspicion

1. Inspect recent requests missing `Origin`, failing `Sec-Fetch-Site`, or returning `429`.
2. Confirm middleware is still issuing the `alea-csrf-token` cookie on page responses.
3. Tighten the affected route budget or move throttling to shared edge/storage-backed infrastructure.
4. Add a regression test that reproduces the bypass before shipping the mitigation.
