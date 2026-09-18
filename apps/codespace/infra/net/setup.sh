#!/usr/bin/env bash
#
# P2 — sets up the closed `codespace` network: Podman network, anchor
# container, fixed nftables rules. Idempotent, replayable, meant to be run at
# workstation start-up:  sudo infra/net/setup.sh
#
# Without root, the script does everything that does not need root (network +
# anchor) and prints what is left to do.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
warn() { printf '  !!    %s\n' "$*" >&2; }

echo "== Podman network =="

if ! pd info >/dev/null 2>&1; then
	warn "rootful Podman socket unreachable: $CS_PODMAN_URL"
	warn "see docs/setup-poste.md (podman group, /etc/tmpfiles.d/podman.conf)"
	exit 1
fi

if pd network exists "$CS_NET" 2>/dev/null; then
	ok "network $CS_NET already present"
else
	pd network create \
		--internal \
		--disable-dns \
		--subnet "$CS_SUBNET" \
		--gateway "$CS_GATEWAY" \
		--interface-name "$CS_IFACE" \
		"$CS_NET" >/dev/null
	ok "network $CS_NET created"
fi

# Conformance check: a network created by hand with other options would make
# the nft rules silent (wrong bridge name) without breaking anything visible.
# We refuse rather than carry on.
read -r got_if got_internal got_dns got_subnet got_gw < <(
	pd network inspect "$CS_NET" --format \
		'{{.NetworkInterface}} {{.Internal}} {{.DNSEnabled}} {{(index .Subnets 0).Subnet}} {{(index .Subnets 0).Gateway}}'
)
conform=0
[ "$got_if" = "$CS_IFACE" ]      || { warn "interface = $got_if, expected $CS_IFACE"; conform=1; }
[ "$got_internal" = "true" ]     || { warn "internal = $got_internal, expected true"; conform=1; }
[ "$got_dns" = "false" ]         || { warn "dns = $got_dns, expected false"; conform=1; }
[ "$got_subnet" = "$CS_SUBNET" ] || { warn "subnet = $got_subnet, expected $CS_SUBNET"; conform=1; }
[ "$got_gw" = "$CS_GATEWAY" ]    || { warn "gateway = $got_gw, expected $CS_GATEWAY"; conform=1; }
if [ "$conform" -ne 0 ]; then
	warn "network not conformant: $0 refuses to carry on."
	warn "fix it with  $CS_NET_DIR/teardown.sh  then run again."
	exit 1
fi
ok "network conformant (if=$got_if internal=$got_internal dns=$got_dns $got_subnet gw=$got_gw)"

echo "== anchor container =="
# netavark creates the bridge when the first container joins the network and
# DELETES it when the last one leaves. Without an anchor, cs0 and the address
# 10.77.0.254 disappear as soon as no session is active, and the portal can no
# longer bind to the bridge address. Decision and discarded alternative:
# infra/net/README.md.
anchor_state="$(pd inspect "$CS_ANCHOR" --format '{{.State.Status}}' 2>/dev/null || true)"
case "$anchor_state" in
	running)
		ok "anchor $CS_ANCHOR already running"
		;;
	"")
		pd run -d \
			--name "$CS_ANCHOR" \
			--network "$CS_NET" \
			--restart always \
			--dns=none \
			--cap-drop=ALL \
			--security-opt no-new-privileges \
			--read-only \
			--pids-limit 16 \
			--memory 32m \
			--cpus 0.05 \
			--label heig-codespace.role=anchor \
			"$CS_ANCHOR_IMAGE" sleep infinity >/dev/null
		ok "anchor $CS_ANCHOR created"
		;;
	*)
		pd start "$CS_ANCHOR" >/dev/null
		ok "anchor $CS_ANCHOR restarted (was: $anchor_state)"
		;;
esac

# The bridge exists only once the anchor is started; we let it settle.
for _ in 1 2 3 4 5 6 7 8 9 10; do
	ip -br -4 addr show dev "$CS_IFACE" >/dev/null 2>&1 && break
	sleep 0.3
done
if ip -br -4 addr show dev "$CS_IFACE" 2>/dev/null | grep -q "${CS_GATEWAY}/"; then
	ok "bridge $CS_IFACE carries $CS_GATEWAY"
else
	warn "bridge $CS_IFACE without the address $CS_GATEWAY"
	exit 1
fi

echo "== nftables rules =="
if ! cs_is_root; then
	warn "not root: the nftables rules were not loaded."
	cs_sudo_hint
	exit 3
fi

# br_netfilter is what makes bridged traffic cross the IP hooks, hence what
# makes the ICC rule effective. Without it the rule is silently useless.
modprobe br_netfilter 2>/dev/null || true
if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
	sysctl -qw net.bridge.bridge-nf-call-iptables=1
	sysctl -qw net.bridge.bridge-nf-call-ip6tables=1
	ok "br_netfilter active (call-iptables=1, call-ip6tables=1)"
else
	warn "br_netfilter unavailable: the ICC rule in the inet family will be inoperative."
	warn "see the fallback documented in infra/net/README.md"
fi

nft -f "$CS_NFT_DIR/codespace.nft"
ok "table inet codespace loaded"

# bridge family: defence in depth when the kernel supports it. The WSL2 kernel
# of this workstation does not; so we do not make it a success condition.
if nft -f "$CS_NFT_DIR/codespace-bridge.nft" 2>/dev/null; then
	ok "table bridge codespace loaded (defence in depth)"
else
	info "bridge family unavailable on this kernel: only the inet table is active"
fi

echo
echo "ready. check with: $CS_NET_DIR/test.sh"
