# Deploying the portal on a VM

A versioned, replayable recipe, from the bare VM to a workspace served over
HTTPS. Everything described here is executed by `deploy/bootstrap.sh` and
`deploy/push.sh`; nothing is left to a manual step.

Reference target: `code.chevallier.io` (Hetzner, Ubuntu 26.04.1, kernel 7.0,
2 vCPU, 3.7 GB of RAM, 38 GB of disk, no swap, ports 80 and 443 open on the
provider's firewall). Executed end to end on 2026-09-17.

---

## 1. The recipe, in two commands

```bash
# fresh VM: packages, Podman socket, closed network, units, Caddy, /etc/codespace/env
apps/codespace/deploy/push.sh --bootstrap

# afterwards, on every deployment
apps/codespace/deploy/push.sh
```

`push.sh --bootstrap` does, in order: local build, `rsync` of
`deploy/ infra/ images/` to `/srv/codespace/src`, execution of `bootstrap.sh`
on the VM, `rsync` of the release, switching the symlink, building the student
image if it is missing, restart, waiting for `/healthz` locally and then over
HTTPS.

Both scripts are **idempotent**: replayed, they break nothing and do not write
twice. `bootstrap.sh` has been replayed twice on the VM already in service,
without side effects; `/etc/codespace/env`, which carries the secrets, is
written only if it does not exist.

Environment variables recognised by both scripts:
`CODESPACE_SSH` (default `root@code.chevallier.io`), `CODESPACE_DOMAIN`,
`CODESPACE_CLASSROOM_URL`, `CODESPACE_IMAGE_TAG`.

One manual step remains, and it cannot be automated: the private key of the
GitHub App, which comes from the classroom droplet (§ 5). Without it, the
students' repositories — private ones — are unreachable.

Two tools accompany the recipe, both playing the role of classroom by signing a
launch token with the shared secret:

| command | what it does |
| --- | --- |
| `deploy/smoke.ts` | complete functional proof on a smoke assignment (§ 10) |
| `deploy/resume.ts` | reopens **an existing session**, by its `sub`, its assignment and its repository (§ 5) |

### What `bootstrap.sh` sets up

| # | Item | Detail |
| --- | --- | --- |
| 1 | swap | 2 GB `/swapfile`, `/etc/fstab`, `vm.swappiness=10` |
| 2 | packages | `podman crun netavark aardvark-dns passt uidmap nftables caddy git curl rsync python3 nodejs` |
| 3 | `--userns=auto` | line `containers:2147483647:2147483648` in `/etc/subuid` and `/etc/subgid` |
| 4 | rootful Podman socket | group `podman`, `SocketGroup`/`SocketMode` drop-in, **tmpfiles override** |
| 5 | user | `codespace`, system, no shell, member of `podman`, `$HOME` in `/srv/codespace/var/home` |
| 6 | directory tree | see § 2 |
| 7 | `br_netfilter` | `/etc/modules-load.d/codespace.conf` + `/etc/sysctl.d/99-codespace-bridge.conf` |
| 7bis | AppArmor profile | `install -m 0644 infra/apparmor/codespace /etc/apparmor.d/codespace` then `apparmor_parser -r`; a host without `apparmor_parser` gets a warning and `CODESPACE_APPARMOR_PROFILE=` (empty) |
| 8 | configuration | `/etc/codespace/env`, secrets drawn from `/dev/urandom` |
| 9 | systemd | `codespace.service`, `codespace-net.service`, `codespace-shadow.{service,timer}` |
| 10 | Caddy | `/etc/caddy/Caddyfile`, automatic Let's Encrypt TLS |
| 11 | closed network | `infra/net/setup.sh`: `codespace` network, anchor, nft tables |

The two Podman pitfalls of [setup-poste.md](setup-poste.md) are handled:

- **`/run/podman` recreated as `0700 root:root`.** `/usr/lib/tmpfiles.d/podman.conf`
  redoes it at every boot; the `/etc/tmpfiles.d/podman.conf` override of the
  same name (`D! /run/podman 0750 root podman`) takes precedence. Verified after
  a real reboot: `/run/podman` is `750 root:podman`, and the service, which runs
  as `codespace`, reaches the socket.
- **`--remote` mandatory.** No script under `deploy/` calls `podman` bare:
  `push.sh` and the `infra/` scripts all go through
  `podman --remote --url unix:///run/podman/podman.sock`, via a `pd()`
  function. Without it the binary falls back to local rootless and measures
  something else.

---

## 2. Directory tree on the VM

```text
/srv/codespace/
├── src/                     rsync of apps/codespace/{deploy,infra,images}
│   ├── deploy/              bootstrap.sh, push.sh, shadow-snapshot.sh, Caddyfile
│   ├── infra/               net/, nft/, seccomp/   <- SECCOMP_PROFILE points here
│   └── images/c-dev/        Containerfile of the student image
├── releases/
│   └── 20260917-201030/     self-contained tree (dist/, node_modules/, drizzle/) ~114 MB
├── app -> releases/20260917-201030
├── volumes/                 <login>/<assignment>/{work,staging.git,shadow.git}   0750 codespace
└── var/
    ├── codespace.sqlite     + -wal, -shm (WAL)                                  0640 codespace
    └── home/                $HOME of the service user

/etc/codespace/env           0640 root:codespace — ALL the configuration, three secrets
/etc/caddy/Caddyfile
/etc/systemd/system/codespace{,-net,-shadow}.{service,timer}
/etc/tmpfiles.d/podman.conf  /etc/systemd/system/podman.socket.d/group.conf
/etc/modules-load.d/codespace.conf  /etc/sysctl.d/99-codespace-{bridge,swap}.conf
```

`infra/` exists in two copies: the one under `/srv/codespace/src` — the only one
used at run time, by the systemd units and by `SECCOMP_PROFILE` — and the one
that travels inside the release because `pnpm deploy` copies the whole package.
The second is inert. A consequence to be aware of: **rolling the application
back does not roll `infra/` back**. The seccomp profile and the nft rules are
versioned and change far less often than the code; if one day one of the two
had to follow the release, `SECCOMP_PROFILE` would have to point at
`/srv/codespace/app/infra/…`.

`seed/` travels too and is useless in production: the YAML seed is the
standalone mode, it goes through `scripts/seed.ts`, which is not deployed
(`tsx` is a development dependency). `push.sh` explicitly checks for the
presence of `dist/server.js`, `drizzle/meta/_journal.json`,
`node_modules/better-sqlite3` and of the two workspace packages, and refuses a
tree that would contain development dependencies.

A detail that cost one pass: **`pnpm deploy` applies the npm publication
rules**, so `dist/` — which is in the package's `.gitignore` — is not copied.
`push.sh` copies it back by hand, exactly as classroom's `Dockerfile` copies
`apps/server/drizzle` back.

---

## 3. Configuration and secrets

Everything lives in **`/etc/codespace/env`**, read by the `EnvironmentFile=` of
`codespace.service`. The file is `0640 root:codespace`: the service reads it,
nobody else.

Three secrets are drawn there from `/dev/urandom` at creation time, 48
alphanumeric characters each, and are **never** rewritten by a replayed
`bootstrap.sh`:

| Key | Role |
| --- | --- |
| `CODESPACE_LAUNCH_SECRET` | HS256 shared with classroom. **The same value must be set on the classroom side**, otherwise `/launch` refuses every token. |
| `COOKIE_SECRET` | signature of the portal's login cookie |
| `EXAM_COOKIE_SECRET` | HMAC of the `exam_session` cookie |

A fourth secret is **not** in that file and cannot be invented: the private key
of the GitHub App, `/etc/codespace/github-app.pem`, in `0640
root:codespace`. It is copied from the classroom droplet — it is the same App —
and `GITHUB_APP_PRIVATE_KEY_PATH` points at it. Procedure in § 5. A PEM spans
several lines: it could not live in an `EnvironmentFile=`.

The launch secret is read on the VM, and nowhere else:

```bash
ssh root@code.chevallier.io "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env"
```

Notable production values:

```text
NODE_ENV=production   HOST=127.0.0.1   PORT=3100
PUBLIC_URL=https://code.chevallier.io   SEB_PUBLIC_ORIGIN=https://code.chevallier.io
CLASSROOM_URL=https://classroom.chevallier.io
SEB_VERIFIER=real                      (the simulated mode is refused by loadConfig in production)
DATABASE_PATH=/srv/codespace/var/codespace.sqlite
VOLUMES_ROOT=/srv/codespace/volumes
SECCOMP_PROFILE=/srv/codespace/src/infra/seccomp/codespace.json
CODESPACE_APPARMOR_PROFILE=codespace
PODMAN_URL=unix:///run/podman/podman.sock
CODESPACE_NETWORK=codespace  CODESPACE_GATEWAY=10.77.0.254  CODESPACE_GIT_PORT=9418
CODESPACE_IMAGE=codespace/c-dev:4.137.0  CODESPACE_MEMORY=1536m  CODESPACE_CPUS=1
SESSION_GRACE_MS=600000  SESSION_GC_INTERVAL_MS=60000  SHADOW_INTERVAL_MS=86400000
OIDC_ISSUER=            (empty: see § 4)
FORGE_KIND=github  FORGE_URL=https://github.com  FORGE_TOKEN=   (see § 5)
GITHUB_APP_ID=<the App identifier>  GITHUB_APP_PRIVATE_KEY_PATH=/etc/codespace/github-app.pem
TRUST_PROXY=            (forbidden in production: see § 6)
```

Two keys that are names, not paths, and that the hardening depends on:

| Key | Value on this VM | What it does |
| --- | --- | --- |
| `SECCOMP_PROFILE` | `/srv/codespace/src/infra/seccomp/codespace.json` | a **path** read by Podman at `run` time |
| `CODESPACE_APPARMOR_PROFILE` | `codespace` | the **name** of a profile the kernel must already have loaded, from `infra/apparmor/codespace`. Written by `bootstrap.sh` § 7bis, reloaded by every `push.sh`. **Empty = no `--security-opt apparmor` flag**, which is what a host without AppArmor needs (the WSL2 workstation; `.env.example` leaves it empty). A non-empty name that the kernel does not know makes `podman run` fail, so `bootstrap.sh` writes it empty when it could not load the profile. |

Without that profile, gdb inside a student container is denied `ptrace` on
kernel 7.0.0-31: see [images/c-dev/README.md](../images/c-dev/README.md)
§ AppArmor.

**Ceiling of simultaneous sessions**: 3.7 GB of RAM, `CODESPACE_MEMORY=1536m`
per session, about 600 MB for the host and the portal. Two sessions fit, a
third one starts eating into the swap. The per-teacher quota
(`quota.maxActiveSessions` of the `PUT`) is the only safeguard; it comes from
classroom and must be set accordingly for this VM.

### Overriding a setting for a trial

An `Environment=` in a drop-in **does not win** over the `EnvironmentFile=` of
the main file — measured, the file's value wins. A second `EnvironmentFile` is
needed, applied afterwards:

```bash
printf 'SESSION_GRACE_MS=5000\nSESSION_GC_INTERVAL_MS=2000\n' > /etc/codespace/env.test
chown root:codespace /etc/codespace/env.test && chmod 0640 /etc/codespace/env.test
mkdir -p /etc/systemd/system/codespace.service.d
printf '[Service]\nEnvironmentFile=/etc/codespace/env.test\n' \
  > /etc/systemd/system/codespace.service.d/zz-test.conf
systemctl daemon-reload && systemctl restart codespace.service
# … then, without fail, back to production:
rm -f /etc/systemd/system/codespace.service.d/zz-test.conf /etc/codespace/env.test
systemctl daemon-reload && systemctl restart codespace.service
```

---

## 4. No identity provider on this VM

Switch edu-ID is not declared and there is no production Keycloak. The students
**all** arrive through classroom's launch token
([integration-classroom.md](integration-classroom.md)). An empty `OIDC_ISSUER`
says exactly that:

- `/auth/login`, `/auth/callback` and `/auth/logout` are **not registered** and
  answer 404;
- a page that requires a user (`/`, `/teacher/sessions`) answers **503** with a
  text that names the cause, instead of redirecting to a 404;
- `/launch`, `/api/assignments/*`, the proxy and the Git channel are whole.

This is not an identity shortcut: invariant 4 says that the OIDC login is real,
and it is — it is absent, not replaced. There is no other way of becoming
`request.user`. OIDC discovery was **already lazy** before this deployment
(`OidcProvider.configuration()`: an unreachable IdP does not prevent start-up);
what was missing was the "no IdP at all" case. Four unit tests cover it
(`src/auth/oidcDisabled.test.ts`).

To connect the IdP later: set `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, and **add the edu-ID hosts to
`SEB_EXTRA_ALLOWED_HOSTS`** — without which Safe Exam Browser's URL filter
would block the login page (analyse.md, docs/pistes.md).

---

## 5. The GitHub App, and what happens without it

It is **the same App as heig-classroom** — same variable names, same PEM file —
because it is the one that created the students' repositories and nobody else
has access to them.

| Key of `/etc/codespace/env` | Value |
| --- | --- |
| `FORGE_KIND` | `github` |
| `FORGE_URL` | `https://github.com` |
| `GITHUB_APP_ID` | the numeric identifier of the App, copied from classroom's `.env.prod` |
| `GITHUB_APP_PRIVATE_KEY_PATH` | `/etc/codespace/github-app.pem` |

The installation is **not** a setting: the portal resolves it through
`GET /orgs/{org}/installation`, organisation by organisation, from the `owner`
of the repository — one portal serves several classes, hence several GitHub
organisations. The installation token is valid for one hour; it is cached per
installation and renewed one minute before it expires.

### Copying the private key without putting it on the workstation's disk

The PEM already lives on the classroom droplet. It goes from one droplet to the
other in a single pipe, without ever touching the workstation:

```bash
ssh root@classroom.chevallier.io 'cat /opt/heig-classroom/secrets/heig-classroom.private-key.pem' \
  | ssh root@code.chevallier.io 'cat > /etc/codespace/github-app.pem \
      && chown root:codespace /etc/codespace/github-app.pem \
      && chmod 0640 /etc/codespace/github-app.pem'

# /etc/codespace must be TRAVERSABLE by the portal: `env` is read by
# systemd (as root) before start-up, but the PEM is read by the process.
ssh root@code.chevallier.io 'chgrp codespace /etc/codespace && chmod 0750 /etc/codespace'

# the identifier, for its part, is not a secret
ssh root@classroom.chevallier.io "sed -n 's/^GITHUB_APP_ID=//p' /opt/heig-classroom/.env.prod"
# … then, on the portal's VM, in /etc/codespace/env:
#   GITHUB_APP_ID=<the value read>
#   GITHUB_APP_PRIVATE_KEY_PATH=/etc/codespace/github-app.pem
systemctl restart codespace.service
```

`deploy/bootstrap.sh` is part of the recipe: it writes the two keys into a
fresh `/etc/codespace/env`, **adds them** to an existing file that does not
have them (they carry no secret), puts the PEM back to `0640 root:codespace`
if it is there, and reminds the copy command if it is missing. It never creates
the key: that cannot be invented.

### What happens without the App

The portal builds a **partial** forge: everything that does not require a token
works — the clone URL of a **public** repository —, and everything else refuses
explicitly.

- The relay: the student's push **succeeds** and the `PushEvent` is written
  (invariant 7); the row stays `pending` with, in `last_error`, "GitHub App
  not configured: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH are missing
  from /etc/codespace/env. Only public repositories are reachable."
  It **never** goes to `failed`: an unconfigured forge is not an outage, and
  exhausting the retry budget would lose a submission that never had a
  destination. Setting the credentials is enough to drain the queue, the relay
  resumes on its own. The service is not affected: one attempt per minute, with
  no network call (the error is raised before).
- Workspace seeding: the repository of a student provisioned by classroom is
  **private**, the `git fetch` is refused, and **the session does not start**.
  See the next section.

### Seeding failure: the session does not start

Measured in production on 2026-09-17, and that is what this fix changes: the
portal used to open the editor on an empty `work/`, without a word, and the
student worked next to their submission. From now on:

- no container is started;
- the student gets a 503 page « Espace de travail impossible à préparer :
  &lt;cause courte&gt; ; signalez-le à votre enseignant. » — `dépôt org/x
  introuvable`, `accès refusé au dépôt org/x`, `le portail n'a pas les accès à
  org/x`;
- the log carries a `warn` with the full cause, the repository, the mode and
  the session identifier. The token never appears there: it only travels
  through `GIT_CONFIG_VALUE_0`, and `redactSecrets` removes it from error
  messages.

**One exception, and only one**: a target repository **with no branch at all**
in lab mode. That is the state of a repository classroom has just created and
that the student has never pushed to. The `fetch` succeeds, reports zero refs,
the workspace legitimately opens empty and the log says so at `info` level
("target repository with no branch at all"). In exam mode, on the contrary, a
template with no branch refuses the session: the student would not have the
assignment text.

### Measured on the VM on 2026-09-17

Real session `21ad5a11-…` (private repository
`heig-test-classroom2/labo-02-quadratic-yves-chevallier`, branch `master`),
resumed by a launch token signed from the workstation
(`deploy/resume.ts`):

- `/launch` answers `303` in 4.9 s, no additional container;
- `/work` contains the 15 entries of the repository (`quadratic.c`, `Makefile`,
  `tests/`, `.vscode/`, …) and the `test` file the student had written, still
  untracked;
- `git status`: `## master...origin/master`, clean tree;
- `git push` **with no argument** from the container lands in `staging.git`,
  the `PushEvent` goes `relayed` in 2.2 s, and `heads/master` of the private
  GitHub repository points at the pushed commit. That is the first proof of the
  real relay to GitHub.

Three things showed up on that occasion, and are fixed here:

1. `/etc/codespace` was `0750 root:root`: the portal could not **traverse** it
   to read the PEM (`EACCES`). The directory is now `0750 root:codespace`, set
   by `bootstrap.sh`.
2. The github.com git transport refuses an installation token as `Bearer`
   ("remote: invalid credentials"): `Basic x-access-token:<token>` is required.
   See `git/forge.ts`.
3. `ensureStagingRepo` was not given the repository's default branch and fell
   back on whichever branch came first — `grading`, written by classroom's CI,
   instead of `master`. The branch now comes from the launch token
   (`defaultBranchOf`).

**Still open**: the GitHub App is not installed on the `heig-tin-info`
organisation. The `PushEvent` of the smoke session therefore stays `pending`
with "GitHub App not installed on organisation heig-tin-info". That is the
intended behaviour — installing the App on that organisation is enough to drain
the queue.

### The mirror is only taken at the first seeding

In lab mode, the staging repository is seeded from the student's repository
**as long as it has no ref at all**. Afterwards, it is not any more: a forced
`fetch --prune` would bring GitHub's refs back over those the student has
pushed but that the relay has not transmitted yet. In exam mode the template is
taken again at every opening, and that is intended — that is how a fix to the
assignment text propagates during the exam (invariant 6).

### Resuming a session whose workspace stayed empty

When opening an existing session whose `staging.git` has **no ref**, the portal
seeds it again before restarting the container, then puts `work/` in shape: a
local branch on the repository's default branch (`master` as well as `main`),
tracking `origin/<branch>` — without which `git pull` and `git push` with no
argument do not work inside the container.

An ownership detail governs the manoeuvre: after the first `podman run`, the
`:U` option has given `work/` to the container's UID range and the portal
**writes into it no more**. Completion then goes through `podman exec` inside
the container that has just started (`sessions/workspace.ts`,
`completionScript`): `git fetch origin`, `git checkout -B <branch>
origin/<branch>`, `git branch --set-upstream-to`. The `fetch` goes to
`portal.internal:9418`, authenticated by the source IP address: **no secret
enters the container** (invariant 1).

Two safeguards:

- a `work/` that already carries **a commit** is never touched again: the
  student is the master of their repository;
- the **untracked** files they wrote into an empty workspace are kept —
  `checkout -B` from an unborn branch does not touch them. If one of them bears
  the name of a file the repository brings, `checkout` refuses rather than
  overwrite it: the log says so at `warn` level and the session opens anyway,
  with an incomplete workspace. That is the only case where the repository is
  not retrieved, and it is better than losing the work.

---

## 6. The client address behind Caddy

`TRUST_PROXY` is, in `src/auth/config.ts`, a **development boolean**: it sets
`trustProxy: true` on Fastify, which makes `request.ip` controllable by any
`X-Forwarded-For` coming from anywhere. `loadConfig()` refuses to start with it
in production. That is correct and it was not touched.

Accepted consequence here: **behind Caddy, `request.ip` is `127.0.0.1` for
everyone.** What that changes, exactly:

- the Git channel is **not** concerned: it listens on `10.77.0.254:9418`, not
  behind Caddy, and authentication by the container's source address
  (invariant 1) is intact;
- the proxy's session cookie is not concerned: it is bound to the session, not
  to the address;
- **exam mode is.** The `exam_session` cookie carries the client address
  recorded at the SEB verification, and `checkExamRequest` compares it again on
  every proxy request (analyse.md D5). With `127.0.0.1` on both sides, the
  comparison is true for everyone: it no longer distinguishes two workstations.

This is not blocking as long as no exam runs on this VM — the current
deployment only serves lab mode — but **it must be fixed before the first
exam**. A proposal, to be worked out with its test:

> A distinct variable, for example `TRUSTED_PROXY_IPS=127.0.0.1,::1`, passed as
> is to Fastify's `trustProxy`, which accepts a list of addresses or of CIDRs.
> Fastify then walks the `X-Forwarded-For` chain only for a hop whose address
> is in the list; a client forging the header from the outside can do nothing,
> since its immediate hop to Caddy is not trusted. That is the correct setting
> behind a controlled front end, and it has nothing to do with the boolean
> `TRUST_PROXY`, which must remain forbidden in production.

The code-free fallback, if the deadline pressed: bind the portal to a second
address and route the exam sessions through a path that does not cross the
front end. It is not recommended — it breaks TLS.

---

## 7. The ghost repository, taken as root

`analyse.md § 3.3` and `docs/v1.md § D-V1-1` left two options for the ghost
repository snapshot; the preferred one — **a root systemd timer** — is the one
that is deployed.

`codespace-shadow.timer` runs `deploy/shadow-snapshot.sh` every three minutes.
The script does exactly what `snapshot()` of `sessions/shadow.ts` does —
`info/exclude` set to `.git`, `add -A --ignore-errors`, commit only if
something is staged, the portal's identity — but as root, hence without the
permission problem. The repository remains owned by `codespace`, and the script
passes `-c safe.directory='*'`.

Verified on the VM: a file created inside the container with `chmod 600` — the
exact case `sessions/shadow.ts` cannot capture — **is in the snapshot**.

The portal's internal timer is pushed out to 24 h
(`SHADOW_INTERVAL_MS=86400000`) so that there is only one writer on
`shadow.git`. The session-closing snapshot stays in place: it is a safety net,
and it works.

A related detail, and it is a decision of the unit: **`UMask=0022`, not
`0027`.** `work/` is created by the portal and then re-chowned by Podman (`:U`)
to the container's UID range, **modes preserved**. At `0750`, the portal can no
longer enter the working tree it has just created and its closing snapshot
fails with "this operation must be run in a work tree". Measured, then fixed.
The tree above is `0750 codespace:codespace`, so no other user of the host can
traverse it.

---

## 8. Redeploying, rolling back, rebuilding

### Redeploying

```bash
apps/codespace/deploy/push.sh
```

A new timestamped release, symlink switch, restart, waiting for `/healthz`. The
last five releases are kept, the older ones pruned.

### Rolling back

```bash
ssh root@code.chevallier.io bash -s <<'EOF'
ls -1 /srv/codespace/releases        # pick the previous one
ln -sfnT releases/<timestamp> /srv/codespace/app
systemctl restart codespace.service
curl -sf http://127.0.0.1:3100/healthz
EOF
```

The Drizzle migrations are applied when the database is opened
(`openDb()` → `migrate()`), at every start. They are not reversible: a release
**older** than a migration cannot read the schema the following release laid
down. Before any rollback that crosses a migration, restore the database backup
taken before the deployment (§ 9). As long as `drizzle/` has not changed
between the two releases, the rollback is immediate and risk-free.

### Rebuilding the VM from scratch

1. a fresh Ubuntu 26.04 VM, root SSH key in place, `A`/`AAAA` DNS records set,
   ports 80 and 443 open;
2. `apps/codespace/deploy/push.sh --bootstrap`;
3. restore `/srv/codespace/volumes` and `/srv/codespace/var/codespace.sqlite`
   from the backup, with the service stopped;
4. copy `CODESPACE_LAUNCH_SECRET` **from the old VM** into
   `/etc/codespace/env` before the first start, otherwise classroom issues
   tokens that the new VM refuses — or set the new value on both sides;
5. `systemctl restart codespace.service`.

The student image is rebuilt automatically (1 to 2 min) if it is missing.

### Changing the image without changing its tag

`push.sh` rebuilds the image only if `podman image exists` says it is absent: a
modification of `images/c-dev/` that keeps the tag
`codespace/c-dev:4.137.0` **would not be picked up**. In that case, and it is
the common case (machine settings, an extension baked into the image), the
deployment is:

```bash
apps/codespace/deploy/push.sh --rebuild-image
```

The `rsync` of `images/` to `/srv/codespace/src` happens in any case; only the
rebuild is conditional. Since 2026-09-18, the image build has a multi-stage
`node:22-slim` step that packages the status bar extension: the VM downloads
that base image the first time (~80 MB) and `npx @vscode/vsce` fetches its
package from npm. Both require outbound network on the VM, which it has.

### Host reboot

Nothing to do: verified by a real reboot. `podman.socket`,
`codespace-net.service` (which recreates the network, the anchor and the two
nft tables — none of the three survives a `reboot`), `codespace.service`,
`codespace-shadow.timer` and Caddy come back on their own, `/run/podman`
returns to `750 root:podman`, the `cs0` bridge carries `10.77.0.254`, and
`/healthz` answers over HTTPS less than a minute after the machine comes back.

---

## 9. Backup

Nothing automatic is in place today, and that is an accepted gap of this
milestone. The two things to back up:

```bash
# 1. the students' volumes (work + staging repositories + ghost repositories)
rsync -a --delete root@code.chevallier.io:/srv/codespace/volumes/ ./sauvegarde/volumes/

# 2. the database, hot and consistently (WAL) — not a plain cp
ssh root@code.chevallier.io "python3 - <<'PY'
import sqlite3
s = sqlite3.connect('/srv/codespace/var/codespace.sqlite')
d = sqlite3.connect('/srv/codespace/var/backup.sqlite')
s.backup(d); d.close(); s.close()
PY"
rsync -a root@code.chevallier.io:/srv/codespace/var/backup.sqlite ./sauvegarde/
```

The `sqlite3` command line is not installed; `python3`'s `backup` API does the
same job and is consistent with the WAL journal. A `cp` of the `.sqlite` file
alone, without `-wal` or `-shm`, would produce a database missing its latest
writes.

What would be needed, and remains to be done:

- a daily `codespace-backup.timer` unit that does both of the above towards a
  storage **outside the VM** (Hetzner Storage Box over `rsync`/`sftp`, or a
  provider volume snapshot);
- a retention policy (7 daily, 4 weekly) and above all **a verified restore**: a
  backup that has never been restored is not a backup;
- the volumes belong to container UID ranges (`--userns=auto`), so the backup
  must be taken as root and restored as root with `--numeric-ids`, otherwise the
  owners are lost.

What does **not** need to be backed up: `/srv/codespace/releases` (replay
`push.sh`), `/srv/codespace/src` (the repository), the student image (rebuilt).
`/etc/codespace/env` does, or at least its three secrets.

---

## 10. Checks, and what they gave

### Closed network

```bash
ssh root@code.chevallier.io bash -s <<'EOF'
systemctl stop codespace.service      # test.sh binds 10.77.0.254:9418 itself
/srv/codespace/src/infra/net/test.sh
systemctl start codespace.service
EOF
```

Stopping the portal is **necessary**: `test.sh` binds its two test servers on
the gateway, including the Git port that the portal already occupies.

Result on the VM, as root: **10 PASS, 1 FAIL, 0 BLOCKED**. The ten invariant
assertions are green, including the two that were `BLOCKED` on the development
workstation for lack of root, and including link-local IPv6.

The single `FAIL` is a limitation of the **test**, not a violation of invariant
2, and the diagnosis has been made:

> `without the ICC rule, A -> B:8080 still fails: something else blocks`

"Something else" is `table bridge codespace`. This VM's kernel has the nftables
`bridge` family, which the workstation's WSL kernel does not: `setup.sh`
therefore **also** loads `infra/nft/codespace-bridge.nft`, the defence in depth
foreseen by `analyse.md D1`. The regression test, for its part, only removes
the ICC rule from the `inet` table; the L2 rule remains and blocks. Measured,
in this order:

| state | A → B:8080 |
| --- | --- |
| both tables loaded | blocked |
| without the ICC rule of `inet`, `bridge` table present | blocked |
| without the ICC rule of `inet` **and** without the `bridge` table | **reachable** |
| both tables reloaded | blocked |

In other words both rules block, either one suffices, and the defence in depth
is real on this VM. `TODO(verify)` / fix to be carried into
`infra/net/test.sh` (out of scope of this work): the ICC regression must remove
the rule from **both** families before concluding, otherwise it is structurally
red on any kernel that supports `bridge`.

### Exposed surfaces

From the workstation, towards `code.chevallier.io`:

| port | expected | measured |
| --- | --- | --- |
| 443 | open | open, valid Let's Encrypt TLS (`CN=code.chevallier.io`, `issuer=Let's Encrypt`) |
| 80 | open (redirect, ACME) | open |
| 3100 | closed | closed/filtered |
| 9418 | closed | closed/filtered |
| 8080 | closed | closed/filtered |

On the VM side, `ss -ltn`: `127.0.0.1:3100` (the portal), `10.77.0.254:9418`
(the Git channel, on the bridge and nothing else), `*:80` and `*:443` (Caddy).
No other listener.

```text
$ curl -sS -D- -o /dev/null https://code.chevallier.io/healthz
HTTP/2 200
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: strict-origin-when-cross-origin
x-frame-options: SAMEORIGIN
```

### Functional proof

```bash
CODESPACE_LAUNCH_SECRET="$(ssh root@code.chevallier.io \
    "sed -n 's/^CODESPACE_LAUNCH_SECRET=//p' /etc/codespace/env")" \
  pnpm --filter @hgc/codespace exec tsx deploy/smoke.ts
```

`deploy/smoke.ts` plays the role of classroom: it signs its own service token
and launch token with `signHs256`, like `scripts/e2e.ts` § 9. It pushes an
assignment `smoke-<date>` in `online` mode, whose `sourceRepo` **and** the
repository of the token are both `heig-tin-info/example-priority-queue` — a
**public** repository of the course organisation, 7 KB, C, branch `main`. In
lab mode it is the token's repository that seeds the staging repository. A
public repository is used here so that the smoke test does not depend on the
App being installed anywhere, **not** because seeding could not use a token:
since 2026-09-17 `ensureStagingRepo` passes the forge's `Authorization` header
to the seeding `fetch` (`src/git/staging.ts`), which is precisely what makes a
private student repository work. The older argument "it must be clonable
without a token" (docs/v1.md D-V1-8) is superseded on that point; what still
holds is that no secret ever reaches the container. No repository was created
for the occasion.

Eleven assertions, all green:

```text
PASS  /healthz — {"ok":true}
PASS  PUT refused without a service token — 401
PASS  assignment synchronised — 200 {"id":"smoke-2026-09-17","configKey":null,"sebLink":null}
PASS  /launch opens the session — 303 /s/47acd86e-…/
PASS  cs_session cookie set by /launch (no second sign-in)
PASS  no OIDC cookie is required or set
PASS  it really is the code-server workbench
PASS  101 Switching Protocols + Sec-WebSocket-Accept recomputed and correct
PASS  websocket refused without a session cookie — status 403
PASS  the same token is refused on replay — 403
PASS  /auth/login answers 404, the home page answers 503
```

Checks made on the VM during the session:

- the workspace contains `main.c`, `priority-queue.c`, `Makefile` — the staging
  repository was indeed seeded from the public repository;
- `origin` is `http://portal.internal:9418/git/<session>`;
- effective hardening of the container:
  `["no-new-privileges","seccomp=/srv/codespace/src/infra/seccomp/codespace.json"]`,
  `readonly=true`, `pids=256`, `mem=1536m`, `cpus=1`, full `CapDrop`,
  `work/` owned by `2147484647` (the range drawn by `--userns=auto`);
- a `git push` from the container succeeds, the `PushEvent` is written and stays
  `pending` with the error of § 5.

### Measurements taken on this VM (2 vCPU, 3.7 GB)

| Measurement | Value |
| --- | --- |
| `podman build` of the student image, without cache | **113 s** |
| Image size | 1.5 GB |
| Release size | 114 MB |
| **Launch token → workbench page, over HTTPS** | **3.92 s / 4.22 s / 4.31 s** (three passes) |
| Websocket upgrade alone, through Caddy | 233 / 251 / 257 ms |
| Launch token → websocket established | 4.15 s / 4.48 s / 4.56 s |
| Closing by the garbage collector (test grace of 5 s) | 4 to 6 s |
| Service restart → `/healthz` | 5 s |
| Recovery after a VM `reboot` → `/healthz` over HTTPS | < 60 s |
| RAM at rest (portal + anchor + Caddy) | 605 MB used out of 3.7 GB |

The 4 s end to end break down into a `podman run` and waiting for the
container's `/healthz` (measured at 0.6–1.0 s on the development workstation,
images/c-dev/README.md), plus the clone of the public repository from GitHub,
which is the variable part. The ten-second target of `analyse.md § 3.4` is met,
and **nothing here justifies a pre-warmed pool**.

### Cleaning up after a smoke pass

`smoke.ts` does not clean up after itself, deliberately: it does only what a
client does. The tidying:

```bash
# 1. close the session: there is no public route for that (the portal only has
#    /teacher/sessions/<id>/close, behind the teacher role, hence behind the
#    absent OIDC). We go through the garbage collector, with the test grace of
#    § 3, then put the production grace back.
# 2. the volume
ssh root@code.chevallier.io 'rm -rf /srv/codespace/volumes/smoke'
```

What stays in the database, and **no route allows deleting them**: the
`assignments` row of the smoke assignment, the `users` row of the `smoke`
student, the `sessions` row in the `closed` state, the `pending` `push_events`
and the consumed `jti`s. It is inconsequential — the smoke assignment only
appears for a logged-in user, and there is none — but it is worth knowing.
Deleting them would require either an administration route (out of scope) or a
direct `DELETE` in SQLite with the service stopped.

---

## 11. What remains for real production

In order of debt.

1. **Client address in exam mode** (§ 6). Blocking before the first exam, not
   before lab work.
2. **Switch edu-ID** (§ 4): `OIDC_*`, plus the edu-ID hosts in
   `SEB_EXTRA_ALLOWED_HOSTS`.
3. **Image from GHCR.** Today the image is built on the VM, 113 s of 2 vCPU
   during which the portal has very little left. In steady state it must come
   from a registry, like classroom's: the CI builds it and pushes it to
   `ghcr.io/heig-tin-info/codespace-c-dev:4.137.0`, `push.sh` does a `pd pull`
   instead of a `pd build`, and classroom's `deploy.sh` shows the pattern of an
   ephemeral token passed over SSH for the `login` of a private package — no
   registry credential is stored on the VM.
4. **Host firewall, on top of Hetzner's.** The provider's firewall is today the
   only barrier on the listening ports; it is correct, but it is outside the
   recipe and a change made in the web console leaves no trace in the
   repository. `table inet filter` exists on the VM with three empty chains in
   `policy accept`. To be set up: `input` with `policy drop`, with
   `ct state established,related accept`, `iif lo accept`,
   `tcp dport {22, 80, 443} accept`, and **definitely no** rule touching `cs0`
   — that is the job of `table inet codespace`, which must remain the only
   place that talks about the bridge. To be written in `infra/nft/` with its
   test, not in `deploy/`.
5. **Automatic backup** (§ 9).
6. **Fixing the ICC regression of `infra/net/test.sh`** (§ 10).
7. **Rotation of the portal's logs**: they go to the `journal`, whose size is
   bounded by default. To be checked (`journalctl --disk-usage`) before a busy
   session.

## 12. `TODO(verify)`

- `TODO(verify)` **Caddy 2.6.2 (Ubuntu 26.04)** — `flush_interval -1` on
  `reverse_proxy`: the directive is accepted and the websocket upgrade goes
  through (measured, 101 + conforming `Sec-WebSocket-Accept`), but the effect of
  the setting itself on a long-lived stream has not been observed. It is there
  because classroom's `Caddyfile` needs it for its SSE; should it cause trouble,
  it can be removed with no consequence for the websocket.
- `TODO(verify)` **Podman 5.7.0 / Ubuntu 26.04** — `codespace-bridge.nft` loads
  on this kernel (7.0) whereas it is refused on the workstation's WSL kernel.
  The consequence on `infra/net/test.sh` is handled in § 10; what has not been
  verified is the behaviour of the `bridge` table after a netavark update that
  would change the interface name.
- `TODO(verify)` **systemd 257 / Ubuntu 26.04** — `SystemCallFilter=@system-service`
  on `codespace.service`: the portal starts and runs, including its `execFile`
  calls to `podman` and to `git`. No rare path (load increase, a `podman build`
  triggered from the portal — which does not exist) has been exercised under
  that filter.
