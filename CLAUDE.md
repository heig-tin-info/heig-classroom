# heig-classroom

A pnpm monorepo of two applications deployed separately:

| Path | Role | Deployment |
| --- | --- | --- |
| `apps/server` + `apps/web` | HEIG GitHub Classroom: classes, assignments, student repositories, CI-based grading | classroom.chevallier.io, 1 GB DigitalOcean VM, **production in service** |
| `apps/codespace` | Portal of supervised development environments (code-server, rootful Podman, SEB exam mode) | dedicated engine VM, under test |
| `packages/domain`, `packages/contracts` | Pure business rules and shared Zod schemas | |

Specifications and ADRs live in `docs/` (classroom) and `apps/codespace/docs/` (portal). Each application has its own `CLAUDE.md` with its invariants; the one in `apps/codespace` takes precedence for anything concerning the portal.

## Production: absolute rules

- `classroom.chevallier.io` is in service for students. **Every push to `main` triggers the image build and its deployment** (`.github/workflows/ci.yml`, `deploy.sh`). We work on branches; `main` only receives changes that are ready to run.
- We do not stop the service, except when a restart is required; we never purge the database; we never run a destructive migration without a verified backup (see `deploy.md`).
- The Dockerfile builds **only** `apps/server` and `apps/web` (`pnpm --filter '!@hgc/codespace' build`). Nothing from `apps/codespace` goes into the production image.
- The portal's container engine **never** runs on the classroom VM: a root Podman socket, nftables and a 1.5 GB image have no business there (956 MiB of RAM, production database).

## Import rule

`apps/codespace` only imports `packages/*`, never `apps/server` or `apps/web`. The same holds the other way round. The two applications talk to each other over HTTP with a signed launch token (to come, portal milestone 2). This rule keeps the portal extractable as an independent project.

## Development

```bash
corepack enable pnpm && pnpm install
docker compose -f docker-compose.dev.yml up -d     # Postgres + Keycloak (classroom)
pnpm dev                                           # classroom on :3000
pnpm build && pnpm typecheck && pnpm test          # both applications
pnpm --filter @hgc/codespace test:integration      # portal: requires rootful Podman, see apps/codespace/docs/setup-poste.md
```

The portal's integration tests are excluded from CI; its unit tests run there. Everything is written in English: code, identifiers, comments, documentation and commit messages. Only end-user UI text follows the user's language (apps/web i18n).
