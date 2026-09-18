---
title: Functional specifications
subtitle: HEIG GitHub Classroom — Phase 2
authors:
  - Yves Chevallier — HEIG-VD
date: 2026-07-03
press:
  template: article
  paper: a4
  language: english
---
> Project: HEIG GitHub Classroom.
> Frame: `01-cahier-des-charges.md` (US-xx, NFR-xx, C-xx);
> analysis: `00-analyse-besoins.md`.
> Conventions: requirements numbered by domain — `AU-xx` (auth, onboarding, API),
> `GH-xx` (GitHub integration), `GR-xx` (grading and metrics), `CLI-xx` (CLI),
> `NT-xx` (notifications). MUST = mandatory, SHOULD = recommended. The identifiers
> are stable and unique.

# Authentication and onboarding (AU)

## Platform login — Switch edu-ID (OIDC)

Switch edu-ID is the sole identity provider for the web session. No local
password (NFR-01).

- **AU-01** — The platform MUST authenticate the users through OpenID Connect with
  Switch edu-ID, *Authorization Code + PKCE* flow, with `state` and `nonce` verified.
- **AU-02** — Requested scopes: `openid profile email`. Claims expected in the ID
  token / userinfo:

| Claim | Use | Mandatory |
| --- | --- | --- |
| `sub` | Stable identifier of the local account (attachment key) | Yes |
| `email` | Roster matching, display | Yes |
| `email_verified` | The roster claim requires `true` | Yes |
| `given_name` | First name | Yes |
| `family_name` | Last name | Yes |
| `swissEduPersonUniqueID` | Academic identifier, stored if present (deduplication) | No |

- **AU-02b** — (GH-11) Facing Switch edu-ID, the `https://eduid.ch/scope/userinfo.read` scope
  MUST additionally be requested: it is behind it that the addresses of the institutional
  affiliations (`swissEduIDLinkedAffiliationMail`) and the affiliations themselves live,
  without which a student registered with a private address remains untraceable in the
  roster. The scope is added only for an edu-ID issuer — an IdP that does not know it
  would answer `invalid_scope`. edu-ID releases these claims **by default only on the
  userinfo endpoint**: it MUST therefore be queried at each login, and a failure of that
  call MUST remain without effect on the session as long as the ID token is enough. What edu-ID
  actually releases depends on the configuration of the client in the Resource Registry.
- **AU-02c** — (GH-11) The whole set of released claims MUST be persisted at each login
  (`user_idp_claims`, one row per account, overwritten). Assumed derogation from minimization:
  an authentication incident is expensive to diagnose after the fact. In return, the
  table MUST stay confined to the server — never joined to a user view, never
  displayed, never exposed by the API.
- **AU-02d** — (GH-11) An account is identified by a **set of addresses**:
  the login address (`email`) and the institutional addresses carried by
  `swissEduIDLinkedAffiliationMail`. They are recorded in `user_emails` at
  each login and are never removed — an affiliation that ends must not
  detach a student in the middle of a semester. Every attachment (roster, staff
  seats, teacher grants, role) MUST be done on this set, never on the login
  address alone. Only the verified addresses count: the login one carries the
  `email_verified` of the IdP, those asserted by the organization are verified by
  construction.
- **AU-02e** — (GH-11) An ambiguous attachment MUST be reported, never guessed. Three
  cases: the address of a roster row is held by two accounts; several rows
  of the same classroom match the same account; the account already holds a row
  in this classroom. All three raise `conflict_flag` (AU-21) and write no
  attachment. An ambiguous staff seat stays unclaimed.
- **AU-02f** — (GH-11) The `teacher` role is granted, in addition to the `teacher_grants` and the
  staff seats (GH-9), to an account whose edu-ID affiliations contain `staff` without
  `student`. A student assistant carries both and stays `student`. The classroom
  guards are unchanged: this role gives access to no one else's classroom.
- **AU-03** — At the first successful login, the backend MUST create a local account:
  `{ oidc_sub, email, email_verified, given_name, family_name, role, created_at }`.
  The account is identified by `oidc_sub`, never by the e-mail (the edu-ID e-mail may
  change).
- **AU-04** — At each login, the profile fields (`email`, names) MUST be
  resynchronized from the claims.
- **AU-05** — If `email_verified` is absent or `false`, the login is accepted
  but the roster claim (§1.4) MUST be blocked with an explicit message.
- **AU-06** — Web session: session cookie `HttpOnly`, `Secure`, `SameSite=Lax`,
  max duration 12 h, invalidable server-side. No OIDC token is exposed to the frontend.
- **AU-07** — The default role of a new account is `student`. The `teacher` role
  MUST be granted exclusively through a **list of authorized e-mails/`sub` in the
  server configuration** (reloaded without a redeployment), managed by the operator of the
  platform. There is no application admin role in v1 (assumption H2 of the requirements
  specification); no self-promotion is possible.

## GitHub account linking (separate OAuth)

The GitHub linking only serves to establish the GitHub identity of the user; the
operations on the repositories go through the GitHub App of the organization, never through a
user token (NFR-02, C-06).

- **AU-08** — The linking MUST use a GitHub OAuth flow (web application flow)
  distinct from the login, triggerable only by a user already authenticated with
  edu-ID. Minimal scope: `read:user` (no write scope).
- **AU-09** — After the callback, the backend MUST store on the account:
  `github_user_id` (immutable, reference key), `github_login` (display,
  periodically resynchronized since it is modifiable), `github_linked_at`. The GitHub OAuth
  token MUST be **discarded** immediately after the identity has been read; it is
  never persisted (C-06 and NFR-02 compliance).
- **AU-10** — A `github_user_id` MUST be linked to at most one local account. In case of
  conflict, the linking is refused with a message indicating that another platform
  account already uses this GitHub account.
- **AU-11** — A student without GitHub linking MUST be able to navigate and consult their
  assignments; only the **acceptance of an assignment** is blocked as long as the
  linking is not done (onboarding banner). Reference behavior for
  US-10.
- **AU-12** — Unlinking: the user MUST be able to unlink their GitHub account. The
  unlinking does not remove the collaborator accesses already provisioned on the existing
  repositories; it blocks any new assignment acceptance. Re-linking to
  another GitHub account MUST be logged (audit) and notified to the teachers of the
  classrooms concerned (NT-03).

## Roster import by the teacher

- **AU-13** — The teacher MUST be able to import the list of students of a classroom
  through a CSV file, UTF-8 encoding, `,` or `;` separator (auto-detected), with a mandatory
  header row:

```text
nom,prenom,email
Dupont,Marie,marie.dupont@heig-vd.ch
Martin,Luc,luc.martin@heig-vd.ch
```

- **AU-14** — Validation at import time: syntactically valid e-mail, normalized (trim,
  lowercase); empty rows ignored; **intra-file** e-mail duplicates rejected
  with the row number. The import is **atomic: all or nothing**, with an error
  report. This semantics is the single reference (US-02 conforms to it).
- **AU-15** — Each row creates a roster entry
  `Enrollment { classroom_id, nom, prenom, email, status }` with `status = pending`.
  Statuses: `pending` / `claimed` (French labels "non réclamée" / "réclamée" at
  display time — single vocabulary for all the documents). The same e-mail may
  appear in several classrooms (one entry per classroom).
- **AU-16** — Re-import: **upsert by e-mail** — the existing entries (including
  `claimed` ones) are kept and their last name/first name updated, the new ones are
  added. The entries absent from the file are NOT deleted automatically;
  the teacher removes them individually (AU-17).
- **AU-17** — The teacher MUST be able to add/edit/delete a roster entry
  manually (same fields as the CSV). If a student repository exists for this
  entry, direct deletion is blocked: an **explicit unenrollment** is
  required, whose effects are: removal of the student's collaborator access on
  the repositories of the classroom, **preservation** of the repositories (archiving at the teacher's
  discretion, GH-25), preservation of the GradeRuns and metrics, logging (audit).

## Roster claim by the student

Single flow: **automatic claim** at login, on a verified e-mail, without
explicit confirmation and without requiring the GitHub linking (reference for US-11;
assumption H3).

- **AU-18** — After the edu-ID login (with `email_verified = true`), the backend MUST
  look for the `pending` roster entries whose normalized e-mail equals the normalized
  edu-ID e-mail, and attach them automatically to the account: `status = claimed`,
  `user_id` filled in, `claimed_at` timestamped. All the matching classrooms
  are claimed at once; a summary screen informs the student of the
  classrooms joined. The `github_login` only appears in the roster after the
  GitHub linking (AU-09), which is not a condition of the claim.
- **AU-19** — The matching MUST be exact (case-insensitive) on the full
  e-mail. No automatic fuzzy matching (last name/first name).
- **AU-20** — Case without a match: the account is created but without enrollment.
  The student sees a screen "no classroom found for `<email>`" inviting them to
  contact their teacher. The teacher MUST be able to resolve the case either by correcting
  the e-mail of the roster entry (the claim replays at the next login or via a
  "retry" button), or by manually attaching the entry to an existing account
  from the roster view.
- **AU-21** — Ambiguous cases: a roster entry can only be `claimed` by a single
  account (uniqueness constraint `enrollment → user`). If the e-mail of an account
  matches an entry already claimed by another account, no attachment takes
  place and the anomaly is reported to the teacher ("conflict" badge in the roster view);
  manual resolution by the teacher only.
- **AU-22** — A manual attachment by the teacher (AU-20, AU-21) MUST be
  logged (who, when, which entry, which account).

## Roles and authorizations

- **AU-23** — Two application roles: `teacher` and `student` (granting of the teacher
  role: AU-07). Access matrix:

| Resource | Teacher (owner) | Student |
| --- | --- | --- |
| Classroom (creation, editing, deletion) | Yes (their own) | No |
| Roster (import, editing, conflicts, github_login, last login) | Yes | No |
| Assignments (creation, publication, controlled modification US-08, deletion with archiving GH-25, synchronization, locking) | Yes | Read-only, only those of their classrooms |
| Student repositories (links, metrics, grades) | All those of their classrooms | Only their own (link, CI status, indicative grade) |
| Source and squashed repository | Yes | No (neither the link nor the existence) |
| API keys | Yes (their own) | No |

- **AU-24** — Every authorization MUST be verified on the backend side at each request
  (ownership of the classroom for the teacher, `claimed` enrollment for the student).
  UI filtering is never enough.
- **AU-25** — A teacher does not see the classrooms of another teacher. (Classroom
  sharing between co-teachers is out of the v1 scope; the
  `classroom → teacher` model stays 1-N extensible.)
- **AU-26** — The grades and metrics of a student are never visible to
  another student.

## Last login

- **AU-27** — The backend MUST timestamp `last_login_at` at each successful edu-ID
  session creation. It is this value (login to the portal) that is displayed in the
  teacher's roster table — decision on open question §5.5 of the analysis.
- **AU-28** — The date of the last push (`last_commit_at` per repository) is a distinct
  metric, displayed at the assignment level, and does NOT replace `last_login_at`.

# GitHub integration (GH)

## GitHub App

### Model and permissions

- **GH-01** — The integration relies on a single **GitHub App** (no OAuth App for
  the server operations), installed on each organization backing a classroom.
  The installation tokens offer fine-grained permissions, a quota of 5,000 req/h
  **per installation** (therefore per organization) and a dedicated bot identity
  (`<app-slug>[bot]`).
- **GH-02** — The App requests the following **minimal permissions**:

| Permission (repository) | Level | Use |
| --- | --- | --- |
| Metadata | Read | Mandatory (API basis) |
| Administration | Read & write | Create the repositories, manage the collaborators, rulesets, archiving |
| Contents | Read & write | Squashed push, revert commits, deadline commit, reading of the trees |
| Workflows | Read & write | Push repositories containing `.github/workflows/grading.yml` |
| Pull requests | Read & write | Synchronization PR |
| Checks | Read | Reading of the check-runs and annotations (grading, §3) |
| Actions | Read | Details of the `workflow_run` |

No *organization* permission is required apart from **Members: Read** (optional,
validation of the teacher's membership of the org). Any additional permission is
forbidden without a revision of this spec.

- **GH-03** — The App authentication follows the standard scheme: JWT signed with the private
  key (duration ≤ 10 min) → `POST /app/installations/{id}/access_tokens` →
  **installation token** (duration 1 h). The backend caches the token per
  installation and renews it at T−10 min; it is never persisted in the database nor
  exposed to the front. The git operations (push) use
  `https://x-access-token:<token>@github.com/...`.

### Installation on the organization

- **GH-04** — When a classroom is created, the teacher chooses the target organization:
  the platform redirects them to the installation page of the App
  (`https://github.com/apps/<slug>/installations/new`) with a signed `state` (CSRF + classroom
  id). Recommended scope: **All repositories** (the student repositories are
  created dynamically; the "selected" scope would impose a manual addition at each
  provisioning).
- **GH-05** — The `installation` (`created`) webhook confirms the installation; the
  backend records `installation_id` on the `Organization` and checks that the account
  installed matches the expected organization. A classroom can only be activated
  with a valid installation.
- **GH-06** — The `installation` (`deleted`, `suspend`) and
  `installation_repositories` events mark the organization as **degraded**: the write
  operations are suspended, the teacher is notified (NT-03) with a reinstallation
  link. No data is deleted.

## Source repositories and source strategies

### Creation of the squashed repository

- **GH-10** — When an assignment is created, the backend validates that the source repository
  belongs to the organization of the classroom and that the selected branches
  exist, then creates the **squashed** repository: private, named `<source>-squashed`
  (numeric suffix in case of a collision), description pointing back to the assignment.
  Its URL is exposed in the teacher UI.
- **GH-11** — The content of the squashed repository is produced according to the **source strategy** of
  the assignment (GH-12/GH-13) and pushed by the bot through git (not the Contents API,
  unsuitable for full trees). The squashed repository is **managed exclusively by the bot**:
  a manual push on it is detected (`push` webhook, author ≠ bot) and reported to the
  teacher.

### "Whole repository" strategy

- **GH-12** — The squashed repository is a **mirror of the selected branches** of the source:
  same commits, same SHAs (`git push` of the selected refs, without tags or other
  refs). The full history is therefore transmitted to the students.

### "Squash into primary commits" strategy

- **GH-13** — Retained definition: for each selected branch, a **primary
  commit** is the complete state of the branch at a publication instant.
  Concretely:

  1. When the assignment is created, the squashed repository receives, per branch, **exactly one
     root commit** whose tree is that of the HEAD of the source branch.
     Author/committer: bot identity. Message:

     ```text
     Initial version — <assignment>

     Source: <org>/<source>@<short-sha>
     ```

  2. At each later synchronization (GH-50), a **new primary commit** is
     added **on top of** the previous one: tree = HEAD of the source, parent = HEAD of the
     squashed repository. The history of the squashed repository is therefore the linear sequence of the published
     versions, without exposing the intermediate commits of the teacher.
  3. Each primary commit carries the source SHA in its message (traceability); the
     backend persists the mapping `primary commit ↔ source sha`.

- **GH-14** — This definition guarantees that the student repositories and the squashed repository share a
  **common ancestor**, the condition for clean synchronization PRs (GH-52). Possible extension
  (out of the v1 scope): `primary/*` tags on the source to publish several
  milestones at once.

### Branch selection

- **GH-15** — By default, the branch retrieved is the **default branch of the
  source**; if the assignment does not specify it, the rule is: `main` if it exists,
  otherwise `master`, otherwise the GitHub default branch. The teacher can select
  additional branches; the first one selected becomes the default branch of the
  student repositories.

## Provisioning of the student repository

- **GH-20** — Upon acceptance by the student, an idempotent job (key
  `assignment_id + user_id`) executes:

  1. Creation of the private repository `<assignment-slug>-<github_login>` in the organization
     (`POST /orgs/{org}/repos`, `auto_init: false`).
  2. **Git push of the refs of the squashed repository** (selected branches) — and not "generate
     from template", which would rewrite the history and break the common ancestor
     (GH-14).
  3. Addition of the student as a collaborator with the **push** role (never
     maintain/admin); the GitHub invitation is accepted by the student (link and state
     displayed in the UI as long as it is `pending`).
  4. Setting of the protection ruleset (GH-21).
  5. Recording of `repo_url`, `default_branch`, `accepted_at`; the URL is
     displayed to the student.

  Any partial failure is taken up by the job (the existing repository name is reused,
  never duplicated). The 60 s SLA (NFR-12) covers steps 1 to 5, that is,
  up to the **sending** of the invitation; the acceptance of the invitation by the student
  is out of SLA.
- **GH-21** — **Prohibition of force push and branch deletion**: a
  **ruleset** at the repository level targets the selected branches with the rules
  *block force pushes* and *restrict deletions*, **without** a bypass for the
  collaborators; the App and the **Organization admin** role appear as bypass
  actors. Constraint: rulesets on private repositories require a GitHub
  Team/Enterprise plan — mandatory verification before M2, with the seat cost of the
  outside collaborators and the invitation quotas (**C-07** of the requirements specification).
- **GH-22** — Fallback if the rulesets are unavailable: the `push` webhook exposes
  `forced: true`; the backend then restores the branch to the last SHA known from a
  bot push and notifies teacher and student. To this end (and for the grade freeze,
  GR-14), the backend persists **at each push webhook**: branch, head SHA and
  **server reception time**. Degraded mode documented, not silent.
- **GH-23** — The student never obtains an administration right: they can neither
  delete the repository, nor modify the rulesets, nor manage the webhooks (the App receives
  its events at the installation level, without a per-repository webhook).
- **GH-24** — **Life cycle of the invitations**: the GitHub collaborator invitations
  expire after 7 days and there is no expiration webhook. The reconciliation
  job (GH-62) lists the `pending` invitations
  (`GET /repos/{owner}/{repo}/invitations`); if an invitation has expired while
  the student does not have access to the repository, a re-invitation is sent automatically (at
  most one per 24 h and per repository) and the student is notified. The student and the teacher
  additionally have a "resend the invitation" action in the UI. The invitation
  state (`pending` / `expired` / `accepted`) is visible to both roles.
- **GH-25** — **Deletion cascades**: the platform **never** deletes a
  GitHub repository silently.

  1. Unenrollment of a student (AU-17): removal of the collaborator access,
     preservation of the repository (archiving offered to the teacher).
  2. Deletion of an assignment: explicit confirmation required; the student
     repositories are **archived** (never deleted) and the squashed repository is kept.
  3. Deletion of a classroom: refused as long as published assignments remain;
     same archiving rules.

## Protected files — revert commit

- **GH-30** — The list of protected files (exact paths relative to the root, no
  glob in v1) is defined on the assignment. Pre-checking at creation time:
  `criteria.yml`, `README.md` **and `.github/workflows/grading.yml`** if they exist
  in the source (consistent with GR-01; unchecking `grading.yml` triggers a
  warning, see US-04). The **reference version** of a protected file is
  that of the **last primary/sync commit** pushed by the bot (not the initial
  version: a synchronization may legitimately update them).
- **GH-31** — **Detection**: at each `push` webhook on a selected branch
  of a student repository, if `sender` ≠ bot, the backend compares `before...after`
  (`GET /repos/.../compare`) and extracts the intersection of the touched files with the
  protected list (modification, deletion or renaming).
- **GH-32** — **Revert algorithm** (Git Data API, atomic):

  1. Read the current HEAD of the branch.
  2. Create a tree `base_tree = HEAD` replacing each protected path with the reference
     blob (re-creation if deleted).
  3. If the resulting tree is identical to that of HEAD, do nothing (already
     compliant).
  4. Create the commit (bot author/committer) and advance the ref by **fast-forward**
     (`update ref`, non-forced) — the student's work is never rewritten,
     only covered over.

  Commit message:

  ```text
  chore(protected): restore protected files

  Restored files: criteria.yml, README.md
  Reference: squashed@<short-sha>. These files are managed by the assignment
  and must not be modified.
  ```

- **GH-33** — **Anti-loop**: the pushes whose author is the bot are ignored by
  GH-31. If the student re-modifies them, the revert repeats; beyond **5 reverts /
  hour / repository**, the backend stops reverting, marks the repository "protected files in
  conflict" and notifies the teacher (protection against a looping student script and
  against exhaustion of the quota). This ceiling is an acceptance criterion of US-21.
- **GH-34** — **Notification**: each revert notifies the student (NT-01, optional
  e-mail NT-02) with the list of the restored files; the revert counter
  appears in the teacher view of the repository. The "student push during the revert"
  race is benign: the non-forced update fails and the webhook of the new push re-triggers
  the analysis.
- **GH-35** — **Resolution of the "protected files in conflict" state**:

  1. Teacher view: the repository is flagged (badge), with the history of the reverts and a
     **"re-enable the protection"** action that pushes a final revert, resets the
     counter to zero and re-arms the detection.
  2. Student view: a banner explains that the protected files of the repository are no longer
     restored automatically and invites them to return to the reference version.
  3. As long as the state persists, the current grade of the repository is marked "to be verified"
     in the teacher view (the criteria files may be altered); the
     GradeRuns keep being recorded.

## Deadline

- **GH-40** — Comparison of the **lock** mechanisms:

| Mechanism | Effect | Bot keeps write access | Student keeps read access | Reversible | Limits |
| --- | --- | --- | --- | --- | --- |
| Archiving of the repository | Everything becomes read-only (code, issues, PR) | No (unarchive first) | Yes | Yes (API) | Also blocks the synchronization and the revert; coarse but simple |
| Removal/downgrade of the rights | Collaborator moved to `pull` | Yes | Yes | Yes | Per collaborator; the student also loses the management of their PRs |
| "Lock branch" ruleset | Push blocked on the targeted branches | **Yes (App bypass)** | Yes | Yes | Requires a Team/Enterprise plan (see GH-21, C-07) |

- **GH-41** — Retained strategy: **lock ruleset**. Bypass actors of the ruleset: the
  **GitHub App** (late revert, corrective commit) **and the Organization admin role**
  (the teacher keeps write access, as US-22 guarantees); these two bypasses are
  part of the acceptance criteria. The reversibility of the ruleset is an asset for a
  future evolution (individual deadline extensions), **out of the v1 scope**
  (see §3.2 of the requirements specification, assumption H1). **Archiving** is the fallback if
  the rulesets are unavailable: it is applied **after** any remaining bot write
  and removes write access from everyone, bot and teacher included — the write access
  guarantee of US-22 therefore only holds in ruleset mode; the archiving mode is reported
  as degraded in the teacher UI.
- **GH-42** — The **deadline commit** strategy pushes, at the due time, an **empty**
  bot-signed commit on each selected branch:

  ```text
  chore(deadline): deadline reached — <assignment> (2026-07-03T23:59:00+02:00)
  ```

  The repository stays open; the **frozen indicative grade** is determined by GR-12 to
  GR-14 (commits received before the deadline, server time — the deadline commit
  itself and the runs it triggers are ignored, GH-44 and GR-05). The two
  strategies are exclusive and fixed per assignment.
- **GH-43** — The deadline job (scheduler, **Europe/Zurich** timezone) is
  idempotent, takes up the failed repositories, reschedules itself if the deadline is modified
  (US-08), and logs `locked_at` / `deadline_commit_sha` per repository. Time
  budget (single, aligned with US-22 and NFR-13): **start ≤ 60 s after the due time,
  full application over 100 repositories ≤ 5 min**. For any dispute about a push close
  to the due time, it is the **server reception time of the push webhook** that prevails
  (GR-14), never the git timestamp.
- **GH-44** — **Side effects of the bot pushes**: the pushes performed with a GitHub App
  installation token trigger the Actions workflows (unlike the
  `GITHUB_TOKEN`). Mandatory consequences and mitigations:

  1. The runs whose head commit is a bot commit (revert, deadline commit,
     synchronization) are **ignored by the grading**: no GradeRun is created (GR-05).
  2. The `grading.yml` template provided to the teachers contains a job condition
     `if: github.actor != '<app-slug>[bot]'` to avoid useless runs.
  3. Quota impact: a deadline commit over 100 repositories may trigger up to
     100 simultaneous runs; the corresponding Actions consumption is measured during the
     S3 spike and documented before milestone M4.

## Synchronization source → squashed → student repositories

- **GH-50** — **Triggering**: the `push` webhook on a selected branch of the
  **source** repository makes the synchronization *available* in the teacher UI (state "source ahead
  by N commits"). The propagation to the students is **triggered
  explicitly by the teacher** (no auto-push: avoid spamming the students with
  PRs at each intermediate commit).
- **GH-51** — On a synchronization request, the backend updates the **squashed repository**:
  fast-forward of the refs (whole repository strategy) or addition of a primary commit
  (GH-13). Then, for each provisioned and non-locked student repository:

  1. Push of the squashed branch to the `sync/<branch>` ref of the student repository (forced
     update allowed on this bot ref only).
  2. Opening of a PR `sync/<branch>` → `<branch>`, bot author, title
     `Sync assignment update (<short-sha>)`, body listing the modified files.
  3. If an **open synchronization PR** already exists, it is reused (the ref is
     updated, a comment reports the new version) — never two synchronization PRs
     open simultaneously.

  The pushes on `sync/<branch>` may trigger workflows: these runs (non-selected
  branch, bot commit) are **excluded from the grading and from the metrics** (GR-05,
  GR-15).
- **GH-52** — **Conflicts**: they are carried by the PR (GitHub displays them) and resolved
  by the student; the bot never merges automatically. If the diff is empty for a
  repository (student already up to date), no PR is opened. The state of the synchronization PRs
  (open / merged / in conflict) is aggregated in the teacher view through the `pull_request`
  webhooks.
- **GH-53** — All the synchronization writes use the **bot identity** of the App
  (`<app-slug>[bot]`, associated GitHub no-reply e-mail), never the identity of the teacher.

## Webhooks

- **GH-60** — A single endpoint `POST /webhooks/github` receives the events of
  the App. Each delivery is verified by **HMAC signature**
  (`X-Hub-Signature-256`, dedicated secret), deduplicated by `X-GitHub-Delivery`,
  acknowledged in < 5 s (asynchronous processing in a job queue).
- **GH-61** — Subscribed events and uses:

| Event | Use |
| --- | --- |
| `installation`, `installation_repositories` | Life cycle of the installation (GH-05, GH-06) |
| `push` | Metrics (last commit/hash + server reception time, GH-22), protected files detection (GH-31), force push fallback detection (GH-22), detection of the source getting ahead (GH-50) |
| `workflow_run` (`requested`, `in_progress`) | Transition of the CI status to `pending` (GR-04, GR-15) |
| `workflow_run` (`completed`) | pass/fail CI status; triggers the reading of the check-runs for the grade (§3) |
| `pull_request` | Tracking of the synchronization PRs (GH-52) |
| `repository` | Detection of renaming/deletion/archiving outside the platform → teacher alert |

There is no webhook for the expiration of the collaborator invitations: it is
covered by the reconciliation (GH-24, GH-62).

- **GH-62** — **Catch-up**: a periodic job (daily, and on demand)
  reconciles the state through the API (`GET /repos/.../branches`, listing of the `pending`
  invitations for GH-24, listing of the missed deliveries through
  `GET /app/hook/deliveries` with redelivery) so that no webhook loss
  lastingly corrupts the metrics or the protections. The reconciliation of the
  GradeRuns follows GR-07.
- **GH-63** — All the GitHub operations go through a centralized client (Octokit)
  with handling of the `403 rate limit` / `secondary rate limit` responses (backoff +
  resumption of the job), logging of the mutations (repository, operation, SHA before/after)
  for audit.

# Grading and metrics collection (GR)

## `grading.yml` convention

### GR-01 — Grading workflow

An assignment is "graded" if the student repository contains the workflow
`.github/workflows/grading.yml`. This file comes from the source repository and is
**pre-checked in the protected files** when the assignment is created (GH-30,
US-04); the teacher can uncheck it, in which case the deletion or alteration of the
workflow by the student is not reverted (warning displayed). The system
identifies the workflow by its path (`path` of the `workflow_run` webhook), not by its
display name.

### GR-02 — Grade annotation format

The workflow emits the grade through a GitHub Actions workflow command of the
`notice` type, with a reserved title `GRADE`:

```bash
echo "::notice title=GRADE::4.5/6"
```

The message MUST respect the following grammar (regex applied by the backend):
```text
^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*$
```

that is `points_obtained/points_max`, decimals with a dot, `points_max > 0`,
`points_obtained <= points_max`.

**Justification**: the `::notice` command creates an annotation attached to the check run
of the job, readable through the REST API
(`GET /repos/{owner}/{repo}/check-runs/{id}/annotations`) with only the
`checks:read` scope of the GitHub App. No artifact to upload, no token to inject
into the student workflow, a single shell line in `grading.yml`, and
the annotation is visible as such in the GitHub UI (transparency for
the student).

**Assumed limitation — falsifiable grade**: the student's code executes in the same
run (tests) and can itself print a `::notice title=GRADE::...` command on the
standard output, forging a grade. Protecting `grading.yml` does not prevent this
injection. The risk is **accepted** because the grade is strictly indicative (GR-10,
§3.2 of the requirements specification — assumption H5). Mitigations: any multiple `GRADE`
annotation in a run, **even with identical values**, invalidates the grade
(`parse_status = multiple`, teacher alert, GR-17); the teacher keeps access to the
logs of the run for verification. If integrity becomes required, the "signed
artifact" extension (GR-16) replaces this convention.

**Ruled-out alternative**: publication of a JSON artifact (`grade.json`) downloaded
by the backend. More expressive (detailed scale per exercise), but heavier
(artifact upload, zip download, limited retention) and invisible in the GitHub
UI. Retained as a possible future extension (GR-16), not required for the MVP.

### GR-03 — Uniqueness of the annotation

The workflow MUST emit exactly one `GRADE` annotation per run. The starter
kit provided to the teachers (`grading.yml` template) documents this constraint and
provides a single final step that aggregates the points and emits the notice with
`if: always()`, so that the grade is published even if test steps fail. The
template also includes the anti-bot condition of GH-44.

## Capture by the backend

### GR-04 — Webhook triggers

The backend subscribes to the `workflow_run` event of the GitHub App (GH-61):

1. `requested` / `in_progress`: the CI status of the repository moves to `pending` (GR-15) if the
   run is eligible (GR-05, step 1).
2. `completed`: full processing below (GR-05).

Only the events whose repository matches a known `StudentRepo` are processed;
the others are ignored (204).

### GR-05 — Extraction pipeline

Upon reception of a completed `workflow_run`:

1. **Eligibility filter**: resolve the `StudentRepo` from `repository.id`,
   then check that `head_branch` is a **selected branch** of the assignment
   (the `sync/*` refs and any other branch are ignored) and that the head commit
   (`head_sha`) is **not a commit pushed by the bot** (revert, deadline commit,
   synchronization — GH-44). A non-eligible run is ignored: no GradeRun is created.
2. If `workflow.path == .github/workflows/grading.yml`: list the check runs of the
   `head_sha` (`GET /commits/{sha}/check-runs`), filter those of the `check_suite` of the run,
   then read their annotations and look for `title == "GRADE"` of `notice` level.
3. Parse the message according to GR-02 and create a `GradeRun` (GR-08).
4. Process the webhook idempotently: the pair
   (`StudentRepo`, `workflow_run.id`, `run_attempt`) is unique; a replayed event
   does not create a duplicate.

### GR-06 — pass/fail fallback (repositories without `grading.yml`)

If the repository does not contain `grading.yml`, the CI status is **aggregated** over the last
eligible student commit (GR-05, step 1) of the default branch of the repository:

1. `pass` if **all** the completed `workflow_run` bearing on this commit have
   `conclusion = success`;
2. `fail` if **at least one** completed run has another conclusion;
3. `pending` if at least one run is `requested`/`in_progress` and none has failed;
4. `none` if no workflow exists.

A `GradeRun` is created without a grade (`grade_points = null`, `parse_status = fallback`)
per eligible completed run. This aggregation rule is the single reference for
`ci_status` (US-05, US-14, AU-35).

### GR-07 — Catch-up

A reconciliation job runs **every 15 minutes** (configurable period,
default 15 min) and re-queries the runs of the active `StudentRepo` whose last
webhook received is older than **N = 30 minutes** (configurable), to compensate for the
lost webhooks. The GR-05 pipeline is reused identically.

## Storage — the `GradeRun` model

### GR-08 — Schema

Each eligible captured CI run produces an immutable record:

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Internal identifier |
| `student_repo_id` | fk | Student repository concerned |
| `workflow_run_id` | bigint | GitHub id of the run |
| `run_attempt` | int | Attempt (re-run) |
| `head_branch` | text | Branch of the run (selected, see GR-05) |
| `head_sha` | char(40) | Evaluated commit |
| `conclusion` | enum | `success`, `failure`, `cancelled`, `timed_out`, … |
| `grade_points` | numeric nullable | Points obtained |
| `grade_max` | numeric nullable | Maximum points |
| `parse_status` | enum | `ok`, `no_annotation`, `malformed`, `multiple`, `fallback` |
| `after_deadline` | bool | `true` if the `head_sha` was **received** (push webhook, server time, GH-22) after the deadline, or if its reception time is unknown while the deadline has passed (GR-14) |
| `completed_at` | timestamptz | End of the run (GitHub time) |
| `created_at` | timestamptz | Insertion |

### GR-09 — Current grade

The denormalized field `StudentRepo.current_grade` references the retained `GradeRun`: the
most recent one (by `completed_at`) whose `after_deadline = false` and
`parse_status IN (ok, fallback)`. Since the non-eligible runs (non-selected branch,
bot commit) do not exist in the database (GR-05), they can never become the current
grade. The full history remains consultable.

## Display

### GR-10 — Student view

After each CI run, the student sees on their assignment: the indicative grade
(`x/y` or pass/fail), the evaluated commit (short hash, GitHub link), the timestamp of the run
and the explicit mention "indicative grade, not contractual". The update is
pushed in real time (SSE/WebSocket, see architecture).

### GR-11 — Teacher view

The teacher sees, per assignment, a table of the students with current grade, CI
status, last commit, and can open the `GradeRun` history of a student. These
data are also exposed by the key-based API (§4).

## Freeze at the deadline

### GR-12 — Grade freeze

At the deadline (deadline job GH-43, Europe/Zurich timezone), the current grade is
frozen: `StudentRepo.frozen_grade_run_id` points to the `GradeRun` retained according to GR-09 at
the moment of the freeze. The runs marked `after_deadline = true` never modify the
frozen grade.

### GR-13 — Post-deadline visibility

After the deadline, the frozen grade and the status remain visible on the student and
teacher sides. The post-deadline runs (manual re-runs, repository not locked in the
deadline commit strategy) are displayed in the history with an "after deadline" badge,
on the teacher side only.

### GR-14 — Freeze criterion: server reception time

The freeze criterion is the **moment when the platform received the evaluated commit**, never
the git timestamp (set by the client, trivially falsifiable through
`GIT_COMMITTER_DATE`):

1. At each `push` webhook on a selected branch, the backend persists the head
   SHA and the **server reception time** (GH-22).
2. A run counts for the frozen grade (`after_deadline = false`) if and only if its
   `head_sha` was received by webhook **before the deadline** and bears on a selected
   branch (GR-05).
3. A `head_sha` without a known reception time (lost webhook, reconciled after
   the fact) is treated as `after_deadline = true` as soon as the deadline has passed —
   a conservative choice, arbitrable by the teacher in view of the history.
4. A run bearing on a commit received before the deadline but **finished after** counts
   for the frozen grade: the effective freeze waits for the end of the runs in progress on
   eligible commits, within the limit of a **configurable grace period (default
   30 min)** after the deadline. Past that period, `frozen_grade_run_id` is fixed
   definitively.

This criterion is the single reference of the freeze (US-14, US-22, GH-42, GH-43).

## Repository metrics

### GR-15 — Collection

The backend maintains per `StudentRepo`, fed by the `push` and
`workflow_run` webhooks (never by polling in nominal operation, see GR-07 for the catch-up):

- `last_commit_at` and `last_commit_sha` (last push on the selected branches,
  bot commits and `sync/*` refs excluded), with the server reception time per SHA
  (GH-22);
- `ci_status`: `none` / `pending` / `pass` / `fail` — `pending` is set by the
  `workflow_run` `requested`/`in_progress` events (GR-04), the other values by
  GR-05/GR-06. This enumeration is the single source of the exposed values (AU-35);
- `current_grade` (GR-09) and timestamp of the last run.

These metrics feed the teacher table and the key-based API.

## Extensions and edge cases

### GR-16 — Future extension: signed grade artifact

Out of the v1 scope. If the integrity of the grade becomes required (beyond the
indicative), `grading.yml` publishes a `grade.json` artifact (detailed scale per
exercise) that the backend downloads and verifies; this variant then replaces the
GR-02 annotation. Referenced by GR-02 as an alternative ruled out for the MVP.

### GR-17 — Table of the edge cases

| Case | Behavior |
| --- | --- |
| Failed run (`conclusion=failure`) with a `GRADE` annotation present | The grade is captured normally (the notice step runs with `if: always()`); `conclusion` reflects the failure |
| Failed run without an annotation | `GradeRun` with `parse_status=no_annotation`, `grade_points=null`; the current grade is not modified; CI status = `fail` |
| Annotation absent on a successful run | `parse_status=no_annotation`; alert visible on the teacher side (probably a defective `grading.yml`) |
| Malformed annotation (GR-02 regex not satisfied, `points > max`, `max = 0`) | `parse_status=malformed`, `grade_points=null`, error message kept for teacher diagnosis |
| Several `GRADE` annotations in the same run, **even with identical values** | `parse_status=multiple`, `grade_points=null`, teacher alert (anti-forgery mitigation, GR-02) |
| Run cancelled or `timed_out` | `GradeRun` recorded with the conclusion; no grade extraction |
| Run on a `sync/*` ref, a non-selected branch or a bot commit (revert, deadline commit) | **Ignored**: no `GradeRun` created (GR-05, GH-44, GH-51) |
| Re-run after the deadline (`run_attempt > 1` or new run on a commit received after the due time) | Recorded with `after_deadline=true`; frozen grade unchanged (GR-12); visible to the teacher only (GR-13) |
| Post-deadline push with a backdated commit (`GIT_COMMITTER_DATE`) | Without effect: the freeze is based on the server reception time of the webhook, not on the git timestamp (GR-14) |
| Duplicated or replayed webhook | Idempotence by (`repo`, `run_id`, `run_attempt`) (GR-05) |
| `grading.yml` deleted by the student | If it is protected (default, GH-30/GR-01): automatic revert; the intermediate runs without grading fall back to GR-06. If it was deliberately unprotected by the teacher: assumed switch to the fallback |
| `GRADE` annotation forged by the student code | Risk documented and accepted (indicative grade); a supernumerary annotation invalidates the grade (GR-02, assumption H5) |
| Repository in the "protected files in conflict" state | GradeRuns recorded, grade marked "to be verified" on the teacher side (GH-35) |

# Key-based API and CLI

Goal: allow the CLI (§4.4) to list then clone the student repositories of an
assignment.

## Life cycle of the keys

- **AU-29** — A teacher MUST be able to create several API keys, each with: a free-form
  label, scopes, a list of authorized classrooms (or `*` = all their classrooms), an optional
  expiration date (SHOULD default: 12 months).
- **AU-30** — Key format: `hgc_` + 40 random characters (≥ 200 bits, CSPRNG).
  The full key is displayed only once at creation time. In the database:
  `{ id, teacher_id, label, key_prefix (first 12 characters, for identification),
  key_hash = SHA-256(key), scopes, classroom_ids, expires_at, created_at,
  last_used_at, revoked_at }`. The key in clear text is never stored.
- **AU-31** — v1 scopes: `classrooms:read` (classrooms, rosters, assignments) and
  `repos:read` (list of the student repositories and clone metadata). No write
  scope in v1.
- **AU-32** — Immediate revocation by the teacher (soft delete `revoked_at`); a revoked
  or expired key MUST be refused with `401`. The teacher's key list
  displays prefix, label, scopes, `last_used_at`, expiration — never the key.
- **AU-33** — A key never grants more than the current rights of its teacher:
  if the teacher loses a classroom, the key loses it as well.

## Endpoints

- **AU-34** — Authentication: `Authorization: Bearer hgc_...` header. Error
  responses: `401` (key absent/invalid/revoked/expired), `403` (scope or classroom
  out of perimeter), `404` (non-existent resource or out of perimeter — indistinguishable).
  v1 endpoints:

| Method | Path | Scope | Role |
| --- | --- | --- | --- |
| `GET` | `/api/v1/classrooms` | `classrooms:read` | List the accessible classrooms |
| `GET` | `/api/v1/classrooms/{id}/assignments` | `classrooms:read` | List the assignments of a classroom |
| `GET` | `/api/v1/assignments/{id}/repos` | `repos:read` | List the student repositories (CLI target) |

- **AU-35** — Response format: JSON, envelope
  `{ "data": [...], "pagination": { "page", "per_page", "total" } }`, pagination by
  `?page=&per_page=` (default 50, max 200). The values of `ci_status` are those of
  the GR-15 enumeration (`none` / `pending` / `pass` / `fail`); the grade is exposed as a
  `grade_points` / `grade_max` pair (GR-08), without normalization. Response of
  `GET /api/v1/assignments/{id}/repos`:

```json
{
  "data": [
    {
      "student": {
        "nom": "Dupont",
        "prenom": "Marie",
        "email": "marie.dupont@heig-vd.ch",
        "github_login": "mdupont"
      },
      "repo": {
        "full_name": "heig-vd-tic/tp1-mdupont",
        "clone_url_https": "https://github.com/heig-vd-tic/tp1-mdupont.git",
        "clone_url_ssh": "git@github.com:heig-vd-tic/tp1-mdupont.git",
        "default_branch": "main",
        "locked": false
      },
      "status": {
        "accepted_at": "2026-07-01T08:12:00Z",
        "last_commit_hash": "a1b2c3d",
        "last_commit_at": "2026-07-02T21:47:00Z",
        "ci_status": "pass",
        "grade_points": 5.2,
        "grade_max": 6
      }
    }
  ],
  "pagination": { "page": 1, "per_page": 50, "total": 34 }
}
```

- **AU-36** — Explicit nullable fields: `github_login`, `accepted_at`,
  `last_commit_*`, `ci_status`, `grade_points`, `grade_max` are `null` as long as
  the corresponding event has not taken place (a student who has not accepted = entry
  present with `repo: null`), so that the CLI also sees the students without a repository.
- **AU-37** — The key-based API does NOT provide git credentials: the clone is performed with
  the teacher's own GitHub rights (member of the organization). The API only serves
  the discovery of the URLs and metadata.

## Security considerations

- **AU-38** — Transport: HTTPS mandatory everywhere (redirection + HSTS). Comparison
  of the key hashes in constant time.
- **AU-39** — Rate limiting: the key-based API SHOULD be limited to 120 req/min per key
  (`429` response + `Retry-After`); auth endpoints (OIDC/OAuth callbacks, claim)
  limited by IP.
- **AU-40** — Rotation: the creation of a new key while an old one is
  active MUST be possible (rotation without interruption: create → switch the CLI over →
  revoke). The system SHOULD notify the teacher before the expiration of a key
  (NT-03).
- **AU-41** — No secret in the logs: API keys (beyond the prefix),
  OIDC/OAuth tokens, session cookies and `client_secret` MUST be masked in the application
  logs, access logs and error messages. The callback URLs containing
  `code` are not logged in clear text.
- **AU-42** — Audit: events logged with actor and timestamp —
  key creation/revocation, GitHub linking/unlinking, claim and manual roster
  attachment, unenrollment, role change.
- **AU-43** — Server secrets (OIDC/GitHub client secrets, GitHub App private key)
  MUST come from the environment or from a secret manager, never from the repository or
  from the database.

## CLI (v1 deliverable, assumption H7)

- **CLI-01** — A `hgc` CLI is delivered (binary or npm package). Configuration:
  environment variables `HGC_API_KEY` and `HGC_BASE_URL`, or the file
  `~/.config/hgc/config.toml` (the environment variable prevails). The key is
  never passed as a command-line argument (visible in the history and in
  `ps`).
- **CLI-02** — v1 commands:

  1. `hgc classrooms` — lists the accessible classrooms.
  2. `hgc assignments <classroom-id>` — lists the assignments of a classroom.
  3. `hgc repos <assignment-id>` — lists the student repositories (table; `--json`
     for the raw AU-35 output).
  4. `hgc clone <assignment-id> [--dir <path>] [--ssh | --https]` — bulk-clones
     the repositories of the assignment into one directory per student; idempotent: if the
     repository is already cloned, a `git fetch` is performed instead.
- **CLI-03** — The clone uses the teacher's **own** git credentials (AU-37):
  the CLI injects no token into the URLs. Bounded parallelism (default: 4 simultaneous
  clones, `--parallel` option) to respect the GitHub quotas.
- **CLI-04** — Exit codes: `0` complete success, `1` partial failure (at least one
  repository in error, listed on stderr), `2` authentication or usage error. The
  students without a repository (`repo: null`, AU-36) are listed at the end of the run without
  constituting a failure.

# Notifications (NT)

Cross-cutting frame for all the "notified" mentions of the requirements (NFR-17 of the requirements
specification).

- **NT-01** — **Mandatory in-app** channel: notification center in the portal
  (badge + timestamped list, read/unread marking). Any "X is notified" requirement is
  satisfied by an in-app notification.
- **NT-02** — **Optional e-mail** channel: opt-in per user, asynchronous sending
  with retry on failure, minimal content (link to the portal, no sensitive
  data). No functional behavior depends on the delivery of an e-mail.
- **NT-03** — v1 notified events:

| Event | Recipient | Reference |
| --- | --- | --- |
| Provisioning failure | Teacher + student | US-13, GH-20 |
| Expired invitation / re-invitation | Student | GH-24 |
| Revert of protected files | Student (teacher: counter in the repository view) | GH-34 |
| Repository in "protected files in conflict" | Teacher + student | GH-33, GH-35 |
| Force push detected (fallback) | Teacher + student | GH-22 |
| Degraded GitHub App installation | Teacher | GH-06 |
| Synchronization finished (summary) | Teacher | US-06 |
| Synchronization PR opened / updated | Student | GH-51 |
| GitHub re-linking of a student | Teachers of the classrooms concerned | AU-12 |
| Roster claim conflict | Teacher | AU-21 |
| Upcoming expiration of an API key | Teacher | AU-40 |
| Deadline applied (summary per assignment) | Teacher | GH-43 |
