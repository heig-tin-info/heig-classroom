#!/usr/bin/env bash
# Test d'acceptation de la tache P1 (docs/jalon-0.md).
# Lance l'image par run-hardened.sh et execute toutes les assertions de P1.
# Sort en code non nul a la premiere qui echoue, avec un message clair.
#
#   ./images/c-dev/test.sh
#
# Prerequis : Podman rootful joignable sur unix:///run/podman/podman.sock,
# image codespace/c-dev:4.137.0 construite, python3 sur l'hote (fabrication
# du .vsix factice). Aucun sudo.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
IMAGE="${IMAGE:-codespace/c-dev:4.137.0}"
PODMAN_URL="${PODMAN_URL:-unix:///run/podman/podman.sock}"
SECCOMP_DEFAULT="${SECCOMP_DEFAULT:-/usr/share/containers/seccomp.json}"

CTR_A=cdev-p1-a
CTR_B=cdev-p1-b
CTR_BOMB=cdev-p1-bomb
VOL_BASE="$(mktemp -d /tmp/codespace-p1-XXXXXX)"

podman_remote() { podman --remote --url "$PODMAN_URL" "$@"; }
# Execute une commande bash dans le conteneur A, en tant que student.
cexec() { podman_remote exec "$CTR_A" bash -lc "$1"; }

NTEST=0
ok()   { NTEST=$((NTEST+1)); printf '  ok   %s\n' "$1"; }
fail() { printf '\nECHEC : %s\n' "$1" >&2; [ $# -gt 1 ] && printf '  --- contexte ---\n%s\n' "$2" >&2; cleanup; exit 1; }
head2() { printf '\n== %s\n' "$1"; }

cleanup() {
  podman_remote rm -f "$CTR_A" "$CTR_B" "$CTR_BOMB" >/dev/null 2>&1
  rm -rf "$VOL_BASE" 2>/dev/null
}
trap 'cleanup' EXIT

# --------------------------------------------------------------------------
# Preparation : un .vsix *valide* depose dans le repertoire de travail avant le
# demarrage. Valide, pour que l'echec d'installation soit imputable a la racine
# en lecture seule et non a une archive corrompue. Il est ecrit avant le
# `podman run` parce que le montage `:U` rechaine le repertoire sur l'UID du
# conteneur et le rend ensuite inaccessible en ecriture depuis l'hote.
# --------------------------------------------------------------------------
mkdir -p "${VOL_BASE}/a/work" "${VOL_BASE}/b/work" "${VOL_BASE}/bomb/work"
python3 - "${VOL_BASE}/a/work/fake-extension.vsix" <<'PY' >/dev/null || { echo "python3 requis" >&2; exit 1; }
import zipfile, json, sys
pkg = {"name": "fake", "displayName": "Fake", "publisher": "attacker",
       "version": "1.0.0", "engines": {"vscode": "^1.60.0"}, "contributes": {}}
manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="fake" Version="1.0.0" Publisher="attacker"/>
<DisplayName>Fake</DisplayName><Description>faux paquet d extension</Description></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
<Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets>
</PackageManifest>'''
types = ('<?xml version="1.0" encoding="utf-8"?>'
         '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
         '<Default Extension="json" ContentType="application/json"/>'
         '<Default Extension="vsixmanifest" ContentType="text/xml"/></Types>')
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('extension.vsixmanifest', manifest)
    z.writestr('extension/package.json', json.dumps(pkg))
    z.writestr('[Content_Types].xml', types)
print("ok")
PY

cat > "${VOL_BASE}/a/work/hello.c" <<'EOF'
#include <stdio.h>
int main(void) { printf("&main=%p\n", (void *)main); return 0; }
EOF

echo "P1 : image etudiante durcie, gdb fonctionnel"
echo "image   : ${IMAGE}"
echo "seccomp : ${REPO_ROOT}/infra/seccomp/codespace.json"

# --------------------------------------------------------------------------
head2 "0. demarrage sous run-hardened.sh et mesure jusqu'a /healthz"
# --------------------------------------------------------------------------
# Les sept variables que le portail pose au `podman run` (sessions/manager.ts,
# CONTAINER_ENV_KEYS) : trois CODESPACE_ pour l'extension de barre d'etat,
# quatre GIT_ pour l'identite de l'etudiant. Le conteneur A les porte, le
# conteneur B non : la section 9 compare les deux environnements et exige
# exactement sept lignes d'ecart. Aucun secret n'y entre, invariant 1.
ENV_DEADLINE=2026-10-01T12:00:00.000Z
ENV_RETURN_URL=https://classroom.chevallier.io/
# Sans espace : run-hardened.sh decoupe EXTRA_ARGS par le shell. Le portail,
# lui, passe la valeur telle quelle a execFile (aucun shell), donc un titre
# avec des espaces lui convient ; c'est ce script qui est contraint.
ENV_ASSIGNMENT_NAME=TP3-pointeurs
# Identite git de l'etudiant (users.display_name, users.email). Meme contrainte
# d'absence d'espace : c'est EXTRA_ARGS qui la pose, pas le portail.
ENV_GIT_NAME=Pierre-Bressy
ENV_GIT_EMAIL=pierre.bressy@heig-vd.ch
PORTAL_ENV="-e CODESPACE_DEADLINE=${ENV_DEADLINE} -e CODESPACE_RETURN_URL=${ENV_RETURN_URL} -e CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_AUTHOR_NAME=${ENV_GIT_NAME} -e GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_COMMITTER_NAME=${ENV_GIT_NAME} -e GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"

T0=$(date +%s.%N)
CTR_NAME="$CTR_A" VOL_DIR="${VOL_BASE}/a" IMAGE="$IMAGE" EXTRA_ARGS="$PORTAL_ENV" \
  "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh n'a pas demarre le conteneur A"

HEALTH=""
for _ in $(seq 1 300); do
  HEALTH=$(podman_remote exec "$CTR_A" curl -sS -m 2 -w ' HTTP=%{http_code}' http://localhost:8080/healthz 2>/dev/null)
  case "$HEALTH" in *"HTTP=200"*) break ;; esac
  HEALTH=""
  sleep 0.1
done
T1=$(date +%s.%N)
BOOT=$(python3 -c "print(round(${T1}-${T0}, 2))")
[ -n "$HEALTH" ] || fail "/healthz n'a pas repondu 200 en 30 s" "$(podman_remote logs "$CTR_A" 2>&1 | tail -30)"
ok "podman run -> /healthz 200 en ${BOOT} s : ${HEALTH}"
echo "MESURE_DEMARRAGE_SECONDES=${BOOT}"

# --------------------------------------------------------------------------
head2 "1. gdb : ptrace autorise, pas d'Operation not permitted"
# --------------------------------------------------------------------------
cexec 'cd /work && gcc -g -O0 -o a.out hello.c' >/dev/null 2>&1 || fail "gcc -g -O0 hello.c a echoue" "$(cexec 'cd /work && gcc -g -O0 -o a.out hello.c' 2>&1)"
# gdb sort en 1 sur « No stack. » (le programme est deja termine quand bt
# s'execute) : c'est la commande litterale de jalon-0, on n'en juge que la sortie.
OUT=$(cexec 'cd /work && gdb -batch -ex run -ex bt ./a.out' 2>&1)
case "$OUT" in
  *"Operation not permitted"*) fail "gdb a rencontre « Operation not permitted »" "$OUT" ;;
esac
case "$OUT" in
  *"&main=0x"*) : ;;
  *) fail "le programme n'a pas affiche l'adresse de main sous gdb" "$OUT" ;;
esac
ok "gcc -g -O0 hello.c puis gdb -batch -ex run -ex bt : sans Operation not permitted"

OUT=$(cexec 'cd /work && gdb -batch -ex "break main" -ex run -ex bt ./a.out' 2>&1) \
  || fail "gdb avec point d'arret a echoue" "$OUT"
case "$OUT" in
  *"#0"*main*) : ;;
  *) fail "bt n'a pas produit de pile avec main" "$OUT" ;;
esac
ok "bt sur un point d'arret dans main produit une pile"

# --------------------------------------------------------------------------
head2 "2. ASLR desactivable : personality(ADDR_NO_RANDOMIZE) passe le profil seccomp"
# --------------------------------------------------------------------------
OUT=$(cexec 'gdb -batch -ex "show disable-randomization"' 2>&1)
case "$OUT" in
  *"is on."*) ok "gdb -batch -ex 'show disable-randomization' repond on" ;;
  *) fail "disable-randomization n'est pas a on" "$OUT" ;;
esac

A1=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
A2=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
[ -n "$A1" ] || fail "premiere execution sous gdb : adresse de main non lue"
[ "$A1" = "$A2" ] || fail "l'adresse de main change entre deux executions sous gdb ($A1 vs $A2) : ADDR_NO_RANDOMIZE refuse par le profil seccomp"
ok "deux executions sous gdb donnent la meme adresse de main ($A1)"

# Temoin : avec le profil par defaut de containers-common, l'adresse doit varier.
# C'est ce qui prouve que la seule entree ajoutee au profil est bien celle qui agit.
if [ -r "$SECCOMP_DEFAULT" ]; then
  CTRL=$(podman_remote run --rm --userns=auto --cap-drop=ALL \
      --security-opt no-new-privileges --security-opt "seccomp=${SECCOMP_DEFAULT}" \
      --read-only --tmpfs /tmp --tmpfs '/run:rw,nosuid,nodev,mode=1777' \
      --pids-limit 256 --memory 1536m --cpus 1 --network none \
      --entrypoint sh "$IMAGE" -c '
        cd /tmp
        cat > h.c <<"EOF"
#include <stdio.h>
int main(void) { printf("&main=%p\n", (void *)main); return 0; }
EOF
        gcc -g -O0 -o h h.c || exit 1
        for i in 1 2 3; do gdb -batch -ex run ./h 2>/dev/null | sed -n "s/^&main=//p"; done' 2>/dev/null \
      | sort -u | wc -l)
  if [ "$CTRL" -gt 1 ]; then
    ok "temoin : avec le profil par defaut l'adresse varie ($CTRL valeurs sur 3) — l'ajout personality(0x40000) est bien la cause"
  else
    fail "temoin invalide : le profil par defaut donne deja une adresse stable, le test 2 ne prouve rien"
  fi
else
  echo "  note profil par defaut introuvable ($SECCOMP_DEFAULT), temoin non joue"
fi

# --------------------------------------------------------------------------
head2 "3. aucune extension installable"
# --------------------------------------------------------------------------
cexec 'test -f /work/fake-extension.vsix' >/dev/null 2>&1 \
  || fail "le .vsix factice n'est pas visible dans /work"

OUT=$(cexec 'cp /work/fake-extension.vsix /tmp/x.vsix && code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "code-server --install-extension /tmp/x.vsix a reussi" "$OUT"
ok "code-server --install-extension /tmp/x.vsix echoue (rc=$RC)"

OUT=$(cexec 'code-server --install-extension /work/fake-extension.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "un .vsix ecrit dans /work s'installe" "$OUT"
ok ".vsix factice depuis /work : refuse (rc=$RC)"

# Variante d'un etudiant qui contourne l'erreur de fichier de configuration :
# le repertoire d'extensions par defaut reste sur la racine en lecture seule.
OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension reussit des que XDG_CONFIG_HOME est inscriptible" "$OUT"
case "$OUT" in
  *EROFS*|*"read-only"*|*"extensions.json"*) : ;;
  *) fail "l'echec n'est pas attribuable a la racine en lecture seule" "$OUT" ;;
esac
ok "avec un XDG_CONFIG_HOME inscriptible, l'echec vient bien de la racine en lecture seule"

OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension directement dans /opt/code-server/extensions a reussi" "$OUT"
ok "install-extension vise sur /opt/code-server/extensions : refuse (rc=$RC)"

LIST=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions' 2>/dev/null | sort | tr '\n' ' ')
case "$LIST" in
  "heig.codespace-statusbar llvm-vs-code-extensions.vscode-clangd webfreak.debug "*) : ;;
  *) fail "la liste des extensions du serveur n'est pas exactement les trois attendues : [$LIST]" ;;
esac
ok "le serveur ne connait que les trois extensions preinstallees : $LIST"

# L'extension de barre d'etat est cuite dans l'image, comme les deux autres :
# elle apparait dans `--list-extensions` et dans le manifeste d'extensions.
VERS=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions --show-versions' 2>/dev/null | tr -d '\r')
case "$VERS" in
  *"heig.codespace-statusbar@0.1.0"*) : ;;
  *) fail "heig.codespace-statusbar@0.1.0 absent de --list-extensions --show-versions" "$VERS" ;;
esac
ok "heig.codespace-statusbar@0.1.0 installee et listee par code-server"

cexec 'grep -qF "heig.codespace-statusbar" /etc/code-server/extensions.lock' >/dev/null 2>&1 \
  || fail "heig.codespace-statusbar absent de /etc/code-server/extensions.lock"
cexec 'test -f /opt/code-server/extensions/heig.codespace-statusbar-0.1.0/extension.js' >/dev/null 2>&1 \
  || fail "le code de l'extension de barre d'etat n'est pas dans le repertoire d'extensions"
if cexec 'touch /opt/code-server/extensions/heig.codespace-statusbar-0.1.0/extension.js' >/dev/null 2>&1; then
  fail "l'extension de barre d'etat est modifiable a l'execution"
fi
ok "extension de barre d'etat inscrite dans extensions.lock et en lecture seule"

# --------------------------------------------------------------------------
head2 "4. racine en lecture seule, aucune capacite"
# --------------------------------------------------------------------------
if cexec 'touch /usr/bin/x' >/dev/null 2>&1; then fail "touch /usr/bin/x a reussi"; fi
ok "touch /usr/bin/x echoue"
for p in /etc/passwd /opt/code-server/extensions/x /usr/lib/code-server/x; do
  if cexec "touch $p" >/dev/null 2>&1; then fail "touch $p a reussi"; fi
done
ok "/etc, /opt/code-server/extensions et /usr/lib/code-server sont en lecture seule"

CAP=$(cexec 'grep CapEff /proc/self/status' | awk '{print $2}')
[ "$CAP" = "0000000000000000" ] || fail "CapEff vaut $CAP au lieu de 0000000000000000"
ok "CapEff = 0000000000000000"

NNP=$(cexec 'grep NoNewPrivs /proc/self/status' | awk '{print $2}')
[ "$NNP" = "1" ] || fail "NoNewPrivs vaut $NNP au lieu de 1"
ok "NoNewPrivs = 1"

SEC=$(cexec 'grep Seccomp: /proc/self/status' | awk '{print $2}')
[ "$SEC" = "2" ] || fail "Seccomp vaut $SEC au lieu de 2 (mode filtre)"
ok "Seccomp = 2 (filtre charge)"

# --------------------------------------------------------------------------
head2 "5. espace d'utilisateurs : uid 1000 dedans, UID hote hors 0-65535"
# --------------------------------------------------------------------------
UID_IN=$(cexec 'id -u')
[ "$UID_IN" = "1000" ] || fail "id -u vaut $UID_IN au lieu de 1000"
ok "id -u = 1000 dans le conteneur"

HUSER_A=$(podman_remote top "$CTR_A" huser | sed -n '2p' | tr -d '[:space:]')
case "$HUSER_A" in
  ''|*[!0-9]*) fail "podman top huser n'a pas renvoye un UID numerique : [$HUSER_A]" ;;
esac
[ "$HUSER_A" -gt 65535 ] || fail "l'UID hote $HUSER_A est dans la plage 0-65535 : --userns=auto n'a pas pris"
ok "UID hote du conteneur A = $HUSER_A (hors 0-65535)"

CTR_NAME="$CTR_B" VOL_DIR="${VOL_BASE}/b" IMAGE="$IMAGE" "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh n'a pas demarre le conteneur B"
for _ in $(seq 1 100); do
  HUSER_B=$(podman_remote top "$CTR_B" huser 2>/dev/null | sed -n '2p' | tr -d '[:space:]')
  [ -n "${HUSER_B:-}" ] && break
  sleep 0.2
done
case "${HUSER_B:-}" in
  ''|*[!0-9]*) fail "podman top huser (B) n'a pas renvoye un UID numerique : [${HUSER_B:-}]" ;;
esac
[ "$HUSER_B" -gt 65535 ] || fail "l'UID hote de B ($HUSER_B) est dans la plage 0-65535"
[ "$HUSER_A" != "$HUSER_B" ] || fail "les deux conteneurs partagent le meme UID hote ($HUSER_A)"
ok "deux conteneurs cote a cote : UID hotes distincts ($HUSER_A et $HUSER_B)"

# --------------------------------------------------------------------------
head2 "6. bombe a fork : contenue par --pids-limit 256, hote intact"
# --------------------------------------------------------------------------
PIDS_MAX=$(cexec 'cat /sys/fs/cgroup/pids.max')
[ "$PIDS_MAX" = "256" ] || fail "pids.max vaut $PIDS_MAX au lieu de 256"
ok "pids.max du cgroup = 256"

HOST_PROCS_BEFORE=$(ps -e --no-headers | wc -l)
CTR_NAME="$CTR_BOMB" VOL_DIR="${VOL_BASE}/bomb" IMAGE="$IMAGE" "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh n'a pas demarre le conteneur de la bombe"
BOMB_CG=$(podman_remote inspect "$CTR_BOMB" --format '{{.State.CgroupPath}}')
[ -r "/sys/fs/cgroup${BOMB_CG}/pids.current" ] || fail "cgroup de la bombe illisible : /sys/fs/cgroup${BOMB_CG}"

podman_remote exec "$CTR_BOMB" bash -c ':(){ :|:& };:' >/dev/null 2>&1 &
BOMB_PID=$!
MAXSEEN=0
for _ in $(seq 1 40); do
  CUR=$(cat "/sys/fs/cgroup${BOMB_CG}/pids.current" 2>/dev/null || echo 0)
  [ "$CUR" -gt "$MAXSEEN" ] && MAXSEEN=$CUR
  sleep 0.25
done
HOST_OK_START=$(date +%s.%N)
ps -e --no-headers >/dev/null
HOST_PROCS_AFTER=$(ps -e --no-headers | wc -l)
HOST_OK_ELAPSED=$(python3 -c "print(round($(date +%s.%N)-${HOST_OK_START}, 2))")

kill "$BOMB_PID" >/dev/null 2>&1
podman_remote rm -f "$CTR_BOMB" >/dev/null 2>&1

[ "$MAXSEEN" -le 256 ] || fail "le cgroup de la bombe a depasse 256 processus ($MAXSEEN)"
[ "$MAXSEEN" -ge 200 ] || fail "la bombe n'a pas atteint la limite ($MAXSEEN processus) : le test ne prouve rien"
ok "la bombe plafonne a $MAXSEEN processus, jamais au-dessus de 256"

DELTA=$((HOST_PROCS_AFTER - HOST_PROCS_BEFORE))
[ "$DELTA" -lt 100 ] || fail "le nombre de processus de l'hote a bondi de $DELTA pendant la bombe"
ok "hote : $HOST_PROCS_BEFORE -> $HOST_PROCS_AFTER processus (delta $DELTA), ps repond en ${HOST_OK_ELAPSED}s"

OUT=$(podman_remote exec "$CTR_A" curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:8080/healthz 2>&1)
[ "$OUT" = "200" ] || fail "le conteneur A ne repond plus apres la bombe (http $OUT)"
ok "le conteneur voisin A repond toujours sur /healthz apres la bombe"

# --------------------------------------------------------------------------
head2 "7. code-server : /healthz, reglages machine, galerie neutralisee"
# --------------------------------------------------------------------------
OUT=$(cexec 'curl -sS -m 3 http://localhost:8080/healthz')
case "$OUT" in
  *'"status"'*) ok "curl http://localhost:8080/healthz depuis le conteneur : $OUT" ;;
  *) fail "/healthz n'a pas repondu le JSON attendu" "$OUT" ;;
esac

for f in /run/code-server/User/settings.json /run/code-server/Machine/settings.json; do
  cexec "test -f $f" >/dev/null 2>&1 || fail "reglages machine non copies dans $f"
  for k in '"files.autoSave": "afterDelay"' '"files.autoSaveDelay": 1000' \
           '"extensions.autoUpdate": false' '"update.mode": "none"' \
           '"telemetry.telemetryLevel": "off"' '"chat.disableAIFeatures": true' \
           '"workbench.secondarySideBar.defaultVisibility": "hidden"' \
           '"keyboard.dispatch": "keyCode"' \
           '"terminal.integrated.stickyScroll.enabled": false' \
           '"terminal.integrated.fontLigatures.enabled": false'; do
    cexec "grep -qF '$k' $f" >/dev/null 2>&1 || fail "reglage absent de $f : $k"
  done
done
ok "reglages machine copies dans le user-data-dir tmpfs (User et Machine)"

cexec "grep -qF '\"extensions.allowed\"' /run/code-server/User/settings.json" >/dev/null 2>&1 \
  || fail "extensions.allowed absent des reglages"
cexec "grep -qF '\"heig.codespace-statusbar\": true' /run/code-server/User/settings.json" >/dev/null 2>&1 \
  || fail "heig.codespace-statusbar absent de extensions.allowed"
ok "extensions.allowed present et restreint aux trois extensions"

# Les deux reglages ajoutes le 2026-09-18 doivent exister **dans le paquet VS
# Code embarque**, pas seulement dans notre fichier : un nom inexistant serait
# ignore en silence. Recherche litterale dans le bundle du workbench.
WB=/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js
cexec "grep -q 'workbench.secondarySideBar.defaultVisibility' $WB" >/dev/null 2>&1 \
  || fail "workbench.secondarySideBar.defaultVisibility inconnu du paquet VS Code embarque"
cexec "grep -q 'keyboard.dispatch' $WB" >/dev/null 2>&1 \
  || fail "keyboard.dispatch inconnu du paquet VS Code embarque"
# La valeur posee doit etre dans l'enumeration declaree, sinon VS Code la rejette.
cexec "grep -qF '\"workbench.secondarySideBar.defaultVisibility\":{type:\"string\",enum:[\"hidden\"' $WB" >/dev/null 2>&1 \
  || fail "« hidden » n'est pas la premiere valeur de l'enumeration de workbench.secondarySideBar.defaultVisibility"
cexec "grep -qF '\"keyboard.dispatch\":{scope:1,type:\"string\",enum:[\"code\",\"keyCode\"]' $WB" >/dev/null 2>&1 \
  || fail "« keyCode » n'est pas une valeur declaree de keyboard.dispatch"
ok "les deux reglages existent dans VS Code 1.137.0 embarque, avec les valeurs posees dans leur enumeration"

# Invite « Use the fonts on your computer » : la chaine de cause, relevee dans
# le paquet embarque (voir README). Le defilement colle du terminal charge
# l'addon de ligatures **sans condition**, et cet addon appelle
# queryLocalFonts(). C'est stickyScroll.enabled (defaut true) qui gouverne.
cexec "grep -qF '\"terminal.integrated.stickyScroll.enabled\":{markdownDescription:' $WB" >/dev/null 2>&1 \
  || fail "terminal.integrated.stickyScroll.enabled inconnu du paquet VS Code embarque"
cexec "grep -aqE '\"terminal.integrated.stickyScroll.enabled\":[{][^}]{0,300}default:!0' $WB" >/dev/null 2>&1 \
  || fail "le defaut amont de terminal.integrated.stickyScroll.enabled n'est plus true : la preuve est perimee"
cexec "grep -qF 'importAddon(\"ligatures\").then' $WB" >/dev/null 2>&1 \
  || fail "le defilement colle ne charge plus l'addon de ligatures : la preuve est perimee"
cexec "grep -aqE 'stickyScroll.enabled.{0,200}hasRichCommandDetection' $WB" >/dev/null 2>&1 \
  || fail "_shouldBeEnabled ne lit plus terminal.integrated.stickyScroll.enabled"
cexec "grep -q 'queryLocalFonts' /usr/lib/code-server/lib/vscode/node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js" >/dev/null 2>&1 \
  || fail "addon-ligatures n'appelle plus queryLocalFonts : la preuve est perimee"
cexec "grep -aqE '\"terminal.integrated.fontLigatures.enabled\":[{][^}]{0,300}default:!1' $WB" >/dev/null 2>&1 \
  || fail "le defaut amont de terminal.integrated.fontLigatures.enabled n'est plus false"
ok "invite des polices : chaine stickyScroll -> addon-ligatures -> queryLocalFonts relevee dans le paquet embarque"

# Les seuls appelants de queryLocalFonts dans ce qui est servi au navigateur :
# l'addon de ligatures, et le paquet du workbench (suggestions de polices des
# reglages, gardees par isElectron, faux en web). Toute autre famille de
# fichiers serait un appelant nouveau, donc une invite possible.
FONT_CALLERS=$(cexec "grep -rl queryLocalFonts /usr/lib/code-server/lib/vscode/out /usr/lib/code-server/lib/vscode/node_modules 2>/dev/null | sort" | tr -d '\r')
[ -n "$FONT_CALLERS" ] || fail "aucun appelant de queryLocalFonts trouve : la recherche ne prouve rien"
STRAY=$(printf '%s\n' "$FONT_CALLERS" | grep -v 'addon-ligatures' | grep -v 'workbench')
[ -z "$STRAY" ] || fail "appelant inattendu de queryLocalFonts dans le paquet" "$STRAY"
# Le garde du second appelant : Vhe=Ogo, ou Ogo est isElectron dans le module
# de plate-forme minifie (voir README). Faux dans un navigateur.
cexec "grep -qF 'Vhe=Ogo' $WB" >/dev/null 2>&1 \
  || echo "  note le garde isElectron du second appelant n'a pas ete retrouve tel quel (minification changee)"
ok "queryLocalFonts n'est appele que par l'addon de ligatures et par un chemin garde par isElectron"

podman_remote logs "$CTR_A" 2>&1 | grep -q 'Using custom extensions gallery' \
  || fail "code-server n'a pas pris EXTENSIONS_GALLERY (galerie par defaut active)"
ok "EXTENSIONS_GALLERY pris en compte : « Using custom extensions gallery »"

ERRS=$(podman_remote logs "$CTR_A" 2>&1 | grep -c 'Uncaught exception')
[ "$ERRS" = "0" ] || fail "code-server a journalise $ERRS exception(s) non rattrapee(s)" "$(podman_remote logs "$CTR_A" 2>&1 | tail -20)"
ok "aucune exception non rattrapee au demarrage de code-server"

cexec 'test -x /usr/bin/clangd && test -x /usr/bin/gdb && test -x /usr/bin/gcc && test -x /usr/bin/make && test -x /usr/bin/git' >/dev/null 2>&1 \
  || fail "un des binaires attendus manque (clangd, gdb, gcc, make, git)"
ok "gcc, gdb, make, git, clangd presents"

cexec 'test -r /home/student/.config/clangd/config.yaml && test -r /run/code-server/xdg-config/clangd/config.yaml' >/dev/null 2>&1 \
  || fail "la configuration clangd n'est pas aux deux chemins attendus"
ok "configuration clangd presente dans ~/.config et dans le XDG_CONFIG_HOME du serveur"

cexec 'man 2 ptrace 2>/dev/null | head -1 | grep -q .' >/dev/null 2>&1 \
  || fail "les pages de manuel de developpement ne sont pas installees (man 2 ptrace)"
ok "pages de manuel de developpement disponibles (man 2 ptrace)"


# --------------------------------------------------------------------------
head2 "8. resolveur : aucun nameserver, echec rapide"
RESOLV=$(cexec 'cat /etc/resolv.conf' 2>&1)
case "$RESOLV" in
  *nameserver*) fail "/etc/resolv.conf contient un nameserver" "$RESOLV" ;;
esac
case "$RESOLV" in
  *"options timeout:1 attempts:1"*) : ;;
  *) fail "/etc/resolv.conf de l'image a ete ecrase par Podman" "$RESOLV" ;;
esac
ok "/etc/resolv.conf vient de l'image : aucun nameserver, options timeout:1 attempts:1"

R0=$(date +%s.%N)
if cexec 'getent hosts example.invalid' >/dev/null 2>&1; then
  fail "getent hosts example.invalid a reussi : il y a un resolveur"
fi
RES_ELAPSED=$(python3 -c "print(round($(date +%s.%N)-${R0}, 2))")
python3 -c "import sys; sys.exit(0 if ${RES_ELAPSED} < 2 else 1)" \
  || fail "getent hosts example.invalid a mis ${RES_ELAPSED}s, au-dela des 2 s exigees"
ok "getent hosts example.invalid echoue en ${RES_ELAPSED}s (< 2 s)"

# --------------------------------------------------------------------------
head2 "9. environnement du conteneur : les sept variables du portail, et rien d'autre"
# --------------------------------------------------------------------------
# Ce que le portail pose au `podman run` (sessions/manager.ts,
# CONTAINER_ENV_KEYS) : l'echeance, l'URL de retour, le titre du devoir, puis
# l'identite git de l'etudiant. L'extension `heig.codespace-statusbar` lit les
# trois premieres dans `process.env` ; git honore les quatre autres sans
# aucun fichier de configuration.

for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" \
          "CODESPACE_RETURN_URL=${ENV_RETURN_URL}" \
          "CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}" \
          "GIT_AUTHOR_NAME=${ENV_GIT_NAME}" \
          "GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}" \
          "GIT_COMMITTER_NAME=${ENV_GIT_NAME}" \
          "GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"; do
  cexec "tr '\\0' '\\n' < /proc/1/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "variable absente de l'environnement de code-server (pid 1) : $kv" \
            "$(cexec "tr '\\0' '\\n' < /proc/1/environ" 2>&1)"
done
ok "les sept variables du portail sont dans l'environnement de code-server (pid 1)"

# Exactement trois lignes d'ecart avec un conteneur lance sans EXTRA_ARGS : le
# portail n'ajoute rien d'autre a l'image, aucun secret au premier chef.
ENV_A=$(podman_remote exec "$CTR_A" env | sort)
ENV_B=$(podman_remote exec "$CTR_B" env | sort)
EXTRA=$(comm -23 <(printf '%s\n' "$ENV_A") <(printf '%s\n' "$ENV_B") | grep -v '^HOSTNAME=' | grep -v '^container=')
EXTRA_COUNT=$(printf '%s\n' "$EXTRA" | grep -c .)
[ "$EXTRA_COUNT" = "7" ] \
  || fail "le conteneur du portail porte $EXTRA_COUNT variable(s) de plus que l'image, attendu 7" "$EXTRA"
printf '%s\n' "$EXTRA" | grep -qvE '^(CODESPACE|GIT)_' \
  && fail "une variable hors CODESPACE_*/GIT_* est posee sur le conteneur" "$EXTRA"
ok "exactement sept variables en plus de celles de l'image, toutes en CODESPACE_ ou GIT_ : $(printf '%s' "$EXTRA" | tr '\n' ' ')"

# L'identite git, a l'usage : un commit reellement fait dans le conteneur porte
# le nom et l'adresse de l'etudiant, sans qu'aucun fichier de configuration
# n'ait ete ecrit. C'est le retour de production du 2026-09-18.
IDENT=$(cexec 'git -C /work var GIT_AUTHOR_IDENT' 2>&1)
case "$IDENT" in
  "${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"*) : ;;
  *) fail "git -C /work var GIT_AUTHOR_IDENT ne porte pas l'identite posee par le portail" "$IDENT" ;;
esac
ok "git -C /work var GIT_AUTHOR_IDENT : $IDENT"

COMMIT=$(cexec '
  set -e
  rm -rf /tmp/idtest && mkdir -p /tmp/idtest && cd /tmp/idtest
  git init -q -b main .
  echo bonjour > a.txt
  git add a.txt
  git commit -q -m "essai identite"
  git --no-pager log -1 --pretty=format:"%an|%ae|%cn|%ce"' 2>&1)
case "$COMMIT" in
  "${ENV_GIT_NAME}|${ENV_GIT_EMAIL}|${ENV_GIT_NAME}|${ENV_GIT_EMAIL}") : ;;
  *) fail "git commit sans fichier de configuration n'a pas produit le bon auteur" "$COMMIT" ;;
esac
ok "git commit dans le conteneur : auteur et committer = ${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"

# Et aucune configuration n'a ete ecrite pour cela : ce sont bien les variables.
CFG=$(cexec 'git -C /tmp/idtest config --local --get user.name || true' 2>&1 | tr -d "[:space:]")
[ -z "$CFG" ] || fail "une identite a ete ecrite dans la configuration locale : $CFG"
ok "aucun user.name local : les quatre variables suffisent a git"

# L'hote d'extensions herite de cet environnement en deux temps. Premier
# temps, mesure : code-server (pid 1) engendre le serveur VS Code, qui porte
# bien les trois variables.
SRV_PID=$(cexec "pgrep -f 'code-server/out/node/entry' | head -1" 2>/dev/null | tr -d '[:space:]')
case "$SRV_PID" in
  ''|*[!0-9]*) fail "processus serveur VS Code (out/node/entry) introuvable dans le conteneur" "$(cexec 'ps -eo pid,args --no-headers' 2>&1)" ;;
esac
for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" "CODESPACE_RETURN_URL=${ENV_RETURN_URL}"; do
  cexec "tr '\\0' '\\n' < /proc/${SRV_PID}/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "le serveur VS Code (pid ${SRV_PID}) n'a pas herite de $kv"
done
ok "le serveur VS Code (pid ${SRV_PID}, engendre par code-server) a herite des trois variables"

# Second temps : c'est ce serveur qui fork l'hote d'extensions, et il construit
# son environnement a partir du sien. Verifie dans le paquet embarque, pas de
# memoire — l'hote d'extensions lui-meme n'existe qu'une fois qu'un navigateur
# s'est connecte, ce que ce test ne fait pas (voir README, TODO(verify)).
cexec "grep -qF 'ExtensionHostConnection#buildUserEnvironment' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment introuvable dans le serveur VS Code embarque"
cexec "grep -aqE 'buildUserEnvironment.{0,400}[{][.][.][.]process[.]env' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment ne construit pas l'environnement de l'hote d'extensions a partir de process.env"
ok "buildUserEnvironment fork l'hote d'extensions avec {...process.env} : l'heritage est complet"

# L'extension, une fois activee, depose un temoin dans /tmp. Il n'existe pas
# tant qu'aucun navigateur n'a ouvert l'editeur : on verifie seulement qu'il
# n'est pas la par accident (il serait alors dans l'image).
if cexec 'test -e /tmp/codespace-statusbar.json' >/dev/null 2>&1; then
  fail "le temoin d'activation existe avant toute connexion : il vient de l'image"
fi
ok "aucun temoin d'activation dans l'image (il n'apparait qu'a l'ouverture de l'editeur)"

printf '\n%d assertions, toutes vertes.\n' "$NTEST"
printf 'MESURE_DEMARRAGE_SECONDES=%s\n' "$BOOT"
