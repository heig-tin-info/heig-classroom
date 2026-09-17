#!/usr/bin/env bash
#
# P2 — test d'acceptation du réseau clos (docs/jalon-0.md, section P2).
#
# Trois verdicts par assertion :
#   PASS    vérifié sur cette machine, maintenant
#   FAIL    l'invariant 2 est violé -> le script sort non nul
#   BLOQUÉ  l'assertion dépend d'une table nftables non chargée, ou de root ;
#           rien n'est affirmé, et la commande à passer est indiquée
#
# Ne demande pas root pour la majeure partie : les conteneurs passent par le
# socket Podman rootful, et les serveurs de test écoutent sur des ports > 1024.
# Seules les deux régressions (retirer chaque règle et vérifier que l'assertion
# correspondante tombe) exigent root.
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
blocked() { printf '  BLOQUÉ  %s\n          -> %s\n' "$1" "$2"; BLOCKED=$((BLOCKED+1)); }
step()    { printf '\n-- %s\n' "$*"; }

cleanup() {
	pd rm -f "$A" "$B" >/dev/null 2>&1
	for p in "${LISTENERS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
	rm -rf "$WWW"
}
trap cleanup EXIT

echo "heig-codespace — P2, réseau clos : test d'acceptation"

# ---------------------------------------------------------------- prérequis --
step "prérequis"
if ! pd info >/dev/null 2>&1; then
	echo "  socket Podman rootful injoignable ($CS_PODMAN_URL) — voir docs/setup-poste.md" >&2
	exit 1
fi
if ! pd network exists "$CS_NET" 2>/dev/null; then
	echo "  réseau $CS_NET absent." >&2
	cs_sudo_hint >&2
	exit 1
fi
if ! ip -br -4 addr show dev "$CS_IFACE" 2>/dev/null | grep -q "${CS_GATEWAY}/"; then
	echo "  pont $CS_IFACE sans l'adresse $CS_GATEWAY (ancrage arrêté ?)." >&2
	cs_sudo_hint >&2
	exit 1
fi
echo "  réseau $CS_NET, pont $CS_IFACE, passerelle $CS_GATEWAY : présents"

# ------------------------------------------------ état de la table nftables --
# Sans root on ne peut pas lire le ruleset ; on ne prétend donc pas le
# connaître. Une assertion qui passe reste une preuve (le comportement observé
# suffit) ; une assertion qui échoue est alors BLOQUÉE, pas FAIL.
NFT_STATE=unknown
if cs_is_root; then
	if nft list table inet codespace >/dev/null 2>&1; then NFT_STATE=loaded; else NFT_STATE=absent; fi
fi
echo "  table inet codespace : $NFT_STATE"

NFT_HINT="table nftables non chargée — $(cs_sudo_hint)"

# Verdict pour une assertion qui dépend des règles fixes.
# $1 = 0 si l'assertion est vérifiée, $2 = libellé
rule_verdict() {
	if [ "$1" -eq 0 ]; then pass "$2"
	elif [ "$NFT_STATE" = loaded ]; then fail "$2"
	else blocked "$2" "$NFT_HINT"; fi
}

# ------------------------------------------------- serveurs de test sur l'hôte
echo "ok $CS_GIT_PORT" > "$WWW/index.html"
start_listener() {
	local port=$1
	if curl -sf -m 1 "http://$CS_GATEWAY:$port/" >/dev/null 2>&1; then
		echo "  port $port : un service écoute déjà sur $CS_GATEWAY, réutilisé"
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
	echo "  impossible d'écouter sur $CS_GATEWAY:$port" >&2
	return 1
}
step "serveurs HTTP de test sur l'hôte, liés à $CS_GATEWAY"
start_listener "$CS_GIT_PORT"   || exit 1
start_listener "$CS_CLOSED_PORT" || exit 1
echo "  $CS_GATEWAY:$CS_GIT_PORT et $CS_GATEWAY:$CS_CLOSED_PORT répondent depuis l'hôte"

# ----------------------------------------------------- conteneurs A et B ------
step "conteneurs de test sur le réseau $CS_NET"
pd rm -f "$A" "$B" >/dev/null 2>&1
pd run -d --name "$A" --network "$CS_NET" \
	--dns=none --add-host "portal.internal:$CS_GATEWAY" \
	--cap-drop=ALL --security-opt no-new-privileges \
	"$IMG" sleep 600 >/dev/null || { echo "  lancement de $A impossible" >&2; exit 1; }
pd run -d --name "$B" --network "$CS_NET" \
	--dns=none --add-host "portal.internal:$CS_GATEWAY" \
	--cap-drop=ALL --security-opt no-new-privileges \
	"$IMG" sh -c 'while true; do printf "HTTP/1.0 200 OK\r\nContent-Length: 8\r\n\r\nhello-b\n" | nc -l -p 8080; done' \
	>/dev/null || { echo "  lancement de $B impossible" >&2; exit 1; }

IPB=""
for _ in $(seq 1 20); do
	IPB="$(pd inspect "$B" --format "{{(index .NetworkSettings.Networks \"$CS_NET\").IPAddress}}" 2>/dev/null)"
	[ -n "$IPB" ] && [ "$IPB" != "<no value>" ] && break
	sleep 0.3
done
LLB="$(pd exec "$B" ip -f inet6 addr show eth0 2>/dev/null | awk '/inet6 fe80/{print $2}' | cut -d/ -f1)"
echo "  A=$A  B=$B (ip $IPB, lien-local ${LLB:-aucune})"
sleep 1

# wget busybox depuis A. Renvoie 0 si la requête aboutit.
from_a() { pd exec "$A" wget -T 3 -q -O- "$1" >/dev/null 2>&1; }
# Équivalent de `curl -m 3` : busybox wget -T ne borne que les entrées/sorties
# réseau, pas la résolution de noms ; `timeout 3` borne l'opération entière,
# comme le fait -m pour curl. C'est la commande de docs/jalon-0.md P2.
from_a_capped() { pd exec "$A" timeout 3 wget -T 3 -q -O- "$1" >/dev/null 2>&1; }
from_a_timed() {
	local t0 t1
	t0=$(date +%s%N); from_a_capped "$1"; local rc=$?; t1=$(date +%s%N)
	ELAPSED_MS=$(( (t1 - t0) / 1000000 ))
	return $rc
}
# une réussite attendue mérite quelques essais (le listener nc de B est mono-connexion)
from_a_retry() { local i; for i in 1 2 3; do from_a "$1" && return 0; sleep 0.5; done; return 1; }

# ------------------------------------------------------------- assertions -----
step "assertions jalon-0 P2"

# 1
if from_a_retry "http://$CS_GATEWAY:$CS_GIT_PORT/"; then
	pass "A -> $CS_GATEWAY:$CS_GIT_PORT (canal Git) réussit"
else
	fail "A -> $CS_GATEWAY:$CS_GIT_PORT (canal Git) devrait réussir"
fi

# 2 (dépend de la règle input)
from_a "http://$CS_GATEWAY:$CS_CLOSED_PORT/"; rc=$?
[ $rc -ne 0 ]; rule_verdict $? "A -> $CS_GATEWAY:$CS_CLOSED_PORT échoue (règle input)"

# 3
from_a_timed "http://1.1.1.1/"; rc=$?
if [ $rc -ne 0 ] && [ "$ELAPSED_MS" -lt 3000 ]; then
	pass "A -> 1.1.1.1 échoue en ${ELAPSED_MS} ms (pas de route)"
elif [ $rc -ne 0 ]; then
	fail "A -> 1.1.1.1 échoue mais en ${ELAPSED_MS} ms (> 3 s)"
else
	fail "A -> 1.1.1.1 RÉUSSIT : le réseau n'est pas clos"
fi

# 4
from_a_timed "https://github.com/"; rc=$?
if [ $rc -ne 0 ]; then
	pass "A -> https://github.com n aboutit pas dans les 3 s (borne timeout 3 ; ${ELAPSED_MS} ms mesurés depuis hôte, podman exec inclus)"
else
	fail "A -> https://github.com RÉUSSIT : le réseau n'est pas clos"
fi
# Mesure honnête, sans borne : ce que verrait un étudiant qui tape `apt update`.
t0=$(date +%s%N); pd exec "$A" timeout 12 wget -T 3 -q -O- "https://github.com/" >/dev/null 2>&1; t1=$(date +%s%N)
printf '          note : sans borne, l'"'"'échec prend %d ms (pas de /etc/resolv.conf avec --dns=none,\n                 le résolveur musl retombe sur 127.0.0.1 et attend son délai de 5 s).\n                 TODO(P1) : livrer /etc/resolv.conf « options timeout:1 attempts:1 » dans l'"'"'image.\n' "$(( (t1 - t0) / 1000000 ))"

# 5
if pd exec "$A" getent hosts github.com >/dev/null 2>&1; then
	fail "getent hosts github.com RÉUSSIT : il reste un résolveur"
else
	pass "getent hosts github.com échoue (--dns=none)"
fi

# 6
if pd exec "$A" getent hosts portal.internal 2>/dev/null | grep -q "$CS_GATEWAY"; then
	pass "getent hosts portal.internal -> $CS_GATEWAY (--add-host)"
else
	fail "getent hosts portal.internal ne résout pas vers $CS_GATEWAY"
fi

# 7 (dépend de la règle ICC)
from_a "http://$IPB:8080/"; rc=$?
[ $rc -ne 0 ]; rule_verdict $? "A -> B($IPB):8080 échoue (règle ICC)"

# 7 bis, extra hors liste : même chose en IPv6 lien-local. Les conteneurs
# reçoivent une adresse fe80::/64 même sur un réseau sans IPv6 ; si la règle ICC
# ne couvrait que l'IPv4, deux étudiants se parleraient par là.
if [ -n "$LLB" ]; then
	pd exec "$A" wget -T 3 -q -O- "http://[$LLB%eth0]:8080/" >/dev/null 2>&1; rc=$?
	[ $rc -ne 0 ]; rule_verdict $? "A -> B en IPv6 lien-local [$LLB]:8080 échoue (règle ICC, extra)"
else
	blocked "A -> B en IPv6 lien-local (extra)" "adresse lien-local de B introuvable"
fi

# 8 (contre-épreuve de 7 : la règle ICC ne doit pas couper l'hôte)
if curl -sf -m 3 "http://$IPB:8080/" >/dev/null 2>&1; then
	pass "hôte -> B($IPB):8080 réussit (le proxy du portail reste possible)"
else
	fail "hôte -> B($IPB):8080 échoue : la règle input casse le proxy vers code-server"
fi

# --------------------------------------------------------- régressions -------
step "régressions (retirer chaque règle doit casser l'assertion correspondante)"
if ! cs_is_root; then
	blocked "retirer la règle ICC rend B joignable depuis A" "exige root — sudo $CS_NET_DIR/test.sh"
	blocked "retirer la règle input rend $CS_CLOSED_PORT joignable depuis A" "exige root — sudo $CS_NET_DIR/test.sh"
elif [ "$NFT_STATE" != loaded ]; then
	blocked "retirer la règle ICC rend B joignable depuis A" "$NFT_HINT"
	blocked "retirer la règle input rend $CS_CLOSED_PORT joignable depuis A" "$NFT_HINT"
else
	restore_nft() { nft -f "$CS_NFT_DIR/codespace.nft"; }
	trap 'restore_nft; cleanup' EXIT

	# variante sans la chaîne forward (marqueurs « <<<ICC » / « ICC>>> »)
	awk '/# <<<ICC/{skip=1} !skip; /# ICC>>>/{skip=0}' "$CS_NFT_DIR/codespace.nft" > "$WWW/no-icc.nft"
	awk '/# <<<INPUT/{skip=1} !skip; /# INPUT>>>/{skip=0}' "$CS_NFT_DIR/codespace.nft" > "$WWW/no-input.nft"

	if nft -f "$WWW/no-icc.nft"; then
		if from_a_retry "http://$IPB:8080/"; then
			pass "sans la règle ICC, A -> B:8080 réussit (la règle 1 est bien ce qui bloque)"
		else
			fail "sans la règle ICC, A -> B:8080 échoue quand même : autre chose bloque"
		fi
	else
		fail "impossible de charger la variante sans règle ICC"
	fi
	restore_nft

	if nft -f "$WWW/no-input.nft"; then
		if from_a_retry "http://$CS_GATEWAY:$CS_CLOSED_PORT/"; then
			pass "sans la chaîne input, A -> $CS_GATEWAY:$CS_CLOSED_PORT réussit (la règle 2 est bien ce qui bloque)"
		else
			fail "sans la chaîne input, A -> $CS_GATEWAY:$CS_CLOSED_PORT échoue quand même : autre chose bloque"
		fi
	else
		fail "impossible de charger la variante sans chaîne input"
	fi
	restore_nft
fi

# ------------------------------------------------------------------ bilan ----
printf '\n== bilan : %d PASS, %d FAIL, %d BLOQUÉ ==\n' "$PASSED" "$FAILED" "$BLOCKED"
if [ "$BLOCKED" -gt 0 ]; then
	printf 'BLOQUÉ : exécuter  sudo %s/setup.sh  puis  sudo %s/test.sh\n' "$CS_NET_DIR" "$CS_NET_DIR"
fi
[ "$FAILED" -eq 0 ]
