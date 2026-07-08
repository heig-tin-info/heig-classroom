# Automatic grading

HEIG Classroom grades student work by reading a single annotation out of the
GitHub Actions run, so there is no artifact to upload, no token to inject into
student repositories, and the grade is visible in the GitHub UI exactly as the
platform records it.

## How it works

Your assignment repository ships a workflow at `.github/workflows/grading.yml`.
When a student pushes, the workflow runs their tests and emits one workflow
command on its last step:

```bash
echo "::notice title=GRADE::4.5/6"
```

That command creates a check-run annotation titled `GRADE`. The platform
receives the `workflow_run` webhook, reads the annotations with its
`checks:read` permission, parses `points/max` and records a grade run. The
grade then shows up live in your assignment view and on the student's
dashboard, marked as indicative.

The message must match `points/max` with decimals written with a dot, `max`
greater than zero and `points` not exceeding `max`. Anything else is recorded
as malformed and flagged in the teacher view.

Emit the annotation exactly once per run. Two `GRADE` annotations in the same
run invalidate the grade, even when they carry the same value. This is the
guard against students printing a forged annotation from inside their own test
code: the forged one plus yours makes two, and the grade is voided for you to
inspect.

## Template

```yaml
name: grading

on:
  push:
    branches: [main]

jobs:
  grade:
    runs-on: ubuntu-latest
    # Bot pushes (protected-file restores, deadline markers, sync branches)
    # must not consume Actions minutes nor produce grade runs.
    if: github.actor != 'hgc-prod[bot]'
    steps:
      - uses: actions/checkout@v6

      - name: Run tests
        id: tests
        continue-on-error: true
        run: |
          # Replace with your real test command; write the score you computed
          # to the step output so the final step can publish it.
          POINTS=$(./run-tests.sh --score)
          echo "points=$POINTS" >> "$GITHUB_OUTPUT"

      - name: Publish grade
        if: always()
        run: |
          echo "::notice title=GRADE::${{ steps.tests.outputs.points || '0' }}/6"
```

The final step runs with `if: always()` so the grade is published even when a
test step fails, and it is the only step allowed to emit the annotation. On the
development instance the bot account is `hgc-dev[bot]` instead of
`hgc-prod[bot]`.

## What the platform records

Every eligible run becomes an immutable grade run: eligible means the run's
branch is one of the assignment's selected branches and the head commit was not
pushed by the platform bot. The current grade is the most recent run received
before the deadline whose annotation parsed correctly. Repositories without a
`grading.yml` still get pass/fail tracking aggregated over their workflow runs.

At the deadline the current grade freezes. During the grace period (30 minutes
by default) runs that evaluate commits pushed before the deadline can still
improve the frozen grade, which covers the run that was still executing when
the deadline hit. What counts is when the platform received the push, never the
git timestamp, which a student can trivially forge. After the grace period the
frozen grade is final; later runs stay in the history with an "after deadline"
badge, visible to you but never affecting the frozen grade.

Keep `grading.yml` in the protected files of the assignment (it is pre-selected
at creation). The grade remains indicative rather than contractual: the student
code runs in the same job as the annotation, so a determined student can game
it, and the mitigations above make that visible rather than impossible. Treat
it as continuous feedback; the authoritative assessment stays with you.
