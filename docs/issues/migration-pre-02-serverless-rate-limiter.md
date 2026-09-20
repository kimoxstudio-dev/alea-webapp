# Pre-02: Serverless-safe rate limiter
Phase: Pre (Supabase to Neon migration blockers). Depends on: none.
Problem: current rate limiter stores state in a globalThis Map. On Vercel serverless/Edge, each invocation may run in a fresh isolate -- Map does not persist across instances, rate limiting silently becomes a no-op under real traffic.
Scope: Locate rate-limiter implementation (lib/server/) and call sites (enforceRateLimit). Replace in-memory globalThis Map with a persistence layer surviving across serverless instances: (1) dedicated Postgres table (preferred, works today against Supabase and later Neon), or (2) an external shared store. Keep enforceRateLimit signature stable.
Acceptance criteria: rate limit state shared correctly across at least two concurrent invocations (test simulating this). pnpm build and pnpm typecheck pass. No regression in existing rate-limit tests.
Out of scope: do not change rate-limit thresholds/policy, only storage mechanism. Do not touch unrelated lib/server/ files.
