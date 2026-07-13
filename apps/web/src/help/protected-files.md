# Protected files

## What they are

Files the student must not touch: the grading criteria, the grading workflow,
the assignment statement. The usual suspects (`criteria.yml`, `README.md`,
`.github/workflows/grading.yml`) are pre-checked automatically when they exist
in the source repository.

## What protection does

If a student commits a change to a protected file, the platform reverts it
automatically within seconds (the reverted content comes from the assignment's
snapshot). Repeated tampering is rate-limited and flagged to you.

## How to adjust the list

Expand the section and check or uncheck files in the tree. The list can still
be edited after creation, from the assignment's edit dialog.
