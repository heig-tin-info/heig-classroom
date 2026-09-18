# ADR-011 — Reconciliation reuses the idempotent webhook handlers

## Status

Accepted (2026-07-03, phase 3).

## Context

GitHub can lose or delay webhook deliveries; some events do not exist at all (invitation
expiry, GH-24). The specs require a catch-up: reconciliation of GradeRuns every 15 min
(GR-07), daily reconciliation of branches, invitations and missed deliveries (GH-62). After a
database restore (NFR-16), the state must resynchronize on its own. The classic risk is
writing two state-update code paths (one for webhooks, one for polling) that drift apart over
time.

## Decision

1. A structuring rule (borrowed from the robustness proposal): **every piece of state has two
   arrival paths — webhook (nominal) and reconciliation (fallback) — but a single update
   code path**. The reconciliation cron jobs build normalized events and invoke **the same
   idempotent handlers** as the webhook pipeline.
2. Handler idempotency rests on the UNIQUE constraints of the schema (ADR-003): replaying an
   event, whatever its source, never produces a duplicate.
3. The cron jobs retained: `reconcile.grades` (15 min, GR-07), `reconcile.repos` (24 h,
   branches and invitations, GH-24), `reconcile.deliveries` (24 h,
   `GET /app/hook/deliveries` with redelivery, GH-62), plus the maintenance tasks (purge,
   e-mails).
4. A deliberate exception: the **receipt time** of a push reconciled after the fact is
   unknown — the conservative GR-14.3 rule applies (`after_deadline = true` if the deadline
   has passed), open to a teacher's arbitration.

## Consequences

- A single state code path to test and maintain; the fallback polling cannot diverge from the
  nominal path.
- **The idempotent design is also the recovery plan**: after an outage or a restore, the cron
  jobs absorb the lost window on their own, with no special procedure.
- Polling stays limited to catching up (NFR-10): in nominal operation, everything arrives
  through webhooks.

## Rejected alternatives

1. **A separate reconciliation code path**: a double implementation of the state rules, with
   guaranteed drift in the long run; that is exactly the defect this rule prevents.
2. **Generalized periodic polling** instead of webhooks: it would violate NFR-10 (rate
   limits, polling limited to catching up) and degrade the NFR-12 latency.
