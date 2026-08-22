# Architecture — Alea WebApp

**Last updated:** 2026-04-05
**Milestone:** M6 (post-flatten, single Next.js app)

---

## Overview

Alea is a single Next.js 15 application at the repository root. There is no monorepo, no separate backend process, and no NestJS. All server-side logic runs inside Next.js Route Handlers backed by Supabase.

---

## Stack

| Concern | Technology |
|---|---|
| Framework | Next.js 15, App Router |
| UI | React 19, Tailwind CSS, shadcn/ui |
| Auth & DB | Supabase (PostgreSQL + Row Level Security + Supabase Auth) |
| i18n | next-intl (ES + EN, locale-prefixed URLs) |
| Validation | Zod |
| Data fetching | TanStack Query (client), Route Handlers (server) |
| Testing | Vitest + React Testing Library |
| Language | TypeScript (strict) |

---

## Directory Layout

```
alea-webapp/
├── app/                        # Next.js App Router
│   ├── layout.tsx              # Root HTML shell (no locale)
│   ├── page.tsx                # Root redirect to default locale
│   ├── globals.css
│   ├── api/                    # Route Handlers (server-side endpoints)
│   │   ├── auth/               # login, logout, me, register, callback
│   │   ├── rooms/              # room listing, tables, availability
│   │   ├── reservations/       # reservation CRUD
│   │   └── users/              # user CRUD (admin)
│   └── [locale]/               # Locale-prefixed routes (/es/..., /en/...)
│       ├── layout.tsx          # Locale layout with providers
│       ├── page.tsx            # Home / landing
│       ├── login/page.tsx
│       ├── register/page.tsx
│       ├── rooms/page.tsx
│       ├── reservations/page.tsx
│       └── admin/page.tsx       # Admin dashboard (admin-only, guarded by requireAdmin)
├── components/                 # Reusable React components (client + server)
├── lib/
│   ├── server/                 # Server-side service layer (never imported client-side)
│   │   ├── auth.ts             # Session guard helpers: requireAuth, requireAdmin, getSessionFromRequest
│   │   ├── auth-service.ts     # Login (member number only), logout, getCurrentUser
│   │   ├── users-service.ts    # User CRUD operations
│   │   ├── rooms-service.ts    # Room listing and lookup
│   │   ├── tables-service.ts   # Table listing, lookup, QR codes
│   │   ├── reservations-service.ts  # Reservation business logic
│   │   ├── availability.ts     # Slot generation, conflict detection, removable_top surface logic
│   │   ├── security.ts         # enforceMutationSecurity, enforceRateLimit, ensureCsrfCookie
│   │   ├── http-error.ts       # Response converter: maps ServiceError to NextResponse JSON
│   │   └── service-error.ts    # ServiceError class and serviceError() throw helper
│   ├── api/                    # Client-side API layer
│   │   ├── client.ts           # Typed fetch wrapper (apiClient singleton); attaches CSRF header on mutations
│   │   └── endpoints.ts        # API path constants
│   ├── auth/
│   │   └── auth-context.tsx    # AuthProvider and useAuth hook (client-side auth state)
│   ├── hooks/                  # Client-side React hooks
│   │   ├── use-rooms.ts
│   │   └── use-reservations.ts
│   ├── i18n/                   # next-intl configuration
│   │   ├── config.ts           # Locale list and default locale
│   │   └── request.ts          # Per-request locale resolution (used by next.config.ts)
│   ├── validations/            # Shared Zod schemas (used by both client forms and server route handlers)
│   │   ├── auth.ts             # loginSchema, registerSchema, passwordSchema
│   │   └── password.ts         # Password strength validation rules
│   ├── supabase/               # Supabase client factories and config getters
│   │   ├── client.ts           # Browser client factory (createSupabaseBrowserClient)
│   │   ├── server.ts           # Server client factories: createSupabaseServerClient, createSupabaseRouteHandlerClient, createSupabaseServerAdminClient
│   │   ├── config.ts           # Server-only config getters (secret key); guarded by `server-only`
│   │   ├── config.client.ts    # Browser-safe config getters (URL, publishable key)
│   │   └── types.ts            # Generated DB types
│   ├── types/
│   │   └── index.ts            # Shared TypeScript domain types (User, Room, etc.)
│   ├── providers.tsx           # React provider tree (QueryClientProvider, AuthProvider, etc.)
│   └── utils.ts                # Shared utility functions
├── messages/                   # i18n JSON files (es.json, en.json)
├── middleware.ts               # i18n routing, Supabase token refresh side effect, CSRF cookie setup
├── supabase/                   # Supabase project config
│   ├── config.toml             # Local dev config
│   └── migrations/             # SQL migration files (versioned)
└── __tests__/                  # Integration and unit tests
```

---

## Server Layer (`lib/server/`)

`lib/server/` is the application's server-side logic layer. It replaces the former NestJS backend.

All modules in this layer:
- Are intended to be imported only from Route Handlers (`app/api/`) or Server Components. `lib/server/security.ts` is additionally imported from `middleware.ts` for the `ensureCsrfCookie` and `getSupabaseCookieOptions` helpers.
- Never run in the browser.
- Call Supabase directly using the server-side client factories from `lib/supabase/server.ts`.
- Throw `ServiceError` instances via the `serviceError()` helper — never raw strings.

Each service module maps to a domain:

| Module | Responsibility |
|---|---|
| `auth.ts` | Session guard helpers: `requireAuth`, `requireAdmin`, `getSessionFromRequest`, `getSessionFromServerCookies` |
| `auth-service.ts` | Login (member number only), logout, `getCurrentUser` |
| `users-service.ts` | User CRUD, role management |
| `rooms-service.ts` | Room listing and lookup |
| `tables-service.ts` | Table listing, lookup, QR codes |
| `reservations-service.ts` | Create, update, cancel, list reservations |
| `availability.ts` | Slot generation, conflict detection, `removable_top` surface logic |
| `security.ts` | `enforceMutationSecurity` (CSRF double-submit + origin + Fetch Metadata), `enforceRateLimit` (in-memory, trusts `x-forwarded-for` only when `TRUST_PROXY_HEADERS=true`, `x-real-ip` is inside `TRUSTED_PROXY_CIDRS`, and the ingress rewrites the forwarding headers), `ensureCsrfCookie` |
| `http-error.ts` | Response converter: maps a caught `ServiceError` to a `NextResponse` JSON error |
| `service-error.ts` | `ServiceError` class and `serviceError()` throw helper |

---

## Auth Flow

Auth is handled by Supabase Auth with server-side session management via HTTP-only cookies:

1. Client POSTs credentials to `/api/auth/login`.
2. The Route Handler calls `enforceMutationSecurity()` (CSRF double-submit + same-origin `Origin` + Fetch Metadata check) and `enforceRateLimit()` before any service logic runs. If either check fails, a 403 or 429 response is returned immediately.
3. Route Handler calls `login()` from `auth-service.ts`. The service resolves the profile by member number using the admin Supabase client (which bypasses RLS), then calls `supabase.auth.signInWithPassword()` with the resolved email address.
4. Supabase writes session tokens into cookies. The Route Handler captures these via `createSupabaseRouteHandlerClient` and applies them to the `NextResponse` using `applyCookies()`.
5. On subsequent page requests, `middleware.ts` calls `supabase.auth.getUser()` as a side effect. The return value is discarded. The call exists solely to allow `@supabase/ssr` to silently refresh an expired access token and write updated session cookies into the response. Middleware does not use the auth result for routing decisions.
6. Protected API routes enforce authentication and authorization per route via `requireAuth()` and `requireAdmin()` from `lib/server/auth.ts`. These helpers read the session from the incoming request cookies and look up the user's role from the `profiles` table.
7. Logout calls `supabase.auth.signOut()`, which invalidates the session and clears the auth cookie(s).

Members can log in with their **member number**.

### PKCE Callback

`/api/auth/callback` handles the Supabase PKCE code exchange for OAuth and magic link flows. It exchanges the `code` query parameter for a session via `supabase.auth.exchangeCodeForSession()` and redirects the user. The `next` redirect parameter is sanitized against control characters and validated as a same-origin relative path to prevent open redirect attacks.

---

## Admin Dashboard

The admin dashboard is located at `/{locale}/admin`. Access is restricted to authenticated users with `role = 'admin'`. Non-admin users are redirected to the home page. Unauthenticated requests are redirected to login.

### Features

1. **User management** — Paginated list (10 per page) with search functionality. Admins can view user member number, email, role, and status. Admins can edit member number, role, and status, delete users, and toggle suspension status. Passwords are never displayed or editable from the admin panel.
2. **Room & table management** — View all rooms, edit room details, and create new tables per room. Tables are assigned a room and type (`small`, `large`, `removable_top`).
3. **Reservation management** — View all reservations with their status (`active`, `cancelled`, `completed`). Admins can cancel reservations with a confirmation prompt.

### User Status

The `profiles` table includes an `is_active` column (`BOOLEAN NOT NULL DEFAULT true`). When `is_active` is `false` the user is considered suspended and cannot log in. Status changes are managed through the admin dashboard.

### Supabase Admin Client

All admin write operations (user creation, deletion, status changes, etc.) use the Supabase admin client (`createSupabaseServerAdminClient`). The admin client bypasses all RLS policies, allowing admins to modify user data directly. Read operations on the admin routes may use either the anon client (with RLS) or the admin client depending on the endpoint.

---

## Data Model (key entities)

- **User** (maps to `profiles` table) — `id`, `memberNumber`, `role` (`admin` | `member`), `isActive` (`boolean`), `createdAt`, `updatedAt`. Suspended users (`isActive = false`) cannot log in. The `email` field is not part of the public user model (issue #39) but is included in admin-facing user data to display and manage members. Supabase Auth continues to own the canonical email in `auth.users`; the `profiles.email` column mirrors it for admin reads.
- **Room** — `id`, `name`, `tableCount`, `description`, `createdAt`
- **GameTable** (maps to `tables` table) — `id`, `roomId`, `name`, `type` (`small` | `large` | `removable_top`), `qrCode`, `posX`, `posY` (two separate nullable integer columns)
- **Reservation** — `id`, `tableId`, `userId`, `date`, `startTime`, `endTime`, `status` (`active` | `cancelled` | `completed`), `surface` (`top` | `bottom` | null)

### `removable_top` rule

A `removable_top` table has two bookable surfaces. Reserving one surface blocks the other in the same time slot. The availability layer enforces this in application code. In addition, the database enforces a GIST exclusion constraint (`reservations_no_active_overlap`) that prevents any two active reservations on the same table from overlapping in time, providing a second independent safety net at the database level.

---

## i18n

- URL prefix: `/es/...` and `/en/...`. `localePrefix: 'always'` is set — every locale including the default requires an explicit prefix; there is no unprefixed root URL serving content.
- `middleware.ts` handles locale detection and redirect via `next-intl/middleware`.
- Translation files: `messages/es.json`, `messages/en.json`.
- `next-intl` is used for both server and client components.
- `lib/i18n/config.ts` exports the locale list and default locale, consumed directly by `middleware.ts` and indirectly by `next.config.ts` (via `lib/i18n/request.ts`).

---

## Supabase as the Sole Provider

- **Database**: PostgreSQL managed by Supabase. All schema changes are versioned SQL migrations in `supabase/migrations/`.
- **Auth**: Supabase Auth. No custom JWT implementation.
- **Row Level Security**: RLS policies enforce access control at the DB level in addition to application-layer checks.

### Supabase Client Variants

There are three distinct Supabase client factories in `lib/supabase/server.ts`:

| Factory | Key | Cookie handling | When to use |
|---|---|---|---|
| `createSupabaseServerClient()` | Anon key | Reads/writes via `next/headers` cookie store | Server Components, Server Actions |
| `createSupabaseRouteHandlerClient(request)` | Anon key | Reads from `NextRequest`, buffers writes returned via `applyCookies()` | Route Handlers |
| `createSupabaseServerAdminClient()` | Secret default key | None (stateless) | Server-only; bypasses all RLS policies |

The browser client factory (`createSupabaseBrowserClient` in `lib/supabase/client.ts`) uses the publishable key and creates a new browser client instance per call. It must never be used in server-side code.

The admin client bypasses all RLS policies and must never be imported in Client Components or exposed to the browser. It is currently used in `auth-service.ts` to look up profiles by member number before sign-in, because the anon client's RLS policies would block unauthenticated profile reads.

---

## Middleware (`middleware.ts`)

`middleware.ts` runs on matched page and API requests (Edge Runtime). Its matcher skips Next.js/Vercel internals and static files, while `middleware.ts` returns API requests before locale routing and Supabase refresh. This still lets Clerk initialize request auth context for Route Handlers.

What middleware does:

1. **Locale routing**: Delegates to `next-intl/middleware` (`handleI18nRouting`) to inject locale prefixes and resolve the active locale.
2. **Supabase token refresh (side effect)**: Calls `supabase.auth.getUser()`. The return value is not used. The call exists to allow `@supabase/ssr` to silently refresh an expired access token and write updated session cookies into the response.
3. **CSRF cookie setup**: Calls `ensureCsrfCookie()` to set a non-`httpOnly` CSRF token cookie if one is not already present or is shorter than 32 characters. The client reads this cookie and sends it as the `x-csrf-token` header on mutations.

What middleware does NOT do:
- It does not enforce authentication or redirect unauthenticated users. Protected Server Components call `getSessionFromServerCookies()` and Route Handlers call `requireAuth()` / `requireAdmin()` at the resource boundary.
- It does not run locale routing, Supabase refresh, or CSRF setup for `/api/` routes.

---

## Client-Side Module Surface

The client-side architecture is organized under `lib/`:

- **`lib/api/client.ts`**: A typed `ApiClient` class (exported as the `apiClient` singleton). All client-side API calls go through this. For unsafe HTTP methods (POST, PUT, PATCH, DELETE) it automatically reads the CSRF token from the `alea-csrf-token` cookie and attaches it as the `x-csrf-token` request header, satisfying the server-side double-submit CSRF check.
- **`lib/api/endpoints.ts`**: Centralized API path constants used by `apiClient` callers.
- **`lib/auth/auth-context.tsx`**: `AuthProvider` (React Context) and `useAuth` hook. Manages client-side auth state (current user, loading state, login/logout/register actions). Accepts an optional `initialUser` prop from Server Components to hydrate state without an extra network round trip.
- **`lib/hooks/`**: Domain-specific TanStack Query hooks (`use-rooms`, `use-reservations`) that call `apiClient` and cache responses.

---

## Local Development Setup

### Prerequisites

- Node.js 20+
- pnpm 9+
- Supabase Cloud project for shared development, or Docker Desktop + Supabase CLI for a full local stack

### Steps

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment template
cp .env.example .env.local
# Edit .env.local with your Supabase credentials:
# - NEXT_PUBLIC_SUPABASE_URL
# - NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
# - SUPABASE_SECRET_DEFAULT_KEY
# - NEXT_PUBLIC_APP_URL
# - CRON_SECRET

# 3. Start dev server
pnpm dev
```

### Local Supabase option

If you want a fully local DB/auth stack instead of a shared Supabase Cloud project:

```bash
supabase start
supabase status
```

Then point `.env.local` to:

- `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=<publishable key from supabase status>`
- `SUPABASE_SECRET_DEFAULT_KEY=<secret/service-role key from supabase status>`
- `NEXT_PUBLIC_APP_URL=http://localhost:3000`

Useful local reset command:

```bash
supabase db reset
```

This reapplies all migrations and the local QA seed in `supabase/seed.sql`.

### Useful local URLs

| Service | URL |
|---|---|
| App | http://localhost:3000 |
| Supabase API (local) | http://127.0.0.1:54321 |
| Supabase Studio (local) | http://127.0.0.1:54323 |

---

## Testing

Tests live in `__tests__/`. Vitest + React Testing Library is used for unit and component tests.

```bash
pnpm test          # run all tests once
pnpm test:watch    # watch mode
pnpm typecheck     # TypeScript type-check
pnpm lint          # ESLint
pnpm build         # production build check
pnpm test:integration  # local Supabase migration/type validation
```

---

## Security Posture

- Passwords never returned from any API endpoint or stored in client state.
- Admin operations require `role = admin` enforced at the Route Handler level (`requireAdmin()`) and by RLS policies at the database level.
- All input validated with Zod before reaching the service layer.
- HTTP-only, SameSite cookies for Supabase session token management.
- Mutations are protected by a three-layer check in each Route Handler: Fetch Metadata validation (`sec-fetch-site`), same-origin `Origin` header validation, and double-submit CSRF token validation — all via `enforceMutationSecurity()` from `lib/server/security.ts`. This check runs inside Route Handlers directly; middleware does not cover API routes.
- The admin Supabase client (secret key) bypasses all RLS policies. It is restricted to server-only code and must never be imported client-side.
- See `docs/SECURITY_RUNBOOK.md` for the full security checklist.
