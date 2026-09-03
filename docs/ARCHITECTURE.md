# Architecture — Alea WebApp

**Last updated:** 2026-09-03
**Milestone:** Post-migration (Supabase fully removed — Neon for data, Clerk for auth; issues #299-#310, #360, #363, #311)

---

## Overview

Alea is a single Next.js 15 application at the repository root. There is no monorepo, no separate backend process, and no NestJS. All server-side logic runs inside Next.js Route Handlers, backed by Neon (Postgres, raw SQL) for data and Clerk for auth.

---

## Stack

| Concern | Technology |
|---|---|
| Framework | Next.js 15, App Router |
| UI | React 19, Tailwind CSS, shadcn/ui |
| Database | Neon (PostgreSQL, raw SQL via `lib/db/client.ts`, no RLS) |
| Auth | Clerk (`@clerk/nextjs`) |
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
│   │   ├── auth/               # login (410, disabled), logout, me, register (410, disabled), activate, recover
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
│   │   ├── auth-service.ts     # Activation/recovery links, Clerk identity resolution, logout, getCurrentUser
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
│   ├── db/                     # Neon connection + schema
│   │   ├── client.ts           # Tagged-template `sql` export (Neon serverless driver)
│   │   ├── transaction.ts      # Multi-statement transaction helper
│   │   └── schema/              # Versioned raw SQL schema files (001_extensions.sql, 002_types.sql, ...)
│   ├── supabase/
│   │   └── types.ts            # Generated DB row types (`Tables<'x'>`) — only surviving file from the old Supabase client layer, still the type source for every service module
│   ├── types/
│   │   └── index.ts            # Shared TypeScript domain types (User, Room, etc.)
│   ├── providers.tsx           # React provider tree (QueryClientProvider, AuthProvider, etc.)
│   └── utils.ts                # Shared utility functions
├── messages/                   # i18n JSON files (es.json, en.json)
├── middleware.ts               # Clerk middleware, i18n routing, CSRF cookie setup
└── __tests__/                  # Integration and unit tests
```

---

## Server Layer (`lib/server/`)

`lib/server/` is the application's server-side logic layer. It replaces the former NestJS backend.

All modules in this layer:
- Are intended to be imported only from Route Handlers (`app/api/`) or Server Components. `lib/server/security-edge.ts` is additionally imported from `middleware.ts` for the `ensureCsrfCookie` helper.
- Never run in the browser.
- Call the database directly via the tagged-template `sql` export from `lib/db/client.ts` (Neon). There is no separate admin-vs-user-scoped client — Neon has no RLS, so that old distinction collapses to a single `sql` client. Admin-only *routes* are gated by `requireAdmin()` at the route boundary; per-resource ownership and role checks that depend on the specific record (not just "is this user an admin") live in this service layer — see `reservations-service.ts`, `club-events-service.ts`, `partners-service.ts`, `library-games-service.ts`, `saved-games-service.ts`, and `lib/server/data-scoping.ts`.
- Throw `ServiceError` instances via the `serviceError()` helper — never raw strings.

Each service module maps to a domain:

| Module | Responsibility |
|---|---|
| `auth.ts` | Session guard helpers: `requireAuth`, `requireAdmin`, `getSessionFromRequest`, `getSessionFromServerCookies` |
| `auth-service.ts` | Admin-issued activation/recovery links (`activateAccount`, `recoverAccount`), Clerk identity resolution (`resolveProfileForClerkUser`), `logout`, `getCurrentUser`. No password-based `login()` — see Auth Flow below. |
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

Auth identity is owned entirely by Clerk. There is no password column on `profiles` and no app-level credential store — `lib/server/session.ts` reads the Clerk session directly from Next.js's request context via `auth()`/`currentUser()`, and `clerkMiddleware()` (wired in `middleware.ts`) populates that context on every matched request, including `/api`.

Members have **no email** and there is **no open self-registration** (closed issues #206/#207). Every member must already exist as an admin-imported `profiles` row (`is_active = false`) before they can ever sign in. The only way a profile becomes active — and the only way its Clerk identity is ever created — is by claiming an admin-issued activation link.

1. **Sign-in**: happens on Alea's own form (`app/[locale]/sign-in/[[...sign-in]]/page.tsx` → `components/auth/login-form.tsx`), backed by Clerk's headless `useSignIn()` client SDK — not Clerk's hosted/prebuilt UI. The member types their bare member number; the `alea-` username prefix (see below) is added client-side before calling `signIn.create()`. `POST /api/auth/login` (password-based) and `POST /api/auth/register` (self-registration) are both permanently disabled and return `410 Gone` — they exist only so old clients get a clear, stable response instead of a 404. There is no `/api/auth/callback` route; Clerk owns its own sign-in redirect flow.
2. **Identity correlation**: the Clerk **username** is `alea-<member_number>` (e.g. `alea-100001`) — the `alea-` prefix exists only because Clerk rejects all-numeric usernames, is never shown to or typed by the member, and carries no email attribute. `resolveProfileForClerkUser()` (`lib/server/auth-service.ts`) strips that prefix and looks up the matching `profiles` row by `member_number`. This is READ-ONLY: a Clerk identity with no matching, already-active `profiles` row never resolves to a session, and no row is ever created as a side effect of a request.
3. **Session guards**: protected Route Handlers call `requireAuth()` / `requireAdmin()` from `lib/server/auth.ts`. These call `getSessionFromRequest()`, which resolves the Clerk session, reads the Clerk user's username, and calls `resolveProfileForClerkUser()`. `requireAdmin()` additionally checks `session.role === 'admin'`. Protected Server Components call `getSessionFromServerCookies()` directly.
4. **Activation**: an admin generates a single-use, 24h activation token (`generateActivationLink()`) for a pre-registered, inactive profile. The member claims it via `activateAccount()`, which atomically claims the token, creates the member's Clerk identity (username + password, no email), and flips `profiles.is_active = true`. Every failure path (Clerk create fails, or the DB update fails after Clerk succeeds) compensates: the token claim is restored, and on a DB failure the just-created Clerk user is deleted best-effort — if that delete itself fails, the orphaned Clerk identity is a known, admin-recoverable state rather than blocking retry.
5. **Recovery**: an admin generates a recovery link the same way; `recoverAccount()` claims the token and calls Clerk's `updateUser()` to set a new password on the member's *existing* Clerk identity (looked up by username, since no Clerk user id is persisted on `profiles`). This is a password reset, not identity creation.
6. **Logout**: `logout()` (`auth-service.ts`) revokes the current Clerk session server-side via `clerkClient().sessions.revokeSession()`. The client-side Clerk SDK (`useClerk().signOut()`) clears the browser cookie separately.
7. `middleware.ts` does not refresh any session cookie itself (that role moved entirely to `clerkMiddleware()`) — it only wraps requests with Clerk's auth context, routes locale pages through `next-intl`, and issues the CSRF cookie.

Mutating auth routes (e.g. login) still run `enforceMutationSecurity()` (CSRF double-submit + same-origin `Origin` + Fetch Metadata check) and `enforceRateLimit()` before any handler logic, even where the handler itself just returns `410`.

---

## Admin Dashboard

The admin dashboard is located at `/{locale}/admin`. Access is restricted to authenticated users with `role = 'admin'`. Non-admin users are redirected to the home page. Unauthenticated requests are redirected to login.

### Features

1. **User management** — Paginated list (10 per page) with search functionality. Admins can view user member number, email, role, and status. Admins can edit member number, role, and status, delete users, and toggle suspension status. Passwords are never displayed or editable from the admin panel.
2. **Room & table management** — View all rooms, edit room details, and create new tables per room. Tables are assigned a room and type (`small`, `large`, `removable_top`).
3. **Reservation management** — View all reservations with their status (`active`, `cancelled`, `completed`). Admins can cancel reservations with a confirmation prompt.

### User Status

The `profiles` table includes an `is_active` column (`BOOLEAN NOT NULL DEFAULT true`). When `is_active` is `false` the user is considered suspended and cannot log in. Status changes are managed through the admin dashboard.

### Admin Writes

All admin write operations (user creation, deletion, status changes, member CSV import, etc.) live in `users-service.ts` and go through the same `sql` client from `lib/db/client.ts` as every other read. Neon has no RLS, so there is no separate admin-vs-anon client distinction — the admin-only gate is `requireAdmin()` (`lib/server/auth.ts`) at the route layer, before any service function runs. `users-service.ts` is the only place a `profiles` row is ever created; no self-service path creates one.

---

## Data Model (key entities)

- **User** (maps to `profiles` table) — `id`, `memberNumber`, `role` (`admin` | `member`), `isActive` (`boolean`), `createdAt`, `updatedAt`. Suspended users (`isActive = false`) cannot log in. The `email`/`phone` fields are not part of the public user model (issue #39) but are included in admin-facing user data to display and manage members. Neither participates in identity or sign-in — Clerk identity correlation is by username (`alea-<member_number>`), never by email (see Auth Flow above); `profiles.email`/`profiles.auth_email` are plain contact-info columns.
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

## Neon as the Data Store

- **Database**: PostgreSQL, provisioned on Neon. Schema changes are versioned raw SQL files in `lib/db/schema/` (e.g. `003_profiles.sql`, `013_activation_tokens.sql`), applied directly — no ORM, no migration DSL.
- **Auth**: Clerk. No custom JWT implementation, no password column anywhere in the schema.
- **Access control**: Neon has no Row Level Security. Every privilege check (ownership + role) is an application-layer check in the service layer (`lib/server/`), enforced before the query runs — never left to the database.

### The `sql` Client

There is a single database client, `sql`, exported from `lib/db/client.ts` (`lib/db/client.ts:1`):

```ts
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
export const sql: NeonQueryFunction<false, false> = neon(databaseUrl);
```

It is a tagged-template function backed by Neon's HTTP driver (no connection pool to manage). Every service module — regular reads and admin writes alike — imports this same `sql` export and calls it as `` sql`SELECT ... WHERE id = ${id}` ``, which auto-parameterizes interpolated values. There is no separate admin/anon/browser client split like the old Supabase setup had: Neon has no RLS to bypass, so that distinction has no equivalent here. `lib/db/transaction.ts` provides a helper for multi-statement transactions where one is needed.

`lib/supabase/types.ts` is the one surviving file from the old Supabase client layer — it still holds the generated `Tables<'x'>` row types every service module imports for typing query results (e.g. `import type { Tables } from '@/lib/supabase/types'`). It is a type-only artifact now; nothing in it makes a network call or reaches an actual Supabase project.

---

## Middleware (`middleware.ts`)

`middleware.ts` runs on matched page and API requests (Edge Runtime). Its matcher skips Next.js/Vercel internals and static files, while `middleware.ts` returns API requests before locale routing and CSRF cookie setup. This still lets Clerk initialize request auth context for Route Handlers.

What middleware does:

1. **Locale routing**: Delegates to `next-intl/middleware` (`handleI18nRouting`) to inject locale prefixes and resolve the active locale.
2. **CSRF cookie setup**: Calls `ensureCsrfCookie()` to set a non-`httpOnly` CSRF token cookie if one is not already present or is shorter than 32 characters. The client reads this cookie and sends it as the `x-csrf-token` header on mutations.

What middleware does NOT do:
- It does not enforce authentication or redirect unauthenticated users. Protected Server Components call `getSessionFromServerCookies()` and Route Handlers call `requireAuth()` / `requireAdmin()` at the resource boundary.
- It does not refresh any session cookie itself. Session cookie handling is entirely `clerkMiddleware()`'s job — session identity comes from Clerk (`lib/server/auth.ts`, `lib/server/session.ts`).
- It does not run locale routing or CSRF setup for `/api/` routes.

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
- A Neon Postgres branch (dashboard: console.neon.tech) — there is no local Postgres/Docker setup for this project; development connects to a real Neon branch via `DATABASE_URL`.
- A Clerk application (dashboard: dashboard.clerk.com) in test mode for its keys.

### Steps

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment template
cp .env.example .env.local
# Edit .env.local with:
# - DATABASE_URL (Neon pooled connection string, ?sslmode=require)
# - NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY / CLERK_SECRET_KEY (Clerk test-mode keys)
# - BLOB_READ_WRITE_TOKEN (Vercel Blob store token)
# - NEXT_PUBLIC_APP_URL
# - CRON_SECRET

# 3. Start dev server
pnpm dev
```

### Seeding local dev data

`scripts/seed-dev.mjs` seeds a development Neon branch with an active admin fixture (Clerk identity created directly via the Clerk Backend API) and an inactive member fixture (a `profiles` row only — no Clerk identity yet, activated later through the real admin-issued-link flow). It requires `DATABASE_URL` and `CLERK_SECRET_KEY` (test-mode, `sk_test_...`) in the environment, plus `SEED_ADMIN_PASSWORD` for the admin fixture's initial password. As a safety gate it refuses to run unless `NODE_ENV !== 'production'` **and** `DEV_SEED_CONFIRM` is set to the script's exact confirmation value, and it refuses if `DATABASE_URL` looks like it points at anything containing "prod":

```bash
DEV_SEED_CONFIRM=YES_SEED_NEON_DEV_DB SEED_ADMIN_PASSWORD=<local-only password> node scripts/seed-dev.mjs
```

Both fixtures are upserted keyed on `member_number` (`ON CONFLICT ... DO UPDATE`), so re-running the script is safe — it will not revert an already-activated member back to pending.

### Useful local URLs

| Service | URL |
|---|---|
| App | http://localhost:3000 |
| Neon dashboard | https://console.neon.tech |
| Clerk dashboard | https://dashboard.clerk.com |

---

## Testing

Tests live in `__tests__/`. Vitest + React Testing Library is used for unit and component tests.

```bash
pnpm test          # run all tests once
pnpm test:watch    # watch mode
pnpm typecheck     # TypeScript type-check
pnpm lint          # ESLint
pnpm build         # production build check
```

---

## Security Posture

- Passwords never returned from any API endpoint or stored in client state. There is no password column in the database — Clerk is the sole credential store.
- Admin operations require `role = admin` enforced at the Route Handler level (`requireAdmin()`). Neon has no RLS, so this application-layer check is the only enforcement — there is no database-level backstop.
- All input validated with Zod before reaching the service layer.
- Session identity is managed entirely by Clerk (HTTP-only session cookies set by `clerkMiddleware()`); no app code reads or writes a session cookie directly.
- Mutations are protected by a three-layer check in each Route Handler: Fetch Metadata validation (`sec-fetch-site`), same-origin `Origin` header validation, and double-submit CSRF token validation — all via `enforceMutationSecurity()` from `lib/server/security.ts`. This check runs inside Route Handlers directly; middleware does not cover API routes.
- `CLERK_SECRET_KEY` is restricted to server-only code (`lib/server/**`, `scripts/seed-dev.mjs`) and must never be imported client-side.
- See `docs/SECURITY_RUNBOOK.md` for the full security checklist.
