#!/usr/bin/env bash
#
# scripts/cutover-rehearsal.sh — F2 cutover rehearsal (KIM-419)
#
# Rehearses the MECHANICAL cutover steps tracked in Linear KIM-420 — dump
# format validation, the bcrypt hash-copy logic, and the session
# invalidation logic — against synthetic, in-memory fixture data only.
#
# This script is PREP-ONLY tooling:
#   - It never runs pg_dump/pg_restore/psql or any other command against a
#     real database.
#   - It never reads a real .env* file or references any real credential.
#   - It never connects to a real Supabase, Neon, or Vercel Postgres
#     project.
#
# Executing the REAL cutover is a separate, USER-ONLY issue (KIM-420,
# "F2 execute cutover") — this script and its tests are
# prep/rehearsal artifacts only, prepared by agents for the human operator
# to review and run manually when the real cutover happens.
#
# Usage: ./scripts/cutover-rehearsal.sh   (or: pnpm cutover:rehearsal)

set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}━━━ F2 cutover rehearsal — synthetic fixtures only, no real infra ━━━${NC}"
echo "See Linear KIM-420 for the current cutover procedure."
echo "Real cutover execution is a separate, user-only step (KIM-420)."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}✗ node is required to run this rehearsal${NC}"
  exit 1
fi

if node "${root_dir}/scripts/cutover-rehearsal-runner.mjs"; then
  echo -e "\n${GREEN}✓ Rehearsal passed — all mechanical checks green against synthetic data.${NC}"
  echo "Reminder: this only validates the logic in lib/cutover/. It does NOT"
  echo "exercise a real Neon/Vercel Postgres restore or real Auth.js runtime"
  echo "activation — that requires a rehearsal against a disposable/local"
  echo "throwaway database once F1 (PRs #168/#169/#170) merges."
  exit 0
else
  echo -e "\n${RED}✗ Rehearsal FAILED — see checks above.${NC}"
  exit 1
fi
