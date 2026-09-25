#!/usr/bin/env bash
# Deploy target for the CI's forced-command SSH key. The VM's authorized_keys
# pins this key to this script:
#   command="/srv/heig-classroom/deploy.sh",restrict ssh-ed25519 AAAA… ci-deploy
# so the runner can ONLY deploy — never open a shell, even if the key leaks.
#
# The runner passes its ephemeral GHCR token as the SSH "command"; it lands in
# $SSH_ORIGINAL_COMMAND and is used only to log in for the private-image pull,
# then expires with the job — no registry credential is ever stored on the VM.
#
# NEVER build here: an on-VM build (1 vCPU / 2 GB) starves Postgres and fills
# the disk (deploy.md §7). This only pulls a prebuilt image and restarts.
set -euo pipefail

# The script's own checkout: /srv/heig-classroom on the Hetzner VM, run by the
# `srv` account (rootless Docker).
cd "$(dirname "$(readlink -f "$0")")"

# Rootless Docker listens on a per-user socket; a forced-command SSH session
# does not always load the profile that exports it.
if [ "$(id -u)" != 0 ] && [ -z "${DOCKER_HOST:-}" ]; then
  export DOCKER_HOST="unix:///run/user/$(id -u)/docker.sock"
fi

# The registry login lives in a throwaway directory, never in the shared
# ~/.docker/config.json: quiz deploys on the same account, and a concurrent
# deploy's login (a token scoped to ITS package) overwrites ours between login
# and pull -- "denied", seen on 2026-09-25.
DOCKER_CONFIG="$(mktemp -d)"
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT

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
