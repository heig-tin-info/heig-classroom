# ADR-014 — Group assignments: groups per assignment, formed by the staff, delivered in three lots

## Status

Accepted (2026-09-21, phase 4, issue #2). Lot 1 (group formation) implemented and deployed on
2026-09-21; lot 2 (one repository per group) implemented on 2026-09-24, see "Lot 2" below;
lot 3 specified here and not yet written.

## Context

Labs are often worked in pairs or threes, and until now the platform only knew individual
assignments: one repository per student, one grade per student. Teachers were duplicating the
work by hand — one student pushes, the others watch, and the grade is copied over afterwards.

Three questions decided the design, all three settled with the teacher on issue #2:

1. **Where do the groups live?** Two labs of the same class are rarely worked in the same
   teams, so a class-wide group list would be wrong half the time.
2. **Who forms them?** Letting students form their own groups means invitations, acceptances,
   a deadline to close the formation, and a teacher who has to arbitrate the leftovers.
3. **What happens once a repository exists?** Adding someone to a group that already has a
   repository is an invitation; removing someone is a revocation — and neither is a
   database-only operation.

The platform also runs an online work mode (ADR-013) where the codespace portal owns the
workspace and pushes on the student's behalf. One workspace serves one student, by
construction, so shared work has no meaning there.

## Decision

1. **A group belongs to ONE assignment** (`assignment_groups.assignment_id`), not to the
   classroom. To spare the retyping, the group screen offers **"Copy from…"**: the groups of
   another group-mode assignment of the same class are duplicated, members included.
2. **The staff forms the groups**, on a dedicated screen: pick a group, click the students
   into it, next group. Students never form, join or leave a group. `POST /groups/split`
   (groups of N in roster order) and `POST /groups/singles` (everyone else alone) do the bulk
   of the typing.
3. **Membership is by roster entry** (`enrollments.id`), not by user account: a student is in
   a group before they ever sign in, exactly like the rest of the roster.
   `UNIQUE(assignment_id, enrollment_id)` states the invariant — at most one group per student
   per assignment — and adding someone to another group *moves* them.
4. **A group that owns a repository is locked**: no rename (the repository is named after the
   slug), no deletion, no member removal — all answered `409 has_repo`, and the screen shows a
   lock. Adding a member stays allowed: lot 2 only has to invite them. (Lot 2 lifts the refusal
   for member removal only, by revoking the access for real.) The lock is read from
   `student_repos.group_id`, so it is a fact about GitHub, not a flag to keep in sync.
5. **The maximum size is advisory** (`assignments.group_max_size`): exceeding it shows a
   warning, it never refuses. Real classes have an odd student, a repeater, a late arrival.
6. **Group mode requires `work_mode = 'free'`** (`400 group_mode_requires_free`, both
   directions) and can only be turned on or off **while the assignment is a draft**
   (`409 not_draft`). The advisory size stays editable at any time.
7. **Publishing refuses to leave anyone out**: a group-mode assignment with a student in no
   group — or with no group at all — answers `409 unassigned_students` with the names, before
   any state change and before any e-mail. The screen offers "put them in individual groups"
   and retries. The scheduled auto-publication applies the same rule inside its atomic claim
   (`ticker.ts`), so a group draft with someone left out stays a draft past its start date
   instead of publishing silently — and goes live on the tick that follows the fix.
8. **Three lots**, each shippable on its own:
   - **Lot 1 (this one)**: schema, API, group-formation screen, publish guard. No GitHub call,
     acceptance untouched.
   - **Lot 2**: one repository per group at the first acceptance, every member a collaborator;
     deadline, freeze and review per repository. Removing a member becomes possible again
     (revoking the collaborator). GitHub teams are *not* used: students are outside
     collaborators, not members of the organization, and a team only grants access to its
     members — so each member is invited individually on the group repository. Removing a
     student from the roster must then refuse, or revoke their access first: today the
     cascade takes them out of a locked group without telling GitHub anything.
   - **Lot 3**: per-member GitHub invitation follow-up, and the teacher's per-member
     adjustment of the group grade.

## Lot 2 — one repository per group

**Data model: one `student_repos` row per group repository**, `group_id` set, `user_id` the
student whose acceptance created it. The members are read from `assignment_group_members`,
never copied onto the row. Rejected: one row per member pointing at the same repository —
`github_repo_id` is unique, and every flow keyed on the repository (webhooks, CI capture,
deadline, freeze, LLM dispatch, sync pull requests) would have had to learn to fan out, or would
have dispatched the review once per member. With one row per repository none of them changed:
deadline, freeze, CI grade and LLM review are per repository, hence per group, by construction.

What did change is the single question "which repository is this student's?", answered in one
place (`apps/server/src/group-repos.ts`, rule `pickStudentRepo` in `@hgc/domain`) and used by
the detail table, the classroom grade sheet, the per-assignment export and the student home. Grades
and exports stay **one line per student**, each member reading the group repository's grade.
Refresh hints and the final-grade e-mail go to every member.

- **Acceptance.** The first member to accept creates the repository
  `<assignment-slug>-<group-slug>` (capped at GitHub's 100 characters) and every member with a
  linked GitHub account is invited (`push`) right away. Later acceptances only attach the member
  (idempotent invitation). A student in no group gets `409 no_group`. A member without a GitHub
  login is invited when they link their account, or when they accept.
- **One provisioning at a time.** Migration `0029_group-repos` adds a partial unique index on
  `(assignment_id, group_id)`, so two members accepting at the same second insert one row, and a
  `provision_claimed_at` column: an atomic claim lets one acceptance provision the row (a failed
  row, or a pending one with no claim or a claim older than five minutes), the other answers
  `409 provision_in_progress`. A late failure never overwrites a provisioned row. The same
  migration narrows `student_repos_assignment_user_uq` to `WHERE group_id IS NULL` (an index swap,
  no data change): a group repository's `user_id` is only its creator, who may already hold
  another row on the assignment — a failed lot-1 row, a solo group formed afterwards.
- **No adoption across classrooms.** Provisioning adopts an existing repository of the same name
  (a 422 is "step already done"). The claim therefore reserves the name on the row while it is
  still pending, and a name another tracked row bears or reserves is disambiguated with the group
  id. And a group row never adopts a repository whose GitHub id another row already records: the
  provisioning fails before anyone is invited on it.
- **Membership changes follow on GitHub.** Adding (or moving in) invites; removing (or moving
  out) revokes the collaborator seat and cancels a pending invitation **first** — a refusal from
  GitHub answers `502 revoke_failed` and leaves the membership untouched. Rename, deletion and
  copy over a group with a repository stay `409 has_repo`. Removing a student from the roster
  revokes their group access before the cascade, with the same refusal.
- **Existing data is not migrated.** Group assignments may hold individual repositories created
  by lot-1 acceptances. They keep working for their student: a live individual repository wins
  over the group one in every read view, its holder is not invited into the group repository nor
  mailed about it, and an acceptance returns it unchanged. "Live" is one predicate,
  `isLiveIndividualRepo` in `@hgc/domain` (provisioned, named, not deleted): a failed or pending
  lot-1 row holds nobody out of their group's repository. Once deleted on GitHub, the group
  repository takes over.
- Every GitHub write is audited (`group.repo.invite`, `group.repo.revoke`), next to the existing
  `assignment.accept`, `group.member.*` and `roster.remove` entries which now name what was
  invited or revoked.

Left for lot 3: the per-member invitation follow-up (today the row's `invitation_status` and the
reconciliation track the creator's invitation only), and the teacher's per-member adjustment of
the group grade.

## Consequences

- The additive migration `0028_assignment-groups` adds two tables and three columns; nothing
  is dropped and no existing assignment changes behaviour (`group_mode` defaults to false).
- `student_repos.group_id` is nullable and `ON DELETE SET NULL`: deleting a group never
  deletes a repository, and lot 1 can read the lock before lot 2 ever writes the column.
- The group screen is a teacher tool, so every route sits behind the teacher guard and
  `accessibleAssignment`; an individual assignment answers `409 group_mode_off` even on a read.
- The detail table stays per student in lot 1: the repository column is simply empty for a
  group assignment until lot 2 fills it. That is deliberate — lot 1 must be deployable while
  lot 2 is still being written. Lot 2 groups the table by team: one row per group, its members
  listed under its name.
- Every write is audited (`group.create`, `group.rename`, `group.delete`, `group.member.add`,
  `group.member.remove`, `group.copy`, `group.split`, `group.singles`) and publishes an
  `assignments` refresh hint to the classroom topic.

## Rejected alternatives

1. **Classroom-wide groups** (a single team list per class, reused by every assignment):
   simpler, and wrong for the common case — teams change from one lab to the next. "Copy
   from…" gives the same economy of typing without the false invariant.
2. **Students form their own groups** (invitations, acceptances, a formation deadline): a
   whole workflow, its e-mails and its arbitration cases, for a decision teachers already make
   in five minutes in class. It can be added later on top of the same tables.
3. **A hard maximum group size**: the first class with 23 students and groups of 3 would have
   been blocked by the platform. A warning tells the teacher what they already know.
4. **Creating the group repository as soon as the group exists**: it would make every group a
   locked group and turn a formation mistake into a GitHub cleanup. The repository is created
   at the first acceptance (lot 2), like the individual flow.
5. **Allowing a member to be removed from a group that has a repository, and reconciling
   later**: the student would keep write access to a repository they no longer belong to until
   some job caught up. Refusing (`409 has_repo`) is honest, and lot 2 lifts the refusal by
   doing the revocation for real.
