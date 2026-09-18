#!/usr/bin/env bash
#
# Shadow repository snapshot, as root (analyse.md § 3.3, docs/v1.md
# D-V1-1). Run by codespace-shadow.timer every three minutes.
#
# Why root, and not the portal. The volume is mounted `:U`: Podman hands its
# ownership to the UID range that `--userns=auto` drew for the container.
# The portal, under the service uid, reads the tree thanks to the container's
# umask 022 — but a plain `chmod 600` by the student leaves it an unreadable
# file and the snapshot becomes partial. That is the limit named in
# sessions/shadow.ts. As root the question does not arise: everything is
# readable, the snapshot is complete, and the portal loses a privilege instead
# of gaining one — this one is the preferred track of docs/v1.md § D-V1-1.
#
# This script does exactly what `snapshot()` in sessions/shadow.ts does:
#   git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A --ignore-errors
#   then commit if anything is staged.
# With the same two details that matter:
#   - `info/exclude` holds `.git`, without which `git add -A` would record the
#     student's repository as a submodule link and capture nothing;
#   - the author identity is the portal's, not the student's.
#
# The shadow repository stays owned by the service user: the portal still takes
# the session-close snapshot, and two different owners would make one of the
# two fail on "dubious ownership".
set -uo pipefail

PREFIX="${CODESPACE_PREFIX:-/srv/codespace}"
VOLUMES="${CODESPACE_VOLUMES:-$PREFIX/volumes}"
SVC_USER="${CODESPACE_USER:-codespace}"

export GIT_AUTHOR_NAME=codespace-portal
export GIT_AUTHOR_EMAIL=portal@codespace.local
export GIT_COMMITTER_NAME=codespace-portal
export GIT_COMMITTER_EMAIL=portal@codespace.local
# HOME neutralised as in git/gitRunner.ts: no personal configuration may enter
# here. safe.directory: root operates on repositories that belong to the
# service user.
export HOME=/nonexistent
GIT=(git -c 'safe.directory=*')

committed=0
skipped=0
failed=0

shopt -s nullglob
for work in "$VOLUMES"/*/*/work; do
	vol="$(dirname "$work")"
	gitdir="$vol/shadow.git"

	if [ ! -d "$gitdir" ]; then
		"${GIT[@]}" init --bare --quiet --initial-branch=main "$gitdir" || { failed=$((failed+1)); continue; }
	fi
	mkdir -p "$gitdir/info"
	printf '.git\n' > "$gitdir/info/exclude"
	chown -R "$SVC_USER":"$SVC_USER" "$gitdir" 2>/dev/null || true

	# `--ignore-errors` stages what it can then exits non-zero; as root there is
	# normally nothing to ignore, and we keep it as a safety net.
	"${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" add -A --ignore-errors >/dev/null 2>&1

	staged="$("${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" diff --cached --name-only 2>/dev/null | head -n 1)"
	if [ -z "$staged" ]; then
		skipped=$((skipped+1))
	elif "${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" \
		commit -q -m "snapshot $(date -Is)" >/dev/null 2>&1; then
		committed=$((committed+1))
	else
		failed=$((failed+1))
	fi
	chown -R "$SVC_USER":"$SVC_USER" "$gitdir" 2>/dev/null || true
done

printf 'shadow repositories: %d snapshots, %d unchanged, %d failed\n' \
	"$committed" "$skipped" "$failed"
exit 0
