#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH key. The VM's authorized_keys
# pins this key to this script:
#   command="/opt/heig-classroom/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# so the runner can ONLY deploy — never open a shell, even if the key leaks.
#
# The runner passes its ephemeral GHCR token as the SSH "command"; it lands in
# $SSH_ORIGINAL_COMMAND and is used only to log in for the private-image pull,
# then expires with the job — no registry credential is ever stored on the VM.
#
# NEVER build here: an on-VM build (453 MiB / 1 CPU) starves Postgres and fills
# the disk (deploy.md §7). This only pulls a prebuilt image and restarts.
set -euo pipefail

cd /opt/heig-classroom

# Optional GHCR login (private package): the token comes in over SSH, is piped
# straight to docker login's stdin (never eval'd), and is discarded after.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  printf '%s' "$SSH_ORIGINAL_COMMAND" \
    | docker login ghcr.io -u heig-tin-info --password-stdin >/dev/null
fi

git pull --ff-only
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
docker image prune -f
echo "deploy: done ($(git rev-parse --short HEAD))"
