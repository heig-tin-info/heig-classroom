#!/usr/bin/env bash
# Acceptance test for task P1 (docs/jalon-0.md).
# Runs the image through run-hardened.sh and executes every P1 assertion.
# Exits non-zero on the first one that fails, with a clear message.
#
#   ./images/c-dev/test.sh
#
# Prerequisites: rootful Podman reachable on unix:///run/podman/podman.sock,
# image codespace/c-dev:4.137.0 built, python3 on the host (to build the fake
# .vsix), and the `codespace` AppArmor profile loaded
# (`sudo apparmor_parser -r /etc/apparmor.d/codespace`, see
# infra/apparmor/codespace). No sudo otherwise.
#
# On a host WITHOUT AppArmor — the WSL2 development workstation — run
# `APPARMOR= ./images/c-dev/test.sh`: `podman run` refuses a profile name the
# kernel does not know, and § 4 then skips the label check with a note.
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
# Runs a bash command inside container A, as the student user.
cexec() { podman_remote exec "$CTR_A" bash -lc "$1"; }

NTEST=0
ok()   { NTEST=$((NTEST+1)); printf '  ok   %s\n' "$1"; }
fail() { printf '\nFAIL: %s\n' "$1" >&2; [ $# -gt 1 ] && printf '  --- context ---\n%s\n' "$2" >&2; cleanup; exit 1; }
head2() { printf '\n== %s\n' "$1"; }

cleanup() {
  podman_remote rm -f "$CTR_A" "$CTR_B" "$CTR_BOMB" >/dev/null 2>&1
  rm -rf "$VOL_BASE" 2>/dev/null
}
trap 'cleanup' EXIT

# --------------------------------------------------------------------------
# Preparation: a *valid* .vsix dropped into the work directory before start-up.
# Valid, so that the installation failure is attributable to the read-only root
# and not to a corrupt archive. It is written before the `podman run` because
# the `:U` mount rechowns the directory onto the container's UID and then makes
# it unwritable from the host.
# --------------------------------------------------------------------------
mkdir -p "${VOL_BASE}/a/work" "${VOL_BASE}/b/work" "${VOL_BASE}/bomb/work"
python3 - "${VOL_BASE}/a/work/fake-extension.vsix" <<'PY' >/dev/null || { echo "python3 required" >&2; exit 1; }
import zipfile, json, sys
pkg = {"name": "fake", "displayName": "Fake", "publisher": "attacker",
       "version": "1.0.0", "engines": {"vscode": "^1.60.0"}, "contributes": {}}
manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
<Metadata><Identity Language="en-US" Id="fake" Version="1.0.0" Publisher="attacker"/>
<DisplayName>Fake</DisplayName><Description>fake extension package</Description></Metadata>
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

echo "P1: hardened student image, working gdb"
echo "image   : ${IMAGE}"
echo "seccomp : ${REPO_ROOT}/infra/seccomp/codespace.json"

# --------------------------------------------------------------------------
head2 "0. start under run-hardened.sh, and time to /healthz"
# --------------------------------------------------------------------------
# The seven variables the portal sets on `podman run` (sessions/manager.ts,
# CONTAINER_ENV_KEYS): three CODESPACE_ for the status-bar extension, four GIT_
# for the student's identity. Container A carries them, container B does not:
# section 9 compares the two environments and requires exactly seven lines of
# difference. No secret goes in there, invariant 1.
ENV_DEADLINE=2026-10-01T12:00:00.000Z
ENV_RETURN_URL=https://classroom.chevallier.io/
# No spaces: run-hardened.sh splits EXTRA_ARGS with the shell. The portal
# itself passes the value as is to execFile (no shell), so a title with spaces
# suits it; it is this script that is constrained.
ENV_ASSIGNMENT_NAME=TP3-pointeurs
# The student's git identity (users.display_name, users.email). Same no-space
# constraint: it comes from EXTRA_ARGS, not from the portal.
ENV_GIT_NAME=Pierre-Bressy
ENV_GIT_EMAIL=pierre.bressy@heig-vd.ch
PORTAL_ENV="-e CODESPACE_DEADLINE=${ENV_DEADLINE} -e CODESPACE_RETURN_URL=${ENV_RETURN_URL} -e CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_AUTHOR_NAME=${ENV_GIT_NAME} -e GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}"
PORTAL_ENV="${PORTAL_ENV} -e GIT_COMMITTER_NAME=${ENV_GIT_NAME} -e GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"

T0=$(date +%s.%N)
CTR_NAME="$CTR_A" VOL_DIR="${VOL_BASE}/a" IMAGE="$IMAGE" EXTRA_ARGS="$PORTAL_ENV" \
  "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh did not start container A"

HEALTH=""
for _ in $(seq 1 300); do
  HEALTH=$(podman_remote exec "$CTR_A" curl -sS -m 2 -w ' HTTP=%{http_code}' http://localhost:8080/healthz 2>/dev/null)
  case "$HEALTH" in *"HTTP=200"*) break ;; esac
  HEALTH=""
  sleep 0.1
done
T1=$(date +%s.%N)
BOOT=$(python3 -c "print(round(${T1}-${T0}, 2))")
[ -n "$HEALTH" ] || fail "/healthz did not answer 200 within 30 s" "$(podman_remote logs "$CTR_A" 2>&1 | tail -30)"
ok "podman run -> /healthz 200 in ${BOOT} s: ${HEALTH}"
echo "MESURE_DEMARRAGE_SECONDES=${BOOT}"

# --------------------------------------------------------------------------
head2 "1. gdb: ptrace allowed, no Operation not permitted"
# --------------------------------------------------------------------------
cexec 'cd /work && gcc -g -O0 -o a.out hello.c' >/dev/null 2>&1 || fail "gcc -g -O0 hello.c failed" "$(cexec 'cd /work && gcc -g -O0 -o a.out hello.c' 2>&1)"
# gdb exits 1 on "No stack." (the program is already finished when bt runs):
# it is the literal command from jalon-0, and we judge only its output.
OUT=$(cexec 'cd /work && gdb -batch -ex run -ex bt ./a.out' 2>&1)
case "$OUT" in
  *"Operation not permitted"*) fail "gdb ran into Operation not permitted" "$OUT" ;;
esac
case "$OUT" in
  *"&main=0x"*) : ;;
  *) fail "the program did not print the address of main under gdb" "$OUT" ;;
esac
ok "gcc -g -O0 hello.c then gdb -batch -ex run -ex bt: no Operation not permitted"

OUT=$(cexec 'cd /work && gdb -batch -ex "break main" -ex run -ex bt ./a.out' 2>&1) \
  || fail "gdb with a breakpoint failed" "$OUT"
case "$OUT" in
  *"#0"*main*) : ;;
  *) fail "bt did not produce a stack containing main" "$OUT" ;;
esac
ok "bt on a breakpoint in main produces a stack"

# --------------------------------------------------------------------------
head2 "2. ASLR can be disabled: personality(ADDR_NO_RANDOMIZE) passes the seccomp profile"
# --------------------------------------------------------------------------
OUT=$(cexec 'gdb -batch -ex "show disable-randomization"' 2>&1)
case "$OUT" in
  *"is on."*) ok "gdb -batch -ex 'show disable-randomization' answers on" ;;
  *) fail "disable-randomization is not on" "$OUT" ;;
esac

A1=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
A2=$(cexec 'cd /work && gdb -batch -ex run ./a.out 2>/dev/null | sed -n "s/^&main=//p"')
[ -n "$A1" ] || fail "first run under gdb: address of main not read"
[ "$A1" = "$A2" ] || fail "the address of main changes between two runs under gdb ($A1 vs $A2): ADDR_NO_RANDOMIZE refused by the seccomp profile"
ok "two runs under gdb give the same address of main ($A1)"

# Control: with the default containers-common profile, the address must vary.
# That is what proves the one entry added to the profile is what acts. The
# control only swaps the seccomp profile: it keeps the AppArmor profile of the
# real run (under containers-default gdb cannot ptrace at all, and an empty gdb
# output would masquerade as a "stable address").
if [ -r "$SECCOMP_DEFAULT" ]; then
  ctrl_aa=()
  if [ -n "${APPARMOR-codespace}" ]; then ctrl_aa=(--security-opt "apparmor=${APPARMOR-codespace}"); fi
  CTRL_OUT=$(podman_remote run --rm --userns=auto --cap-drop=ALL \
      --security-opt no-new-privileges --security-opt "seccomp=${SECCOMP_DEFAULT}" "${ctrl_aa[@]}" \
      --read-only --tmpfs /tmp --tmpfs '/run:rw,nosuid,nodev,mode=1777' \
      --pids-limit 256 --memory 1536m --cpus 1 --network none \
      --entrypoint sh "$IMAGE" -c '
        cd /tmp
        cat > h.c <<"EOF"
#include <stdio.h>
int main(void) { printf("&main=%p\n", (void *)main); return 0; }
EOF
        gcc -g -O0 -o h h.c || exit 1
        for i in 1 2 3; do gdb -batch -ex run ./h 2>/dev/null | sed -n "s/^&main=//p"; done' 2>/dev/null)
  CTRL_RUNS=$(printf '%s\n' "$CTRL_OUT" | grep -c .)
  CTRL=$(printf '%s\n' "$CTRL_OUT" | grep . | sort -u | wc -l)
  if [ "$CTRL_RUNS" -lt 3 ]; then
    fail "invalid control: gdb printed $CTRL_RUNS address(es) out of 3 under the default profile (ptrace refused?), test 2 proves nothing"
  elif [ "$CTRL" -gt 1 ]; then
    ok "control: with the default profile the address varies ($CTRL values out of 3) — the personality(0x40000) addition is indeed the cause"
  else
    fail "invalid control: the default profile already gives a stable address, test 2 proves nothing"
  fi
else
  echo "  note default profile not found ($SECCOMP_DEFAULT), control not run"
fi

# --------------------------------------------------------------------------
head2 "3. no extension can be installed"
# --------------------------------------------------------------------------
cexec 'test -f /work/fake-extension.vsix' >/dev/null 2>&1 \
  || fail "the fake .vsix is not visible in /work"

OUT=$(cexec 'cp /work/fake-extension.vsix /tmp/x.vsix && code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "code-server --install-extension /tmp/x.vsix succeeded" "$OUT"
ok "code-server --install-extension /tmp/x.vsix fails (rc=$RC)"

OUT=$(cexec 'code-server --install-extension /work/fake-extension.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "a .vsix written into /work installs" "$OUT"
ok "fake .vsix from /work: refused (rc=$RC)"

# Variant of a student working around the configuration file error: the
# default extensions directory stays on the read-only root.
OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension succeeds as soon as XDG_CONFIG_HOME is writable" "$OUT"
case "$OUT" in
  *EROFS*|*"read-only"*|*"extensions.json"*) : ;;
  *) fail "the failure is not attributable to the read-only root" "$OUT" ;;
esac
ok "with a writable XDG_CONFIG_HOME, the failure really comes from the read-only root"

OUT=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --install-extension /tmp/x.vsix --force' 2>&1)
RC=$?
[ "$RC" -ne 0 ] || fail "install-extension straight into /opt/code-server/extensions succeeded" "$OUT"
ok "install-extension aimed at /opt/code-server/extensions: refused (rc=$RC)"

LIST=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions' 2>/dev/null | sort | tr '\n' ' ')
case "$LIST" in
  "heig.codespace-statusbar llvm-vs-code-extensions.vscode-clangd webfreak.debug "*) : ;;
  *) fail "the server's extension list is not exactly the three expected ones: [$LIST]" ;;
esac
ok "the server knows only the three preinstalled extensions: $LIST"

# The status-bar extension is baked into the image like the other two: it shows
# up in `--list-extensions` and in the extensions manifest.
VERS=$(cexec 'XDG_CONFIG_HOME=/tmp/cfg code-server --extensions-dir /opt/code-server/extensions --user-data-dir /tmp/ud --list-extensions --show-versions' 2>/dev/null | tr -d '\r')
case "$VERS" in
  *"heig.codespace-statusbar@0.1.0"*) : ;;
  *) fail "heig.codespace-statusbar@0.1.0 missing from --list-extensions --show-versions" "$VERS" ;;
esac
ok "heig.codespace-statusbar@0.1.0 installed and listed by code-server"

cexec 'grep -qF "heig.codespace-statusbar" /etc/code-server/extensions.lock' >/dev/null 2>&1 \
  || fail "heig.codespace-statusbar missing from /etc/code-server/extensions.lock"
cexec 'test -f /opt/code-server/extensions/heig.codespace-statusbar-0.1.0/extension.js' >/dev/null 2>&1 \
  || fail "the status-bar extension code is not in the extensions directory"
if cexec 'touch /opt/code-server/extensions/heig.codespace-statusbar-0.1.0/extension.js' >/dev/null 2>&1; then
  fail "the status-bar extension can be modified at run time"
fi
ok "status-bar extension recorded in extensions.lock and read-only"

# --------------------------------------------------------------------------
head2 "4. read-only root, no capability"
# --------------------------------------------------------------------------
if cexec 'touch /usr/bin/x' >/dev/null 2>&1; then fail "touch /usr/bin/x succeeded"; fi
ok "touch /usr/bin/x fails"
for p in /etc/passwd /opt/code-server/extensions/x /usr/lib/code-server/x; do
  if cexec "touch $p" >/dev/null 2>&1; then fail "touch $p succeeded"; fi
done
ok "/etc, /opt/code-server/extensions and /usr/lib/code-server are read-only"

CAP=$(cexec 'grep CapEff /proc/self/status' | awk '{print $2}')
[ "$CAP" = "0000000000000000" ] || fail "CapEff is $CAP instead of 0000000000000000"
ok "CapEff = 0000000000000000"

NNP=$(cexec 'grep NoNewPrivs /proc/self/status' | awk '{print $2}')
[ "$NNP" = "1" ] || fail "NoNewPrivs is $NNP instead of 1"
ok "NoNewPrivs = 1"

SEC=$(cexec 'grep Seccomp: /proc/self/status' | awk '{print $2}')
[ "$SEC" = "2" ] || fail "Seccomp is $SEC instead of 2 (filter mode)"
ok "Seccomp = 2 (filter loaded)"

# The project AppArmor profile, not Podman's built-in containers-default-*:
# that one denies ptrace towards the stacked label `<profile>//&crun` and § 1
# would fail. The label is read from /proc/self/attr/apparmor/current, with the
# pre-5.1 path as a fallback; the value is `codespace (enforce)`, possibly with
# a `//&…` stack suffix.
if [ -z "${APPARMOR-codespace}" ]; then
  printf '  skip  AppArmor label (APPARMOR= : the flag was not passed)\n'
elif ! cexec 'test -r /proc/self/attr/apparmor/current || test -r /proc/self/attr/current' >/dev/null 2>&1; then
  printf '  skip  AppArmor label (host without AppArmor: no /proc/self/attr/…/current)\n'
else
  LABEL=$(cexec 'cat /proc/self/attr/apparmor/current 2>/dev/null || cat /proc/self/attr/current' | tr -d '\0\r')
  case "$LABEL" in
    unconfined*|"")
      fail "the container is not confined by the codespace profile: [$LABEL]" \
           "expected 'codespace (enforce)'; check apparmor_parser -r /etc/apparmor.d/codespace" ;;
    codespace*) : ;;
    *) fail "AppArmor label is [$LABEL] instead of the codespace profile" ;;
  esac
  ok "AppArmor label: $LABEL"
fi

# --------------------------------------------------------------------------
head2 "5. user namespace: uid 1000 inside, host UID outside 0-65535"
# --------------------------------------------------------------------------
UID_IN=$(cexec 'id -u')
[ "$UID_IN" = "1000" ] || fail "id -u is $UID_IN instead of 1000"
ok "id -u = 1000 inside the container"

HUSER_A=$(podman_remote top "$CTR_A" huser | sed -n '2p' | tr -d '[:space:]')
case "$HUSER_A" in
  ''|*[!0-9]*) fail "podman top huser did not return a numeric UID: [$HUSER_A]" ;;
esac
[ "$HUSER_A" -gt 65535 ] || fail "host UID $HUSER_A is inside the 0-65535 range: --userns=auto did not take"
ok "host UID of container A = $HUSER_A (outside 0-65535)"

CTR_NAME="$CTR_B" VOL_DIR="${VOL_BASE}/b" IMAGE="$IMAGE" "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh did not start container B"
for _ in $(seq 1 100); do
  HUSER_B=$(podman_remote top "$CTR_B" huser 2>/dev/null | sed -n '2p' | tr -d '[:space:]')
  [ -n "${HUSER_B:-}" ] && break
  sleep 0.2
done
case "${HUSER_B:-}" in
  ''|*[!0-9]*) fail "podman top huser (B) did not return a numeric UID: [${HUSER_B:-}]" ;;
esac
[ "$HUSER_B" -gt 65535 ] || fail "host UID of B ($HUSER_B) is inside the 0-65535 range"
[ "$HUSER_A" != "$HUSER_B" ] || fail "the two containers share the same host UID ($HUSER_A)"
ok "two containers side by side: distinct host UIDs ($HUSER_A and $HUSER_B)"

# --------------------------------------------------------------------------
head2 "6. fork bomb: contained by --pids-limit 256, host untouched"
# --------------------------------------------------------------------------
PIDS_MAX=$(cexec 'cat /sys/fs/cgroup/pids.max')
[ "$PIDS_MAX" = "256" ] || fail "pids.max is $PIDS_MAX instead of 256"
ok "cgroup pids.max = 256"

HOST_PROCS_BEFORE=$(ps -e --no-headers | wc -l)
CTR_NAME="$CTR_BOMB" VOL_DIR="${VOL_BASE}/bomb" IMAGE="$IMAGE" "${HERE}/run-hardened.sh" >/dev/null \
  || fail "run-hardened.sh did not start the bomb container"
BOMB_CG=$(podman_remote inspect "$CTR_BOMB" --format '{{.State.CgroupPath}}')
[ -r "/sys/fs/cgroup${BOMB_CG}/pids.current" ] || fail "bomb cgroup unreadable: /sys/fs/cgroup${BOMB_CG}"

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

[ "$MAXSEEN" -le 256 ] || fail "the bomb cgroup went past 256 processes ($MAXSEEN)"
[ "$MAXSEEN" -ge 200 ] || fail "the bomb did not reach the limit ($MAXSEEN processes): the test proves nothing"
ok "the bomb tops out at $MAXSEEN processes, never above 256"

# The bomb's processes are host processes (rootful Podman, one kernel), so the
# host count legitimately rises by up to pids-limit. What must hold is that it
# never rises beyond that bound (nothing escapes the cgroup) and that the host
# keeps answering.
DELTA=$((HOST_PROCS_AFTER - HOST_PROCS_BEFORE))
[ "$DELTA" -le 300 ] || fail "the host process count jumped by $DELTA during the bomb: more than the 256 the cgroup allows"
ok "host: $HOST_PROCS_BEFORE -> $HOST_PROCS_AFTER processes (delta $DELTA, bounded by pids-limit), ps answers in ${HOST_OK_ELAPSED}s"

OUT=$(podman_remote exec "$CTR_A" curl -sS -m 3 -o /dev/null -w '%{http_code}' http://localhost:8080/healthz 2>&1)
[ "$OUT" = "200" ] || fail "container A no longer answers after the bomb (http $OUT)"
ok "neighbour container A still answers on /healthz after the bomb"

# --------------------------------------------------------------------------
head2 "7. code-server: /healthz, machine settings, neutralised gallery"
# --------------------------------------------------------------------------
OUT=$(cexec 'curl -sS -m 3 http://localhost:8080/healthz')
case "$OUT" in
  *'"status"'*) ok "curl http://localhost:8080/healthz from the container: $OUT" ;;
  *) fail "/healthz did not answer the expected JSON" "$OUT" ;;
esac

for f in /run/code-server/User/settings.json /run/code-server/Machine/settings.json; do
  cexec "test -f $f" >/dev/null 2>&1 || fail "machine settings not copied into $f"
  for k in '"files.autoSave": "afterDelay"' '"files.autoSaveDelay": 1000' \
           '"extensions.autoUpdate": false' '"update.mode": "none"' \
           '"telemetry.telemetryLevel": "off"' '"chat.disableAIFeatures": true' \
           '"workbench.secondarySideBar.defaultVisibility": "hidden"' \
           '"keyboard.dispatch": "keyCode"' \
           '"terminal.integrated.stickyScroll.enabled": false' \
           '"terminal.integrated.fontLigatures.enabled": false'; do
    cexec "grep -qF '$k' $f" >/dev/null 2>&1 || fail "setting missing from $f: $k"
  done
done
ok "machine settings copied into the tmpfs user-data-dir (User and Machine)"

cexec "grep -qF '\"extensions.allowed\"' /run/code-server/User/settings.json" >/dev/null 2>&1 \
  || fail "extensions.allowed missing from the settings"
cexec "grep -qF '\"heig.codespace-statusbar\": true' /run/code-server/User/settings.json" >/dev/null 2>&1 \
  || fail "heig.codespace-statusbar missing from extensions.allowed"
ok "extensions.allowed present and restricted to the three extensions"

# The two settings added on 2026-09-18 must exist **in the bundled VS Code
# package**, not only in our own file: a name that does not exist would be
# silently ignored. Literal search in the workbench bundle.
WB=/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js
cexec "grep -q 'workbench.secondarySideBar.defaultVisibility' $WB" >/dev/null 2>&1 \
  || fail "workbench.secondarySideBar.defaultVisibility unknown to the bundled VS Code package"
cexec "grep -q 'keyboard.dispatch' $WB" >/dev/null 2>&1 \
  || fail "keyboard.dispatch unknown to the bundled VS Code package"
# The value set must be in the declared enum, otherwise VS Code rejects it.
cexec "grep -qF '\"workbench.secondarySideBar.defaultVisibility\":{type:\"string\",enum:[\"hidden\"' $WB" >/dev/null 2>&1 \
  || fail "hidden is not the first value of the workbench.secondarySideBar.defaultVisibility enum"
cexec "grep -qF '\"keyboard.dispatch\":{scope:1,type:\"string\",enum:[\"code\",\"keyCode\"]' $WB" >/dev/null 2>&1 \
  || fail "keyCode is not a declared value of keyboard.dispatch"
ok "both settings exist in the bundled VS Code 1.137.0, with the values set present in their enum"

# "Use the fonts on your computer" prompt: the causal chain, traced in the
# bundled package (see README). The terminal's sticky scroll loads the
# ligatures addon **unconditionally**, and that addon calls
# queryLocalFonts(). It is stickyScroll.enabled (default true) that governs.
cexec "grep -qF '\"terminal.integrated.stickyScroll.enabled\":{markdownDescription:' $WB" >/dev/null 2>&1 \
  || fail "terminal.integrated.stickyScroll.enabled unknown to the bundled VS Code package"
cexec "grep -aqE '\"terminal.integrated.stickyScroll.enabled\":[{][^}]{0,300}default:!0' $WB" >/dev/null 2>&1 \
  || fail "the upstream default of terminal.integrated.stickyScroll.enabled is no longer true: the proof is stale"
cexec "grep -qF 'importAddon(\"ligatures\").then' $WB" >/dev/null 2>&1 \
  || fail "sticky scroll no longer loads the ligatures addon: the proof is stale"
cexec "grep -aqE 'stickyScroll.enabled.{0,200}hasRichCommandDetection' $WB" >/dev/null 2>&1 \
  || fail "_shouldBeEnabled no longer reads terminal.integrated.stickyScroll.enabled"
cexec "grep -q 'queryLocalFonts' /usr/lib/code-server/lib/vscode/node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js" >/dev/null 2>&1 \
  || fail "addon-ligatures no longer calls queryLocalFonts: the proof is stale"
cexec "grep -aqE '\"terminal.integrated.fontLigatures.enabled\":[{][^}]{0,300}default:!1' $WB" >/dev/null 2>&1 \
  || fail "the upstream default of terminal.integrated.fontLigatures.enabled is no longer false"
ok "fonts prompt: chain stickyScroll -> addon-ligatures -> queryLocalFonts traced in the bundled package"

# The only callers of queryLocalFonts in what is served to the browser: the
# ligatures addon, and the workbench bundle (font suggestions in the settings,
# guarded by isElectron, false on the web). Any other family of files would be
# a new caller, hence a possible prompt.
FONT_CALLERS=$(cexec "grep -rl queryLocalFonts /usr/lib/code-server/lib/vscode/out /usr/lib/code-server/lib/vscode/node_modules 2>/dev/null | sort" | tr -d '\r')
[ -n "$FONT_CALLERS" ] || fail "no caller of queryLocalFonts found: the search proves nothing"
STRAY=$(printf '%s\n' "$FONT_CALLERS" | grep -v 'addon-ligatures' | grep -v 'workbench')
[ -z "$STRAY" ] || fail "unexpected caller of queryLocalFonts in the package" "$STRAY"
# The second caller's guard: Vhe=Ogo, where Ogo is isElectron in the minified
# platform module (see README). False in a browser.
cexec "grep -qF 'Vhe=Ogo' $WB" >/dev/null 2>&1 \
  || echo "  note the second caller's isElectron guard was not found as such (minification changed)"
ok "queryLocalFonts is called only by the ligatures addon and by a path guarded by isElectron"

podman_remote logs "$CTR_A" 2>&1 | grep -q 'Using custom extensions gallery' \
  || fail "code-server did not take EXTENSIONS_GALLERY (default gallery active)"
ok "EXTENSIONS_GALLERY taken into account: 'Using custom extensions gallery'"

ERRS=$(podman_remote logs "$CTR_A" 2>&1 | grep -c 'Uncaught exception')
[ "$ERRS" = "0" ] || fail "code-server logged $ERRS uncaught exception(s)" "$(podman_remote logs "$CTR_A" 2>&1 | tail -20)"
ok "no uncaught exception at code-server start-up"

cexec 'test -x /usr/bin/clangd && test -x /usr/bin/gdb && test -x /usr/bin/gcc && test -x /usr/bin/make && test -x /usr/bin/git' >/dev/null 2>&1 \
  || fail "one of the expected binaries is missing (clangd, gdb, gcc, make, git)"
ok "gcc, gdb, make, git, clangd present"

cexec 'test -r /home/student/.config/clangd/config.yaml && test -r /run/code-server/xdg-config/clangd/config.yaml' >/dev/null 2>&1 \
  || fail "the clangd configuration is not at both expected paths"
ok "clangd configuration present in ~/.config and in the server's XDG_CONFIG_HOME"

cexec 'man 2 ptrace 2>/dev/null | head -1 | grep -q .' >/dev/null 2>&1 \
  || fail "the development manual pages are not installed (man 2 ptrace)"
ok "development manual pages available (man 2 ptrace)"


# --------------------------------------------------------------------------
head2 "8. resolver: no nameserver, fast failure"
RESOLV=$(cexec 'cat /etc/resolv.conf' 2>&1)
case "$RESOLV" in
  *nameserver*) fail "/etc/resolv.conf contains a nameserver" "$RESOLV" ;;
esac
case "$RESOLV" in
  *"options timeout:1 attempts:1"*) : ;;
  *) fail "the image's /etc/resolv.conf was overwritten by Podman" "$RESOLV" ;;
esac
ok "/etc/resolv.conf comes from the image: no nameserver, options timeout:1 attempts:1"

R0=$(date +%s.%N)
if cexec 'getent hosts example.invalid' >/dev/null 2>&1; then
  fail "getent hosts example.invalid succeeded: there is a resolver"
fi
RES_ELAPSED=$(python3 -c "print(round($(date +%s.%N)-${R0}, 2))")
python3 -c "import sys; sys.exit(0 if ${RES_ELAPSED} < 2 else 1)" \
  || fail "getent hosts example.invalid took ${RES_ELAPSED}s, beyond the 2 s required"
ok "getent hosts example.invalid fails in ${RES_ELAPSED}s (< 2 s)"

# --------------------------------------------------------------------------
head2 "9. container environment: the portal's seven variables, and nothing else"
# --------------------------------------------------------------------------
# What the portal sets on `podman run` (sessions/manager.ts,
# CONTAINER_ENV_KEYS): the deadline, the return URL, the assignment title, then
# the student's git identity. The `heig.codespace-statusbar` extension reads the
# first three from `process.env`; git honours the other four without any
# configuration file at all.

for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" \
          "CODESPACE_RETURN_URL=${ENV_RETURN_URL}" \
          "CODESPACE_ASSIGNMENT_NAME=${ENV_ASSIGNMENT_NAME}" \
          "GIT_AUTHOR_NAME=${ENV_GIT_NAME}" \
          "GIT_AUTHOR_EMAIL=${ENV_GIT_EMAIL}" \
          "GIT_COMMITTER_NAME=${ENV_GIT_NAME}" \
          "GIT_COMMITTER_EMAIL=${ENV_GIT_EMAIL}"; do
  cexec "tr '\\0' '\\n' < /proc/1/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "variable missing from code-server's environment (pid 1): $kv" \
            "$(cexec "tr '\\0' '\\n' < /proc/1/environ" 2>&1)"
done
ok "the portal's seven variables are in code-server's environment (pid 1)"

# Exactly seven lines of difference with a container started without EXTRA_ARGS:
# the portal adds nothing else to the image, and no secret whatsoever.
ENV_A=$(podman_remote exec "$CTR_A" env | sort)
ENV_B=$(podman_remote exec "$CTR_B" env | sort)
EXTRA=$(comm -23 <(printf '%s\n' "$ENV_A") <(printf '%s\n' "$ENV_B") | grep -v '^HOSTNAME=' | grep -v '^container=')
EXTRA_COUNT=$(printf '%s\n' "$EXTRA" | grep -c .)
[ "$EXTRA_COUNT" = "7" ] \
  || fail "the portal container carries $EXTRA_COUNT variable(s) more than the image, expected 7" "$EXTRA"
printf '%s\n' "$EXTRA" | grep -qvE '^(CODESPACE|GIT)_' \
  && fail "a variable outside CODESPACE_*/GIT_* is set on the container" "$EXTRA"
ok "exactly seven variables beyond the image's own, all CODESPACE_ or GIT_: $(printf '%s' "$EXTRA" | tr '\n' ' ')"

# The git identity in use: a commit really made inside the container carries the
# student's name and address, without any configuration file having been
# written. This is the production feedback of 2026-09-18.
IDENT=$(cexec 'git -C /work var GIT_AUTHOR_IDENT' 2>&1)
case "$IDENT" in
  "${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"*) : ;;
  *) fail "git -C /work var GIT_AUTHOR_IDENT does not carry the identity set by the portal" "$IDENT" ;;
esac
ok "git -C /work var GIT_AUTHOR_IDENT: $IDENT"

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
  *) fail "git commit without a configuration file did not produce the right author" "$COMMIT" ;;
esac
ok "git commit inside the container: author and committer = ${ENV_GIT_NAME} <${ENV_GIT_EMAIL}>"

# And no configuration was written for that: it really is the variables.
CFG=$(cexec 'git -C /tmp/idtest config --local --get user.name || true' 2>&1 | tr -d "[:space:]")
[ -z "$CFG" ] || fail "an identity was written into the local configuration: $CFG"
ok "no local user.name: the four variables are enough for git"

# The extension host inherits this environment in two steps. First step,
# measured: code-server (pid 1) spawns the VS Code server, which does carry
# the three variables.
SRV_PID=$(cexec "pgrep -f 'code-server/out/node/entry' | head -1" 2>/dev/null | tr -d '[:space:]')
case "$SRV_PID" in
  ''|*[!0-9]*) fail "VS Code server process (out/node/entry) not found in the container" "$(cexec 'ps -eo pid,args --no-headers' 2>&1)" ;;
esac
for kv in "CODESPACE_DEADLINE=${ENV_DEADLINE}" "CODESPACE_RETURN_URL=${ENV_RETURN_URL}"; do
  cexec "tr '\\0' '\\n' < /proc/${SRV_PID}/environ | grep -qxF '$kv'" >/dev/null 2>&1 \
    || fail "the VS Code server (pid ${SRV_PID}) did not inherit $kv"
done
ok "the VS Code server (pid ${SRV_PID}, spawned by code-server) inherited the three variables"

# Second step: it is that server which forks the extension host, and it builds
# its environment from its own. Checked in the bundled package, not from
# memory — the extension host itself only exists once a browser has connected,
# which this test does not do (see README, TODO(verify)).
cexec "grep -qF 'ExtensionHostConnection#buildUserEnvironment' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment not found in the bundled VS Code server"
cexec "grep -aqE 'buildUserEnvironment.{0,400}[{][.][.][.]process[.]env' /usr/lib/code-server/lib/vscode/out/server-main.js" >/dev/null 2>&1 \
  || fail "buildUserEnvironment does not build the extension host environment from process.env"
ok "buildUserEnvironment forks the extension host with {...process.env}: inheritance is complete"

# Once activated, the extension drops a witness in /tmp. It does not exist as
# long as no browser has opened the editor: we only check that it is not there
# by accident (it would then come from the image).
if cexec 'test -e /tmp/codespace-statusbar.json' >/dev/null 2>&1; then
  fail "the activation witness exists before any connection: it comes from the image"
fi
ok "no activation witness in the image (it only appears when the editor is opened)"

printf '\n%d assertions, all green.\n' "$NTEST"
printf 'MESURE_DEMARRAGE_SECONDES=%s\n' "$BOOT"
