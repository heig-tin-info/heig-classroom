# What is HEIG Classroom

GitHub announced in May 2026 that GitHub Classroom, its tool for orchestrating
student repositories around assignments, would be retired on August 28, 2026,
after 18 months in maintenance mode. The official transition points educators to
two partner products: [Codio](https://www.codio.com/), a commercial hands-on
learning platform, and Classroom 50, a free open-source alternative maintained by
the Fifty Foundation.

Neither of them fits the way computer science is taught in the TIN department at
HEIG-VD, where the needs are basic but specific. A teacher writes an assignment as
a regular Git repository, students each get their own private copy with push
access, a CI workflow grades every push, and the whole thing locks itself at the
deadline. Around that core we want a single source of truth per assignment, a
one-page view of who pushed what and which tests pass, protected files that
students cannot tamper with (tests, CI configuration), the ability to squash the
assignment history so the solution never leaks from the private master repository,
a clean path to push fixes to every student repo through pull requests, easy reuse
of assignments from one year to the next, and login through Switch edu-ID with the
GitHub account linked to the student's academic identity.

Rather than bending a generic platform to do all that, we built HEIG Classroom
from scratch for the Fall 2026 semester. It is a small Fastify monolith on top of
PostgreSQL, driving GitHub through a GitHub App. GitHub stays the source of truth
for everything Git; the portal orchestrates.

## Teacher workflow

The teacher writes the assignment wherever they like, as a normal repository with
a `grading.yml` CI workflow that prints the earned and maximum points (an LLM
based code review can slot in here just as well as plain unit tests). Student
repositories live in a GitHub organization, typically one per course such as
`heig-info2-tin-b`, upgraded to the Team plan for free through GitHub Education.
The HEIG Classroom GitHub App is installed on that organization once.

From there everything happens in the portal:

1. Create a classroom bound to the organization.
2. Import the roster from the GAPS student list, dropped as an Excel or CSV file.
   Column detection is permissive, so the export works as is.
3. Create an assignment pointing at the source repository, pick the dates, the
   deadline strategy and the protected files directly in the repository tree.
4. Publish. Students can now accept the assignment.

At creation time the portal squashes the source into a sibling repository with the
`-squashed` suffix. That repository is the single source of truth distributed to
students: full content, no history, so the solution and the drafting process stay
private. The teacher can keep committing to it, and the portal can later open pull
requests on every student repository to distribute fixes.

## Student workflow

Students sign in with Switch edu-ID. On first login the portal matches their
verified e-mail against the roster and attaches them automatically, so there is no
invitation code to type. The one manual step is linking their GitHub account,
which uses a minimal `read:user` OAuth scope.

After that the student picks an assignment, clicks accept, waits a few seconds
while their private repository is provisioned (created from the squashed source,
protected against force pushes, with push access granted), then clones it and
works normally: commit, push, repeat. Every push triggers the grading CI and the
indicative grade shows up in the portal. When the deadline hits, the repository is
either write-locked or stamped with a signed empty commit, depending on the
strategy the teacher chose. If a CI was configured, the grade is right there in
the interface.

## Traceability

The deadline commit is authored by the App bot and force pushes are blocked by a
repository ruleset, so the history up to the deadline can be trusted as evidence.
For assignments that need intermediate checkpoints, the same trick generalizes
into milestones: a bot commit dropped on demand or at a scheduled time. GitHub has
no atomic "commit everywhere at once" primitive, but revoking push access,
committing, and restoring access gets close enough in practice.

## CLI

A companion CLI (a `gh` extension) talks to the portal API with a teacher API key.
It clones or syncs a whole assignment or classroom in one go, which is handy for
grading offline or keeping a local backup:

```bash
$ gh classroom
Select your classroom
> (dropdown)
Select your assignment
> (dropdown with all)
... then it clones
```
