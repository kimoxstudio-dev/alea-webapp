# Alea WebApp

Web application for a cultural gaming association (board games and tabletop RPGs — not casino games). Built with Next.js 15 and a Tolkien-inspired RPG/fantasy dark theme.

## What This Is

Alea is a cultural association management platform that allows members to:

- Log in with their member number + password
- Browse and reserve tables across 6 themed rooms
- View QR codes per table reservation

Admins can manage users, member imports, rooms, tables, events, and reservations through a dedicated dashboard.

## Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router) |
| UI | React 19, Tailwind CSS, shadcn/ui |
| Database | Neon (PostgreSQL, raw SQL, no RLS) |
| Auth | Clerk |
| i18n | next-intl (Spanish + English) |
| Testing | Vitest + React Testing Library |
| Language | TypeScript |

## Project Structure

```
alea-webapp/
├── app/                    # Next.js App Router pages and layouts
│   ├── [locale]/           # Locale-prefixed routes (es, en)
│   └── api/                # Route handlers (server-side API)
├── components/             # Reusable UI components
├── lib/                    # Application logic
│   ├── server/             # Server-side service layer (auth, rooms, reservations, users)
│   ├── db/                 # Neon connection (lib/db/client.ts) and versioned SQL schema (lib/db/schema/)
│   └── supabase/           # types.ts only — generated DB row types, still used as the type source everywhere
├── messages/               # i18n translation files (es.json, en.json)
├── __tests__/              # Integration and unit tests
├── docs/                   # Architecture and decision documentation
├── middleware.ts            # Clerk middleware, i18n routing, CSRF cookie setup
└── scripts/                # Dev utility scripts
```

## Prerequisites

- **Node.js** 20+ (see `.nvmrc` or `engines` in `package.json`)
- **pnpm** 9+ (`npm install -g pnpm`)

## Quick Start

1. **Clone the repository**

   ```bash
   git clone <repo-url>
   cd alea-webapp
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   ```

3. **Configure environment variables**

   ```bash
   cp .env.example .env.local
   ```

   The project uses **Neon** for the database and **Clerk** for auth — there is no local Postgres/Docker setup; development connects to a real Neon branch. Open `.env.local` and fill in at minimum `DATABASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`, `BLOB_READ_WRITE_TOKEN` (local Blob access), and `NEXT_PUBLIC_APP_URL`.

   See **[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)** for the full variable reference (every variable, its scope, required/optional status, and where to obtain it), the Preview/Production split, and the Clerk instance configuration.

4. **Start the development server**

   ```bash
   pnpm dev
   ```

   The app is available at [http://localhost:3000](http://localhost:3000).

### Local seed data

`scripts/seed-dev.mjs` seeds a development Neon branch with an active admin fixture (its Clerk identity is created directly via the Clerk Backend API) and an inactive member fixture (a `profiles` row only, activated later through the real admin-issued-link flow, same as production). It requires `DATABASE_URL`, `CLERK_SECRET_KEY` (test-mode, `sk_test_...`), and `SEED_ADMIN_PASSWORD` (the admin fixture's initial password — no default). It refuses to run unless `NODE_ENV !== 'production'` **and** `DEV_SEED_CONFIRM` is set to the script's exact confirmation value, and it refuses if `DATABASE_URL` looks like it points at anything containing "prod":

```bash
DEV_SEED_CONFIRM=YES_SEED_NEON_DEV_DB SEED_ADMIN_PASSWORD=<local-only password> node scripts/seed-dev.mjs
```

Both fixtures are upserted keyed on `member_number`, so re-running the script is safe and will not revert an already-activated member back to pending.

## Local CI Hook

The repository uses a local `pre-push` hook to run the core validation checks before a push. The hook is not installed automatically after cloning.

1. Install the hook:

   ```bash
   pnpm hooks:install
   ```

   On Windows, this command requires Bash or WSL. If Bash is not available, the script exits without modifying your environment.

   `scripts/install-hooks.sh` resolves the hooks directory with `git rev-parse --git-path hooks`, so it installs correctly both in a normal checkout and inside a `git worktree` (where `.git` is a file, not the real hooks directory). You can verify the hook actually gets installed in a worktree with:

   ```bash
   pnpm hooks:verify:worktree
   ```

   This creates a temporary detached worktree, runs `install-hooks.sh` inside it, and asserts the `pre-push` hook landed at the path Git will actually read for that worktree.

2. Push as usual:

   ```bash
   git push
   ```

   To skip the hook for a single push, use `git push --no-verify`.

The hook currently runs:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

This repository has no `.github/workflows/` CI pipeline — there is no automated coverage report, dependency audit, or SAST check on push or PR. The local `pre-push` hook (`scripts/ci-local.sh`) is the only automated gate today. Treat it as the local fast-fail gate for the main development path, not as a full CI substitute.

## Available Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Start Next.js dev server |
| `pnpm build` | Production build |
| `pnpm test` | Run the full test suite (Vitest) |
| `pnpm test:watch` | Run Vitest in watch mode |
| `pnpm lint` | ESLint via Next.js |
| `pnpm typecheck` | TypeScript type-check (no emit) |
| `pnpm security:deps` | Audit production dependencies |
| `pnpm hooks:install` | Install the local `pre-push` hook |
| `pnpm hooks:verify:worktree` | Smoke test: confirms `hooks:install` installs the hook correctly inside a `git worktree` |

## Developer Checklist

For a fresh machine:

1. `pnpm install`
2. `cp .env.example .env.local`
3. Fill in `DATABASE_URL` (Neon) and the Clerk keys
4. `pnpm dev`
5. Optional local guardrail: `pnpm hooks:install`

Before pushing:

1. `pnpm typecheck`
2. `pnpm lint`
3. `pnpm test`
4. `pnpm build`

Session hygiene:

1. Read `docs/HANDOFF.md` before starting work.
2. Update `docs/HANDOFF.md` before ending the session.
3. Keep handoff notes only in `docs/HANDOFF.md`; do not use GitHub PR comments or `CLAUDE.md` for repository handoff state.

If you touched SQL schema in `lib/db/schema/`, confirm the change is reflected wherever `lib/supabase/types.ts` types are consumed.

## Key Business Rules

- **6 rooms**: Mirkwood, Gondolin, Khazad-dum, Rivendell, Lothlorien, Edoras — each with a fixed number of tables.
- **Table types**: `small`, `large`, `removable_top`.
- **removable_top rule**: A table with a removable top has two bookable surfaces (`top` and `bottom`). Reserving one surface blocks the other surface in the same time slot.
- **Authentication**: Members currently log in with their member number + password. Passwords require: minimum 12 characters, at least one letter, at least one number, and at least one special character.
- **Admin**: Admins access the dashboard at `/{locale}/admin` (guarded route). The dashboard features: user management (10/page, paginated list with search, status badge, edit role/status/member number/contact fields, member import from `csv`/`xlsx`/`odt`, delete), room and table management (list/edit rooms, create tables), event management, and reservation management (list all, cancel with confirmation). The member importer accepts source columns such as `USUARIOS` -> `full_name` and `ID` -> `member_number`, normalizes them into the canonical dataset before persistence, returns invalid/skipped rows, and shows a normalized preview for audit. Passwords are never shown or editable. Admin write operations go through `users-service.ts` using the same Neon `sql` client as every other query (no RLS to bypass — the privilege check is `requireAdmin()` at the route layer). Inactive/suspended users cannot log in.
- **QR codes**: Each table has a QR code for quick reservation lookup.

## Accessibility

Target: **WCAG 2.2 AA**

- Full keyboard navigation
- Skip links
- High contrast tokens
- Visible focus indicators
- Semantic HTML and ARIA labels where applicable

## Internationalization

The app is available in **Spanish** (default) and **English**. Language is determined from the URL prefix (`/es/...`, `/en/...`). Translation files live in `messages/`.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for a full description of system architecture, local setup, and runtime data flow.
