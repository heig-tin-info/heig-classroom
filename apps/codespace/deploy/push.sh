#!/usr/bin/env bash
#
# heig-codespace — déploiement depuis le poste vers la VM. Rejouable.
#
#   apps/codespace/deploy/push.sh                # construire et déployer
#   apps/codespace/deploy/push.sh --bootstrap    # + (re)mettre la VM en état
#   apps/codespace/deploy/push.sh --rebuild-image
#
# Ce qu'il fait :
#   1. construit @hgc/codespace et ses paquets (tsc)
#   2. `pnpm deploy --prod --legacy` : un arbre autonome (node_modules élagué,
#      workspaces recopiés), exactement comme le Dockerfile de classroom
#   3. vérifie que ce qui est nécessaire à l'exécution y est
#   4. rsync de deploy/ infra/ images/ vers /srv/codespace/src
#   5. rsync de l'arbre vers /srv/codespace/releases/<horodatage>
#   6. bascule du lien /srv/codespace/app
#   7. construction de l'image étudiante sur la VM si elle manque
#   8. redémarrage du service, attente de /healthz en local puis en HTTPS
#
# Retour arrière : voir docs/deploy.md. En résumé, rebasculer le lien vers la
# release précédente et redémarrer — aucune migration Drizzle n'est
# destructive, mais une release antérieure au dernier `drizzle/` ne sait pas
# lire un schéma plus récent.
#
# Aucun pnpm n'est nécessaire sur la VM : l'arbre déployé est autonome.
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
		*) echo "option inconnue : $arg" >&2; exit 2 ;;
	esac
done

ok()   { printf '  ok    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf '  ÉCHEC %s\n' "$*" >&2; exit 1; }

OUT="$(mktemp -d "${TMPDIR:-/tmp}/hgc-codespace-deploy.XXXXXX")"
# pnpm deploy veut un répertoire inexistant ou vide.
rmdir "$OUT"
trap 'rm -rf "$OUT"' EXIT

# ------------------------------------------------------------ 1. construction
step "construction de @hgc/codespace et de ses paquets"
cd "$REPO_ROOT"
pnpm --filter '@hgc/codespace...' --workspace-concurrency=1 build
ok "tsc : paquets + application"

step "arbre de production autonome"
pnpm --filter @hgc/codespace deploy --prod --legacy "$OUT" >/dev/null
ok "pnpm deploy --prod --legacy"
# `pnpm deploy` applique les règles de publication npm : `dist/` est dans le
# `.gitignore` du paquet, donc il n'est pas copié. C'est le même geste que le
# Dockerfile de classroom, qui recopie `drizzle/` pour la même raison.
[ -f "$APP_DIR/dist/server.js" ] || die "dist/server.js absent : la construction a échoué"
cp -r "$APP_DIR/dist" "$OUT/dist"
ok "dist/ recopié dans l'arbre"

# ------------------------------------------------------ 3. ce qu'il faut à l'exécution
step "contenu de l'arbre déployé"
need() { [ -e "$OUT/$1" ] || die "absent de l'arbre déployé : $1"; ok "$1"; }
need dist/server.js
need package.json
# migrationsFolder() de db/client.ts cherche `drizzle/meta/_journal.json` dans
# les ancêtres du module compilé : il doit être à la racine de la release.
need drizzle/meta/_journal.json
need node_modules/better-sqlite3
need node_modules/@hgc/domain/dist/index.js
need node_modules/@hgc/contracts/dist/index.js
# infra/ et seed/ voyagent avec le paquet (aucun champ `files` ne les exclut) ;
# à l'exécution, le portail ne lit ni l'un ni l'autre : SECCOMP_PROFILE pointe
# sur /srv/codespace/src/infra (la copie que les unités systemd utilisent
# aussi), et `seed/` ne sert qu'à `scripts/seed.ts`, qui n'est pas déployé.
[ -e "$OUT/infra/seccomp/codespace.json" ] && ok "infra/ présent (non utilisé à l'exécution)"
[ -e "$OUT/seed/assignments.yaml" ] && ok "seed/ présent (non utilisé à l'exécution)"
[ ! -e "$OUT/node_modules/typescript" ] || die "devDependencies dans l'arbre --prod"
ok "taille : $(du -sh "$OUT" | cut -f1)"

# --------------------------------------------------- 4. sources d'infra sur la VM
step "sources d'infrastructure vers $TARGET:$PREFIX/src"
rsync -a --delete "${RSYNC_E[@]}" \
	--rsync-path="mkdir -p $PREFIX/src && rsync" \
	"$APP_DIR/deploy" "$APP_DIR/infra" "$APP_DIR/images" \
	"$TARGET:$PREFIX/src/"
"${SSH[@]}" "chmod +x $PREFIX/src/deploy/*.sh $PREFIX/src/infra/net/*.sh $PREFIX/src/images/c-dev/*.sh"
ok "deploy/ infra/ images/"

if [ "$DO_BOOTSTRAP" -eq 1 ]; then
	step "bootstrap de la VM (idempotent)"
	"${SSH[@]}" "CODESPACE_DOMAIN=$DOMAIN $PREFIX/src/deploy/bootstrap.sh"
fi

# ------------------------------------------------------------ 5. release ----
step "release $STAMP"
rsync -a --delete "${RSYNC_E[@]}" \
	--rsync-path="mkdir -p $PREFIX/releases/$STAMP && rsync" \
	"$OUT/" "$TARGET:$PREFIX/releases/$STAMP/"
ok "$PREFIX/releases/$STAMP"

# ------------------------------------------ 6..8. bascule, image, redémarrage
step "bascule, image, redémarrage"
"${SSH[@]}" bash -s -- "$STAMP" "$IMAGE_TAG" "$REBUILD_IMAGE" "$KEEP_RELEASES" <<'REMOTE'
set -euo pipefail
STAMP="$1"; IMAGE_TAG="$2"; REBUILD_IMAGE="$3"; KEEP="$4"
PREFIX=/srv/codespace
pd() { podman --remote --url unix:///run/podman/podman.sock "$@"; }

previous="$(readlink "$PREFIX/app" 2>/dev/null || echo "(aucune)")"
ln -sfnT "releases/$STAMP" "$PREFIX/app"
echo "  lien app : $previous -> releases/$STAMP"

if [ "$REBUILD_IMAGE" = 1 ] || ! pd image exists "$IMAGE_TAG"; then
	echo "  construction de $IMAGE_TAG (1 à 2 min sur 2 vCPU)…"
	t0=$(date +%s)
	pd build -q -t "$IMAGE_TAG" -t codespace/c-dev:latest "$PREFIX/src/images/c-dev" >/dev/null
	echo "  image construite en $(( $(date +%s) - t0 )) s"
else
	echo "  image $IMAGE_TAG déjà présente"
fi

systemctl restart codespace.service
for i in $(seq 1 60); do
	if curl -sf -m 2 http://127.0.0.1:3100/healthz >/dev/null; then
		echo "  /healthz local : OK après ${i}s"
		break
	fi
	if [ "$i" = 60 ]; then
		echo "  /healthz local : PAS DE RÉPONSE" >&2
		systemctl --no-pager --lines=40 status codespace.service >&2 || true
		journalctl -u codespace.service -n 60 --no-pager >&2 || true
		exit 1
	fi
	sleep 1
done

# On garde quelques releases pour le retour arrière, pas plus : 38 Go de disque
# et l'image de 1,5 Go vivent sur le même volume.
current="$(basename "$(readlink "$PREFIX/app")")"
ls -1 "$PREFIX/releases" | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
	[ "$old" = "$current" ] && continue
	rm -rf "${PREFIX:?}/releases/$old"
	echo "  release élaguée : $old"
done
REMOTE

# ----------------------------------------------------------- 8bis. HTTPS ----
step "vérification depuis le poste"
for i in $(seq 1 30); do
	body="$(curl -sS -m 5 "https://$DOMAIN/healthz" 2>/dev/null || true)"
	if [ "$body" = '{"ok":true}' ]; then
		ok "https://$DOMAIN/healthz -> $body"
		break
	fi
	[ "$i" = 30 ] && die "https://$DOMAIN/healthz ne répond pas ($body)"
	sleep 2
done

printf '\nrelease déployée : %s\n' "$STAMP"
