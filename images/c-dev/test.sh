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
T0=$(date +%s.%N)
CTR_NAME="$CTR_A" VOL_DIR="${VOL_BASE}/a" IMAGE="$IMAGE" "${HERE}/run-hardened.sh" >/dev/null \
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
  "llvm-vs-code-extensions.vscode-clangd webfreak.debug "*) : ;;
  *) fail "la liste des extensions du serveur n'est pas exactement les deux attendues : [$LIST]" ;;
esac
ok "le serveur ne connait que les deux extensions preinstallees : $LIST"

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
           '"telemetry.telemetryLevel": "off"' '"chat.disableAIFeatures": true'; do
    cexec "grep -qF '$k' $f" >/dev/null 2>&1 || fail "reglage absent de $f : $k"
  done
done
ok "reglages machine copies dans le user-data-dir tmpfs (User et Machine)"

cexec "grep -qF '\"extensions.allowed\"' /run/code-server/User/settings.json" >/dev/null 2>&1 \
  || fail "extensions.allowed absent des reglages"
ok "extensions.allowed present et restreint aux deux extensions"

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

printf '\n%d assertions, toutes vertes.\n' "$NTEST"
printf 'MESURE_DEMARRAGE_SECONDES=%s\n' "$BOOT"
