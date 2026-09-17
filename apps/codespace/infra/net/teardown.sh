#!/usr/bin/env bash
#
# P2 — défait ce que setup.sh a posé : tables nft, ancrage, réseau.
# Ne touche à aucune autre table nft ni à aucun autre réseau Podman.
# Les conteneurs de session encore attachés au réseau bloquent sa suppression ;
# on les liste plutôt que de les tuer.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
warn() { printf '  !!    %s\n' "$*" >&2; }

echo "== règles nftables =="
if cs_is_root; then
	for fam in inet bridge; do
		if nft list table "$fam" codespace >/dev/null 2>&1; then
			nft delete table "$fam" codespace && ok "table $fam codespace supprimée"
		else
			info "table $fam codespace absente"
		fi
	done
else
	warn "pas root : tables nft laissées en place."
	warn "BLOQUÉ : exécuter  sudo $CS_NET_DIR/teardown.sh"
fi

echo "== conteneur d'ancrage =="
if pd container exists "$CS_ANCHOR" 2>/dev/null; then
	pd rm -f "$CS_ANCHOR" >/dev/null && ok "ancrage $CS_ANCHOR supprimé"
else
	info "ancrage absent"
fi

echo "== réseau Podman =="
if pd network exists "$CS_NET" 2>/dev/null; then
	rest="$(pd ps -a --filter "network=$CS_NET" --format '{{.Names}}' | tr '\n' ' ')"
	if [ -n "${rest// /}" ]; then
		warn "conteneurs encore attachés à $CS_NET : $rest"
		warn "les retirer puis relancer ce script."
		exit 1
	fi
	pd network rm "$CS_NET" >/dev/null && ok "réseau $CS_NET supprimé"
else
	info "réseau $CS_NET absent"
fi
