#!/usr/bin/env bash
# Wrapper around scripts/e2e.ts. Everything is in the .ts; this file only
# runs it with tsx and the application's .env.
#
#   ./scripts/e2e.sh
#   E2E_GRACE_MS=5000 ./scripts/e2e.sh     # shortened grace period
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx --env-file-if-exists=.env scripts/e2e.ts "$@"
