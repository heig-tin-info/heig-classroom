# ADR-006 — Deadlines through a single ticker-sweeper, no scheduled one-shot job

## Status

Accepted (2026-07-03, phase 3).

## Context

The deadline job must start at most 60 s after the due time and apply to 100 repositories in
under 5 min (US-22, NFR-13), survive an outage of any length without double application
(NFR-09), and follow deadline rescheduling (US-08, GH-43). Deadlines are entered in
Europe/Zurich and stored in UTC (C-02).

## Decision

1. A **single ticker** runs every 20 s, protected by a Postgres advisory lock (safe even
   after a `WORKER_MODE` split): it selects the published assignments whose
   `deadline_at <= now()` and `deadline_applied_at IS NULL`, and enqueues a `deadline.apply`
   job (singleton per assignment).
2. `deadline.apply` fans out into per-repository jobs (concurrency 10), each idempotent (it
   re-reads `locked_at` and `bot_commits` before acting); individual failures stay in retry
   without blocking the other repositories.
3. **Freezing** follows the same mechanism: a scan on `frozen_at IS NULL` triggers the
   definitive freeze at `deadline + grace_minutes` (details in ADR-012).
4. The partial indexes `assignments(deadline_at) WHERE state='published' AND
   deadline_applied_at IS NULL` (and its equivalent for freezing) make the scan free.

## Consequences

- Start guaranteed in under 60 s (20 s period, a factor-3 margin).
- **Rescheduling is free**: the ticker re-reads the table, there is no job cancellation to
  handle.
- **Catch-up after an outage is free**: the SQL condition stays true as long as the deadline
  has not been applied; no double application, thanks to `deadline_applied_at` and to the
  idempotency constraints.
- A single code path to test and debug.

## Rejected alternatives

1. **A one-shot job scheduled at `deadline_at`** (`startAfter`, productivity and robustness
   proposals as a latency optimization, backed by a guarantee sweeper): the "belt and
   braces" approach maintains two code paths that can diverge, for zero latency gain against
   a 20 s ticker. The review kept the single mechanism.
2. **External cron (systemd timer)**: it moves the logic out of the application process and
   complicates deployment with no benefit; pg-boss and the in-process ticker cover the need.
