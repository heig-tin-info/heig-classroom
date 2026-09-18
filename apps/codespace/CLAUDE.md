# heig-codespace

Portal for supervised development environments (VS Code in the browser, hardened containers, SEB exam mode). Framing document: [project.md](project.md). Analysis and trade-offs: [docs/analyse.md](docs/analyse.md). Task breakdown: [docs/jalon-0.md](docs/jalon-0.md). Boundary with classroom: [docs/integration-classroom.md](docs/integration-classroom.md). In case of contradiction, analyse.md prevails over project.md; sections 3 and 4 of project.md (requirements, non-goals) prevail over everything.

Sibling project: `~/heig-classroom` (same author, same stack, same IdP, same GitHub App). Reuse its conventions and its ADRs rather than inventing new ones.

## Where to read

| Kind | Documents |
| --- | --- |
| Reference — the current state, to be trusted | [docs/analyse.md](docs/analyse.md) (decisions D1–D8), [docs/integration-classroom.md](docs/integration-classroom.md) (the classroom boundary), [docs/deploy.md](docs/deploy.md) (the VM recipe), [docs/setup-poste.md](docs/setup-poste.md) (the development workstation), [images/c-dev/README.md](images/c-dev/README.md) (the student image), [src/git/README.md](src/git/README.md) (the Git channel), [src/seb/README.md](src/seb/README.md) (the SEB verification), [infra/net/README.md](infra/net/README.md) (the closed network) |
| History and journals — context, superseded in places | [project.md](project.md) (the initial framing document), [docs/jalon-0.md](docs/jalon-0.md) (the task breakdown), [docs/v1.md](docs/v1.md) (the v1 journal, decisions D-V1-x), [docs/pistes.md](docs/pistes.md) (leads and corrections), [docs/preuve-b-manuelle.md](docs/preuve-b-manuelle.md) (the manual SEB proof) |

## Stack

Node 22, strict TypeScript, Fastify 5, Zod, Drizzle on SQLite, `openid-client`, `octokit`, vitest, pnpm. No dependency injection, no decorators, no front-end framework in v0 (HTML served by Fastify). Everything is written in English: code, identifiers, comments, documentation and commit messages. Only end-user UI text follows the user's language.

Container engine: **rootful** Podman, driven through the CLI from the single module `src/engine/`, always in the form `podman --remote --url unix:///run/podman/podman.sock ... --format json`. Without `--remote`, the binary silently falls back to local rootless mode and every network test measures something else. Never Docker, never Docker Desktop, never rootless.

## Invariants (never work around them, not even "temporarily")

1. **No secret inside the student container.** No token, no key, no credential helper. The Git channel authenticates by the source IP address on the `codespace` bridge. The **closed** list of variables set at `podman run` time is `CONTAINER_ENV_KEYS` (`src/sessions/manager.ts`): three `CODESPACE_*` for the status bar extension, four `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}` for the student's git identity (`users.display_name`, `users.email`). None of them is a secret; a unit test and `images/c-dev/test.sh` § 9 assert that there is no other one. Adding a key is done in that list, together with its test.
2. **Network closed by construction.** Podman network `codespace` created by `infra/net/setup.sh` (`--internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254 --interface-name cs0`; the explicit gateway is what makes the host reachable), containers started with `--dns=none --add-host portal.internal:10.77.0.254`. The two nftables rules of `infra/nft/codespace.nft` (no inter-container traffic, only the Git port reachable on the host) are fixed and loaded at boot. No per-session rule. The `codespace-anchor` container (label `heig-codespace.role=anchor`) keeps the bridge alive: never delete it, never count it as a session.
3. **Hardening from the very first `podman run`**: the exact options are in `images/c-dev/run-hardened.sh` (`--userns=auto --cap-drop=ALL --security-opt no-new-privileges --security-opt seccomp=infra/seccomp/codespace.json --read-only --pids-limit --memory --cpus`, tmpfs in `mode=1777`). The engine module reuses them as they are. A test that needs to relax an option must say so in the docs, not in a comment.
4. **Real OIDC even in development** (Keycloak, discovery, PKCE, token validation). No "current user" environment variable.
5. **The proxy to code-server never reads a SEB header.** It only knows the session cookie bound to the client address. The SEB verification happens once, on the route where SEB arrives through a top-level navigation: `/exam/<assignment>/start` for a standalone assignment, `GET /launch` for an assignment coming from classroom.
6. **The staging repository of an assignment in exam mode is seeded from the teacher's template, never from the student's repository.**
7. **`PushEvent` is written before any relay attempt** towards the forge.
8. The `simulated` mode of the SEB verification is impossible under `NODE_ENV=production`, and a test asserts it.
9. **A launch token is used only once.** The `jti` is consumed by inserting a row into `launch_tokens_used`, before any other check: the primary key is the guarantee, not a read followed by a write. A token refused for any other reason is burnt; classroom issues a fresh one on the next click.
10. **The quota is per teacher, across all assignments**, counted on `sessions.teacherId` in the live states. Resuming an already live session does not consult it: it does not open one more container.
11. **The `startURL` of the `.seb` file of a synchronised assignment is classroom's**, not the portal's: it is classroom that authenticates the student and then redirects to `/launch`. SEB's URL filter must therefore allow classroom, the portal and `SEB_EXTRA_ALLOWED_HOSTS` (the identity provider).
12. **A launch token never grants a role.** `users.role` is written only by the OIDC login; an account born from a launch is a student.

## What is out of scope

See project.md section 4. In addition, for v0: teacher-facing creation UI, pre-warmed pool, gVisor, documentation mirrors, disk quotas. Do not start them without an explicit request.

## Commands

```bash
pnpm install
podman compose -f infra/compose.dev.yml up -d      # Forgejo only (Keycloak comes from the classroom compose at the repo root)
sudo infra/net/setup.sh                             # codespace network + nft
podman build -t codespace/c-dev:4.137.0 images/c-dev            # then images/c-dev/test.sh
pnpm dev                                            # portal on :3100 (classroom occupies 3000)
pnpm build && pnpm typecheck && pnpm test
```

`infra/compose.dev.yml` starts **only Forgejo**. The development OIDC identity provider is the classroom Keycloak, started from the monorepo root with `docker compose -f docker-compose.dev.yml up -d` (realm `hgc-dev`, client `codespace-portal`).

An empty `CODESPACE_LAUNCH_SECRET` (the default) disables the integration: `/launch` and `/api/assignments/*` answer 404 and the portal stays usable standalone, with its YAML seed and its own OIDC login. See [docs/integration-classroom.md](docs/integration-classroom.md).

The portal talks to the rootful socket `/run/podman/podman.sock`; in development the user belongs to the `podman` group, which owns the socket and its directory (see [docs/setup-poste.md](docs/setup-poste.md)). This component is privileged and must be treated as such. The nftables rules require sudo; that is the only expected use of sudo.

## Working conventions

- One task = one directory of `docs/jalon-0.md`, with its executable acceptance test script. The task is finished only if the script is green and was run by the agent, not described.
- Any code-server, Podman or nftables option whose existence has not been verified in the pinned version is marked `TODO(verify)` with the version.
- Non-trivial decisions go into `docs/adr/ADR-NNN-*.md` **at the monorepo root** — the portal has no `docs/adr/` directory of its own; ADR-013 is the portal's — in the same format as heig-classroom.
- Do not modify `project.md`.
