# HEIG GitHub Classroom

A teacher/student web portal built on top of GitHub: classrooms, assignments,
student repository provisioning, CI-based grading and automatic deadlines.

Specifications live in [docs/](docs/) (needs analysis, requirements, functional
specs, architecture) as TeXSmith sources that compile to PDF. Architecture
decision records are under [docs/adr/](docs/adr/).

## Development

Prerequisites: Node.js >= 22 (pnpm via corepack), Docker (dev Postgres + Keycloak).

```bash
corepack enable pnpm
pnpm install

# Database + local OIDC IdP (Keycloak, realm hgc-dev,
# test accounts teacher/teacher and student/student)
docker compose -f docker-compose.dev.yml up -d

cp .env.example .env
pnpm --filter @hgc/server db:migrate   # Drizzle migrations
pnpm dev                               # server on :3000
```

Sanity checks:

```bash
pnpm build && pnpm typecheck && pnpm test
curl http://localhost:3000/healthz
curl http://localhost:3000/metrics
```

## Deployment

Production runs at <https://classroom.chevallier.io> (a single small VM:
Postgres, the app container, and Caddy natively on the host). Deployment is
fully automated by CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)):
every push to `main`

1. runs the checks (build, typecheck, test);
2. builds the production image on GitHub Actions and pushes it to GHCR
   (`ghcr.io/heig-tin-info/heig-classroom`, tags `latest` + commit sha);
3. SSHes to the VM and triggers [deploy.sh](deploy.sh), which pulls the new
   image and runs `docker compose up -d` — a few seconds, no contention.

The image is **never built on the VM** (453 MiB / 1 CPU): an on-VM build swaps
the host and starves Postgres, and fills the disk. Security: the CI key is
pinned to `deploy.sh` in the VM's `authorized_keys`
(`command="…",restrict`), so it can only deploy — never open a shell. The GHCR
package stays private; the runner's ephemeral token is handed to the VM over
SSH just for the pull, so no registry credential is stored on the VM.

Roll back to a previous image on the VM:

```bash
IMAGE_TAG=<commit-sha> docker compose -f compose.prod.yml --env-file .env.prod up -d
```

One-time operator setup (VM provisioning, the `DEPLOY_SSH_KEY` secret, backups)
is documented in [deploy.md](deploy.md).

## Layout

| Path | Role |
| --- | --- |
| `packages/domain` | Pure business rules (GR-02 grade parsing, freezing...), framework-free |
| `packages/contracts` | Zod schemas shared across front, back and CLI |
| `apps/server` | Fastify monolith: API, webhooks, SSE, jobs (pg-boss), `WORKER_MODE` |
| `docs/` | Specifications (TeXSmith) and ADRs |

## PDF documentation

```bash
python3 -m venv .venv && .venv/bin/pip install --group docs
cd build && ../.venv/bin/texsmith ../docs/01-cahier-des-charges.md --build
```
