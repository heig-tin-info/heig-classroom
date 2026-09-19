# Assignment view

## What this table shows

The figures at the top sum up acceptance, CI, the average grade and the deadline. Below, one row per enrolled student: acceptance, last commit, live CI checks and the grade. The table is sortable, the search field filters students, and clicking a row unfolds its commit activity.

## How grades work (two tiers)

- **While open** — every push runs the objective tier (build + tests); the extracted `GRADE` is **indicative**.
- **At the deadline** — the grade is frozen, then the full LLM review runs on the frozen commit and commits `GRADING.yml` (awarded points and rationale per criterion) to the student repository. That review is the **authoritative** grade; a failed review run never counts.

## How to read the columns

- **checks** — live check-runs on the current HEAD. A dash after the deadline is normal: the deadline-marker commit carries no CI.
- **grade** — the frozen grade once locked (lock icon), the current one otherwise. The history icon lists every captured run.
- **Grade now** (play icon) — triggers the grading workflow immediately for that student.

## How to sync student repositories

When the source repository moves ahead, a banner offers to open **sync pull requests** on all student repositories; students merge them at their own pace. Protected files (criteria, grading workflow) are restored automatically if a student modifies them.

## Online workspace and exam mode

An assignment in an **online** mode also lives in the workspace portal; the banner shows the last successful synchronisation, or the error of the last attempt. **Resync** pushes it again.

In **SEB exam mode** the banner also offers:

- **Download .seb** — the Safe Exam Browser configuration of this exam, over plain HTTPS. Open it in the SEB configuration tool to read the Browser Exam Key of each machine of the fleet, and **never save it again**: saving regenerates the salt and invalidates every file already handed out. The students get the `sebs://` link from their own page; that one launches SEB and is not what you want here.
- **Config Key** — the fingerprint the portal computed for that file. It must match the Config Key the configuration tool displays. If the two differ, the exam start will be refused, and no BEK will help.

The button only appears once the assignment has reached the portal: before the first successful sync there is no `.seb` to download. The full protocol is `apps/codespace/docs/preuve-b-manuelle.md`.
