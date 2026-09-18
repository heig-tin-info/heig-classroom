#!/usr/bin/env bash
# Definitions shared by setup.sh, teardown.sh and test.sh (task P2).
# This file is sourced, not executed.

CS_NET=codespace
CS_IFACE=cs0
CS_SUBNET=10.77.0.0/24
CS_GATEWAY=10.77.0.254
CS_GIT_PORT=9418
CS_CLOSED_PORT=9999            # control port: must stay unreachable
CS_ANCHOR=codespace-anchor
CS_ANCHOR_IMAGE=docker.io/library/alpine:3.20
CS_PODMAN_URL=unix:///run/podman/podman.sock

CS_NET_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CS_NFT_DIR="$(cd "$CS_NET_DIR/../nft" && pwd)"

# Rootful Podman through the socket, ALWAYS. Without --remote the binary falls
# back to rootless local and everything below measures another network
# (setup-poste.md). A function, not a variable: the author's shell is zsh.
pd() { podman --remote --url "$CS_PODMAN_URL" "$@"; }

cs_is_root() { [ "$(id -u)" -eq 0 ]; }

cs_sudo_hint() {
	echo "BLOCKED: run  sudo $CS_NET_DIR/setup.sh"
}
