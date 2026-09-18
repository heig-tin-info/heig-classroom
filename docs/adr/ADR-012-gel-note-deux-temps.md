# ADR-012 — Grade freezing: receipt time written synchronously, two-step freeze

## Status

Accepted (2026-07-03, phase 3).

## Context

The grade frozen at the deadline is the most disputable piece of data in the system. The
reference for the freeze is the server receipt time of the push webhook, persisted per SHA
(GR-14, H6) — never the git timestamp, which can be forged. A run on a commit received before
the deadline but finished after it counts towards the frozen grade, within the limit of a
grace period (GR-14.4, default 30 min). Webhooks are processed asynchronously through a queue
(GH-60): if the receipt time depended on the processing, a queue delay would change grades.

## Decision

1. **Synchronous write of `push_receipts`** in the webhook's HTTP handler, before the job is
   enqueued: the receipt time (the legally decisive data of the freeze) never depends on the
   queue lag. Acknowledgement stays under 5 s (two INSERTs).
2. A **`bot_commits` table** (`student_repo_id`, `sha`, `kind`) fed on every bot push
   (revert, deadline, sync): a **deterministic** GR-05/GH-44 eligibility filter, more reliable
   than inferring from the actor at run time.
3. **A two-step freeze** (a literal reading of GR-12 and GR-14.4, borrowed from the
   productivity proposal):
   1. When the deadline is applied, `frozen_grade_run_id` is set **provisionally** (the
      current GR-09 grade at that instant).
   2. During the grace period, only runs on commits received before the deadline (present in
      `push_receipts`) can still improve that pointer.
   3. At `deadline + grace_minutes`, the ticker sets `frozen_at` and `frozen_final`: the
      frozen grade becomes definitive and immutable, and later runs never change it.
4. A SHA with no known receipt time (lost webhook, reconciled after the fact) is treated as
   `after_deadline = true` as soon as the deadline has passed — the conservative GR-14.3
   choice, open to a teacher's arbitration in the light of the history.
5. The grace period is configurable per assignment; the portal recommends 60 min when the
   class size makes runner capacity the limiting factor (ADR-007).

## Consequences

- The freeze is **insensitive to processing delay**: a deadline burst only produces display
  lag, never a wrong grade.
- Disputes are settled on persisted facts: `push_receipts.received_at` per SHA, `bot_commits`
  for excluding bot commits, the full history of the GradeRuns.
- The grading pipeline and the freeze are decoupled from runner availability: a failed runner
  delays the grades, and the freeze waits for the grace period and then locks in.

## Rejected alternatives

1. **Receipt time written by the asynchronous worker** (productivity proposal, not spelled
   out): a queue delay would shift the reference time towards the processing time —
   unacceptable for a piece of data that separates submissions to the second.
2. **A single-step freeze at `deadline + grace` only**: simpler, but it offers no provisional
   grade to display during the grace period, and the literal reading of GR-12 (freeze at the
   deadline) would be lost.
3. **A bot filter based on the run's `github.actor` only**: it depends on the workflow's
   execution context; the per-SHA `bot_commits` table can be verified after the fact and
   replayed.
