# Milestone 0 and portal v0: breakdown for agents

Follow-up to [analyse.md](analyse.md). Every task has an input, an output and an executable acceptance criterion. Tasks P1 to P4 are independent and can be started in parallel; V1 assembles them. No graphical interface before V1, and V1 only has HTML pages served by Fastify.

Manual prerequisites, done on 2026-09-17 on the development workstation: Podman 5.7 rootful, netavark, `containers` range in `/etc/subuid`, socket accessible to the `podman` group, remote connection by default. Procedure in [setup-poste.md](setup-poste.md).

Results already obtained on this workstation, which the agents do not have to demonstrate again but must preserve in their tests: `internal` network + `--gateway` → host reachable on the gateway and no outbound route; `--dns=none` → no resolution; `--userns=auto` → a distinct host UID range per container; inter-container traffic **open** as long as the nftables rule is not in place.

## State as of 2026-09-17

| Task | State | Proof |
| --- | --- | --- |
| P1 hardened image | done | `images/c-dev/test.sh`: 47 green assertions, 1 s start-up |
| P2 closed network | done | `sudo infra/net/test.sh`: 11 PASS, 0 FAIL, 0 BLOCKED (9 assertions + 2 regressions), nftables rules loaded |
| P3 Git channel | done | `vitest src/git`: 56 tests, 5 of which are Podman + Forgejo integration tests |
| P4 SEB verification | done | `vitest src/seb`: 91 tests, 4 Config Key vectors sourced from Moodle |
| V1 portal v0 | done | `scripts/e2e.sh`: 57 green assertions against Keycloak, Forgejo and real containers (reproduced twice); report in [v1.md](v1.md) |

Full suite: `pnpm typecheck` green, `pnpm test` 237 green tests (17 files). Start → workbench 0.93 s, → websocket 0.96 s, push → Forgejo 0.24 s. Permanent containers on the workstation: `codespace-anchor` (bridge `cs0`), `infra_forgejo_1` (development forge, token in `.env`).

### Instructions for V1 coming out of P1 to P4

- `engine/` starts the image `codespace/c-dev:4.137.0` with exactly the options of `images/c-dev/run-hardened.sh` (reuse them, do not rewrite them), plus `--network codespace --dns=none --add-host portal.internal:10.77.0.254` and the label `heig-codespace.session=<id>`. The `codespace-anchor` container (label `heig-codespace.role=anchor`) must be ignored by the garbage collector and by the reconciliation.
- The Git service (`startGitServer` of `src/git`) binds to `CODESPACE_GATEWAY`; its `SessionLookup` and `stagingTargets` interfaces plug into the `Session` table and into the assignment. `src/git/db.ts` disappears in favour of `db/client.ts` + drizzle-kit migrations; `db/schema.ts` already contains `push_events`.
- `sebRoutes` of `src/seb` registers with an `AssignmentLookup` and an `onStart`; the proxy calls `checkExamRequest` (cookie only, invariant 5). Variables to add to `.env.example`: `SEB_PUBLIC_ORIGIN`, `EXAM_COOKIE_SECRET`.
- The code-server machine settings are not immutable (P1 README): the host-side shadow repository is the real E15 safety net, to be implemented in V1 as planned.
- `webfreak.debug` has no `launch.json`: provide one in the template repository of the test assignment.
- Replace `docker.io/alpine/git` with `codespace/c-dev` in `channel.integration.test.ts`.

## Target tree

```
apps/codespace/
├── CLAUDE.md                  invariants and conventions for the agents
├── project.md                 framing document (do not modify)
├── docs/                      analysis, milestones, ADRs
├── src/                       Fastify + TypeScript, the only application code
│   ├── server.ts
│   ├── auth/              OIDC (openid-client), development user selector
│   ├── engine/            podman CLI wrapper, the single module that knows Podman
│   ├── proxy/             /s/<session>/* → code-server, websockets
│   ├── git/               http-backend CGI, staging repository, relay
│   ├── seb/               BEK/CK verification, real and simulated, .seb generation
│   ├── sessions/          state, heartbeat, garbage collector, reconciliation
│   └── db/                Drizzle + SQLite
├── images/c-dev/              Containerfile of the student image
├── infra/
│   ├── nft/codespace.nft      fixed rules (ICC, bridge input)
│   ├── seccomp/codespace.json default profile + personality(0x40000)
│   └── compose.dev.yml        Forgejo
└── seed/                      YAML assignments, test users
```

## P1. Hardened student image, working gdb

**Output**: `images/c-dev/Containerfile`, `infra/seccomp/codespace.json`, script `images/c-dev/run-hardened.sh` which starts the image with all the hardening options.

Contents of the image: Debian stable slim, `gcc gdb make git man-db manpages-dev clangd`, code-server (pinned .deb release), user `student` uid 1000, extensions preinstalled from Open VSX into `/opt/code-server/extensions` (`llvm-vs-code-extensions.vscode-clangd`, `webfreak.debug`), machine settings in `/etc/code-server/settings.json` (`files.autoSave: afterDelay`, `files.autoSaveDelay: 1000`, `extensions.autoUpdate: false`, `update.mode: none`, `telemetry.telemetryLevel: off`, `chat.disableAIFeatures: true` if the version knows it).

Entry point: copy of the machine settings into the `user-data-dir` (tmpfs), then `code-server --auth none --bind-addr 0.0.0.0:8080 --disable-file-downloads --disable-file-uploads --disable-workspace-trust --disable-update-check --disable-getting-started-override --extensions-dir /opt/code-server/extensions --user-data-dir /run/code-server /work` with `EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'`. Check that every option exists in the pinned version; remove none of them without noting it in the docs.

Launch options: `--userns=auto --cap-drop=ALL --security-opt no-new-privileges --security-opt seccomp=infra/seccomp/codespace.json --read-only --tmpfs /tmp --tmpfs /run --tmpfs /home/student/.cache --pids-limit 256 --memory 1536m --cpus 1 --dns=none -v <vol>/work:/work:U`.

**Acceptance** (script `images/c-dev/test.sh`, run inside the container started by `run-hardened.sh`):

- `gcc -g -O0 hello.c && gdb -batch -ex run -ex bt ./a.out` finishes without "Operation not permitted" and `gdb -batch -ex 'show disable-randomization'` answers `on`.
- Two successive runs of a program that prints `&main` under gdb give the same address.
- `code-server --install-extension /tmp/x.vsix` fails (read-only directory) and a fake `.vsix` written into `/work` does not install either.
- `touch /usr/bin/x` fails, `cat /proc/self/status | grep CapEff` is `0000000000000000`.
- `id -u` inside the container is 1000; `podman top <ctr> huser` shows a host UID outside the 0–65535 range; two containers started side by side have different host UIDs.
- A `:(){ :|:& };:` is killed by the process limit without affecting the host.
- `curl http://localhost:8080/healthz` answers from inside the container.

## P2. Closed network: proof C, network part

**Output**: `infra/nft/codespace.nft`, script `infra/net/setup.sh` (creates the `codespace` network with `--internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254`, loads the nft table), script `infra/net/test.sh`. The explicit gateway is mandatory: without it the bridge has no address and the host is unreachable. Containers get `--add-host portal.internal:10.77.0.254`.

**Acceptance** (`infra/net/test.sh`, starts two containers of the P1 image on the `codespace` network and a test HTTP server on the host bound to 10.77.0.254:9418 and another one on 10.77.0.254:9999):

- From container A: `curl -m 3 http://10.77.0.254:9418/` succeeds.
- `curl -m 3 http://10.77.0.254:9999/` fails (input rule).
- `curl -m 3 http://1.1.1.1/`, `curl -m 3 https://github.com/` fail in less than three seconds (no route).
- `getent hosts github.com` fails; `getent hosts portal.internal` succeeds through `--add-host`.
- `curl -m 3 http://<ip of B>:8080/` fails (ICC rule) whereas the same `curl` from the host succeeds.
- The test is green with an **empty** nft table apart from the two fixed rules, and red if either of the two rules is removed (the test must check both regressions).

Should the ICC rule in the `bridge` family turn out to be ineffective under netavark, a documented fallback: one `internal` network per session. Do not spend more than half a day on the rule before switching.

## P3. Git channel: proof C, Git part

**Output**: `src/git/` with `httpBackend.ts` (CGI towards `git http-backend`), `staging.ts` (creation and seeding of the staging repository), `relay.ts` (push to the forge with an authorization header), `pushEvents.ts`; vitest tests.

Rules: the remote on the container side is `http://portal.internal:9418/git/<sessionId>`. Authentication is the source IP, compared with the one recorded for the session; any other IP gets a 403. `http.receivepack=true` on the staging repository; `http.uploadpack` driven by the assignment (true by default). After every successful receive-pack, `for-each-ref` then insertion of one `PushEvent` per modified ref **before** scheduling the relay. The relay uses `git push` with `-c http.extraHeader=Authorization: ...`; the token never goes to disk nor into a command line visible in `ps` (pass it through the `GIT_CONFIG_PARAMETERS` environment variable or through a 0600 temporary file held in memory).

In development, the target forge is Forgejo in `compose.dev.yml` with a personal access token; the `Forge` interface has two implementations (`forgejo`, `github` through `octokit` and an installation token).

**Acceptance**:

- Integration test: a P1 container on the P2 network does `git clone http://portal.internal:9418/git/<s>` (seeded from a local template repository), commits, pushes; the `PushEvent` shows up in the database with the right sha; the commit shows up in Forgejo less than ten seconds later.
- The same push from the host (IP outside the session) gets a 403.
- Forgejo stopped: the student's push still succeeds, the `PushEvent` is in state `pending`, then moves to `relayed` when Forgejo comes back.
- A `grep -r` for the token in `/proc/*/cmdline` and on the host disk during a relay finds nothing.
- Assignment with `uploadpack: false`: `git fetch` gets a clean error, `git push` works.

## P4. SEB verification: proof B

**Output**: `src/seb/` with `configKey.ts` (normalisation and hashing, ported from `quizaccess_seb`), `verify.ts` (interface `SebVerifier`, implementations `real` and `simulated`), `sebFile.ts` (generation of the `.seb`: `startURL`, `URLFilterRules`, `allowDownUploads: false`, `enablePrivateClipboard: true`, kiosk, `sendBrowserExamKey: true`), route `GET /exam/<assignment>.seb` and `sebs://` link.

Verification semantics: on `GET /exam/<assignment>/start`, require `X-SafeExamBrowser-ConfigKeyHash == sha256(urlWithoutFragment + configKey)` and `X-SafeExamBrowser-RequestHash == sha256(urlWithoutFragment + bek)` for **one** of the accepted BEKs of the assignment. Success: signed `exam_session` cookie, bound to the assignment identifier and to the client address. The `/s/<session>/*` proxy **never** looks at a SEB header: it requires the cookie, checks the address, and otherwise refuses with an explicit "session outside SEB" page. The `simulated` mode accepts an `X-Dev-SEB: ok` header in development only, and is **impossible to enable** if `NODE_ENV=production` (a test asserts it).

**Acceptance** (vitest, both implementations):

- Config Key test vectors: at least three configurations whose expected key was obtained through the SEB configuration tool or through the `quizaccess_seb` test suite. Changing a single setting changes the key.
- Request without header, with a forged header, with a modified URL (fragment, reordered query), with a BEK from another version: all refused with a 403 and logged.
- A valid cookie presented from another client address: refused.
- The generated `.seb` reloads as JSON and yields the same Config Key (idempotence).
- Manual test documented in `docs/preuve-b-manuelle.md`: open the `sebs://` link from a real SEB, get the editor; copy the session URL into Edge, get the refusal.

## V1. Portal v0: a fictitious student starts, writes, compiles, pushes

Assembles P1 to P4. Without a teacher interface, without a pool, without an active exam mode (the P4 verification is wired but the test assignment is in lab mode).

Components:

- `auth/`: `openid-client` against the development Keycloak (realm reused from heig-classroom, client `codespace-portal`). Role derived from a realm attribute. User selector in development = a plain logout link, Keycloak does the rest.
- `engine/`: wrapper around `podman --remote --url unix:///run/podman/podman.sock ... --format json`. Never bare `podman`: without `--remote` the binary silently falls back to local rootless.
- `sessions/`: table `Session` (student, assignment, container, ip, state, last heartbeat, cookie). `POST /assignments/<a>/start`: creates or resumes the session, `engine.run(...)`, waits for the container's `/healthz`, redirects to `/s/<session>/`. Heartbeat: the proxy updates `lastSeen` on every request; garbage collector every minute; 10 min grace then destruction of the container, volume kept. At portal start-up: `podman ps --filter label=heig-codespace.session --format json` and reconciliation with the database.
- `proxy/`: `@fastify/http-proxy` with `websocket: true`, upstream `http://<container ip>:8080`, prefix `/s/<session>` stripped; refusal without a valid session cookie.
- Shadow repository: a task every three minutes, `git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A && commit`, excluding `.git`.
- HTML pages: list of open assignments with a Start button; table `/teacher/sessions` (state, last heartbeat, last push, Close button).
- `seed/assignments.yaml`: one lab assignment (`uploadpack: true`, local template), one exam assignment (`mode: exam`, test BEK, `uploadpack: true`, template only).

**Acceptance** (script `scripts/e2e.sh` + Playwright or curl tests):

- Keycloak login as `student`, click Start, editor loaded in less than ten seconds (measurement printed by the script).
- In the code-server terminal: write `hello.c`, `make`, `gdb`, `git push`; the commit is in Forgejo; `PushEvent` in the database.
- `podman kill` of the container during the session: reloading the page, the portal restarts on the same volume, the file is there.
- Close the tab, wait out the grace period: container destroyed, volume and `shadow.git` present with at least one commit.
- Restart the portal with an active session: the session stays reachable without recreating the container.
- `pnpm build && pnpm typecheck && pnpm test` green.

## Out of scope for milestone 0 and v0

End-to-end exam mode in an exam room (milestone 3), teacher interface for assignment creation (milestone 4), documentation mirrors (milestone 3, which only requires serving static directories), pre-warmed pool (to be built only after measurement), gVisor, off-host backup, disk quotas.
