# ADR-003 — PostgreSQL as the only stateful component, access through an isolated Drizzle ORM

## Status

Accepted (2026-07-03, phase 3).

## Context

The platform is the source of truth for accounts, roster, assignment configuration, API
keys, audit and frozen grades (C-01); GitHub is the source of truth for Git content and runs.
We need transactions (atomic CSV import AU-14), uniqueness constraints as the idempotency
mechanism (NFR-09), revocable sessions (AU-06), a durable job queue and a simple backup
(NFR-16: RPO 24 h, RTO 4 h).

## Decision

1. **PostgreSQL 17 is the only stateful component**: business data, sessions (hashed), the
   pg-boss job queue, webhook deduplication, audit. A single `pg_dump` covers the whole
   NFR-16 scope.
2. `timestamptz` timestamps in UTC everywhere, converted to Europe/Zurich for display
   (C-02); `uuid` v7 primary keys (time-sortable).
3. **UNIQUE constraints are the idempotency mechanism**: every replay ends in
   `ON CONFLICT DO NOTHING`, never in a duplicate.
4. Access through **Drizzle ORM + drizzle-kit** (close to SQL, versioned SQL migrations, run
   at startup under a lock), with pinned versions. Database access is isolated behind a
   repository layer: the pre-1.0 risk of Drizzle is contained (a switch to Kysely is possible
   without touching the domain).
5. Audit immutability **at the database level**: the application SQL role has neither
   `UPDATE` nor `DELETE` on `audit_log` (NFR-05); only the data protection (FADP)
   pseudonymization routine, under a dedicated role, may rewrite identity fields (NFR-07).

## Consequences

- A single brick to back up, monitor and restore; the restore runbook fits on one page and
  the semester test validates the RTO.
- When a job misbehaves, diagnosis happens in SQL directly on the pg-boss tables — no opaque
  layer between the maintainer and their data.
- Upgrading Drizzle is a targeted piece of work, never a blocker: the migrations are raw SQL
  files, independent of the ORM API.

## Rejected alternatives

1. **Prisma** (productivity proposal): productive, but adds a binary engine and a generation
   chain between the maintainer and their SQL; when a query locks, you read SQL, not Prisma.
2. **Redis as a second stateful component** (sessions or queue): one more moving part, one
   more backup and one more failure mode, with no need justified by an NFR (see ADR-004).
3. **JWT sessions**: AU-06 requires server-side invalidation; a sessions table (hashed token)
   is enough and avoids any token revocation machinery.
