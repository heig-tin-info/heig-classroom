# At deadline

## Lock the repository (default)

At the deadline a ruleset blocks every push: the repository becomes read-only
for the student. Clean and unambiguous; reopening (rescheduling) unlocks.

## Deadline commit

The repository stays writable, but the platform pushes an **empty marker
commit** on each branch at the deadline: anything after the marker is visibly
late. Grading only ever counts work received before the deadline (server
receipt time), whichever strategy you pick.

The strategy is fixed once the assignment is published.
