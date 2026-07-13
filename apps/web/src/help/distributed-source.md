# Distributed source

## Squash (default)

The branch is reduced to a **single initial commit**: students receive the
material without its history. Recommended — the teacher's trial-and-error
(and any solution that once lived in the history) stays private.

## Whole history

The full history of the selected branches is pushed as is. Use it when the
history itself is part of the material (e.g. a refactoring exercise).

Either way the snapshot lands in a `<slug>-squashed` repository; student
copies are made from it, never from the live source.
