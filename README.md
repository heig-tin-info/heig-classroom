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
