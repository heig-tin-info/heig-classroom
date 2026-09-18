#!/usr/bin/env bash
# Runs the student image with the mandatory hardening (CLAUDE.md invariant 3,
# docs/jalon-0.md P1). No option is negotiable: a test that needs one relaxed
# must say so in docs/, not here.
#
# P1 only: --network none by default. The closed `codespace` network is the P2
# task; this script neither creates it nor assumes it.
#
# mode=1777 on /run and /home/student/.cache: Podman 5.7 mounts /run as
# mode=755 root:root and named tmpfs without a mode inherit root:root;
# the container runs as uid 1000 and could write neither its user-data-dir
# nor its cache. The other flags (rw,nosuid,nodev) are Podman's own.
#
# --dns=none: Podman 5.7 refuses `--dns` together with `--network none`
# ("conflicting options: dns and the network mode: none"). The flag is
# therefore set only when a network is requested; with `--network none` there
# is no resolver anyway (empty resolv.conf). P2 will run this script with
# NETWORK=codespace and the flag will be there.
#
# Variables:
#   CTR_NAME   container name              (default cdev-p1)
#   NETWORK    podman network              (default none, P1)
#   VOL_DIR    host work directory         (default /tmp/codespace-vol/<CTR_NAME>)
#   IMAGE      image to run                (default codespace/c-dev:4.137.0)
#   EXTRA_ARGS extra podman options (string, split by the shell)
#
# Writes the container id on standard output.
set -euo pipefail

CTR_NAME="${CTR_NAME:-cdev-p1}"
IMAGE="${IMAGE:-codespace/c-dev:4.137.0}"
VOL_DIR="${VOL_DIR:-/tmp/codespace-vol/${CTR_NAME}}"
NETWORK="${NETWORK:-none}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECCOMP="${SECCOMP:-${REPO_ROOT}/infra/seccomp/codespace.json}"

PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
podman_remote() { podman --remote --url "$PODMAN_URL" "$@"; }

[ -f "$SECCOMP" ] || { echo "seccomp profile not found: $SECCOMP" >&2; exit 1; }
mkdir -p "${VOL_DIR}/work"

podman_remote rm -f "$CTR_NAME" >/dev/null 2>&1 || true

# shellcheck disable=SC2206
extra=( ${EXTRA_ARGS:-} )

net_args=( --network "$NETWORK" )
if [ "$NETWORK" != "none" ]; then
  net_args+=( --dns=none )
fi

podman_remote run -d \
  --name "$CTR_NAME" \
  --label codespace.role=student \
  --userns=auto \
  --cap-drop=ALL \
  --security-opt no-new-privileges \
  --security-opt "seccomp=${SECCOMP}" \
  --read-only \
  --tmpfs /tmp \
  --tmpfs '/run:rw,nosuid,nodev,mode=1777' \
  --tmpfs '/home/student/.cache:rw,nosuid,nodev,mode=1777' \
  --pids-limit 256 \
  --memory 1536m \
  --cpus 1 \
  "${net_args[@]}" \
  -v "${VOL_DIR}/work:/work:U" \
  "${extra[@]}" \
  "$IMAGE"
