# Leads and options noted along the way

Notes from 2026-09-17, to be sorted out milestone after milestone. Nothing here is committed to; these are the trade-offs discussed after milestone 0, written down so as not to lose them.

## Hosting

Sizing for twenty sessions: 8 vCPU, 16 GB, 80 GB are enough (measured: a few hundred MB per idle session, CPU bursts on compilation). The 32 GB of the framing document are margin.

Monthly prices excluding VAT, collected on 2026-09-17 (Hetzner raised its rates on 15 June 2026, by up to ×2.7 on CPX/CCX):

| Offer | vCPU | RAM | Price |
| --- | --- | --- | --- |
| Hetzner CX43, shared | 8 | 16 GB | €15.99 |
| Hetzner CX53, shared | 16 | 32 GB | €29.49 |
| Hetzner CCX33, dedicated | 8 | 32 GB | €138.49 |
| DigitalOcean Basic | 8 | 16 GB | $96 |
| AWS / Azure 8 vCPU on demand | 8 | 32 GB | ≈ $0.40 to 0.55 per hour + disk |

Position: one shared Hetzner VM always on for the labs; for exams, a dedicated machine created through the API the day before and destroyed in the evening (≈ €2 for the day) rather than a dormant dedicated one. Orchestrating "start the VM on demand" only becomes worthwhile below a few dozen hours of use per month and costs real development work (milestone 5).

To be checked before deciding: the Azure credits of the HEIG-VD institutional agreement (Azure Switzerland North and AWS Zurich also settle the question of data residency in Switzerland). Neither Hetzner nor DigitalOcean has a Swiss region; Infomaniak and Exoscale not quoted.

## Integration into heig-classroom (decided)

The portal moves into the heig-classroom monorepo as a second application (`apps/codespace`), through `git subtree` to keep the history, at milestone 2. Import rule: `apps/codespace` only imports the shared packages (`packages/contracts`, `packages/domain`, later the UI), never `apps/server`. Separate deployments: classroom on its small VM, the container engine on a dedicated VM, linked by a signed launch token.

On the classroom side:
- an assignment gains a working mode: free (the current flow), online (sessions in the portal, push relayed by the GitHub App), online under SEB (SEB verification required);
- in online mode, the student repository is created **without write access** for the student: no student credential to manage, the relay pushes with the installation token, the grading CI triggers normally;
- the Start button is on the classroom interface, a single interface for the student;
- the feature is **enabled by the administrator, teacher by teacher**, with a quota of active sessions per teacher and a global quota. Teachers who are not entitled do not see the option. This allows a pilot with one or two students without touching the other schools.

Interface term to be chosen: "codespace" collides with GitHub Codespaces; "online environment" or "workshop" are candidates.

## Features discussed, proposed order

1. **Student profile**: VS Code user settings (theme, font, keybindings) persisted per student on the host and mounted into the container; in exam mode, only an allowlist of keys is copied over (snippets and the free text of the settings are a cheat-sheet channel). No preferences screen in the portal.
2. **Session buttons** on the home page: go back to the editor, finish (container stopped, volume kept). In an exam, a "submit and quit" route that checks the relay of the last push then redirects to SEB's exit URL.
3. **Image catalogue**: `vi`, `perl`, `hexdump`, `xxd` go into the base image; Python, uv, Typst into derived images through `FROM`, built by CI, chosen by name in the assignment. Ruled out: composable tool groups (a build per assignment), a `.codespace` file in the student repository (the student would choose their image in lab mode; if it ever exists, it will be read from the template repository only), a Containerfile submitted through a form (arbitrary build as root on the host).
4. **VS Code status bar extension** (portal / submit): after the first exam rehearsal in the exam room.
5. **Visual identity**: follows from the monorepo (shared React components at milestone 4); in the meantime, copy the CSS variables of classroom into the HTML pages.

## Feedback from the first real trial (2026-09-17, test classroom)

A session opened from classroom by a real account, VS Code served, push relayed to GitHub by the GitHub App. Three pieces of interface feedback, all to be dealt with in the image (machine settings and extension), not in the portal:

1. **Empty secondary side bar** open by default (it used to host the chat, which is disabled): to be hidden at start-up through a machine setting; exact name of the setting to be checked in the embedded 1.137 version.
2. **Keyboard layout detected as "Swiss German"**: VS Code Web has no French-Swiss layout. Typing is not affected, only some keybindings are; set `keyboard.dispatch: keyCode` in the image.
3. **Status bar extension** (already lead 4 above, now a priority): countdown to the assignment deadline and a "Close" button that leads back to classroom. The portal passes the deadline and the return URL to the container at start-up (environment variables or machine settings file); the extension is baked into the image and into the allowlist.

### Dealt with on 2026-09-18 (branch `feat/codespace-image-ux`)

The three points above are done. Details, proofs and limits in
[images/c-dev/README.md](../images/c-dev/README.md).

1. **Done.** `workbench.secondarySideBar.defaultVisibility: "hidden"` in the machine settings. The name, the enumeration and the upstream default (`visibleInWorkspace`) were collected by `grep` in the embedded VS Code 1.137.0 package; `test.sh` § 7 replays the search. Visual effect to be observed in a browser: `TODO(verify)`.
2. **Done.** `keyboard.dispatch: "keyCode"`, same verification method (`enum:["code","keyCode"]`, default `code`). Typing is not affected, which is noted in the image README. Reservation collected and noted as `TODO(verify)`: the declaration carries `included: jo===2||jo===3`, so the key is only registered for macOS and Linux — to be checked on a Windows machine, which is the platform of the exam room.
3. **Done.** Extension `heig.codespace-statusbar` 0.1.0, plain JavaScript, packaged into a `.vsix` by a multi-stage step (`node:22-slim` + `@vscode/vsce` 4.0.0) then installed like the two others, hence listed by `--list-extensions` and added to `extensions.allowed`. The portal sets three variables at `podman run` — `CODESPACE_DEADLINE` (the assignment deadline), `CODESPACE_RETURN_URL` (classroom if the session was born from a launch token, the portal otherwise), `CODESPACE_ASSIGNMENT_NAME` — and **nothing beyond the seven keys of `CONTAINER_ENV_KEYS`**: these three plus the four `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}` of the git identity added the same day (section below). A unit test and `test.sh` § 9 assert it, as invariant 1 requires.

What this does not settle, and what stays in lead 2 above: "Close" opens
a tab towards the return URL, it does not end the session. A real
"finish" route (container stopped, volume kept) still has to be written on the portal side.

## Feedback from the real sessions of the evening of 2026-09-17 (dealt with on 2026-09-18, branch `feat/codespace-git-identity`)

Two student sessions on the `code.chevallier.io` VM, plus one smoke
session. Four findings, all dealt with; proofs and limits in
[images/c-dev/README.md](../images/c-dev/README.md).

1. **No git identity inside the container.** A student could not commit
   from VS Code: `git config user.name` empty, whereas the portal knows
   their name and their academic address. **Done**: the `podman run` sets
   `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
   `GIT_COMMITTER_EMAIL` from `users.display_name` and `users.email` — git
   honours them without any configuration file, and the VS Code git extension launches
   git with `process.env` as its base (collected from the package). On top of that,
   `work/.git/config` receives `user.name` / `user.email` if they are missing, from
   the host before the first `:U`, through `engine.exec` afterwards. An identity set
   by the student is never overwritten. `CONTAINER_ENV_KEYS` goes from three to
   seven keys, none of which is a secret (invariant 1).

2. **"Use the fonts on your computer" prompt when opening the editor.**
   **Done**: `terminal.integrated.stickyScroll.enabled: false`. The cause was
   looked for in the embedded package: the terminal sticky scroll loads
   `@xterm/addon-ligatures` **unconditionally** — it does not look at
   `terminal.integrated.fontLigatures.enabled` —, and that addon calls
   `window.queryLocalFonts()`. The setting is `true` upstream, hence the prompt
   without anyone having asked for ligatures. The second caller of
   `queryLocalFonts` (font suggestions of the settings editor) is guarded
   by `isElectron`, false on the web: it does not run. Visual effect to be observed
   in a browser: `TODO(verify)`.

3. **Relay towards an organisation without a GitHub App: 517 attempts, one `warn`
   per minute, indefinitely.** The "`pending`, never `failed`" behaviour
   is intended — the submission never had a destination, this is not a breakdown —,
   the cadence was not. **Done**: for a `ForgeUnconfiguredError`, a clean backoff,
   exponential from one minute and **capped at one hour**, and a single `warn`
   per change of cause instead of one per attempt. The other errors
   keep the existing policy (attempt budget, `failed` on
   exhaustion, one `warn` per attempt).

4. **Assignment row in the classroom student view.** The
   "Online environment" badge on the name row cluttered the title, and the
   "Open your repository" button has no purpose in online mode (the student
   only has read access, or nothing at all under SEB). **Done**: the mode moves below
   the name as small text with a discreet icon, the repository button disappears as soon
   as the mode is not free (the name stays a discreet link in `online` mode,
   nothing in `online_seb`), and "Start" remains the only primary button, aligned
   like the other actions. Card view and list view. **The free mode is
   strictly unchanged**, and a test asserts it
   (`apps/web/src/StudentHome.test.ts`).

## Correction to the framing document raised by the SEB test

SEB's URL filter must allow the domain of the identity provider (Switch edu-ID) in addition to that of the portal, otherwise the login page is blocked. The framing document spoke of a single domain rule.

## Kernel 7.0.0-31 and AppArmor (2026-09-18)

The portal VM moved to `7.0.0-31-generic` on 2026-09-17. On the following day, gdb
inside the student containers stopped working: `warning: ptrace: Permission denied`,
with `apparmor="DENIED" operation="ptrace" profile="containers-default-0.66.0"
comm="gdb" requested_mask="trace" peer="containers-default-0.66.0//&crun"` — and the
same denial on `signal=term`. On this kernel the traced process carries a **stacked**
label, `<profile>//&crun`, and Podman's built-in profile only allows
`ptrace (trace,read) peer=<its own bare name>`. The peer does not match, so the
operation is refused.

Measured with throwaway containers from `images/c-dev/run-hardened.sh`: default →
denied; `--cap-add=SYS_PTRACE` → **still** denied (the capability check is passed
long before the LSM check); `--security-opt apparmor=unconfined` → gdb works. Running
unconfined was not an option: it would drop every `deny` rule of the built-in profile
at the same time.

**Fixed** by a dedicated profile, `infra/apparmor/codespace`: the `containers-default`
template of containers/common transcribed rule for rule, every `deny` kept, with the
ptrace and signal peers widened to the stacked labels of the same profile
(`peer=codespace` and `peer=codespace//&*`, plus the tracee side `tracedby,readby`).
No ptrace towards `unconfined` or any other profile. Same shape as the upstream fix
for cri-containerd on kernel 6.17+
([canonical/k8s-snap#2750](https://github.com/canonical/k8s-snap/pull/2750)).
`bootstrap.sh` installs and loads it, `push.sh` reloads it on every push,
`CODESPACE_APPARMOR_PROFILE` (empty on the WSL2 workstation) selects it, and
`test.sh` § 4 asserts the container's label.

**Two things left open.** (1) `containers/common` publishes no `v0.66.0` tag, so the
template was transcribed from `v0.64.2`, which is byte-identical to `main`; if the
0.66.0 body ever turns out to differ, the profile has to be rebased on it. (2) The
profile has **not** been run through `apparmor_parser -Q` here — the development
workstation is WSL2 and has no AppArmor. That check belongs to the first deployment.
