#!/usr/bin/env bash
#
# heig-codespace — bringing a fresh VM into shape, as root, IDEMPOTENT.
#
#   rsync -a --rsync-path='mkdir -p /srv/codespace/src && rsync' \
#     apps/codespace/deploy apps/codespace/infra apps/codespace/images \
#     root@<vm>:/srv/codespace/src/
#   ssh root@<vm> /srv/codespace/src/deploy/bootstrap.sh
#
# or, from the workstation, in a single command:  deploy/push.sh --bootstrap
#
# Replayable without side effects: nothing that holds a secret is overwritten
# (/etc/codespace/env is written only when it does not exist), nothing is added
# twice (subuid, fstab), and the units are rewritten identically.
#
# This script does the following, and nothing else:
#   1. 2 GB swap                     (3.7 GB of RAM, a `podman build` just fits)
#   2. packages                      (podman 5.7, caddy, nftables, node 22)
#   3. `containers` range            (what makes `--userns=auto` possible)
#   4. rootful Podman socket         (the two traps of docs/setup-poste.md)
#   5. codespace system user
#   6. /srv/codespace tree           and /etc/codespace
#   7. persistent br_netfilter       (without it the ICC rule is inoperative)
#  7bis. AppArmor profile `codespace` (what makes gdb work again, see
#                                     infra/apparmor/codespace)
#   8. /etc/codespace/env            (secrets drawn from /dev/urandom, once only)
#  8bis. GitHub App private key      (checked and set right, never created)
#   9. systemd units                 (portal, network, root shadow repository)
#  10. Caddy                         (Let's Encrypt TLS, proxy to 127.0.0.1:3100)
#  11. infra/net/setup.sh            (codespace network, anchor, nft table)
#
# It does NOT deploy the application: that is deploy/push.sh.
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

[ "$(id -u)" -eq 0 ] || { echo "bootstrap.sh must run as root" >&2; exit 1; }
[ -x "$SRC_ROOT/infra/net/setup.sh" ] || {
	echo "infra/ missing from $SRC_ROOT: rsync deploy/ infra/ images/ first" >&2
	exit 1
}

# --------------------------------------------------------------- 1. swap ----
step "2 GB swap"
if swapon --show=NAME --noheadings | grep -q .; then
	ok "swap already active: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
else
	if [ ! -f /swapfile ]; then
		# fallocate is enough on ext4; dd would only be slower for nothing.
		fallocate -l 2G /swapfile
		chmod 600 /swapfile
		mkswap -q /swapfile >/dev/null
	fi
	swapon /swapfile
	ok "2 GB swap enabled"
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
# 3.7 GB without swap: the `podman build` of the 1.5 GB image and Node tread on
# each other. Swap is a safety net, not a place to live: we go there last.
printf 'vm.swappiness = 10\n' > /etc/sysctl.d/99-codespace-swap.conf
sysctl -q --system >/dev/null 2>&1 || true
ok "/etc/fstab and vm.swappiness=10"

# ----------------------------------------------------------- 2. packages ----
step "packages"
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
	ok "installed: ${MISSING[*]}"
else
	ok "all present"
fi
# Node 22: the Ubuntu 26.04 package (22.x), not NodeSource. Rationale in
# docs/deploy.md; the real constraint is better-sqlite3's ABI, which is the
# same between any two Node 22.
info "node $(node --version), podman $(podman --version | awk '{print $3}'), caddy $(caddy version | head -1)"

# ------------------------------------------- 3. containers range (userns) ----
step "subordinate UID range 'containers' (--userns=auto)"
for f in /etc/subuid /etc/subgid; do
	if grep -q '^containers:' "$f"; then
		ok "$f: containers line already present"
	else
		echo "containers:2147483647:2147483648" >> "$f"
		ok "$f: containers line added"
	fi
done

# ------------------------------------------------- 4. rootful Podman socket --
step "rootful Podman socket, podman group"
groupadd -f podman
install -d -m 0755 /etc/systemd/system/podman.socket.d
printf '[Socket]\nSocketGroup=podman\nSocketMode=0660\n' \
	> /etc/systemd/system/podman.socket.d/group.conf
# Trap 1 of docs/setup-poste.md: /usr/lib/tmpfiles.d/podman.conf recreates
# /run/podman as 0700 root:root at every boot. The socket may be root:podman
# 0660, the directory stays impassable. The override of the same name in
# /etc/tmpfiles.d/ wins.
printf 'D! /run/podman 0750 root podman\n' > /etc/tmpfiles.d/podman.conf
systemd-tmpfiles --create /etc/tmpfiles.d/podman.conf >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable --now podman.socket nftables >/dev/null 2>&1
# The directory may predate the override: we set it right again.
chgrp podman /run/podman 2>/dev/null || true
chmod 0750 /run/podman 2>/dev/null || true
ok "podman.socket active, /run/podman $(stat -c '%a %U:%G' /run/podman)"

# ------------------------------------------------------ 5. the service user --
step "system user $SVC_USER"
if id "$SVC_USER" >/dev/null 2>&1; then
	ok "$SVC_USER already exists"
else
	useradd --system --home-dir "$PREFIX/var/home" --create-home \
		--shell /usr/sbin/nologin "$SVC_USER"
	ok "$SVC_USER created (no shell)"
fi
usermod -aG podman "$SVC_USER"
ok "$SVC_USER in the podman group"

# -------------------------------------------------- 6. directory tree ------
step "directory tree"
install -d -m 0755 "$PREFIX" "$PREFIX/releases" "$PREFIX/src"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX/volumes" "$PREFIX/var" "$PREFIX/var/home"
# Group `codespace` and 0750: the portal must **traverse** this directory to
# read /etc/codespace/github-app.pem. `env` itself is read by systemd (as root)
# before start-up, so a root:root 0750 directory was enough until the GitHub
# App arrived — and the key was then unreadable with a plain EACCES. Measured
# on the VM on 2026-09-17.
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
install -d -m 0755 /var/log/caddy
chown caddy:caddy /var/log/caddy 2>/dev/null || true
ok "$PREFIX/{app,releases,src,volumes,var} and $ETC"

# ------------------------------------------------------- 7. br_netfilter ----
step "persistent br_netfilter"
# Without it the ICC rule in the inet family is silently inoperative and two
# students can talk to each other over the bridge (infra/nft/codespace.nft).
printf 'br_netfilter\n' > /etc/modules-load.d/codespace.conf
printf 'net.bridge.bridge-nf-call-iptables = 1\nnet.bridge.bridge-nf-call-ip6tables = 1\n' \
	> /etc/sysctl.d/99-codespace-bridge.conf
modprobe br_netfilter
sysctl -qw net.bridge.bridge-nf-call-iptables=1
sysctl -qw net.bridge.bridge-nf-call-ip6tables=1
ok "br_netfilter loaded, call-iptables and call-ip6tables at 1"

# ------------------------------------------------- 7bis. AppArmor profile ----
# Podman's built-in containers-default-<version> denies ptrace towards the
# stacked label `<profile>//&crun` that kernel 7.0.0-31 gives the traced
# process, and gdb stops working inside the student containers. The project
# profile keeps every deny rule of the built-in one and only widens the
# ptrace/signal peers. Rationale and audit line: infra/apparmor/codespace.
step "AppArmor profile codespace"
AA_SRC="$SRC_ROOT/infra/apparmor/codespace"
AA_DST=/etc/apparmor.d/codespace
# Value written into $ETC/env below; emptied when the profile could not be
# loaded, because `podman run` refuses a profile name the kernel does not know.
AA_PROFILE=codespace
if [ ! -f "$AA_SRC" ]; then
	AA_PROFILE=
	info "$AA_SRC missing: rsync infra/ again (deploy/push.sh does it)"
elif ! command -v apparmor_parser >/dev/null 2>&1; then
	AA_PROFILE=
	# Not an error: a kernel without AppArmor is a valid host for the portal,
	# it simply loses the hardening that this profile adds.
	info "WARNING: apparmor_parser absent — the profile is NOT loaded."
	info "  The containers will run under Podman's built-in profile, or none,"
	info "  and gdb may be denied ptrace. Set CODESPACE_APPARMOR_PROFILE= (empty)"
	info "  in $ETC/env on such a host, otherwise podman run will refuse an"
	info "  unknown profile name. This script writes it empty for you."
else
	install -m 0644 "$AA_SRC" "$AA_DST"
	# -r: replace, so a reload is idempotent and a running container keeps the
	# profile it started with.
	if apparmor_parser -r "$AA_DST"; then
		ok "$AA_DST loaded"
	else
		echo "  FAIL  apparmor_parser -r $AA_DST refused the profile" >&2
		exit 1
	fi
fi

# ----------------------------------------------------- 8. /etc/codespace/env -
step "$ETC/env"
if [ -f "$ETC/env" ]; then
	ok "present: kept as is (it holds the secrets)"
else
	# 48 characters drawn from /dev/urandom. base64 then filtering: nothing
	# that follows may be cut short by the EnvironmentFile reader.
	rand48() { tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 48; }
	umask 027
	cat > "$ETC/env" <<ENVEOF
# heig-codespace — production configuration. Written once by
# deploy/bootstrap.sh; never rewritten. Holds three secrets.
NODE_ENV=production
HOST=127.0.0.1
PORT=3100
LOG_LEVEL=info
PUBLIC_URL=https://${DOMAIN}
DATABASE_PATH=${PREFIX}/var/codespace.sqlite

# --- container engine -------------------------------------------------------
PODMAN_URL=${PODMAN_SOCK}
CODESPACE_NETWORK=codespace
CODESPACE_GATEWAY=10.77.0.254
CODESPACE_GIT_PORT=9418
VOLUMES_ROOT=${PREFIX}/volumes
SECCOMP_PROFILE=${PREFIX}/src/infra/seccomp/codespace.json
# Name of a profile loaded in the kernel, not a path. Source:
# ${PREFIX}/src/infra/apparmor/codespace, installed into /etc/apparmor.d/ by
# bootstrap.sh and reloaded by every push.sh. Empty = no --security-opt
# apparmor flag, for a host without AppArmor.
CODESPACE_APPARMOR_PROFILE=${AA_PROFILE}
CODESPACE_IMAGE=codespace/c-dev:4.137.0
CODESPACE_MEMORY=1536m
CODESPACE_CPUS=1
CODESPACE_PIDS_LIMIT=256

# --- session lifecycle ------------------------------------------------------
SESSION_GRACE_MS=600000
SESSION_GC_INTERVAL_MS=60000
# Shadow repository snapshots are taken by codespace-shadow.timer, as root
# (analyse.md 3.3, docs/v1.md D-V1-1). The portal's own timer is therefore
# pushed back to 24 h so that there is a single writer; the session-close
# snapshot itself stays in place.
SHADOW_INTERVAL_MS=86400000
SESSION_HEALTH_TIMEOUT_MS=30000

# --- OIDC -------------------------------------------------------------------
# Empty = no /auth/* route is registered (404): this VM has no identity
# provider yet, students arrive through the classroom launch token. Setting the
# Switch edu-ID issuer restores standalone sign-in.
OIDC_ISSUER=
OIDC_CLIENT_ID=codespace-portal
OIDC_CLIENT_SECRET=
OIDC_ROLES_CLAIM=codespace_roles
OIDC_TEACHER_ROLE=teacher
COOKIE_SECRET=$(rand48)
SESSION_TTL_HOURS=12

# --- forge ------------------------------------------------------------------
# GitHub through an App, the SAME one as heig-classroom, same variable names.
# Student repositories are PRIVATE: without the App neither the workspace
# bootstrap nor the relay works, and the session is refused with a named cause
# rather than opened on an empty directory.
# The id is copied from classroom's .env.prod; the PEM key is copied from
# droplet to droplet without touching the workstation's disk, see
# docs/deploy.md § 5.
FORGE_KIND=github
FORGE_URL=https://github.com
FORGE_TOKEN=
FORGE_USER=heig-tin-info
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=${ETC}/github-app.pem

# --- heig-classroom integration ---------------------------------------------
# The very same secret, word for word, must be set on the classroom side.
CODESPACE_LAUNCH_SECRET=$(rand48)
CLASSROOM_URL=${CLASSROOM}
CODESPACE_DEFAULT_IMAGE=codespace/c-dev:4.137.0

# --- SEB --------------------------------------------------------------------
SEB_VERIFIER=real
SEB_PUBLIC_ORIGIN=https://${DOMAIN}
# Hosts SEB's URL filter must let through IN ADDITION to classroom (the host
# of the startURL, added by buildSebConfig) and this portal (added from
# SEB_PUBLIC_ORIGIN). In practice: the identity provider, because SEB opens
# the startURL cold and classroom immediately bounces the student to its
# sign-in page — a page SEB would block, with no way out of kiosk mode.
#
# EMPTY IS CORRECT TODAY, and it is a statement, not an omission: in the
# transitional phase classroom's OIDC issuer is its own Keycloak, mounted
# under https://${CLASSROOM#https://}/kc/realms/... (.env.prod.example,
# OIDC_ISSUER). Same host as classroom, therefore already allowed.
#
# THE DAY THE IdP MOVES to Switch edu-ID, this must list login.eduid.ch plus
# every host the discovery document and the sign-in flow actually redirect to
# (SWITCH AAI hosts among them). The procedure to find them is in
# docs/integration-classroom.md § 5. Comma-separated, host[:port], no scheme:
#   SEB_EXTRA_ALLOWED_HOSTS=login.eduid.ch,eduid.ch
SEB_EXTRA_ALLOWED_HOSTS=
EXAM_COOKIE_SECRET=$(rand48)
EXAM_COOKIE_MAX_AGE_MS=14400000

# --- the client address behind Caddy (docs/deploy.md § 6) --------------------
# TRUSTED_PROXY_IPS is what makes request.ip the STUDENT's address instead of
# Caddy's. The exam cookie is bound to it (analyse.md D5): with 127.0.0.1 on
# both sides the "same workstation" check compares 127.0.0.1 with 127.0.0.1
# for everyone and never fires. Caddy's reverse_proxy appends X-Forwarded-For
# by default, so the only hop to declare is the loopback it dials from.
# loadConfig() refuses to start in production when this is empty.
TRUSTED_PROXY_IPS=127.0.0.1
# TRUST_PROXY is the development boolean — it would let ANYONE set their own
# address through X-Forwarded-For. loadConfig() refuses it in production.
TRUST_PROXY=
ENVEOF
	umask 022
	ok "written (secrets drawn from /dev/urandom)"
fi
chown root:"$SVC_USER" "$ETC/env"
chmod 0640 "$ETC/env"
ok "$ETC/env is $(stat -c '%a %U:%G' "$ETC/env")"

# A file written before the GitHub App — or before the AppArmor profile, or
# before the 2026-09-18 audit — does not have these keys. Without
# TRUSTED_PROXY_IPS the portal now REFUSES TO START in production. None of them
# holds a secret: we add them, overwriting nothing.
for pair in \
	"GITHUB_APP_ID=" \
	"GITHUB_APP_PRIVATE_KEY_PATH=$ETC/github-app.pem" \
	"CODESPACE_APPARMOR_PROFILE=$AA_PROFILE" \
	"TRUSTED_PROXY_IPS=127.0.0.1"; do
	key="${pair%%=*}"
	if grep -q "^${key}=" "$ETC/env"; then
		ok "$key already in $ETC/env"
	else
		printf '%s\n' "$pair" >> "$ETC/env"
		ok "$key added to $ETC/env (value '${pair#*=}'; GitHub App: docs/deploy.md § 5; proxy: § 6)"
	fi
done

# ------------------------------------------------ 8bis. GitHub App private key
# The file cannot be produced here: it comes from the classroom droplet, it is
# the same App. This script only checks that it is present with the right
# permissions, and says what to do if it is missing. The copy procedure, which
# never goes through the workstation's disk, is in docs/deploy.md § 5.
step "GitHub App private key"
PEM="$ETC/github-app.pem"
if [ -f "$PEM" ]; then
	chown root:"$SVC_USER" "$PEM"
	chmod 0640 "$PEM"
	ok "$PEM is $(stat -c '%a %U:%G' "$PEM")"
	if grep -q '^GITHUB_APP_ID=.\+' "$ETC/env"; then
		ok "GITHUB_APP_ID is set"
	else
		info "GITHUB_APP_ID empty in $ETC/env: the forge stays unconfigured"
	fi
else
	info "$PEM missing: only public repositories will be reachable (docs/deploy.md § 5)"
	info "  ssh root@<classroom> cat /opt/heig-classroom/secrets/heig-classroom.private-key.pem \\"
	info "    | ssh root@<vm> 'cat > $PEM && chown root:$SVC_USER $PEM && chmod 0640 $PEM'"
fi

# ---------------------------------------------------------- 9. systemd units -
step "systemd units"

cat > /etc/systemd/system/codespace-net.service <<UNIT
[Unit]
Description=heig-codespace — closed network, bridge anchor, nftables table
Documentation=file://${PREFIX}/src/infra/net/README.md
# Neither the Podman network, nor the cs0 bridge, nor the nft table survives a
# reboot: setup.sh is the normal mechanism, replayed at every boot.
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
Description=heig-codespace — development environment portal
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

# Hardening: the portal is the host's privileged component (it holds the
# rootful Podman socket); we take away everything it does not need.
# MemoryDenyWriteExecute is deliberately absent: it would break V8's JIT.
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
# UMask stays at 0022, and that is a decision. 'work/' is created by the portal
# then chowned by Podman (':U') to the container's UID range, **modes
# preserved** (docs/v1.md D-V1-1): at 0750 the portal could no longer enter the
# work tree it has just created, and its session-close snapshot would fail on
# "must be run in a work tree". Measured here.
# The tree above is 0750 codespace:codespace, so no other user of the host
# traverses it.
UMask=0022

[Install]
WantedBy=multi-user.target
UNIT

cat > /etc/systemd/system/codespace-shadow.service <<UNIT
[Unit]
Description=heig-codespace — shadow repository snapshot (root)
Documentation=file://${PREFIX}/src/deploy/shadow-snapshot.sh

[Service]
Type=oneshot
ExecStart=${PREFIX}/src/deploy/shadow-snapshot.sh
Nice=10
IOSchedulingClass=idle
UNIT

cat > /etc/systemd/system/codespace-shadow.timer <<UNIT
[Unit]
Description=heig-codespace — shadow repository snapshot every 3 min

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
# `enable` alone would only arm the timer at the next boot.
systemctl enable --now codespace-shadow.timer >/dev/null
ok "codespace.service, codespace-net.service, codespace-shadow.timer ($(systemctl is-active codespace-shadow.timer))"

# ------------------------------------------------------------- 10. Caddy ----
step "Caddy"
install -m 0644 "$SRC_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
# The domain is the file's only variable setting.
sed -i "s|@DOMAIN@|${DOMAIN}|g" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload-or-restart caddy
ok "/etc/caddy/Caddyfile validated, caddy reloaded ($DOMAIN)"

# ----------------------------------------- 11. closed network + anchor + nft -
step "closed codespace network"
systemctl restart codespace-net.service
systemctl --no-pager --lines=0 status codespace-net.service >/dev/null
ok "codespace-net.service : $(systemctl show -p SubState --value codespace-net.service)"

step "summary"
printf '  the portal is NOT deployed by this script: run deploy/push.sh\n'
printf '  launch secret to copy on the classroom side: %s/env, key CODESPACE_LAUNCH_SECRET\n' "$ETC"
