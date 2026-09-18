# ADR-007 — Ephemeral self-hosted runners for grading, sized by the freeze

## Status

Accepted (2026-07-03, phase 3). Confirmation measurements expected from spike S3 (before M4,
GH-44.3).

## Context

Grading runs exclusively on GitHub Actions (C-04), on private repositories. The Team plan
includes 3,000 min/month; the low estimate (100 students × 20 runs/month × 2.5 min) gives
5,000 min, with much worse peaks during submission weeks. Overrunning is structural. On top
of that, GR-14.4 requires that runs on commits received before the deadline finish within the
grace period, otherwise they are excluded from the frozen grade: compute capacity is driven
by the freeze, not by comfort. Finally, GH-02 forbids any additional organization permission
for the GitHub App without a revision of the spec.

## Decision

1. A **dedicated runner VM** (8 vCPU / 16 GB / 100 GB), separate from the application VM,
   outside the HEIG internal network, with filtered egress (GitHub and package mirrors only).
2. **8 ephemeral runners** (`--ephemeral`, one disposable unprivileged container per job,
   systemd respawn), an immutable image rebuilt by CI, monthly patching.
3. **Sizing derived from the freeze**: required capacity = burst × run duration / grace.
   Worst case 100 runs × 3 min / 30 min = 10 slots; with the recommended 60 min grace for
   classes above 60 students, 5 slots are enough — 8 slots give the margin.
   `grace_minutes` stays configurable per assignment (default 30 min, in line with H6).
4. **Registration outside the GitHub App** (GH-02 unchanged): a dedicated fine-grained PAT,
   organization-scoped, with the single "Self-hosted runners: read & write" permission,
   stored only on the runner VM host (root, 600), expiring after 12 months. The supervisor
   generates a **JIT** configuration per job; the job containers never see the PAT.
5. An **organization runner group** visible to every private repository: dynamically created
   student repositories are covered without an API call at provisioning time (the
   organization is dedicated to teaching). Label `grading`; the `grading.yml` template uses
   `runs-on: [self-hosted, grading]` and the GH-44 anti-bot condition.
6. **A two-step plan B**: scripted rebuild of the VM in under an hour; as a last resort, a
   GitHub spending limit and a sync PR switching `runs-on` to `ubuntu-latest` (paid
   degradation rather than an outage).

## Consequences

- Grading cost is fixed and zero in minutes; the 3,000 hosted minutes stay available for the
  teacher.
- Student code, hostile by definition, runs in a disposable container without any secret: the
  GR-02 annotation convention requires no token in `grading.yml`, so the blast radius of an
  escape is close to nil (the runner VM has access to nothing).
- An outage of the runner VM only delays grades: the freeze is based on `push_receipts`,
  which is insensitive to processing delay.
- One more secret to manage (the runners PAT), with minimal scope and rotation in the
  runbook.

## Rejected alternatives

1. **GitHub-hosted runners alone**: certain budget overrun, billing to steer, and the risk of
   grading being cut off in the middle of a deadline; kept only as plan B.
2. **JIT registration through the GitHub App** (simplicity proposal): it would require the
   "Self-hosted runners: write" organization permission, contradicting the GH-02 table, which
   forbids any additional permission without a revision of the spec. Discarded in favour of
   the dedicated PAT, which also isolates that power on the runner host.
3. **A runner group restricted to a list of repositories** (productivity and robustness
   proposals): it would impose an API call to add the repository to the group at every
   provisioning, with an organization permission that is not planned; "all private
   repositories" visibility is safe in a dedicated organization.
4. **Sizing for the average rush** (simplicity proposal: 6 slots, drain < 15 min;
   productivity proposal: 4-6 slots, 60 min queue): a 60 min queue against a 30 min grace
   would miss runs eligible for the frozen grade, in violation of GR-14.4. The chosen sizing
   starts from the constraint in the spec.
