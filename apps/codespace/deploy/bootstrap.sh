#!/usr/bin/env bash
#
# heig-codespace — mise en état d'une VM neuve, en root, IDEMPOTENT.
#
#   rsync -a --rsync-path='mkdir -p /srv/codespace/src && rsync' \
#     apps/codespace/deploy apps/codespace/infra apps/codespace/images \
#     root@<vm>:/srv/codespace/src/
#   ssh root@<vm> /srv/codespace/src/deploy/bootstrap.sh
#
# ou, depuis le poste, en une commande :  deploy/push.sh --bootstrap
#
# Rejouable sans effet de bord : rien n'est écrasé qui porte un secret
# (/etc/codespace/env n'est écrit que s'il n'existe pas), rien n'est ajouté
# deux fois (subuid, fstab), et les unités sont réécrites à l'identique.
#
# Ce script fait, et rien d'autre :
#   1. swap de 2 Go                  (3,7 Go de RAM, un `podman build` y tient juste)
#   2. paquets                       (podman 5.7, caddy, nftables, node 22)
#   3. plage `containers`            (ce qui rend `--userns=auto` possible)
#   4. socket Podman rootful         (les deux pièges de docs/setup-poste.md)
#   5. utilisateur système codespace
#   6. arborescence /srv/codespace   et /etc/codespace
#   7. br_netfilter persistant       (sans lui la règle ICC est inopérante)
#   8. /etc/codespace/env            (secrets tirés de /dev/urandom, une seule fois)
#  8bis. clé privée de la GitHub App (vérifiée et remise d'aplomb, jamais créée)
#   9. unités systemd                (portail, réseau, dépôt fantôme root)
#  10. Caddy                         (TLS Let's Encrypt, proxy vers 127.0.0.1:3100)
#  11. infra/net/setup.sh            (réseau codespace, ancrage, table nft)
#
# Il ne déploie PAS l'application : c'est deploy/push.sh.
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=/srv/codespace
ETC=/etc/codespace
SVC_USER=codespace
DOMAIN="${CODESPACE_DOMAIN:-code.chevallier.io}"
CLASSROOM="${CODESPACE_CLASSROOM_URL:-https://classroom.chevallier.io}"
PODMAN_SOCK=unix:///run/podman/podman.sock

ok()   { printf '  ok    %s\n' "$*"; }
info() { printf '  ..    %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "bootstrap.sh doit tourner en root" >&2; exit 1; }
[ -x "$SRC_ROOT/infra/net/setup.sh" ] || {
	echo "infra/ absent de $SRC_ROOT : rsync deploy/ infra/ images/ d'abord" >&2
	exit 1
}

# --------------------------------------------------------------- 1. swap ----
step "swap de 2 Go"
if swapon --show=NAME --noheadings | grep -q .; then
	ok "swap déjà actif : $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
else
	if [ ! -f /swapfile ]; then
		# fallocate suffit sur ext4 ; dd serait plus lent pour rien.
		fallocate -l 2G /swapfile
		chmod 600 /swapfile
		mkswap -q /swapfile >/dev/null
	fi
	swapon /swapfile
	ok "swap de 2 Go activé"
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# 3,7 Go sans swap : `podman build` de l'image de 1,5 Go et Node se marchent
# dessus. Le swap est un filet, pas un lieu de vie : on n'y va qu'à la fin.
printf 'vm.swappiness = 10\n' > /etc/sysctl.d/99-codespace-swap.conf
sysctl -q --system >/dev/null 2>&1 || true
ok "/etc/fstab et vm.swappiness=10"

# ------------------------------------------------------------ 2. paquets ----
step "paquets"
export DEBIAN_FRONTEND=noninteractive
NEEDED=(podman crun netavark aardvark-dns passt uidmap nftables caddy git curl
        rsync python3 nodejs ca-certificates)
MISSING=()
for p in "${NEEDED[@]}"; do
	dpkg -s "$p" >/dev/null 2>&1 || MISSING+=("$p")
done
if [ "${#MISSING[@]}" -gt 0 ]; then
	apt-get update -qq
	apt-get install -y -qq --no-install-recommends "${MISSING[@]}" >/dev/null
	ok "installés : ${MISSING[*]}"
else
	ok "tous présents"
fi
# Node 22 : le paquet d'Ubuntu 26.04 (22.x), pas NodeSource. Justification
# dans docs/deploy.md ; la contrainte réelle est l'ABI de better-sqlite3,
# identique entre deux Node 22.
info "node $(node --version), podman $(podman --version | awk '{print $3}'), caddy $(caddy version | head -1)"

# ------------------------------------------- 3. plage containers (userns) ----
step "plage d'UID subordonnés « containers » (--userns=auto)"
for f in /etc/subuid /etc/subgid; do
	if grep -q '^containers:' "$f"; then
		ok "$f : ligne containers déjà présente"
	else
		echo "containers:2147483647:2147483648" >> "$f"
		ok "$f : ligne containers ajoutée"
	fi
done

# ------------------------------------------------- 4. socket Podman rootful --
step "socket Podman rootful, groupe podman"
groupadd -f podman
install -d -m 0755 /etc/systemd/system/podman.socket.d
printf '[Socket]\nSocketGroup=podman\nSocketMode=0660\n' \
	> /etc/systemd/system/podman.socket.d/group.conf
# Piège 1 de docs/setup-poste.md : /usr/lib/tmpfiles.d/podman.conf recrée
# /run/podman en 0700 root:root à chaque démarrage. Le socket peut être
# root:podman 0660, le répertoire reste infranchissable. La surcharge du même
# nom dans /etc/tmpfiles.d/ prime.
printf 'D! /run/podman 0750 root podman\n' > /etc/tmpfiles.d/podman.conf
systemd-tmpfiles --create /etc/tmpfiles.d/podman.conf >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable --now podman.socket nftables >/dev/null 2>&1
# Le répertoire peut dater d'avant la surcharge : on le remet d'aplomb.
chgrp podman /run/podman 2>/dev/null || true
chmod 0750 /run/podman 2>/dev/null || true
ok "podman.socket actif, /run/podman $(stat -c '%a %U:%G' /run/podman)"

# ------------------------------------------------ 5. utilisateur du service --
step "utilisateur système $SVC_USER"
if id "$SVC_USER" >/dev/null 2>&1; then
	ok "$SVC_USER existe déjà"
else
	useradd --system --home-dir "$PREFIX/var/home" --create-home \
		--shell /usr/sbin/nologin "$SVC_USER"
	ok "$SVC_USER créé (sans shell)"
fi
usermod -aG podman "$SVC_USER"
ok "$SVC_USER dans le groupe podman"

# ---------------------------------------------------- 6. arborescence ------
step "arborescence"
install -d -m 0755 "$PREFIX" "$PREFIX/releases" "$PREFIX/src"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX/volumes" "$PREFIX/var" "$PREFIX/var/home"
# Groupe `codespace` et 0750 : le portail doit **traverser** ce répertoire pour
# lire /etc/codespace/github-app.pem. `env` lui, est lu par systemd (en root)
# avant le démarrage, donc un répertoire root:root 0750 suffisait jusqu'à
# l'arrivée de la GitHub App — et la clé était alors illisible avec un simple
# EACCES. Mesuré sur la VM le 2026-09-17.
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
install -d -m 0755 /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true
ok "$PREFIX/{app,releases,src,volumes,var} et $ETC"

# ------------------------------------------------------- 7. br_netfilter ----
step "br_netfilter persistant"
# Sans lui, la règle ICC en famille inet est silencieusement inopérante et
# deux étudiants se parlent sur le pont (infra/nft/codespace.nft).
printf 'br_netfilter\n' > /etc/modules-load.d/codespace.conf
printf 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\n' \
	> /etc/sysctl.d/99-codespace-bridge.conf
modprobe br_netfilter
sysctl -qw net.bridge.bridge-nf-call-iptables=1
sysctl -qw net.bridge.bridge-nf-call-ip6tables=1
ok "br_netfilter chargé, call-iptables et call-ip6tables à 1"

# ----------------------------------------------------- 8. /etc/codespace/env -
step "$ETC/env"
if [ -f "$ETC/env" ]; then
	ok "présent : conservé tel quel (il porte les secrets)"
else
	# 48 caractères tirés de /dev/urandom. base64 puis filtrage : rien de ce
	# qui suit ne doit pouvoir être coupé par le lecteur d'EnvironmentFile.
	rand48() { tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48; }
	umask 027
	cat > "$ETC/env" <<ENVEOF
# heig-codespace — configuration de production. Écrit une fois par
# deploy/bootstrap.sh ; jamais réécrit. Porte trois secrets.
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
LOG_LEVEL=info
PUBLIC_URL=https://${DOMAIN}
DATABASE_PATH=${PREFIX}/var/codespace.sqlite

# --- moteur de conteneurs ---------------------------------------------------
PODMAN_URL=${PODMAN_SOCK}
CODESPACE_NETWORK=codespace
CODESPACE_GATEWAY=10.77.0.254
CODESPACE_GIT_PORT=9418
VOLUMES_ROOT=${PREFIX}/volumes
SECCOMP_PROFILE=${PREFIX}/src/infra/seccomp/codespace.json
CODESPACE_IMAGE=codespace/c-dev:4.137.0
CODESPACE_MEMORY=1536m
CODESPACE_CPUS=1
CODESPACE_PIDS_LIMIT=256

# --- cycle de vie des sessions ----------------------------------------------
SESSION_GRACE_MS=600000
SESSION_GC_INTERVAL_MS=60000
# Les instantanés du dépôt fantôme sont pris par codespace-shadow.timer, en
# root (analyse.md 3.3, docs/v1.md D-V1-1). Le temporisateur interne du
# portail est donc repoussé à 24 h pour qu'il n'y ait qu'un seul écrivain ;
# l'instantané de fermeture de session, lui, reste en place.
SHADOW_INTERVAL_MS=86400000
SESSION_HEALTH_TIMEOUT_MS=30000

# --- OIDC -------------------------------------------------------------------
# Vide = aucune route /auth/* n'est enregistrée (404) : cette VM n'a pas encore
# de fournisseur d'identité, les étudiants arrivent par le jeton de lancement
# de classroom. Poser l'émetteur Switch edu-ID rétablit la connexion autonome.
OIDC_ISSUER=
OIDC_CLIENT_ID=codespace-portal
OIDC_CLIENT_SECRET=
OIDC_ROLES_CLAIM=codespace_roles
OIDC_TEACHER_ROLE=teacher
COOKIE_SECRET=$(rand48)
SESSION_TTL_HOURS=12

# --- forge ------------------------------------------------------------------
# GitHub par App, la MÊME que heig-classroom, mêmes noms de variables. Les
# dépôts des étudiants sont PRIVÉS : sans App, ni l'amorçage de l'espace de
# travail ni le relais ne fonctionnent, et la session est refusée avec une
# cause nommée plutôt qu'ouverte sur un répertoire vide.
# L'identifiant se recopie depuis le .env.prod de classroom ; la clé PEM se
# copie de droplet à droplet sans toucher le disque du poste, voir
# docs/deploy.md § 5.
FORGE_KIND=github
FORGE_URL=https://github.com
FORGE_TOKEN=
FORGE_USER=heig-tin-info
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=${ETC}/github-app.pem

# --- intégration heig-classroom ---------------------------------------------
# Le même secret, mot pour mot, doit être posé côté classroom.
CODESPACE_LAUNCH_SECRET=$(rand48)
CLASSROOM_URL=${CLASSROOM}
CODESPACE_DEFAULT_IMAGE=codespace/c-dev:4.137.0

# --- SEB --------------------------------------------------------------------
SEB_VERIFIER=real
SEB_PUBLIC_ORIGIN=https://${DOMAIN}
# À compléter avec les hôtes de Switch edu-ID le jour où l'IdP est branché,
# sans quoi la page de connexion serait bloquée par le filtre d'URL de SEB.
SEB_EXTRA_ALLOWED_HOSTS=
EXAM_COOKIE_SECRET=$(rand48)
EXAM_COOKIE_MAX_AGE_MS=14400000

# TRUST_PROXY est un réglage de développement ; loadConfig() refuse de
# démarrer avec en production. Conséquence derrière Caddy : request.ip vaut
# 127.0.0.1. Voir docs/deploy.md, « adresse du client ».
TRUST_PROXY=
ENVEOF
	umask 022
	ok "écrit (secrets tirés de /dev/urandom)"
fi
chown root:"$SVC_USER" "$ETC/env"
chmod 0640 "$ETC/env"
ok "$ETC/env en $(stat -c '%a %U:%G' "$ETC/env")"

# Un fichier écrit avant que la GitHub App n'entre dans la recette n'a pas les
# deux clés. Elles ne portent aucun secret : on les ajoute, sans rien écraser.
for pair in "GITHUB_APP_ID=" "GITHUB_APP_PRIVATE_KEY_PATH=$ETC/github-app.pem"; do
	key="${pair%%=*}"
	if grep -q "^${key}=" "$ETC/env"; then
		ok "$key déjà dans $ETC/env"
	else
		printf '%s\n' "$pair" >> "$ETC/env"
		ok "$key ajouté à $ETC/env (à compléter, voir docs/deploy.md § 5)"
	fi
done

# ------------------------------------------- 8bis. clé privée de la GitHub App
# Le fichier ne peut pas être produit ici : il vient du droplet de classroom,
# c'est la même App. Ce script ne fait que vérifier sa présence et ses droits,
# et dire quoi faire s'il manque. La procédure de copie, sans passer par le
# disque du poste, est dans docs/deploy.md § 5.
step "clé privée de la GitHub App"
PEM="$ETC/github-app.pem"
if [ -f "$PEM" ]; then
	chown root:"$SVC_USER" "$PEM"
	chmod 0640 "$PEM"
	ok "$PEM en $(stat -c '%a %U:%G' "$PEM")"
	if grep -q '^GITHUB_APP_ID=.\+' "$ETC/env"; then
		ok "GITHUB_APP_ID renseigné"
	else
		info "GITHUB_APP_ID vide dans $ETC/env : la forge reste non configurée"
	fi
else
	info "$PEM absent : seuls les dépôts publics seront accessibles (docs/deploy.md § 5)"
	info "  ssh root@<classroom> cat /opt/heig-classroom/secrets/heig-classroom.private-key.pem \\"
	info "    | ssh root@<vm> 'cat > $PEM && chown root:$SVC_USER $PEM && chmod 0640 $PEM'"
fi

# --------------------------------------------------------- 9. unités systemd -
step "unités systemd"

cat > /etc/systemd/system/codespace-net.service <<UNIT
[Unit]
Description=heig-codespace — réseau clos, ancrage du pont, table nftables
Documentation=file://${PREFIX}/src/infra/net/README.md
# Ni le réseau Podman, ni le pont cs0, ni la table nft ne survivent à un
# redémarrage : setup.sh est le mécanisme normal, rejoué à chaque démarrage.
Requires=podman.socket
After=podman.socket network-online.target
Before=codespace.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${PREFIX}/src/infra/net/setup.sh
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/codespace.service <<UNIT
[Unit]
Description=heig-codespace — portail d'environnements de développement
Documentation=file://${PREFIX}/src/deploy/bootstrap.sh
Requires=codespace-net.service podman.socket
After=codespace-net.service podman.socket

[Service]
Type=simple
User=${SVC_USER}
Group=${SVC_USER}
SupplementaryGroups=podman
WorkingDirectory=${PREFIX}/app
EnvironmentFile=${ETC}/env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30

# Durcissement : le portail est le composant privilégié de l'hôte (il tient le
# socket Podman rootful) ; on lui retire tout ce dont il n'a pas besoin.
# MemoryDenyWriteExecute est volontairement absent : il casserait le JIT de V8.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${PREFIX}/volumes ${PREFIX}/var
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
LockPersonality=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
# UMask reste à 0022, et c'est une décision. `work/` est créé par le portail
# puis rechown par Podman (`:U`) vers la plage d'UID du conteneur, **modes
# conservés** (docs/v1.md D-V1-1) : en 0750 le portail ne pourrait plus entrer
# dans l'arbre de travail qu'il vient de créer, et son instantané de fermeture
# de session échouerait sur « must be run in a work tree ». Mesuré ici.
# L'arborescence au-dessus est en 0750 codespace:codespace, donc aucun autre
# utilisateur de l'hôte ne traverse.
UMask=0022

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/codespace-shadow.service <<UNIT
[Unit]
Description=heig-codespace — instantané des dépôts fantômes (root)
Documentation=file://${PREFIX}/src/deploy/shadow-snapshot.sh

[Service]
Type=oneshot
ExecStart=${PREFIX}/src/deploy/shadow-snapshot.sh
Nice=10
IOSchedulingClass=idle
UNIT

cat > /etc/systemd/system/codespace-shadow.timer <<UNIT
[Unit]
Description=heig-codespace — instantané des dépôts fantômes toutes les 3 min

[Timer]
OnBootSec=3min
OnUnitActiveSec=3min
AccuracySec=15s
Unit=codespace-shadow.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable codespace-net.service codespace.service >/dev/null
# `enable` seul ne poserait le temporisateur qu'au prochain démarrage.
systemctl enable --now codespace-shadow.timer >/dev/null
ok "codespace.service, codespace-net.service, codespace-shadow.timer ($(systemctl is-active codespace-shadow.timer))"

# ------------------------------------------------------------- 10. Caddy ----
step "Caddy"
install -m 0644 "$SRC_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
# Le domaine est le seul réglage variable du fichier.
sed -i "s|@DOMAIN@|${DOMAIN}|g" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload-or-restart caddy
ok "/etc/caddy/Caddyfile validé, caddy rechargé ($DOMAIN)"

# ------------------------------------------- 11. réseau clos + ancrage + nft -
step "réseau clos codespace"
systemctl restart codespace-net.service
systemctl --no-pager --lines=0 status codespace-net.service >/dev/null
ok "codespace-net.service : $(systemctl show -p SubState --value codespace-net.service)"

step "bilan"
printf '  le portail n%s'"'"'est PAS déployé par ce script : lancer deploy/push.sh\n' ""
printf '  secret de lancement à recopier côté classroom : %s/env, clé CODESPACE_LAUNCH_SECRET\n' "$ETC"
