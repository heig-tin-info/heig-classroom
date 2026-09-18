# ADR-004 — pg-boss job queue on Postgres

## Status

Accepted (2026-07-03, phase 3).

## Context

The critical jobs (provisioning, deadline, revert, grading, synchronization, e-mails) must be
durable, idempotent, replayable and caught up after an outage (NFR-09). Webhooks are
acknowledged in under 5 s (GH-60) and then processed asynchronously. The worst expected
throughput is a deadline burst: about 100 pushes plus 100 `workflow_run` events within a few
minutes, i.e. fewer than 10 jobs/s.

## Decision

1. **pg-boss 10**: a job queue persisted **in PostgreSQL** — exponential retries,
   `singletonKey` (idempotency), scheduled jobs, built-in cron, retention and archiving.
2. Bounded concurrency per job type (10 workers): bursts fill the queue without ever
   threatening webhook acknowledgement or the GitHub quotas.
3. Handler failure: 5 attempts with exponential backoff, then **dead-letter**, visible in the
   technical administration screen with manual replay and a log alert.
4. Normalized singleton keys: `provision:<assignment>:<user>` (GH-20),
   `deadline:<assignment>` (GH-43), `revert:<repo>:<head_sha>`.

## Consequences

- No broker and no Redis to operate: the queue survives a crash together with the database,
  is covered by the same backup, and can be inspected in SQL.
- The required throughput is orders of magnitude below what pg-boss can do; the load the
  queue puts on Postgres is negligible at this scale.
- Operational metrics (queue depth, lag, dead-lettered jobs) are exposed on `/metrics`
  (borrowed from the robustness proposal).

## Rejected alternatives

1. **BullMQ + Redis**: a fast queue, but it imposes a second stateful component to back up,
   monitor and secure, for throughput the project does not need.
2. **RabbitMQ, SQS or a dedicated broker**: obvious over-engineering for 20 classrooms; no
   NFR justifies it.
3. **System cron + home-made tables**: reinventing retries, backoff and singletons without
   the proven guarantees of pg-boss.
