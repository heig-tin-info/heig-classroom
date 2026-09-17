#!/usr/bin/env bash
#
# Instantané des dépôts fantômes, en root (analyse.md § 3.3, docs/v1.md
# D-V1-1). Lancé par codespace-shadow.timer toutes les trois minutes.
#
# Pourquoi root, et pas le portail. Le volume est monté `:U` : Podman en donne
# la propriété à la plage d'UID que `--userns=auto` a tirée pour le conteneur.
# Le portail, en uid du service, lit l'arbre grâce à l'umask 022 du conteneur —
# mais un simple `chmod 600` de l'étudiant lui rend un fichier illisible et
# l'instantané devient partiel. C'est la limite nommée dans sessions/shadow.ts.
# En root, la question ne se pose pas : tout est lisible, l'instantané est
# complet, et le portail perd un privilège au lieu d'en gagner un — c'est la
# piste préférée de docs/v1.md § D-V1-1, celle-ci.
#
# Ce script fait exactement ce que fait `snapshot()` de sessions/shadow.ts :
#   git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A --ignore-errors
#   puis commit s'il y a quelque chose d'indexé.
# Avec les deux mêmes détails qui comptent :
#   - `info/exclude` porte `.git`, sans quoi `git add -A` enregistrerait le
#     dépôt de l'étudiant comme lien de sous-module et ne capturerait rien ;
#   - l'identité de l'auteur est celle du portail, pas celle de l'étudiant.
#
# Le dépôt fantôme reste la propriété de l'utilisateur du service : le portail
# prend encore l'instantané de fermeture de session, et deux propriétaires
# différents feraient échouer l'un des deux sur « dubious ownership ».
set -uo pipefail

PREFIX="${CODESPACE_PREFIX:-/srv/codespace}"
VOLUMES="${CODESPACE_VOLUMES:-$PREFIX/volumes}"
SVC_USER="${CODESPACE_USER:-codespace}"

export GIT_AUTHOR_NAME=codespace-portal
export GIT_AUTHOR_EMAIL=portal@codespace.local
export GIT_COMMITTER_NAME=codespace-portal
export GIT_COMMITTER_EMAIL=portal@codespace.local
# HOME neutralisé comme dans git/gitRunner.ts : aucune configuration
# personnelle ne doit entrer ici. safe.directory : root opère sur des dépôts
# qui appartiennent à l'utilisateur du service.
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

	# `--ignore-errors` indexe ce qu'il peut puis sort non nul ; en root il n'y
	# a normalement rien à ignorer, et on le garde comme filet.
	"${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" add -A --ignore-errors >/dev/null 2>&1

	staged="$("${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" diff --cached --name-only 2>/dev/null | head -n 1)"
	if [ -z "$staged" ]; then
		skipped=$((skipped+1))
	elif "${GIT[@]}" --git-dir="$gitdir" --work-tree="$work" \
		commit -q -m "instantané $(date -Is)" >/dev/null 2>&1; then
		committed=$((committed+1))
	else
		failed=$((failed+1))
	fi
	chown -R "$SVC_USER":"$SVC_USER" "$gitdir" 2>/dev/null || true
done

printf 'dépôts fantômes : %d instantanés, %d inchangés, %d en échec\n' \
	"$committed" "$skipped" "$failed"
exit 0
