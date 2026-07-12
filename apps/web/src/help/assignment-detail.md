# Assignment view

## What this table shows

One row per enrolled student: acceptance, last commit, live CI checks and the grade. The table is sortable and the search field filters students.

## How grades work (two tiers)

- **While open** — every push runs the objective tier (build + tests); the extracted `GRADE` is **indicative**.
- **At the deadline** — the grade is frozen, then the full LLM review runs on the frozen commit and commits `GRADING.yml` (awarded points and rationale per criterion) to the student repository. That review is the **authoritative** grade; a failed review run never counts.

## How to read the columns

- **checks** — live check-runs on the current HEAD. A dash after the deadline is normal: the deadline-marker commit carries no CI.
- **grade** — the frozen grade once locked (lock icon), the current one otherwise. The history icon lists every captured run.
- **Grade now** (play icon) — triggers the grading workflow immediately for that student.

## How to sync student repositories

When the source repository moves ahead, a banner offers to open **sync pull requests** on all student repositories; students merge them at their own pace. Protected files (criteria, grading workflow) are restored automatically if a student modifies them.
