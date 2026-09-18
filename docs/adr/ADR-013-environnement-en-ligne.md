# ADR-013 — Online workspace: no student credential, therefore no write access

## Status

Accepted (2026-09-17, portal milestone 2).

## Context

The `apps/codespace` portal makes the student work inside a hardened container served by
code-server, possibly under Safe Exam Browser. Its founding invariant is that **no secret
enters the student container**: no GitHub token, no SSH key, no credential helper. It is the
container that pushes — through a relay authenticated by the source IP address on the
internal bridge — and not the student from their editor.

Now, in the historical classroom flow (the "free" mode), the student repository is
provisioned with `push` permission: the student clones and pushes with their own GitHub
account. Keeping that right in online mode would mean two write paths coexisting on the same
repository (the portal relay, and the student from any browser), which makes the content of
an exam indefensible: nothing distinguishes a commit produced in the supervised session from
a commit pushed from home.

We also have to decide who may turn the feature on. The container engine is a privileged
component on a dedicated VM with bounded capacity (a few dozen sessions); opening it to every
teacher of `classroom.chevallier.io` at once makes no sense while the pilot covers one or two
classes.

## Decision

1. **An assignment has a work mode** (`assignments.work_mode`, `WorkMode` of the shared
   contract): `free` (unchanged), `online`, `online_seb`. The default is `free`: every
   existing assignment keeps exactly its behaviour.
2. **No student credential, therefore no write access.** Provisioning
   (`github/provision.ts`) invites the student with the permission:
   - `free` → `push` (the historical flow, strictly unchanged);
   - `online` → `pull`: the student reads their repository and re-reads their commits, but
     only the portal relay writes to it — so there is no student credential to distribute,
     expire or revoke;
   - `online_seb` → **no invitation at all**: during an exam, the student has no access to
     the repository before grading.
   The anti force-push and anti-deletion ruleset (`hgc-protect`, GH-21..23) stays in place in
   all three modes: it also protects against the relay.
3. **A one-way door.** An assignment published in an `online*` mode cannot go back to `free`
   (409 `work_mode_frozen`). Its repositories were provisioned without write access; going
   back to `free` would leave every student in front of a repository they cannot push to, and
   granting `push` after the fact would contradict exactly the invariant this mode protects.
   A new assignment is created instead.
4. **Activation by the administrator, teacher by teacher**, with a quota of simultaneous
   sessions: two columns on `teacher_grants` (`codespace_enabled` at `false`,
   `codespace_max_active_sessions` at 2). A teacher without that grant does not see the
   "Work mode" section of the form (the front end reads `Me.codespace`) and the API refuses
   any non-`free` mode with a 403 — the server-side check is the only authoritative one.
5. **Global absence is possible.** An empty `CODESPACE_URL` means the feature does not exist:
   no administration column, no selector, and the `/app/codespace/*` routes answer 404. A
   `CODESPACE_URL` without a `CODESPACE_LAUNCH_SECRET` of at least 32 characters makes
   startup fail (ADR-010: secrets travel through the environment).
6. **Two HS256-signed messages, never a cross import** (the import rule of the root
   `CLAUDE.md`):
   - classroom → portal: `PUT ${CODESPACE_URL}/api/assignments/:id` with a
     `CodespaceAssignmentSync` body and a 2-minute `ServiceTokenClaims` in
     `Authorization: Bearer`. The call goes through **a pg-boss job** (`codespace.sync`,
     singleton key `codespace:<assignment>`, ADR-004/ADR-011): a portal that is restarting
     never makes saving an assignment fail, recovery is free, and the state of the last
     attempt (`codespace_synced_at`, `codespace_sync_error`) is shown to the teacher with a
     "Resync" button.
   - student → portal: `GET /app/codespace/start/:aid` checks enrollment, acceptance,
     publication and mode, issues a 5-minute `LaunchTokenClaims` with a random `jti` and
     redirects with a 303 to `${CODESPACE_URL}/launch?token=…`. It is a **navigable GET**
     because the portal also uses it as the `startURL` of Safe Exam Browser, which can only
     navigate. Issuance is logged (`codespace.launch_issued`) by its `jti`; the token itself
     never enters the log (AU-41).
7. **Browser Exam Keys are teacher-side secrets.** They are stored on the assignment
   (`browser_exam_keys`), sent to the portal in the synchronization message, and **never**
   included in a student payload.

## Consequences

- In online mode a student can no longer push from their own machine: that is the intended
  effect, but it means the portal becomes indispensable to submission. An outage of the
  portal during an online lab is therefore a submission incident, not merely a comfort one —
  the `free` mode stays the default for everything that does not need supervision.
- The grading CI is unchanged: it triggers on the relay's pushes exactly as on a student's,
  and the whole grading chain (GR-05..16) ignores the mode.
- The migration is purely additive (columns with defaults, no rewrite): the production
  service gets `work_mode = 'free'` everywhere and does not change behaviour.
- The quota is carried by the **owner of the class**, not by the staff member who saves the
  assignment: it is the person running the course who consumes the VM's capacity.
- The portal stays extractable: all it knows of classroom is those two signed messages.

## Rejected alternatives

1. **Keeping `push` in online mode** and relying on supervision: two write paths on the same
   repository, indefensible exam content, and the "no secret in the container" invariant
   would lose its point since the student would have a credential anyway.
2. **Distributing a short-lived token inside the container** so the student pushes
   themselves: that is exactly the secret the container hardening forbids, and it would be
   exfiltrable from any terminal in the editor.
3. **A synchronous HTTP call to the portal when the assignment is saved**: an unavailable
   portal VM would make an unrelated teacher action fail, and we would have to reinvent the
   recovery that pg-boss already provides.
4. **Global activation through an environment variable**: it would be impossible to run one
   class without exposing all the others, and there would be nowhere to put the per-teacher
   quota.
5. **A single global quota** rather than one per teacher: a teacher starting an exam would
   consume everyone else's capacity without any screen showing it.
