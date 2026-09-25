# Deploying HEIG Classroom

This section is for the **operator** — the person hosting the portal. Teachers
and students never touch anything described here: once the platform is
deployed, onboarding a teaching organization happens entirely from the portal
(see the [GitHub App](github-app.md) page, *Onboarding an organization*).

## What a deployment looks like

One small VM runs everything (ADR-009) — in production a Hetzner Cloud VM
(1 vCPU / 2 GB) shared with two other services: the Node monolith (API + built SPA),
PostgreSQL and a daily backup job under Docker Compose, behind a native Caddy
for TLS. State lives in PostgreSQL only (ADR-004); secrets travel through the
environment and a `secrets/` directory, never through git (ADR-010).

```
Caddy (TLS) ──► app (Fastify + SPA, :3000) ──► PostgreSQL
                     ▲                              ▲
        GitHub webhooks / OIDC login          pg_dump backups
```

## Steps

1. **Provision the VM** — Ubuntu, 2 GB of swap, UFW with SSH/80/443 (plus the
   Hetzner Cloud Firewall), rootless Docker + compose plugin for the `srv`
   service account, native Caddy with one fragment per project under
   `/etc/caddy/conf.d/`, SSH hardened (no root login). The full command list
   lives in [`deploy.md`](https://github.com/heig-tin-info/heig-classroom/blob/main/deploy.md)
   at the repository root.
2. **DNS** — make the portal's hostname a CNAME to the VM's name
   (`portal.heig.chevallier.io`).
3. **Clone and configure** — as `srv`, clone the repository into `/srv/heig-classroom`,
   copy `.env.prod.example` to `.env.prod` and fill it in: PostgreSQL password,
   cookie secret, OIDC provider (SWITCH edu-ID in production), super-admin
   e-mail, Scaleway TEM credentials for e-mail, session TTL.
4. **Create the GitHub App** — once, globally. Follow
   [the GitHub App page](github-app.md); the App ID, private key, slug,
   webhook secret and OAuth client land in `.env.prod` and `secrets/`.
5. **First start** — the image is never built on the VM, it is pulled from
   GHCR:
   `docker compose -f compose.prod.yml --env-file .env.prod pull app` then
   `docker compose -f compose.prod.yml --env-file .env.prod up -d`.
   Migrations run at boot (`MIGRATE_ON_START=1`); check
   `https://<host>/healthz` returns `database: up, jobs: up`.
6. **Backups** — two layers. Hetzner Backups (to enable in the Hetzner
   console) keeps a daily image of the whole VM, off the VM: that covers losing
   the machine, though a disk image of a running
   Postgres is crash-consistent rather than a clean dump. The compose `backup`
   service adds a daily `pg_dump` with 30 days of retention — a logical dump,
   restorable table by table, but living on the VM it protects. Take a fresh
   dump before any migration rather than trusting the daily one.

## Updating

Every push to `main` builds the image in CI and deploys it automatically; the
manual equivalent on the VM is:

```bash
cd /srv/heig-classroom && git pull --ff-only
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

Rollback = redeploy an earlier image by its commit sha, which stays on GHCR
(`deploy.md` §7):

```bash
IMAGE_TAG=<commit-sha> docker compose -f compose.prod.yml --env-file .env.prod up -d
```

Migrations are additive; when in doubt, restore the previous night's dump.
