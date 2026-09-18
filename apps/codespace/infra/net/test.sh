#!/usr/bin/env bash
#
# P2 — acceptance test of the closed network (docs/jalon-0.md, section P2).
#
# Three verdicts per assertion:
#   PASS     verified on this machine, right now
#   FAIL     invariant 2 is violated -> the script exits non-zero
#   BLOCKED  the assertion depends on an nftables table that is not loaded, or
#            on root; nothing is asserted, and the command to run is shown
#
# Does not need root for most of it: the containers go through the rootful
# Podman socket, and the test servers listen on ports > 1024.
# Only the two regressions (remove each rule and check that the matching
# assertion falls) require root.
set -uo pipefail
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

A=codespace-test-a
B=codespace-test-b
IMG="$CS_ANCHOR_IMAGE"
WWW="$(mktemp -d)"
LISTENERS=()
FAILED=0
BLOCKED=0
PASSED=0

pass()    { printf '  PASS    %s\n' "$*"; PASSED=$((PASSED+1)); }
fail()    { printf '  FAIL    %s\n' "$*"; FAILED=$((FAILED+1)); }
blocked() { printf '  BLOCKED %s\n          -> %s\n' "$1" "$2"; BLOCKED=$((BLOCKED+1)); }
step()    { printf '\n-- %s\n' "$*"; }

cleanup() {
	pd rm -f "$A" "$B" >/dev/null 2>&1
	for p in "${LISTENERS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
	rm -rf "$WWW"
}
trap cleanup EXIT

echo "heig-codespace — P2, closed network: acceptance test"

# ------------------------------------------------------------ prerequisites --
step "prerequisites"
if ! pd info >/dev/null 2>&1; then
	echo "  rootful Podman socket unreachable ($CS_PODMAN_URL) — see docs/setup-poste.md" >&2
	exit 1
fi
if ! pd network exists "$CS_NET" 2>/dev/null; then
	echo "  network $CS_NET absent." >&2
	cs_sudo_hint >&2
	exit 1
fi
if ! ip -br -4 addr show dev "$CS_IFACE" 2>/dev/null | grep -q "${CS_GATEWAY}/"; then
	echo "  bridge $CS_IFACE without the address $CS_GATEWAY (anchor stopped?)." >&2
	cs_sudo_hint >&2
	exit 1
fi
echo "  network $CS_NET, bridge $CS_IFACE, gateway $CS_GATEWAY: present"

# ---------------------------------------------- state of the nftables table --
# Without root we cannot read the ruleset; so we do not claim to know it. An
# assertion that passes is still a proof (the observed behaviour is enough);
# an assertion that fails is then BLOCKED, not FAIL.
NFT_STATE=unknown
if cs_is_root; then
	if nft list table inet codespace >/dev/null 2>&1; then NFT_STATE=loaded; else NFT_STATE=absent; fi
fi
echo "  table inet codespace: $NFT_STATE"

NFT_HINT="nftables table not loaded — $(cs_sudo_hint)"

# Verdict for an assertion that depends on the fixed rules.
# $1 = 0 if the assertion holds, $2 = label
rule_verdict() {
	if [ "$1" -eq 0 ]; then pass "$2"
	elif [ "$NFT_STATE" = loaded ]; then fail "$2"
	else blocked "$2" "$NFT_HINT"; fi
}

# ---------------------------------------------------- test servers on the host
echo "ok $CS_GIT_PORT" > "$WWW/index.html"
start_listener() {
	local port=$1
	if curl -sf -m 1 "http://$CS_GATEWAY:$port/" >/dev/null 2>&1; then
		echo "  port $port: a service already listens on $CS_GATEWAY, reused"
		LISTENERS+=("")
		return 0
	fi
	python3 -m http.server "$port" --bind "$CS_GATEWAY" --directory "$WWW" >/dev/null 2>&1 &
	local pid=$!
	LISTENERS+=("$pid")
	local i
	for i in $(seq 1 25); do
		curl -sf -m 1 "http://$CS_GATEWAY:$port/" >/dev/null 2>&1 && return 0
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.2
	done
	echo "  cannot listen on $CS_GATEWAY:$port" >&2
	return 1
}
step "test HTTP servers on the host, bound to $CS_GATEWAY"
start_listener "$CS_GIT_PORT"   || exit 1
start_listener "$CS_CLOSED_PORT" || exit 1
echo "  $CS_GATEWAY:$CS_GIT_PORT and $CS_GATEWAY:$CS_CLOSED_PORT answer from the host"

# ---------------------------------------------------- containers A and B ------
step "test containers on network $CS_NET"
pd rm -f "$A" "$B" >/dev/null 2>&1
pd run -d --name "$A" --network "$CS_NET" \
	--dns=none --add-host "portal.internal:$CS_GATEWAY" \
	--cap-drop=ALL --security-opt no-new-privileges \
	"$IMG" sleep 600 >/dev/null || { echo "  cannot start $A" >&2; exit 1; }
pd run -d --name "$B" --network "$CS_NET" \
	--dns=none --add-host "portal.internal:$CS_GATEWAY" \
	--cap-drop=ALL --security-opt no-new-privileges \
	"$IMG" sh -c 'while true; do printf "HTTP/1.0 200 OK\r\nContent-Length: 8\r\n\r\nhello-b\n" | nc -l -p 8080; done' \
	>/dev/null || { echo "  cannot start $B" >&2; exit 1; }

IPB=""
for _ in $(seq 1 20); do
	IPB="$(pd inspect "$B" --format "{{(index .NetworkSettings.Networks \"$CS_NET\").IPAddress}}" 2>/dev/null)"
	[ -n "$IPB" ] && [ "$IPB" != "<no value>" ] && break
	sleep 0.3
done
LLB="$(pd exec "$B" ip -f inet6 addr show eth0 2>/dev/null | awk '/inet6 fe80/{print $2}' | cut -d/ -f1)"
echo "  A=$A  B=$B (ip $IPB, link-local ${LLB:-none})"
sleep 1

# busybox wget from A. Returns 0 if the request goes through.
from_a() { pd exec "$A" wget -T 3 -q -O- "$1" >/dev/null 2>&1; }
# Equivalent of `curl -m 3`: busybox wget -T only bounds network I/O, not name
# resolution; `timeout 3` bounds the whole operation, the way -m does for curl.
# This is the command from docs/jalon-0.md P2.
from_a_capped() { pd exec "$A" timeout 3 wget -T 3 -q -O- "$1" >/dev/null 2>&1; }
from_a_timed() {
	local t0 t1
	t0=$(date +%s%N); from_a_capped "$1"; local rc=$?; t1=$(date +%s%N)
	ELAPSED_MS=$(( (t1 - t0) / 1000000 ))
	return $rc
}
# an expected success deserves a few tries (B's nc listener is single-connection)
from_a_retry() { local i; for i in 1 2 3; do from_a "$1" && return 0; sleep 0.5; done; return 1; }

# ------------------------------------------------------------- assertions -----
step "jalon-0 P2 assertions"

# 1
if from_a_retry "http://$CS_GATEWAY:$CS_GIT_PORT/"; then
	pass "A -> $CS_GATEWAY:$CS_GIT_PORT (Git channel) succeeds"
else
	fail "A -> $CS_GATEWAY:$CS_GIT_PORT (Git channel) should succeed"
fi

# 2 (depends on the input rule)
from_a "http://$CS_GATEWAY:$CS_CLOSED_PORT/"; rc=$?
[ $rc -ne 0 ]; rule_verdict $? "A -> $CS_GATEWAY:$CS_CLOSED_PORT fails (input rule)"

# 3
from_a_timed "http://1.1.1.1/"; rc=$?
if [ $rc -ne 0 ] && [ "$ELAPSED_MS" -lt 3000 ]; then
	pass "A -> 1.1.1.1 fails in ${ELAPSED_MS} ms (no route)"
elif [ $rc -ne 0 ]; then
	fail "A -> 1.1.1.1 fails, but in ${ELAPSED_MS} ms (> 3 s)"
else
	fail "A -> 1.1.1.1 SUCCEEDS: the network is not closed"
fi

# 4
from_a_timed "https://github.com/"; rc=$?
if [ $rc -ne 0 ]; then
	pass "A -> https://github.com does not get through within 3 s (timeout 3 bound; ${ELAPSED_MS} ms measured from the host, podman exec included)"
else
	fail "A -> https://github.com SUCCEEDS: the network is not closed"
fi
# Honest measurement, unbounded: what a student typing `apt update` would see.
t0=$(date +%s%N); pd exec "$A" timeout 12 wget -T 3 -q -O- "https://github.com/" >/dev/null 2>&1; t1=$(date +%s%N)
printf '          note: unbounded, the failure takes %d ms. These test containers are\n                 alpine started with --dns=none and no /etc/resolv.conf, so the musl\n                 resolver falls back to 127.0.0.1 and waits its 5 s. The student image\n                 ships its own /etc/resolv.conf with "options timeout:1 attempts:1",\n                 see images/c-dev/resolv.conf.\n' "$(( (t1 - t0) / 1000000 ))"

# 5
if pd exec "$A" getent hosts github.com >/dev/null 2>&1; then
	fail "getent hosts github.com SUCCEEDS: a resolver is left"
else
	pass "getent hosts github.com fails (--dns=none)"
fi

# 6
if pd exec "$A" getent hosts portal.internal 2>/dev/null | grep -q "$CS_GATEWAY"; then
	pass "getent hosts portal.internal -> $CS_GATEWAY (--add-host)"
else
	fail "getent hosts portal.internal does not resolve to $CS_GATEWAY"
fi

# 7 (depends on the ICC rule)
from_a "http://$IPB:8080/"; rc=$?
[ $rc -ne 0 ]; rule_verdict $? "A -> B($IPB):8080 fails (ICC rule)"

# 7 bis, extra, off the list: the same thing in IPv6 link-local. Containers get
# a fe80::/64 address even on a network without IPv6; if the ICC rule covered
# IPv4 only, two students could talk to each other that way.
if [ -n "$LLB" ]; then
	pd exec "$A" wget -T 3 -q -O- "http://[$LLB%eth0]:8080/" >/dev/null 2>&1; rc=$?
	[ $rc -ne 0 ]; rule_verdict $? "A -> B in IPv6 link-local [$LLB]:8080 fails (ICC rule, extra)"
else
	blocked "A -> B in IPv6 link-local (extra)" "link-local address of B not found"
fi

# 8 (counter-check of 7: the ICC rule must not cut the host off)
if curl -sf -m 3 "http://$IPB:8080/" >/dev/null 2>&1; then
	pass "host -> B($IPB):8080 succeeds (the portal proxy stays possible)"
else
	fail "host -> B($IPB):8080 fails: the input rule breaks the proxy to code-server"
fi

# --------------------------------------------------------- regressions -------
step "regressions (removing each rule must break the matching assertion)"
if ! cs_is_root; then
	blocked "removing the ICC rule makes B reachable from A" "requires root — sudo $CS_NET_DIR/test.sh"
	blocked "removing the input rule makes $CS_CLOSED_PORT reachable from A" "requires root — sudo $CS_NET_DIR/test.sh"
elif [ "$NFT_STATE" != loaded ]; then
	blocked "removing the ICC rule makes B reachable from A" "$NFT_HINT"
	blocked "removing the input rule makes $CS_CLOSED_PORT reachable from A" "$NFT_HINT"
else
	restore_nft() { nft -f "$CS_NFT_DIR/codespace.nft"; }
	trap 'restore_nft; cleanup' EXIT

	# variant without the forward chain (markers "<<<ICC" / "ICC>>>")
	awk '/# <<<ICC/{skip=1} !skip; /# ICC>>>/{skip=0}' "$CS_NFT_DIR/codespace.nft" > "$WWW/no-icc.nft"
	awk '/# <<<INPUT/{skip=1} !skip; /# INPUT>>>/{skip=0}' "$CS_NFT_DIR/codespace.nft" > "$WWW/no-input.nft"

	if nft -f "$WWW/no-icc.nft"; then
		if from_a_retry "http://$IPB:8080/"; then
			pass "without the ICC rule, A -> B:8080 succeeds (rule 1 really is what blocks)"
		else
			fail "without the ICC rule, A -> B:8080 still fails: something else blocks"
		fi
	else
		fail "cannot load the variant without the ICC rule"
	fi
	restore_nft

	if nft -f "$WWW/no-input.nft"; then
		if from_a_retry "http://$CS_GATEWAY:$CS_CLOSED_PORT/"; then
			pass "without the input chain, A -> $CS_GATEWAY:$CS_CLOSED_PORT succeeds (rule 2 really is what blocks)"
		else
			fail "without the input chain, A -> $CS_GATEWAY:$CS_CLOSED_PORT still fails: something else blocks"
		fi
	else
		fail "cannot load the variant without the input chain"
	fi
	restore_nft
fi

# ---------------------------------------------------------------- summary ----
printf '\n== summary: %d PASS, %d FAIL, %d BLOCKED ==\n' "$PASSED" "$FAILED" "$BLOCKED"
if [ "$BLOCKED" -gt 0 ]; then
	printf 'BLOCKED: run  sudo %s/setup.sh  then  sudo %s/test.sh\n' "$CS_NET_DIR" "$CS_NET_DIR"
fi
[ "$FAILED" -eq 0 ]
