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

## LLM review at the deadline

The push-triggered grade above is the *indicative* tier. Once an assignment's
grade is definitively frozen (deadline + grace period), the platform fires a
`repository_dispatch` event on every student repository:

```json
POST /repos/{owner}/{repo}/dispatches
{
  "event_type": "grade-final",
  "client_payload": {
    "sha": "<frozen commit>",
    "assignment_id": "…",
    "deadline": "2026-07-03T21:59:00.000Z",
    "trigger": "deadline"
  }
}
```

`client_payload.sha` is the head commit of the **frozen** grade run — the last
run on a commit received before the deadline — never the current HEAD, so late
pushes are ignored by the review exactly as they are by the freeze.
Repositories where the student never produced an eligible run are skipped.
Each dispatch is recorded in a ledger (one per repository and trigger), so
worker restarts and pg-boss retries never fire the review twice.

The student repository reacts in `grading.yml`: a `llm-review` job guarded by
`if: github.event_name == 'repository_dispatch'` checks out
`client_payload.sha`, grades every criterion with
[`score grade --llm`](https://github.com/heig-tin-info/score), commits the
detailed `GRADING.yml` review back to the repository and publishes the mark as
the run's single `GRADE` annotation. On a dispatch, only the review job may
emit the annotation (the objective job must be guarded by
`github.event_name == 'push'`), preserving the exactly-one rule. The reusable
workflow `heig-tin-info/score/.github/workflows/grading.yml` implements both
tiers; student repositories only carry a thin shim calling it.

The completed review run comes back through the regular `workflow_run`
ingestion, but is recorded apart: the platform classifies runs triggered by
`repository_dispatch` on `grading.yml` as `llm` and stores them in their own
slot next to the frozen CI grade — the review never displaces the frozen
grade, and both are visible in the teacher and student views.

Operational requirements:

- **Contents: write** on the App installation — required by the dispatches
  endpoint and already part of the platform's permission set.
- **`ANTHROPIC_API_KEY`** as an organization secret scoped to the classroom
  repositories: the review job needs it to call the model. Set a spending
  limit on the key and rotate it every semester. The key is exposed only to
  the `score grade` step, never to the build/test steps that execute student
  code; the remaining exfiltration path is a tampered `grading.yml`, which is
  why that file must stay in the protected files.
- The review commit is pushed with the workflow's default `GITHUB_TOKEN` — on
  purpose, and **never a PAT**: GitHub does not trigger workflows for
  `GITHUB_TOKEN` pushes, which is what makes a grading loop impossible. The
  platform registers those pushes (sender `github-actions[bot]`) as bot
  commits, so they never produce a grade run nor count as student activity.
- A `grade-milestone` dispatch type is reserved for intermediate milestones
  (same mechanics, one ledger row per milestone); milestones are not
  implemented yet.

### Configuring the Anthropic API key

The review job reads the key from `secrets.ANTHROPIC_API_KEY`. Provide it once,
as an **organization secret scoped to the classroom repositories**, so every
student repository inherits it without ever storing the plaintext key.

1. **Create the key** in the [Anthropic Console](https://console.anthropic.com)
   under *Settings → API keys*. Use a dedicated key for the classroom (so it
   can be revoked without affecting anything else), put it in its own workspace,
   and set a monthly **spending limit** on that workspace — the key runs
   untrusted student code's grading and you want a hard ceiling. Copy the
   `sk-ant-…` value; the console shows it only once.

2. **Store it as an organization secret**, restricted to the class repositories.

   From the GitHub UI: *Organization → Settings → Secrets and variables →
   Actions → New organization secret*. Name it `ANTHROPIC_API_KEY`, paste the
   value, and under *Repository access* choose **Selected repositories**, then
   add the assignment repositories (source, squashed and the per-student ones).
   Never choose *All repositories*: that would expose the key to any repo in the
   org, including ones outside the course.

   Or with the CLI (needs `admin:org`):

   ```bash
   gh secret set ANTHROPIC_API_KEY \
     --org <your-org> \
     --app actions \
     --visibility selected \
     --repos "labo-02-quadratic,labo-02-quadratic-squashed" \
     --body "sk-ant-..."
   ```

   As new student repositories are provisioned, add them to the secret's
   selected list (or grant the secret to the whole set once the naming pattern
   is known). A repository that cannot read the secret still runs the review
   job, but `score grade --llm` fails for lack of a key and the run records no
   grade — visible in the teacher view rather than silent.

3. **Rotate it every semester** (or whenever a key may have leaked): create a
   new key in the console, update the org secret with the command above, then
   revoke the old key. No workflow change is needed — the secret name is stable.

The shim workflow forwards the secret to the reusable pipeline with an
**explicit mapping** — `secrets: inherit` must NOT be relied upon here:
organisation secrets do not cross the organisation boundary when the reusable
workflow lives in another org (`heig-tin-info/score` vs the classroom org).
With `inherit` the LLM tier runs with an empty key and fails; the shim
therefore declares:

```yaml
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Nothing else needs configuring on the student side.
