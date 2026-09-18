#!/usr/bin/env bash
#
# P2 — undoes what setup.sh put in place: nft tables, anchor, network.
# Touches no other nft table and no other Podman network.
# Session containers still attached to the network block its removal;
# we list them rather than kill them.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
warn() { printf '  !!    %s\n' "$*" >&2; }

echo "== nftables rules =="
if cs_is_root; then
	for fam in inet bridge; do
		if nft list table "$fam" codespace >/dev/null 2>&1; then
			nft delete table "$fam" codespace && ok "table $fam codespace deleted"
		else
			info "table $fam codespace absent"
		fi
	done
else
	warn "not root: nft tables left in place."
	warn "BLOCKED: run  sudo $CS_NET_DIR/teardown.sh"
fi

echo "== anchor container =="
if pd container exists "$CS_ANCHOR" 2>/dev/null; then
	pd rm -f "$CS_ANCHOR" >/dev/null && ok "anchor $CS_ANCHOR deleted"
else
	info "anchor absent"
fi

echo "== Podman network =="
if pd network exists "$CS_NET" 2>/dev/null; then
	rest="$(pd ps -a --filter "network=$CS_NET" --format '{{.Names}}' | tr '\n' ' ')"
	if [ -n "${rest// /}" ]; then
		warn "containers still attached to $CS_NET: $rest"
		warn "remove them then run this script again."
		exit 1
	fi
	pd network rm "$CS_NET" >/dev/null && ok "network $CS_NET deleted"
else
	info "network $CS_NET absent"
fi
