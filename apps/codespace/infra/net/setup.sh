#!/usr/bin/env bash
#
# P2 — met en place le réseau clos `codespace` : réseau Podman, conteneur
# d'ancrage, règles nftables fixes. Idempotent, rejouable, prévu pour être
# lancé au démarrage du poste :  sudo infra/net/setup.sh
#
# Sans root, le script fait tout ce qui ne demande pas root (réseau + ancrage)
# et affiche ce qui reste.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/common.sh"

ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
warn() { printf '  !!    %s\n' "$*" >&2; }

echo "== réseau Podman =="

if ! pd info >/dev/null 2>&1; then
	warn "socket Podman rootful injoignable : $CS_PODMAN_URL"
	warn "voir docs/setup-poste.md (groupe podman, /etc/tmpfiles.d/podman.conf)"
	exit 1
fi

if pd network exists "$CS_NET" 2>/dev/null; then
	ok "réseau $CS_NET déjà présent"
else
	pd network create \
		--internal \
		--disable-dns \
		--subnet "$CS_SUBNET" \
		--gateway "$CS_GATEWAY" \
		--interface-name "$CS_IFACE" \
		"$CS_NET" >/dev/null
	ok "réseau $CS_NET créé"
fi

# Vérification de conformité : un réseau créé à la main avec d'autres options
# rendrait les règles nft muettes (mauvais nom de pont) sans rien casser de
# visible. On refuse plutôt que de continuer.
read -r got_if got_internal got_dns got_subnet got_gw < <(
	pd network inspect "$CS_NET" --format \
		'{{.NetworkInterface}} {{.Internal}} {{.DNSEnabled}} {{(index .Subnets 0).Subnet}} {{(index .Subnets 0).Gateway}}'
)
conform=0
[ "$got_if" = "$CS_IFACE" ]      || { warn "interface = $got_if, attendu $CS_IFACE"; conform=1; }
[ "$got_internal" = "true" ]     || { warn "internal = $got_internal, attendu true"; conform=1; }
[ "$got_dns" = "false" ]         || { warn "dns = $got_dns, attendu false"; conform=1; }
[ "$got_subnet" = "$CS_SUBNET" ] || { warn "subnet = $got_subnet, attendu $CS_SUBNET"; conform=1; }
[ "$got_gw" = "$CS_GATEWAY" ]    || { warn "gateway = $got_gw, attendu $CS_GATEWAY"; conform=1; }
if [ "$conform" -ne 0 ]; then
	warn "réseau non conforme : $0 refuse de continuer."
	warn "corriger avec  $CS_NET_DIR/teardown.sh  puis relancer."
	exit 1
fi
ok "réseau conforme (if=$got_if internal=$got_internal dns=$got_dns $got_subnet gw=$got_gw)"

echo "== conteneur d'ancrage =="
# netavark crée le pont quand le premier conteneur rejoint le réseau et le
# SUPPRIME quand le dernier le quitte. Sans ancrage, cs0 et l'adresse
# 10.77.0.254 disparaissent dès qu'aucune session n'est active, et le portail
# ne peut plus se lier à l'adresse du pont. Décision et alternative écartée :
# infra/net/README.md.
anchor_state="$(pd inspect "$CS_ANCHOR" --format '{{.State.Status}}' 2>/dev/null || true)"
case "$anchor_state" in
	running)
		ok "ancrage $CS_ANCHOR déjà en marche"
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
		ok "ancrage $CS_ANCHOR créé"
		;;
	*)
		pd start "$CS_ANCHOR" >/dev/null
		ok "ancrage $CS_ANCHOR relancé (était: $anchor_state)"
		;;
esac

# Le pont n'existe qu'une fois l'ancrage démarré ; on le laisse s'installer.
for _ in 1 2 3 4 5 6 7 8 9 10; do
	ip -br -4 addr show dev "$CS_IFACE" >/dev/null 2>&1 && break
	sleep 0.3
done
if ip -br -4 addr show dev "$CS_IFACE" 2>/dev/null | grep -q "${CS_GATEWAY}/"; then
	ok "pont $CS_IFACE porte $CS_GATEWAY"
else
	warn "pont $CS_IFACE sans l'adresse $CS_GATEWAY"
	exit 1
fi

echo "== règles nftables =="
if ! cs_is_root; then
	warn "pas root : les règles nftables n'ont pas été chargées."
	cs_sudo_hint
	exit 3
fi

# br_netfilter est ce qui fait traverser les hooks IP au trafic ponté, donc ce
# qui rend la règle ICC opérante. Sans lui elle est silencieusement inutile.
modprobe br_netfilter 2>/dev/null || true
if [ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]; then
	sysctl -qw net.bridge.bridge-nf-call-iptables=1
	sysctl -qw net.bridge.bridge-nf-call-ip6tables=1
	ok "br_netfilter actif (call-iptables=1, call-ip6tables=1)"
else
	warn "br_netfilter indisponible : la règle ICC en famille inet sera inopérante."
	warn "voir le repli documenté dans infra/net/README.md"
fi

nft -f "$CS_NFT_DIR/codespace.nft"
ok "table inet codespace chargée"

# Famille bridge : défense en profondeur si le noyau la supporte. Le noyau WSL2
# de ce poste ne l'a pas ; on n'en fait donc pas une condition de succès.
if nft -f "$CS_NFT_DIR/codespace-bridge.nft" 2>/dev/null; then
	ok "table bridge codespace chargée (défense en profondeur)"
else
	info "famille bridge indisponible sur ce noyau : seule la table inet est active"
fi

echo
echo "prêt. vérifier avec : $CS_NET_DIR/test.sh"
