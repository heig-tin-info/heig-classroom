# images/c-dev — hardened student image (task P1)

The working environment of a student: a complete C toolchain, a `gdb` that is really
usable (ASLR can be disabled), code-server without network, without an extension
gallery and unable to write anywhere outside the work volume.

Framework: [docs/jalon-0.md](../../docs/jalon-0.md) § P1,
[docs/analyse.md](../../docs/analyse.md) § 3.2, 3.4, 3.5 and 4.3,
invariants 1 and 3 of [CLAUDE.md](../../CLAUDE.md).

## Files

| File | Role |
| --- | --- |
| `Containerfile` | image `codespace/c-dev` |
| `entrypoint.sh` | copies the machine settings into the tmpfs `user-data-dir`, then `code-server` |
| `settings.json` | machine settings, installed as `/etc/code-server/settings.json` |
| `resolv.conf` | empty resolver, installed as `/etc/resolv.conf` |
| `extension/` | source of `heig.codespace-statusbar`, packaged into a `.vsix` at build time |
| `run-hardened.sh` | `podman run` with the mandatory hardening |
| `test.sh` | P1 acceptance test (47 assertions) |
| `../../infra/seccomp/codespace.json` | seccomp profile of the project |
| `../../infra/apparmor/codespace` | AppArmor profile of the project (what makes gdb work again) |

## Pinned versions

| Item | Version | Pinning |
| --- | --- | --- |
| Base | Debian 13.6 "trixie" slim | digest `sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f` |
| code-server | **4.137.0** (VS Code 1.137.0, commit `b11dabda`) | `ARG CS_VERSION`, `.deb` from the GitHub release `coder/code-server` |
| gcc | 14.2.0 (Debian 14.2.0-19) | Debian stable repository |
| gdb | 16.3 (Debian 16.3-1) | Debian stable repository |
| clangd | 19.1.7 | package `clangd` |
| git | 2.47.3 | Debian stable repository |
| `llvm-vs-code-extensions.vscode-clangd` | 0.6.0 | Open VSX, resolved at build time |
| `webfreak.debug` | 0.27.0 | Open VSX, resolved at build time |
| `heig.codespace-statusbar` | 0.1.0 | local source `extension/`, packaged at build time |
| `@vscode/vsce` (packaging only) | 4.0.0 | `ARG VSCE_VERSION`, `npx` in the `vsix` stage |
| Node of the packaging stage | `node:22-slim` | digest `sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96` |

The two Open VSX extensions are pinned by identifier only: Open VSX does not
guarantee that an old version stays available. The version actually
selected at build time is written into `/etc/code-server/extensions.lock` **inside
the image**, and the build fails if either of the two is missing. No `.vsix` had to
be downloaded by hand: `code-server --install-extension <id>` from Open
VSX (code-server's default gallery) worked for both.

## Building and running

From `apps/codespace`, as in [CLAUDE.md](../../CLAUDE.md):

```bash
podman build -t codespace/c-dev:4.137.0 images/c-dev

CTR_NAME=cdev-p1 VOL_DIR=/srv/codespace/volumes/demo images/c-dev/run-hardened.sh
images/c-dev/test.sh

# on a host without AppArmor (the WSL2 workstation):
APPARMOR= images/c-dev/run-hardened.sh
APPARMOR= images/c-dev/test.sh
```

`podman` here must be the rootful remote one: either through the
`alias podman='podman --remote'` of [docs/setup-poste.md](../../docs/setup-poste.md),
or spelled out as `podman --remote --url unix:///run/podman/podman.sock build …`.
Without `--remote` the binary silently falls back to local rootless mode and builds
into another store. Add `-t codespace/c-dev:latest` to get the floating tag as
well, which is what `deploy/push.sh` does.

`run-hardened.sh` accepts `CTR_NAME`, `VOL_DIR`, `IMAGE`, `NETWORK`,
`SECCOMP`, `APPARMOR`, `PODMAN_URL`, `EXTRA_ARGS`. It writes the container
identifier on standard output. `NETWORK` is `none` for P1; P2 will start it
with `NETWORK=codespace`. `APPARMOR` is `codespace` by default and an empty
value drops the flag entirely, for a host without AppArmor (see § AppArmor).

## Modifying the image

- **Add an apt package**: add it to the `apt-get install` list of the `Containerfile` (step 1), add its binary to the presence assertion of `test.sh` § 7 (`test -x /usr/bin/…`), and add a row to the pinned-versions table above.
- **Add an extension**: one `ARG` for its identifier, one `--install-extension` in the same `RUN`, one `grep -qi "^<id>@"` against `/etc/code-server/extensions.lock` so that the build fails if it is missing, its id in `extensions.allowed` of `settings.json`, the exact expected list asserted in `test.sh` § 3 (three ids, sorted), and a row in the pinned-versions table.
- **Bump code-server**: `ARG CS_VERSION` in the `Containerfile`, then the tag `codespace/c-dev:4.137.0` wherever it is hard-coded — `.env.example` (`CODESPACE_IMAGE`, `CODESPACE_DEFAULT_IMAGE`), `src/auth/config.ts` (the defaults of those same two), `images/c-dev/run-hardened.sh`, `images/c-dev/test.sh`, `deploy/push.sh`, `deploy/bootstrap.sh`, `seed/assignments.yaml`, `CLAUDE.md`, `docs/deploy.md`, `docs/integration-classroom.md`, `src/git/README.md`, this README, and the tests that state it (`src/engine/index.test.ts`, `src/sessions/sessions.test.ts`, `src/sessions/containerEnv.test.ts`, `src/sessions/workspace.test.ts`, `src/proxy/proxy.test.ts`, `src/web/pages.test.ts`, `src/git/channel.integration.test.ts`).
- **Deploy**: `deploy/push.sh --rebuild-image` rebuilds the image on the VM; without the flag it is only built there when the tag is missing.
- **Run `images/c-dev/test.sh`**: prerequisites are rootful Podman on `unix:///run/podman/podman.sock`, the image built, `python3` on the host (it fabricates the fake `.vsix`); no sudo. Its ten sections prove, in order:
  - § 0 the container starts under `run-hardened.sh` and answers `/healthz` (prints `MESURE_DEMARRAGE_SECONDES`);
  - § 1 `gdb` runs a program and produces a backtrace, with no "Operation not permitted";
  - § 2 `personality(ADDR_NO_RANDOMIZE)` passes the project seccomp profile, and the control container on the default profile still varies;
  - § 3 no extension can be installed, and the server knows exactly the three baked-in ones;
  - § 4 the root filesystem is read-only, `CapEff` is zero, `NoNewPrivs` is 1, the seccomp filter is loaded and the AppArmor label is the `codespace` profile (skipped with a note on a host without AppArmor);
  - § 5 uid 1000 inside, host UID outside 0–65535, and two containers side by side get different host UIDs;
  - § 6 a fork bomb is capped by `--pids-limit 256`, the host and the neighbouring container are intact;
  - § 7 code-server: machine settings copied, `extensions.allowed`, the settings found in the embedded package, the font-prompt chain, neutralised gallery, no uncaught exception, toolchain binaries and man pages present;
  - § 8 `/etc/resolv.conf` comes from the image, with no nameserver, and resolution fails in under two seconds;
  - § 9 the container carries the seven portal variables and nothing else, the git identity works without a configuration file, and the VS Code server inherits the environment.

## Measurements (2026-09-17, WSL2, 24 cores, Podman 5.7 rootful, crun, overlay)

| Measurement | Value |
| --- | --- |
| Full `--no-cache` build | **45 – 51 s** (of which ~25 s downloading the 233 MB `.deb`) |
| Build with layer cache | 4.0 s |
| Image size | **1.50 GB** (1,499,111,868 bytes) |
| `podman run` (command returns) | 0.18 s |
| `podman run` → `/healthz` 200 | **0.61 – 0.76 s** warm, **1.0 s** on the first start after a build (cold page cache). Measurement printed by `test.sh`: `MESURE_DEMARRAGE_SECONDES` |
| `podman run` → `GET /` (workbench HTML served) | 0.95 – 1.01 s |

Reading for the "pre-warmed pool" decision of
[docs/analyse.md § 3.4](../../docs/analyse.md): starting the container
is not the expensive part. One second between `podman run` and a workbench
served, on an image that is already local, leaves more than nine seconds for
authentication, volume creation, seeding of the staging repository and
loading of the browser. **Nothing in this measurement justifies
building a pre-warmed pool.** To be measured again at milestone 1 with twenty simultaneous
containers: the measurement above is single-container, and the cost of a
`--userns=auto` is in the `chown` over the layers, not in the `run`.

## code-server options: checked in `code-server --help` of 4.137.0

Every option required by jalon-0 § P1 exists in the pinned version.
Verification done by running `code-server --help` inside the built image.

| Option | Present in 4.137.0 |
| --- | --- |
| `--auth none` | yes |
| `--bind-addr 0.0.0.0:8080` | yes |
| `--disable-file-downloads` | yes |
| `--disable-file-uploads` | yes |
| `--disable-workspace-trust` | yes |
| `--disable-update-check` | yes |
| `--disable-getting-started-override` | yes |
| `--extensions-dir` | yes |
| `--user-data-dir` | yes |
| `--install-extension`, `--list-extensions`, `--force` | yes (build) |

`EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'`
is taken into account: the start-up log shows `Using custom extensions
gallery`, and `test.sh` makes an assertion out of it.

## Machine settings

`/etc/code-server/settings.json` is copied by the entry point into
`/run/code-server/User/settings.json` **and** `/run/code-server/Machine/settings.json`
(the `user-data-dir` is a tmpfs, hence reset on every container start).

The seven required keys are present and their names really do exist in the
embedded VS Code 1.137.0 package (literal search in
`/usr/lib/code-server/lib/vscode/out`):

`files.autoSave: afterDelay`, `files.autoSaveDelay: 1000`,
`extensions.autoUpdate: false`, `update.mode: none`,
`telemetry.telemetryLevel: off`, `chat.disableAIFeatures: true`,
`extensions.allowed` restricted to `llvm-vs-code-extensions.vscode-clangd`,
`webfreak.debug` and `heig.codespace-statusbar` (with `"*": false`).

Added on top, not required but consistent: `extensions.autoCheckUpdates`,
`update.showReleaseNotes`, `workbench.startupEditor`,
`security.workspace.trust.enabled`, and `clangd.path: /usr/bin/clangd` +
`clangd.checkUpdates: false` — without which the clangd extension tries to
download its binary and fails, the network being cut off (docs/analyse.md § 3.5).

### The two settings added after the first real trial (2026-09-18)

Feedback 1 and 2 of [docs/pistes.md](../../docs/pistes.md), "Feedback from the first
real trial". Both names were **looked up in the embedded package**, not
recalled from memory: literal `grep` in
`/usr/lib/code-server/lib/vscode/out/vs/workbench/workbench.web.main.internal.js`
of the built image. `test.sh` § 7 replays both searches, and over the
complete declaration, so that a change of version breaks the test
rather than the behaviour.

**1. Secondary side bar hidden at start-up.**

```json
"workbench.secondarySideBar.defaultVisibility": "hidden"
```

Proof, as it comes out of the package (minified, truncated):

```js
"workbench.secondarySideBar.defaultVisibility":{type:"string",
 enum:["hidden","visibleInWorkspace","visible","maximizedInWorkspace","maximized"],
 default:"visibleInWorkspace", …}
```

The upstream default is `visibleInWorkspace`: that is indeed what opened an empty
bar, the chat view that used to live in it being disabled by
`chat.disableAIFeatures`. `hidden` is the first value of the declared
enumeration. Neighbouring keys noticed along the way, not used:
`workbench.secondarySideBar.forceMaximized` (marked `experimental`) and
`workbench.secondarySideBar.showLabels`.

**2. Keybindings independent of the detected keyboard layout.**

```json
"keyboard.dispatch": "keyCode"
```

Proof:

```js
{id:"keyboard",order:15,type:"object",title:…,properties:{
 "keyboard.dispatch":{scope:1,type:"string",enum:["code","keyCode"],
   default:"code",markdownDescription:…,included:jo===2||jo===3},
 "keyboard.mapAltGrToCtrlAlt":{…,included:jo===1}}}
```

and, in use:

```js
function Dwn(s){let o=s.getValue("keyboard"),e=o?.dispatch==="keyCode"?1:0; …}
```

VS Code Web has no French-Swiss layout; it detects "Swiss German"
and derives wrong keybindings from it. `keyCode` makes keybindings dispatch on
the raw key code, hence independently of the detected layout.

**Typing is not affected.** The characters the student types come
from the browser and from the operating system layout; VS Code receives them
as they are. `keyboard.dispatch` only touches the resolution of
keybindings. An `é`, an `à` or a `<` keep being typed just as
anywhere else on the machine.

### The setting added after the real sessions of 2026-09-18

**"Use the fonts on your computer" prompt when opening the editor.**

```json
"terminal.integrated.stickyScroll.enabled": false
```

Same method as the two previous ones: the cause was **looked up in the
embedded package**, not guessed. The chain, in four links:

1. the call that triggers the browser prompt (*Local Font
   Access* permission) is `window.queryLocalFonts()`, in
   `node_modules/@xterm/addon-ligatures/lib/addon-ligatures.js`:

   ```js
   else if("undefined"!=typeof window&&"queryLocalFonts"in window){
     const e={};try{const t=await window.queryLocalFonts(); …
   ```

2. the **terminal sticky scroll** loads that addon **unconditionally** —
   it does not consult `terminal.integrated.fontLigatures.enabled`. Found in
   the constructor of the overlay, `workbench.web.main.internal.js`:

   ```js
   this._stickyScrollOverlay.open(this._element),
   …
   this._xtermAddonLoader.importAddon("ligatures").then(c=>{ …
     this._ligaturesAddon=new c,this._stickyScrollOverlay.loadAddon(this._ligaturesAddon) …
   ```

   It is the second of the two calls to `importAddon("ligatures")` in the package;
   the other one, in `_refreshLigaturesAddon()`, is properly guarded
   (`if(e?.enabled){…}`) and is therefore not the cause.

3. the overlay only exists if the setting is true. `_shouldBeEnabled()`:

   ```js
   _shouldBeEnabled(){let e=this._ctx.instance.capabilities.get(2);
     return!!(this._configurationService.getValue("terminal.integrated.stickyScroll.enabled")
       &&e&&e.hasRichCommandDetection&&this._xterm?.raw?.element)}
   ```

4. and its upstream default is **true**:

   ```js
   "terminal.integrated.stickyScroll.enabled":{markdownDescription:d(18525,…),
     type:"boolean",default:!0}
   ```

Hence the prompt on opening, as soon as the shell integration has detected a
command, without anyone having asked for ligatures. `false` removes the
overlay, hence the import, hence the call.

**The second caller of `queryLocalFonts` does not run on the web.** It is the
list of fonts offered by the settings editor for `editor.fontFamily` and
`terminal.integrated.fontFamily`:

```js
fTn=async()=>{try{return[...await ut.queryLocalFonts()].map(t=>t.family)}
  catch(s){return console.error(`Failed to query fonts: ${s}`),[]}},
mNt=async()=>Vhe?(await fTn()).map(e=>({body:`${e}`})):[];
```

`Vhe` is the `isElectron` of the minified platform module
(`Ti=eZe,yt=tZe,Fr=ZJe,HSi=Ago,Ls=Ngo,Vhe=Ogo,Bt=FSi,…`, that is
`isWindows, isMacintosh, isLinux, isLinuxSnap, isNative, isElectron, isWeb`).
In a browser it is false and `mNt()` returns an empty list without asking
anything. No setting governs it, and none is needed.

**Also added, out of caution and not because it fixes anything:**

```json
"terminal.integrated.fontLigatures.enabled": false
```

It is already the upstream default (`default:!1`), verified; setting it explicitly
closes the first path (`_refreshLigaturesAddon`) even if that default were to change.

`test.sh` § 7 replays the five searches: the two declarations with their
upstream default, the unconditional import of the sticky scroll, the call in
the addon, and the complete list of the files of the package that mention
`queryLocalFonts` — any new family of files makes the test fail
rather than making the prompt reappear.

## Status bar extension `heig.codespace-statusbar`

Feedback 3 of [docs/pistes.md](../../docs/pistes.md). Publisher `heig`, name
`codespace-statusbar`, version `0.1.0`. Source in `extension/`:
plain JavaScript, two useful files (`package.json`, `extension.js`), **no
dependency, no bundler, no network access, no telemetry**.

### What it displays

Two items on the right of the status bar:

1. **the remaining time** until the assignment deadline — "1 h 23 min left",
   refreshed every 30 s, warning colour
   (`statusBarItem.warningBackground`) under ten minutes, "Deadline passed"
   beyond it. The tooltip carries the local date and time of the container
   (`TZ=Europe/Zurich`) and the title of the assignment;
2. **"Close"** — command `codespace.close`, which opens the return URL with
   `vscode.env.openExternal`.

French as soon as `vscode.env.language` starts with `fr`, English otherwise.

### What it reads

Three of the seven environment variables that the portal sets at `podman run` time
(`src/sessions/manager.ts`, `CONTAINER_ENV_KEYS`, then `src/engine/index.ts`):

| Variable | Contents | Absent |
| --- | --- | --- |
| `CODESPACE_DEADLINE` | ISO 8601 deadline (`deadlineAt` from classroom, column `assignments.closes_at`) | no countdown |
| `CODESPACE_RETURN_URL` | `${CLASSROOM_URL}/` for a session born from a launch token, `${PUBLIC_URL}/` otherwise | no "Close" button |
| `CODESPACE_ASSIGNMENT_NAME` | title of the assignment | tooltip without the title |

**No secret goes in there** (invariant 1). A unit test
(`src/sessions/containerEnv.test.ts`) asserts that the portal never sets a
key outside `CONTAINER_ENV_KEYS`, and `test.sh` § 9 compares the environment of a
container started by the portal with that of a bare container: exactly seven
lines of difference, all of them in `CODESPACE_` or `GIT_`.

## Git identity of the student

Feedback from the real sessions of 2026-09-18: a student could not commit
from VS Code, their container having no git identity (`git config
user.name` empty), whereas the portal knows their name and their academic
address (table `users`, fed by the classroom launch token).

The portal therefore sets four more variables at `podman run` time:

| Variable | Source |
| --- | --- |
| `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` | `users.display_name`, failing that `users.login` |
| `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` | `users.email` |

**All or nothing**: without a usable address, none of the four is set —
half an identity would make git fall back on its automatic detection
(`student@<container name>`), which is worse than a clean absence. These are
not secrets: the student already reads both of them in classroom.

### Why the variables are enough, and what is written on top

Git honours `GIT_AUTHOR_*` / `GIT_COMMITTER_*` **without any configuration
file**: `test.sh` § 9 makes a real `git commit` inside the container and
checks that `%an|%ae|%cn|%ce` carries the four values, with a
`git config --local --get user.name` that stayed empty.

The VS Code git extension is satisfied with them too. Found in
`extensions/git/dist/main.js` of the image: it only reads `user.name` /
`user.email` **in the error branch**, to qualify a `git commit`
that has already failed —

```js
try{await this.exec(["config","--get-all","user.name"])}
catch(t){throw t.gitErrorCode=X.NoUserNameConfigured,t}
```

— and it launches git with `process.env` as its base, without filtering it:

```js
t.env=Sm({},process.env,this.env,t.env||{},
  {VSCODE_GIT_COMMAND:e[0],LANGUAGE:"en",LC_ALL:"en_US.UTF-8",LANG:"en_US.UTF-8",GIT_PAGER:"cat"});
```

The portal writes `user.name` / `user.email` into
`work/.git/config` **on top of that**, because a student who types `git config user.name` must
read something. It is done from the host as long as `work/` belongs to it
(before the first `:U`), and through `engine.exec` afterwards — same constraint, and
same mechanism, as the completion of the workspace. An identity already
set by the student is **never** overwritten.

### How it receives that environment

The code-server extension host is a Node process **of the server**, not of the
browser: the extension declares `"extensionKind": ["workspace"]` in order to run there,
and reads `process.env` there. The inheritance happens in two steps, both
verified by `test.sh` § 9:

1. `code-server` (pid 1, which carries the `-e` of the `podman run`) spawns the
   VS Code server (`out/node/entry`); the test reads
   `/proc/<pid of the server>/environ` and finds the three variables there;
2. that server forks the extension host, building its environment
   from its own. Found literally in `server-main.js` of the image:

   ```js
   …catch(g){o.error("ExtensionHostConnection#buildUserEnvironment resolving shell environment failed",g)}
   let c={...process.env, …, VSCODE_ESM_ENTRYPOINT:"vs/workbench/api/node/extensionHostProcess", …}
   ```

### Packaging and installation

The `.vsix` is built in a **multi-stage step** of the `Containerfile`
(`FROM node:22-slim AS vsix`, `npx @vscode/vsce@4.0.0 package
--allow-missing-repository`); only the `.vsix` goes into the final image, not
Node nor `vsce`. `--allow-missing-repository` is necessary: the extension is
not published and has no repository of its own.

It is then installed by `code-server --install-extension` **like the
two others**, into the same read-only directory. It therefore appears
in `code-server --list-extensions` and in `/etc/code-server/extensions.lock`
(the build fails if it is missing from it), and it is added to
`extensions.allowed` of the machine settings.

The hardening is intact: `test.sh` § 3 keeps checking that no
`.vsix` brought by the student installs, and that the extensions directory
— including that of the status bar extension — is not writable.

### Limits

- **`openExternal` opens a new tab.** In lab mode, the
  "Close" button closes nothing: it opens classroom (or the portal) in one more
  tab and leaves the editor behind. That is the behaviour of
  `vscode.env.openExternal` in VS Code Web, which has no way of closing
  the current tab. A real exit would require a portal page
  ("finish the session"); that is lead 2 of docs/pistes.md, out of
  scope here.
- **The countdown is indicative.** It does not close the session, does not block
  anything, and the time is that of the container. The portal does not use it: the
  opening window of an assignment stays decided on the server side
  (`sessions/store.ts`, `isOpen`).
- **The title of the command in the palette stays in French.** The strings
  displayed by the extension (status bar, tooltips, error message) are
  chosen at run time from `vscode.env.language`; the title declared by the
  manifest, on the other hand, is static. Localising it would require `package.nls.json` +
  `package.nls.fr.json`, a correct mechanism but one that cannot be verified without a browser;
  ruled out for a title the student does not need to read, the button being
  in the status bar.
- **An activation witness** is dropped into `/tmp/codespace-statusbar.json`
  (tmpfs) on activation, with the three variables as they were
  read. It is only there for diagnosis; it contains no secret and disappears
  with the container.

## Resolver: `/etc/resolv.conf` shipped by the image

A finding that came from P2: with `--dns=none` Podman writes no `/etc/resolv.conf`,
and libc then falls back on `127.0.0.1` with **five seconds of waiting per
attempt**. Any failed resolution — `curl`, `git`, a download attempted by
clangd — makes the student wait five seconds instead of failing right
away.

The image therefore ships a static `/etc/resolv.conf` **without any `nameserver`**,
with `options timeout:1 attempts:1`. Since the root filesystem is read-only, this
file comes from the image and the student cannot replace it: that is the point.

A detail that matters: the file is placed by `COPY`, **not** by `RUN`. During
a `RUN`, buildah mounts its own `/etc/resolv.conf` over it; a
`printf > /etc/resolv.conf` inside a `RUN` writes into the mount and disappears
with it. The first attempt was made that way, the image shipped without the file, the error
detected by comparing the contents at run time.

Measured on the pinned version (Podman 5.7.0):

| Launch | `/etc/resolv.conf` seen in the container | `getent hosts example.invalid` |
| --- | --- | --- |
| `--network none` (P1) | the one from the image | fails in ~2 ms |
| `--dns=none` (P2) | the one from the image | fails in ~2 ms |
| default bridge, without `--dns` | rewritten by Podman with the host resolver | resolves |

In other words `--dns=none` **does not overwrite** the file of the image, and
neither does `--network none`. `test.sh` § 8 makes two assertions out of it: absence of
`nameserver` in the file seen at run time, and failure of
`getent hosts example.invalid` in less than two seconds (measured: 0.16 s end
to end, including the `podman exec` call).

## Seccomp profile: `infra/seccomp/codespace.json`

Source: `/usr/share/containers/seccomp.json` of the workstation (package
`containers-common`, consistent with Podman 5.7.0). **A single entry added**,
nothing else modified, nothing removed, nothing reordered apart from the insertion:

```json
{
  "names": ["personality"],
  "action": "SCMP_ACT_ALLOW",
  "args": [{ "index": 0, "value": 262144, "valueTwo": 0, "op": "SCMP_CMP_EQ" }],
  "comment": "ADDR_NO_RANDOMIZE (0x40000): required by gdb set disable-randomization on (heig-codespace P1)",
  "includes": {},
  "excludes": {}
}
```

The five `personality` values already allowed by the upstream profile are
kept: `0`, `8`, `131072` (0x20000), `131080` (0x20008), `4294967295`
(0xffffffff). The added entry is inserted right after them. Diff verified by
set comparison of the 40 upstream entries → 41 project entries: one added,
zero removed, zero modified, head keys (`defaultAction`, `architectures`,
`archMap`) identical.

Regression covered by `test.sh` § 2: a control container started with the
**default** profile gives three different addresses for `main` over three
runs under gdb; with the project profile the address is stable at
`0x555555555139`. If the control stopped varying, `test.sh` would fail rather
than validate an empty assertion.

## AppArmor profile: `infra/apparmor/codespace`

### The defect (2026-09-18)

The portal VM moved to kernel **7.0.0-31-generic** on 2026-09-17. Since then
`gdb` inside a student container fails on the first `run`:

```text
warning: ptrace: Permission denied
```

with, in the kernel audit log:

```text
apparmor="DENIED" operation="ptrace" class="ptrace"
  profile="containers-default-0.66.0" pid=52042 comm="gdb"
  requested_mask="trace" denied_mask="trace"
  peer="containers-default-0.66.0//&crun"
apparmor="DENIED" operation="signal" class="signal"
  profile="containers-default-0.66.0" comm="MainThread"
  requested_mask="send" denied_mask="send" signal=term
  peer="containers-default-0.66.0//&crun"
```

Podman's built-in profile allows `ptrace (trace,read) peer=<its own name>` and
nothing more. On this kernel the traced process carries a **stacked** label,
`containers-default-0.66.0//&crun` — the runtime's profile stacked onto the
container's, `//&` being the stack separator. The bare peer name does not match
the stacked label, so both the trace and the `SIGTERM` gdb sends to its inferior
are denied.

### Why `--cap-add=SYS_PTRACE` does not help

Measured on the VM with throwaway containers started by `run-hardened.sh`:

| Run | Result |
| --- | --- |
| default (`--cap-drop=ALL`) | `ptrace: Permission denied` |
| `--cap-add=SYS_PTRACE` | **still** `ptrace: Permission denied` |
| `--security-opt apparmor=unconfined` | `Breakpoint 1, main () at t.c:1` |

The capability check is passed long before the LSM check, and it is the LSM that
refuses; `kernel.yama.ptrace_scope=1` is not the cause either, since a process
tracing its own descendant satisfies Yama. Only the AppArmor peer match is
missing. Running unconfined is not an option: it would drop every `deny` rule of
the built-in profile at the same time (mounts, `/proc` and `/sys` writes).

### What the project profile changes

`infra/apparmor/codespace` is the `containers-default` template of
containers/common, expanded with `.Name = codespace`, transcribed **rule for
rule**: every `deny` is kept as it is. Two things change, and only those:

```text
ptrace  (trace,read,tracedby,readby) peer=codespace,
ptrace  (trace,read,tracedby,readby) peer=codespace//&*,
signal  (send,receive)               peer=codespace,
signal  (send,receive)               peer=codespace//&*,
```

`//&*` matches every stacked label whose first element is this profile,
`codespace//&crun` included; the unstacked peer keeps the plain case.
`tracedby`/`readby` are the tracee's side of the mediation, and both ends carry
a label of this profile. There is **no** `ptrace peer=unconfined` and no
unqualified `ptrace,`: a student debugs their own processes, never a host
process and never another profile. The same fix in the same shape was applied
upstream to the cri-containerd profile for kernel 6.17+ stacking
([canonical/k8s-snap#2750](https://github.com/canonical/k8s-snap/pull/2750)).

The source of the template could not be fetched at the exact version the VM
reports (`0.66.0`): containers/common publishes no `v0.66.0` tag. The
transcription comes from `v0.64.2`, whose
`pkg/apparmor/apparmor_linux_template.go` is byte-identical to `main`; the file
has not changed in that window. The profile carries its own header with the
sources.

### Loading and checking it

```bash
sudo install -m 0644 infra/apparmor/codespace /etc/apparmor.d/codespace
sudo apparmor_parser -r /etc/apparmor.d/codespace   # replace: idempotent
sudo apparmor_parser -Q /etc/apparmor.d/codespace   # parse only, no load
aa-status | grep codespace
```

`deploy/bootstrap.sh` § 7bis does the install and the load, and
`deploy/push.sh` reloads it right after the `infra/` rsync, so a change to the
profile ships **without** `--bootstrap`. A container already running keeps the
profile it was started with; the next session picks the new one up.

`run-hardened.sh` passes `--security-opt apparmor=$APPARMOR`, `codespace` by
default. `APPARMOR=` (empty) drops the flag — that is what the WSL2 development
workstation, which has no AppArmor, needs — and `APPARMOR=unconfined` gives the
witness run of the table above. The engine does the same from
`CODESPACE_APPARMOR_PROFILE`; empty there too means no flag, because `podman
run` refuses a profile name the kernel has not loaded. `test.sh` § 4 asserts
that the container's label under `/proc/self/attr/apparmor/current` is
`codespace`, and skips with a note when the host has no AppArmor.

## Deviations accepted from the letter of jalon-0 § P1

None of them weakens the hardening; all of them are checked by `test.sh`.

1. **`--dns=none` is not set when `--network none` is.** Podman 5.7 refuses the
   combination: `Error: conflicting options: dns and the network mode: none`.
   `run-hardened.sh` adds `--dns=none` as soon as `NETWORK != none`, so P2 will
   see it. With `--network none` there is no resolver anyway.
2. **`--tmpfs /run` and `--tmpfs /home/student/.cache` carry `mode=1777`.**
   Podman mounts `/run` as `mode=755 root:root` and named tmpfs without `mode`
   inherit `root:root`; the container runs as uid 1000 and could write
   neither its `user-data-dir` nor its cache (observed failure:
   `mkdir: cannot create directory '/run/code-server': Permission denied`).
   `uid=`/`gid=` are not `--tmpfs` options accepted by Podman
   (`unknown mount option "uid=1000"`), and `tmpcopyup` does not carry ownership over.
   The other flags (`rw,nosuid,nodev`) are Podman's own.
3. **Packages added to the list of jalon-0**: `libc6-dev`, `binutils`
   (real dependencies of the C toolchain), `curl` + `ca-certificates` (download
   of the `.deb` at build time, and the `/healthz` assertion of the test), `procps`, `less`.
4. **`/home/student/.local/share/code-server/coder-logs` is a symbolic
   link to `/run/code-server/logs`.** Without it, code-server raises an
   uncaught exception at start-up while trying to write its logs onto the
   read-only root. The rest of `~/.local/share/code-server` stays on
   the read-only root, so the **default** extensions directory
   is not writable — that is the point of docs/analyse.md § 3.2, and
   `test.sh` makes an assertion out of it.
5. **`XDG_CONFIG_HOME` is redirected to the tmpfs, but only in
   `entrypoint.sh`**, never in an `ENV` of the image. The student's shell
   keeps the default values: their `code-server --install-extension` does target
   a read-only extensions directory.
6. **`/etc/resolv.conf` is shipped by the image** (previous section), which
   jalon-0 § P1 did not ask for: without it, `--dns=none` costs five seconds on
   every failed resolution.
7. **`/etc/dpkg/dpkg.cfg.d/heig-man-pages`** re-enables `/usr/share/man` before
   the packages are installed: the `slim` image excludes it through dpkg and
   `manpages-dev` was installed without its pages. The other exclusions of the
   slim image (doc, locale, info) are kept.

## TODO(verify)

Marked according to the convention of CLAUDE.md: version concerned in parentheses.
No setting has been removed; those whose effect could not be observed are
listed here.

- `TODO(verify)` **code-server 4.137.0 / VS Code 1.137.0** — `extensions.allowed`:
  the key exists in the embedded package, but its effect (refusal of an extension
  outside the list) has not been observed. The test only checks that it is present in
  the copied settings. The barrier that holds is the read-only extensions directory,
  and that one is measured. To be checked when a real session is
  opened in a browser.
- `TODO(verify)` **code-server 4.137.0 / VS Code 1.137.0** — `chat.disableAIFeatures`:
  likewise, key present in the package, effect not observed. No chat
  extension is installed, so the impact is nil as things stand.
- `TODO(verify)` **code-server 4.137.0** — actual scope of the
  `Machine/settings.json` file: only settings with `MACHINE` or
  `APPLICATION` scope are honoured there, and the classification of each of the seven keys has
  not been collected from the minified code. Practical consequence to know:
  **a student can modify these settings from the interface during their
  session**; they are reset at the next container start since
  the `user-data-dir` is a tmpfs. Strict immutability would require
  "policy" support that code-server 4.137.0 does not expose.
- `TODO(verify)` **code-server 4.137.0** — `--disable-file-downloads` and
  `--disable-file-uploads` are indeed present in `--help` but their effect
  (drag and drop and "Download" in the context menu) requires a browser;
  that is a manual verification for milestone 1, to be recorded together with proof B.
  Second layer already planned: `allowDownUploads: false` on the SEB side
  (docs/analyse.md § 4.3).
- `TODO(verify)` **clangd 19.1.7 + extension 0.6.0** — does the language server
  start without `compile_commands.json` and without network? The default
  configuration is placed at both paths that clangd actually reads
  (`/home/student/.config/clangd/config.yaml` in the image, and
  `$XDG_CONFIG_HOME/clangd/config.yaml` copied by the entry point, which
  the extension host inherits), but its effect has not been observed for lack of a
  session in a browser. To be taken up again at milestone 1.
- **Settled** (was a `TODO(verify)` for **webfreak.debug 0.27.0**) — no gdb launch
  configuration is shipped in the image, and that is the decision: the
  `launch.json` lives in the teacher's template repository, not in a machine file.
  It is there in both seed templates
  (`seed/templates/tp-pointeurs/.vscode/launch.json`,
  `seed/templates/exam-c/.vscode/launch.json`), as asked for by
  [docs/jalon-0.md](../../docs/jalon-0.md) § V1 and as observed by the
  end-to-end test ([docs/v1.md](../../docs/v1.md) § 2, step 3).
- `TODO(verify)` **VS Code 1.137.0** — `workbench.secondarySideBar.defaultVisibility:
  hidden`: the key, the enumeration and the upstream default are collected from the
  embedded package, but the effect (bar absent on opening) requires a
  browser. To be observed at the next real session.
- `TODO(verify)` **VS Code 1.137.0** — `keyboard.dispatch: keyCode`: the
  declaration carries `included: jo===2||jo===3`, where `jo` is the operating
  system that was detected (`var jo = … ? 2 : … ? 1 : 3`, that is macOS / Windows /
  Linux). The key is therefore only **registered** for macOS and Linux; on a
  Windows machine it stays a key unknown to the configuration registry. The
  reader (`s.getValue("keyboard")?.dispatch === "keyCode"`) reads the raw
  configuration and should see it anyway, but that has not been
  observed. To be checked on a Windows machine, which is the platform of the exam
  room.
- `TODO(verify)` **code-server 4.137.0** — the extension host could not be
  started without a browser. `test.sh` § 9 measures the inheritance up to the **server**
  of VS Code, which is the process that forks the extension host, and collects from
  the package the fact that this fork starts from `{...process.env}`. The final link is observed
  by opening the editor: the countdown displayed **is** the proof, and
  `podman exec <container> cat /tmp/codespace-statusbar.json` makes it readable.
  Two attempts at driving a headless Chromium (chrome-headless-shell
  and Chrome for Testing 153) stopped at the management connection, without
  ever reaching the extension host connection.
- `TODO(verify)` **heig.codespace-statusbar 0.1.0 under SEB** — in exam mode,
  `vscode.env.openExternal` asks the browser to open a URL. Under Safe Exam
  Browser, the URL filter may refuse the opening, or open it in an
  extra window that the student will not know how to close. Behaviour to be
  observed at the first rehearsal in the exam room. The classroom domain is already
  allowed by the filter (`sebAllowedHosts`), so the refusal, if it happens,
  will come from SEB's window policy, not from the host filter.

- `TODO(verify)` **VS Code 1.137.0** —
  `terminal.integrated.stickyScroll.enabled: false`: the chain of causes is
  collected from the embedded package and replayed by `test.sh`, but the effective
  disappearance of the "Use the fonts on your computer" prompt requires a
  browser. To be observed at the next real session. Accepted side effect:
  the student loses the reminder of the running command at the top of the terminal.
- `TODO(verify)` **code-server 4.137.0** — the git identity as seen **by the VS Code
  git extension**: reading the package says that `process.env` is passed
  as it is to the extension's `git commit`, and `test.sh` § 9 measures the commit on
  the command line. The "Commit" button of the interface, on the other hand, requires a
  browser; to be observed at the next real session.

## What P1 does not cover

- The network: `run-hardened.sh` starts with `--network none`. The closed
  `codespace` network, the nftables rules and `--add-host portal.internal` are
  task P2. `test.sh` therefore measures no network property.
- `CAP_SYS_PTRACE` stays dropped (docs/analyse.md § 3.5): `gdb ./prog`
  works, `gdb -p <pid>` on a process from another terminal will not
  work. That is the decision, not a defect.
- The image size (1.5 GB) is dominated by code-server (723 MB installed).
  No effort at reduction has been made: the image is local, the `podman run`
  does not transfer it.
