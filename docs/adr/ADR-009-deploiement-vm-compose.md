# ADR-009 — Deployment on a single VM, Docker Compose, Caddy, SWITCH backups

## Status

Accepted (2026-07-03, phase 3).

## Context

The availability target is 99 % during semesters (NFR-08), with an external probe on
`/healthz`, a daily backup with RPO 24 h and RTO 4 h tested every semester (NFR-16). Personal
data of Swiss students: the Swiss data protection act applies (NFR-07, H11) and hosting in
Switzerland avoids any cross-border transfer question. The operator is a teacher.

## Decision

1. **One HEIG application VM** (4 vCPU / 8 GB / 60 GB, Debian stable), **Docker Compose**,
   three services: `caddy` (automatic Let's Encrypt TLS, HSTS, the only exposed port),
   `app` (a single image, front end included, `restart: always`), `postgres` (local volume,
   not exposed). Webhooks are a route of the monolith behind Caddy; in development,
   `smee.io` or `cloudflared tunnel`.
2. Deployment by `docker compose pull && up -d`, migrations at startup (under a lock), image
   versioned by git tag, rollback to the previous tag.
3. **Backups**: a daily `pg_dump -Fc` through a sidecar cron container, copied off the VM to
   **Swiss institutional object storage** (SWITCH or HEIG, encrypted transfer), with 30-day
   retention. A **timed** restore test once per semester.
4. **Requirements-driven observability**: `/healthz` (DB, pg-boss, clock) probed every 60 s;
   a Prometheus `/metrics` endpoint exposing the age of the oldest unprocessed webhook, the
   queue lag, dead-lettered jobs, the remaining GitHub quota and the ticker lag; a minimal
   technical administration screen (dead letters with replay).

## Consequences

- Three containers, one compose file, a fifteen-line Caddyfile: the whole deployment can be
  rebuilt from scratch in under an hour.
- Restoring follows the runbook: fresh VM, infrastructure repository, secrets from the vault
  (ADR-010), `pg_restore`, DNS, GH-62 reconciliation — the cron jobs absorb the lost window
  (ADR-011). RTO 4 h validated by the semester test.
- Data and backups in Switzerland: the data protection argument is settled.

## Rejected alternatives

1. **A foreign cloud host or backup storage outside Switzerland** (Backblaze, cited by the
   robustness proposal): defensible when encrypted, but it opens an avoidable question of
   cross-border transfer — institutional storage removes it.
2. **Kubernetes or a managed PaaS**: disproportionate operational capacity, external
   dependencies and recurring costs with no gain on the NFRs.
3. **A minimal probe and minimal metrics only** (initial simplicity proposal): the review
   kept the observability from the robustness proposal — without it, diagnosing a deadline
   burst would mean raw SQL in the pg-boss tables.
