#!/usr/bin/env bash
#
# heig-codespace — deployment from the workstation to the VM. Replayable.
#
#   apps/codespace/deploy/push.sh                # build and deploy
#   apps/codespace/deploy/push.sh --bootstrap    # + (re)set the VM up
#   apps/codespace/deploy/push.sh --rebuild-image
#
# What it does:
#   1. builds @hgc/codespace and its packages (tsc)
#   2. `pnpm deploy --prod --legacy`: a self-contained tree (pruned
#      node_modules, workspaces copied in), exactly like classroom's Dockerfile
#   3. checks that whatever is needed at run time is there
#   4. rsync of deploy/ infra/ images/ to /srv/codespace/src, then reload of
#      the AppArmor profile (so a profile change ships without --bootstrap)
#   5. rsync of the tree to /srv/codespace/releases/<timestamp>
#   6. switch of the /srv/codespace/app symlink
#   7. build of the student image on the VM if it is missing
#   8. service restart, wait for /healthz locally then over HTTPS
#
# Rollback: see docs/deploy.md. In short, point the symlink back at the
# previous release and restart — no Drizzle migration is destructive, but a
# release older than the latest `drizzle/` does not know how to read a newer
# schema.
#
# No pnpm is needed on the VM: the deployed tree is self-contained.
set -euo pipefail

TARGET="${CODESPACE_SSH:-root@code.chevallier.io}"
DOMAIN="${CODESPACE_DOMAIN:-code.chevallier.io}"
PREFIX=/srv/codespace
IMAGE_TAG="${CODESPACE_IMAGE_TAG:-codespace/c-dev:4.137.0}"
KEEP_RELEASES=5

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "$TARGET")
RSYNC_E=(-e "ssh -o BatchMode=yes -o ConnectTimeout=15")

DO_BOOTSTRAP=0
REBUILD_IMAGE=0
for arg in "$@"; do
	case "$arg" in
		--bootstrap)     DO_BOOTSTRAP=1 ;;
		--rebuild-image) REBUILD_IMAGE=1 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

ok()   { printf '  ok    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

OUT="$(mktemp -d "${TMPDIR:-/tmp}/hgc-codespace-deploy.XXXXXX")"
# pnpm deploy wants a directory that does not exist, or an empty one.
rmdir "$OUT"
trap 'rm -rf "$OUT"' EXIT

# ------------------------------------------------------------------ 1. build
step "build of @hgc/codespace and its packages"
cd "$REPO_ROOT"
pnpm --filter '@hgc/codespace...' --workspace-concurrency=1 build
ok "tsc: packages + application"

step "self-contained production tree"
pnpm --filter @hgc/codespace deploy --prod --legacy "$OUT" >/dev/null
ok "pnpm deploy --prod --legacy"
# `pnpm deploy` applies the npm publishing rules: `dist/` is in the package's
# `.gitignore`, so it is not copied. It is the same move as classroom's
# Dockerfile, which copies `drizzle/` back in for the same reason.
[ -f "$APP_DIR/dist/server.js" ] || die "dist/server.js missing: the build failed"
cp -r "$APP_DIR/dist" "$OUT/dist"
ok "dist/ copied into the tree"

# ------------------------------------------------ 3. what run time needs
step "contents of the deployed tree"
need() { [ -e "$OUT/$1" ] || die "missing from the deployed tree: $1"; ok "$1"; }
need dist/server.js
need package.json
# migrationsFolder() in db/client.ts looks for `drizzle/meta/_journal.json` in
# the compiled module's ancestors: it must sit at the release root.
need drizzle/meta/_journal.json
need node_modules/better-sqlite3
need node_modules/@hgc/domain/dist/index.js
need node_modules/@hgc/contracts/dist/index.js
# infra/ and seed/ travel with the package (no `files` field excludes them);
# at run time the portal reads neither: SECCOMP_PROFILE points at
# /srv/codespace/src/infra (the copy the systemd units use as well), and
# `seed/` only serves `scripts/seed.ts`, which is not deployed.
[ -e "$OUT/infra/seccomp/codespace.json" ] && ok "infra/ present (unused at run time)"
[ -e "$OUT/seed/assignments.yaml" ] && ok "seed/ present (unused at run time)"
[ ! -e "$OUT/node_modules/typescript" ] || die "devDependencies in the --prod tree"
ok "size: $(du -sh "$OUT" | cut -f1)"

# --------------------------------------------- 4. infra sources on the VM
step "infrastructure sources to $TARGET:$PREFIX/src"
rsync -a --delete "${RSYNC_E[@]}" \
	--rsync-path="mkdir -p $PREFIX/src && rsync" \
	"$APP_DIR/deploy" "$APP_DIR/infra" "$APP_DIR/images" \
	"$TARGET:$PREFIX/src/"
"${SSH[@]}" "chmod +x $PREFIX/src/deploy/*.sh $PREFIX/src/infra/net/*.sh $PREFIX/src/images/c-dev/*.sh"
ok "deploy/ infra/ images/"

# The AppArmor profile is reloaded on **every** push, not only under
# --bootstrap: a change to infra/apparmor/codespace must reach the containers
# started after the restart below. `-r` (replace) is idempotent, and a running
# container keeps the profile it was started with.
step "AppArmor profile codespace"
"${SSH[@]}" bash -s <<'REMOTE'
set -euo pipefail
AA=/srv/codespace/src/infra/apparmor/codespace
if ! command -v apparmor_parser >/dev/null 2>&1; then
	echo "  ..    apparmor_parser absent: profile NOT loaded (host without AppArmor)"
	echo "  ..    CODESPACE_APPARMOR_PROFILE must stay empty in /etc/codespace/env"
	exit 0
fi
install -m 0644 "$AA" /etc/apparmor.d/codespace
apparmor_parser -r /etc/apparmor.d/codespace
echo "  ok    /etc/apparmor.d/codespace (re)loaded"
REMOTE

if [ "$DO_BOOTSTRAP" -eq 1 ]; then
	step "VM bootstrap (idempotent)"
	"${SSH[@]}" "CODESPACE_DOMAIN=$DOMAIN $PREFIX/src/deploy/bootstrap.sh"
fi

# ------------------------------------------------------------ 5. release ----
step "release $STAMP"
rsync -a --delete "${RSYNC_E[@]}" \
	--rsync-path="mkdir -p $PREFIX/releases/$STAMP && rsync" \
	"$OUT/" "$TARGET:$PREFIX/releases/$STAMP/"
ok "$PREFIX/releases/$STAMP"

# ------------------------------------------ 6..8. switch, image, restart ----
step "switch, image, restart"
"${SSH[@]}" bash -s -- "$STAMP" "$IMAGE_TAG" "$REBUILD_IMAGE" "$KEEP_RELEASES" <<'REMOTE'
set -euo pipefail
STAMP="$1"; IMAGE_TAG="$2"; REBUILD_IMAGE="$3"; KEEP="$4"
PREFIX=/srv/codespace
pd() { podman --remote --url unix:///run/podman/podman.sock "$@"; }

previous="$(readlink "$PREFIX/app" 2>/dev/null || echo "(none)")"
ln -sfnT "releases/$STAMP" "$PREFIX/app"
echo "  app symlink: $previous -> releases/$STAMP"

if [ "$REBUILD_IMAGE" = 1 ] || ! pd image exists "$IMAGE_TAG"; then
	echo "  building $IMAGE_TAG (1 to 2 min on 2 vCPU)…"
	t0=$(date +%s)
	pd build -q -t "$IMAGE_TAG" -t codespace/c-dev:latest "$PREFIX/src/images/c-dev" >/dev/null
	echo "  image built in $(( $(date +%s) - t0 )) s"
else
	echo "  image $IMAGE_TAG already present"
fi

systemctl restart codespace.service
for i in $(seq 1 60); do
	if curl -sf -m 2 http://127.0.0.1:3100/healthz >/dev/null; then
		echo "  /healthz local: OK after ${i}s"
		break
	fi
	if [ "$i" = 60 ]; then
		echo "  /healthz local: NO ANSWER" >&2
		systemctl --no-pager --lines=40 status codespace.service >&2 || true
		journalctl -u codespace.service -n 60 --no-pager >&2 || true
		exit 1
	fi
	sleep 1
done

# We keep a few releases for rollback, no more: 38 GB of disk and the 1.5 GB
# image live on the same volume.
current="$(basename "$(readlink "$PREFIX/app")")"
ls -1 "$PREFIX/releases" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
	[ "$old" = "$current" ] && continue
	rm -rf "${PREFIX:?}/releases/$old"
	echo "  release pruned: $old"
done
REMOTE

# ----------------------------------------------------------- 8bis. HTTPS ----
step "check from the workstation"
for i in $(seq 1 30); do
	body="$(curl -sS -m 5 "https://$DOMAIN/healthz" 2>/dev/null || true)"
	if [ "$body" = '{"ok":true}' ]; then
		ok "https://$DOMAIN/healthz -> $body"
		break
	fi
	[ "$i" = 30 ] && die "https://$DOMAIN/healthz does not answer ($body)"
	sleep 2
done

printf '\nrelease deployed: %s\n' "$STAMP"
