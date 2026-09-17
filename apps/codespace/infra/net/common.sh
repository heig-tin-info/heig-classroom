#!/usr/bin/env bash
# Définitions partagées par setup.sh, teardown.sh et test.sh (tâche P2).
# Ce fichier est sourcé, pas exécuté.

CS_NET=codespace
CS_IFACE=cs0
CS_SUBNET=10.77.0.0/24
CS_GATEWAY=10.77.0.254
CS_GIT_PORT=9418
CS_CLOSED_PORT=9999            # port de contrôle : doit rester injoignable
CS_ANCHOR=codespace-anchor
CS_ANCHOR_IMAGE=docker.io/library/alpine:3.20
CS_PODMAN_URL=unix:///run/podman/podman.sock

CS_NET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CS_NFT_DIR="$(cd "$CS_NET_DIR/../nft" && pwd)"

# Podman rootful par le socket, TOUJOURS. Sans --remote le binaire bascule en
# rootless local et tout ce qui suit mesure un autre réseau (setup-poste.md).
# Fonction et pas variable : le shell de l'auteur est zsh.
pd() { podman --remote --url "$CS_PODMAN_URL" "$@"; }

cs_is_root() { [ "$(id -u)" -eq 0 ]; }

cs_sudo_hint() {
	echo "BLOQUÉ : exécuter  sudo $CS_NET_DIR/setup.sh"
}
