# HEIG GitHub Classroom

Portail web teacher/student adossé à GitHub : classrooms, assignments, provisionnement de
dépôts étudiants, grading par CI et deadlines automatiques.

- Spécifications : [docs/](docs/) (analyse, cahier des charges, specs fonctionnelles,
  architecture) — sources TeXSmith, PDF compilables.
- Décisions d'architecture : [docs/adr/](docs/adr/).

## Développement

Prérequis : Node.js ≥ 22 (pnpm via corepack), Docker (Postgres + Keycloak de dev).

```bash
corepack enable pnpm
pnpm install

# Base de données + IdP OIDC local (Keycloak, realm hgc-dev,
# comptes de test teacher/teacher et student/student)
docker compose -f docker-compose.dev.yml up -d

cp .env.example .env
pnpm --filter @hgc/server db:migrate   # migrations Drizzle
pnpm dev                               # serveur sur :3000
```

Vérifications :

```bash
pnpm build && pnpm typecheck && pnpm test
curl http://localhost:3000/healthz
curl http://localhost:3000/metrics
```

## Structure

| Chemin | Rôle |
| --- | --- |
| `packages/domain` | Règles métier pures (parse de note GR-02, gel…), sans dépendance framework |
| `packages/contracts` | Schémas Zod partagés front/back/CLI |
| `apps/server` | Monolithe Fastify : API, webhooks, SSE, jobs (pg-boss), `WORKER_MODE` |
| `docs/` | Spécifications (TeXSmith) et ADRs |

## Documentation PDF

```bash
python3 -m venv .venv && .venv/bin/pip install --group docs
cd build && ../.venv/bin/texsmith ../docs/01-cahier-des-charges.md --build
```
