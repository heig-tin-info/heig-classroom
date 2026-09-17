#!/usr/bin/env bash
# Enveloppe de scripts/e2e.ts, pour que le chemin annoncé par docs/jalon-0.md
# existe. Tout est dans le .ts ; ce fichier ne fait que le lancer avec tsx et
# le .env du dépôt.
#
#   ./scripts/e2e.sh
#   E2E_GRACE_MS=5000 ./scripts/e2e.sh     # grâce raccourcie
set -euo pipefail
cd "$(dirname "$0")/../apps/portal"
exec ./node_modules/.bin/tsx --env-file-if-exists=../../.env ../../scripts/e2e.ts "$@"
