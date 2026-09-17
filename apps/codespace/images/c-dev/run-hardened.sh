#!/usr/bin/env bash
# Lance l'image etudiante avec le durcissement obligatoire (CLAUDE.md invariant 3,
# docs/jalon-0.md P1). Aucune option n'est negociable : un test qui a besoin d'en
# relacher une doit le dire dans docs/, pas ici.
#
# P1 seulement : --network none par defaut. Le reseau clos `codespace` est la
# tache P2 ; ce script ne le cree pas et ne le suppose pas.
#
# mode=1777 sur /run et /home/student/.cache : Podman 5.7 monte /run en
# mode=755 root:root et les tmpfs nommes sans mode heritent de root:root ;
# le conteneur tourne en uid 1000 et ne pourrait ecrire ni son user-data-dir
# ni son cache. Les autres drapeaux (rw,nosuid,nodev) sont ceux de Podman.
#
# --dns=none : Podman 5.7 refuse `--dns` avec `--network none`
# (« conflicting options: dns and the network mode: none »). Le drapeau est donc
# pose seulement quand un reseau est demande ; avec `--network none` il n'y a de
# toute facon aucun resolveur (resolv.conf vide). P2 lancera ce script avec
# NETWORK=codespace et le drapeau sera present.
#
# Variables :
#   CTR_NAME   nom du conteneur            (defaut cdev-p1)
#   NETWORK    reseau podman               (defaut none, P1)
#   VOL_DIR    repertoire de travail hote  (defaut /tmp/codespace-vol/<CTR_NAME>)
#   IMAGE      image a lancer              (defaut codespace/c-dev:4.137.0)
#   EXTRA_ARGS options podman en plus (chaine, decoupee par le shell)
#
# Ecrit l'identifiant du conteneur sur la sortie standard.
set -euo pipefail

CTR_NAME="${CTR_NAME:-cdev-p1}"
IMAGE="${IMAGE:-codespace/c-dev:4.137.0}"
VOL_DIR="${VOL_DIR:-/tmp/codespace-vol/${CTR_NAME}}"
NETWORK="${NETWORK:-none}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SECCOMP="${SECCOMP:-${REPO_ROOT}/infra/seccomp/codespace.json}"

PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
podman_remote() { podman --remote --url "$PODMAN_URL" "$@"; }

[ -f "$SECCOMP" ] || { echo "profil seccomp introuvable : $SECCOMP" >&2; exit 1; }
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
