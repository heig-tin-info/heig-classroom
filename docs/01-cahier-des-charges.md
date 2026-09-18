---
title: Requirements specification
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
> Source: initial product note (absorbed into `00-analyse-besoins.md`), `00-analyse-besoins.md`.
> Detailed specifications: `02-specs-fonctionnelles.md`.
> Status: consolidated (final phase 2 edition). The decisions taken to resolve the
> ambiguities are listed in [Assumptions to be validated](#sec:assumptions).

# Purpose of the document

This document defines the need: context, objectives, scope, actors, user stories
with acceptance criteria (US-xx), non-functional requirements (NFR-xx) and
constraints (C-xx). The detailed implementation rules (AU-xx, GH-xx, GR-xx,
API/CLI) are in the functional specifications (`02-specs-fonctionnelles.md`).

# Context and objectives

## Context

GitHub Classroom covers some HEIG-VD needs poorly: institutional
authentication (Switch edu-ID), configurable deadline strategies, protection of
assignment statement files, grade extraction from the CI and synchronization of statements after
publication. The "HEIG GitHub Classroom" project is a web portal that reproduces and
adapts these functions, relying exclusively on GitHub (organizations, repositories,
Actions) as the execution infrastructure.

## Objectives

- **O1** — Allow the teacher to manage classrooms and assignments from a single
  portal, backed by a GitHub organization.
- **O2** — Automatically provision one private repository per student when an
  assignment is accepted, with the appropriate permissions and protections.
- **O3** — Automatically apply the pedagogical policies: protected files
  (automatic revert), deadline strategy (lock or deadline commit).
- **O4** — Continuously report the state of the student repositories (last commit, CI status,
  indicative grade coming from `grading.yml`).
- **O5** — Offer a key-based API and a minimal CLI allowing automation on the
  teacher side (bulk clone of the repositories).

## Success criteria

- An assignment for a class of 100 students is published, accepted and provisioned
  without manual intervention from the teacher (subject to the GitHub checks of
  constraint C-07).
- The indicative grade appears in the portal in less than 2 minutes after the end of a
  CI run.
- At the deadline (Europe/Zurich time), the locking job starts at most 60 s
  after the due time and the full application over 100 repositories completes in less than
  5 minutes (single global budget, taken up by US-22 and NFR-13).

# Scope

## Included

- Two-role web portal (teacher, student) with Switch edu-ID authentication (OIDC)
  and GitHub account linking (separate OAuth).
- Classroom management: creation, association with a GitHub organization
  (GitHub App installation), roster import, automatic claiming of the rows by the
  students at login.
- Assignment management: full life cycle (draft, publication, acceptance,
  deadline), source strategy (whole or squashed repository), selected branches,
  protected files, deadline strategy, controlled modification after publication.
- Provisioning of private student repositories in the organization, with force push
  forbidden.
- Detection and automatic revert of modifications to protected files (bot
  identity), with an anti-loop ceiling.
- Metrics collection through GitHub webhooks (push, `workflow_run`); extraction of the
  grade via a check-run annotation; pass/fail fallback.
- Deadline jobs: repository lock or deadline commit, freezing of the retained grade.
- Statement synchronization: teacher push on the source repository → update of the
  squashed repository → bot PR towards each student repository.
- Key-based REST API for the teacher (read access to classrooms, assignments, repositories, grades)
  and minimal bulk-clone CLI.
- In-app notifications (e-mail optional).

## Excluded

- Group assignments (repository shared by several students) — postponed to a
  later version.
- Individual per-student deadline extensions — excluded from v1. The
  retained lock mechanism (ruleset, reversible per repository) is chosen to make this
  evolution possible without a redesign, but no flow is specified or delivered in v1.
- Official grading and export to the academic information system (GAPS or equivalent): the
  collected grade is **indicative** and not contractual.
- Hosting or execution of the CI: the runs execute on GitHub Actions, never on
  the platform.
- Anti-plagiarism, similarity detection between repositories.
- Mobile application; the portal is a responsive web application.

# Actors and roles

| Actor | Description | Authentication |
| --- | --- | --- |
| **Teacher** | HEIG-VD teacher. Creates and administers classrooms, assignments, roster; consults the state and the grades; manages their API keys. | Switch edu-ID + linked GitHub account (admin of the target organization) |
| **Student** | Student enrolled in the roster of a classroom. Automatically attached to their roster row, accepts assignments, works in their repository. | Switch edu-ID + linked GitHub account |
| **System (bot)** | Machine identity of the platform (GitHub App + bot commit identity). Provisions the repositories, pushes the reverts and deadline commits, opens the synchronization PRs. | GitHub App installation tokens |
| **API client** | Provided CLI or teacher script consuming the REST API. | API key (scoped, revocable) |

Three application roles (revision H2 of 2026-07-07): `admin`, `teacher` and
`student`. The super administrator (unique, e-mail in the server configuration) grants
and revokes the teacher role from the administration screen; the admin inherits the
teacher capabilities. A teacher can be a student of another classroom.

# User stories

Convention: acceptance criteria in the Given / When / Then format. The roster
statuses use the technical values `pending` / `claimed`, displayed in
French as "non réclamée" / "réclamée".

## Teacher

### US-01 — Create a classroom

As a teacher, I create a classroom linked to a GitHub organization in order to
group my assignments in it.

- **Given** a teacher logged in with a linked GitHub account, **when** they create a
  classroom (name + organization), **then** the system requests the installation of the
  GitHub App on the organization if it is not already installed there.
- **Given** an organization without a valid installation, **when** the installation
  fails or is refused, **then** the classroom is not activated and the teacher sees
  the cause of the error.
- **Given** a valid installation, **when** the classroom is created, **then**
  it appears in the teacher's list with 0 assignments and 0 students.

### US-02 — Import the roster

As a teacher, I import the list of students (last name, first name, e-mail) in order to
control who can join the classroom.

- **Given** an existing classroom, **when** the teacher imports a CSV file
  (last name, first name, e-mail), **then** the import is **atomic** (all or nothing): if it is
  valid, each row becomes a roster entry with status `pending`; otherwise no
  change is applied and an error report indicates the faulty rows.
- **Given** a file containing **intra-file** duplicate e-mails,
  **when** the import is submitted, **then** it is rejected with the numbers of the duplicate
  rows (AU-14).
- **Given** a file containing e-mails **already present** in the roster,
  **when** the import is validated, **then** the existing entries (including
  `claimed` ones) are kept and their last name/first name updated (upsert, AU-16); the
  entries absent from the file are not deleted.
- **Given** an imported roster, **when** the teacher consults the classroom,
  **then** they see each row with its status (`pending` / `claimed`) and, if
  claimed, the associated GitHub login (empty as long as the student has not linked GitHub).

### US-03 — Consult the dashboard of a classroom

As a teacher, I consult the state of my classroom in order to follow the activity of the
students.

- **Given** a classroom with assignments and students, **when** the teacher
  opens its view, **then** they see the number of assignments, their start and
  due dates, and the student table (last name, first name, e-mail, GitHub account,
  last login to the portal).
- **Given** an unclaimed roster row, **when** the table is displayed,
  **then** the GitHub account and last login columns are empty and the status
  `pending` is visible.

### US-04 — Create an assignment

As a teacher, I create an assignment from a source repository in order to
distribute it to the students.

- **Given** an active classroom, **when** the teacher creates an assignment,
  **then** they fill in: name, start date, deadline, source repository (mandatorily
  within the organization), source strategy (`whole repository` | `squash`), branches
  to distribute (default: `main` or `master` depending on which exists), protected files,
  deadline strategy (`lock` | `deadline commit`). The assignment is created in the
  `draft` state (US-08).
- **Given** a source repository containing `criteria.yml`, `README.md` or
  `.github/workflows/grading.yml`, **when** the form opens, **then** these
  files are pre-checked as protected (modifiable by the teacher). Unchecking
  `grading.yml` displays a warning: without protection, the student can alter or
  delete the grading workflow.
- **Given** a source repository outside the organization, **when** the teacher validates,
  **then** the creation is refused with an explicit message.
- **Given** a validated assignment, **when** the creation succeeds, **then** the
  system creates the private **squashed source** repository in the organization and displays its
  link in the teacher UI.

### US-05 — Track the state of the repositories of an assignment

As a teacher, I consult the state of each student repository in order to follow the
progress and the grades.

- **Given** an assignment accepted by students, **when** the teacher opens
  the assignment view, **then** they see per student: repository link, date and hash
  of the last commit, CI status (`none` / `pending` / `pass` / `fail`, aggregation
  rule GR-06), indicative grade if `grading.yml` is present.
- **Given** a repository without any student push, **when** the view is displayed,
  **then** the student appears with the state `accepted, no work`; if they have not
  accepted, `not accepted`.

### US-06 — Synchronize the statement after publication

As a teacher, I propagate a correction of the statement to the student repositories
in order to fix an already distributed assignment.

- **Given** a teacher push on the source repository, **when** the teacher
  triggers the synchronization from the UI, **then** the system updates the squashed
  repository then opens a PR (bot identity) towards each existing student repository.
- **Given** a synchronization PR conflicting with a student's work,
  **when** the PR is created, **then** it stays open with the conflict to be resolved
  by the student; the system never forces the merge.
- **Given** a launched synchronization, **when** it finishes, **then** the
  teacher sees a summary (PRs created, already up to date, failures).

### US-07 — Manage their API keys

As a teacher, I generate and revoke API keys in order to automate the
retrieval of the repositories through the CLI.

- **Given** a logged-in teacher, **when** they generate a key, **then** the
  secret is displayed only once and only a hash is stored.
- **Given** a revoked key, **when** an API call uses it, **then** the
  request is rejected with `401`.
- **Given** a valid key, **when** the CLI calls the API, **then** it can
  list classrooms, assignments, student repositories (clone URL), statuses and grades —
  read-only and limited to the classrooms of the owning teacher.

### US-08 — Publish and modify an assignment

As a teacher, I publish my assignment then correct it if necessary in order to
control what the students see.

Life cycle: `draft` → `published` → `locked`.

- **Given** an assignment in the `draft` state, **when** the teacher
  consults it, **then** it is invisible to the students and all its fields are
  freely modifiable.
- **Given** a draft assignment, **when** the teacher publishes it,
  **then** the assignment becomes visible to the students of the classroom (acceptable from
  the start date) and the deadline job is scheduled.
- **Given** a `published` assignment, **when** the teacher modifies it, **then**
  only the following are modifiable: the name, the deadline (as long as it has not passed; the
  new value cannot be in the past), the deadline strategy (as long as the
  due time has not passed) and the list of protected files. The source repository, the
  source strategy and the branches are no longer modifiable from the first
  acceptance onwards.
- **Given** a modified deadline, **when** the modification is saved,
  **then** the deadline job is rescheduled (GH-43) and the students see the
  new due time.
- **Given** a modified list of protected files, **when** it is
  saved, **then** the new list applies to the following pushes (the reference
  version stays the one of the last bot commit, GH-30); no retroactive revert
  is triggered.
- **Given** a published assignment with student repositories, **when** the teacher
  deletes it, **then** an explicit confirmation is required, the student repositories
  are **archived** on GitHub (never deleted, GH-25) and the assignment disappears from the
  student views. Once the deadline has passed, the assignment moves to `locked`
  automatically.

## Student

### US-10 — Log in and link their GitHub account

As a student, I log in with Switch edu-ID and I link my GitHub account
in order to access my working repositories.

- **Given** an unauthenticated user, **when** they access the portal,
  **then** they are redirected to the Switch edu-ID login (OIDC).
- **Given** a successful login without a linked GitHub account, **when** the session
  opens, **then** the student can navigate and consult their assignments; an
  onboarding banner invites them to link their GitHub account (OAuth flow), and
  the **acceptance of an assignment is blocked** as long as the linking is not done
  (AU-11).
- **Given** a GitHub account already linked to another user of the platform,
  **when** the linking is attempted, **then** it is refused with an
  explicit message.

### US-11 — Be attached to the roster (automatic claim)

As a student, I am attached automatically to my classrooms at login
in order to have no manual step to take.

- **Given** a student who logs in with a **verified** edu-ID e-mail
  matching one or more `pending` roster entries, **when** the session
  opens, **then** these entries move to `claimed`, attached to their platform
  account, and a summary screen presents them the classrooms they joined
  (AU-18). The GitHub login only appears in the roster after the GitHub linking
  (US-10); it is not required for the claim.
- **Given** an e-mail without a match in the roster, **when** the student
  logs in, **then** they see a message inviting them to contact their teacher,
  without access to any classroom. The teacher can correct the e-mail of the entry (the
  claim replays at the next login or via "retry") or attach the entry
  manually (AU-20).
- **Given** an entry already `claimed` by another account whose e-mail
  matches, **when** the login takes place, **then** no attachment is
  performed, the anomaly is logged and reported to the teacher ("conflict" badge,
  AU-21); the resolution is manual, by the teacher only.

### US-12 — See their assignments

As a student, I consult my assignments in order to know my due dates and
to access my repositories.

- **Given** a student attached to one or more classrooms, **when** they
  open the portal, **then** they see their published assignments with name, start date,
  deadline (Europe/Zurich), status (`to accept`, `in progress`, `locked`) and the link
  to their repository if it exists.
- **Given** an assignment whose start date is in the future, **when** the list
  is displayed, **then** the assignment is visible but not acceptable.

### US-13 — Accept an assignment

As a student, I accept an assignment in order to obtain my personal working
repository.

- **Given** an open assignment (published, start reached, deadline not passed) and
  a linked GitHub account, **when** the student accepts, **then** the system provisions
  their private repository (US-20): the creation of the repository and the **sending of the**
  collaborator **invitation** happen in less than 60 seconds, and the link appears in their view
  with the state of the invitation (to be accepted on the GitHub side).
- **Given** a GitHub invitation that has not been accepted or that has expired, **when** the student
  consults the assignment, **then** they see the invitation link and a
  "resend the invitation" button (GH-24).
- **Given** a failed provisioning, **when** the error occurs, **then**
  the student sees a re-runnable error status and the teacher is notified.
- **Given** an assignment whose deadline has passed, **when** the student
  tries to accept, **then** the acceptance is refused.

### US-14 — Track their CI status and their indicative grade

As a student, I see the CI result and my indicative grade in order to know
my progress.

- **Given** a push on a distributed branch of their repository triggering
  `grading.yml`, **when** the run finishes, **then** the portal displays the status
  of the run and the grade extracted from the annotation (convention GR-02), with the mention
  "indicative grade, not contractual".
- **Given** a repository without `grading.yml`, **when** a CI workflow finishes,
  **then** the portal displays only the aggregated pass/fail status (GR-06).
- **Given** a passed deadline, **when** the student consults the assignment,
  **then** the displayed grade is the **frozen grade**: last eligible run bearing on
  a commit **received by the platform before the deadline** (webhook server time,
  GR-14); the freeze becomes definitive after a grace period (30 min by default)
  letting the runs in progress finish. Later runs never modify the
  frozen grade.

## System

### US-20 — Provision a student repository

As the system, I create the working repository upon acceptance in order to give the
student a ready environment.

- **Given** an acceptance (US-13), **when** the provisioning executes,
  **then** the system creates a private repository in the organization from the repository
  corresponding to the source strategy (whole or squashed), with the branches
  configured.
- **Given** the created repository, **when** the permissions are set, **then** the student
  has push rights (not admin) and force push is forbidden by a ruleset on the
  distributed branches (GH-21, fallback GH-22).
- **Given** a step that fails, **when** the provisioning is re-run,
  **then** the operation is idempotent (no duplicate repository or invitation).
- **Given** an expired collaborator invitation (7 GitHub days), **when** the
  catch-up job detects it, **then** a re-invitation is sent
  automatically (at most one per 24 h) and the student is notified (GH-24).

### US-21 — Revert the protected files

As the system, I restore the protected files modified by the student in order to
guarantee the integrity of the statement and of the criteria.

- **Given** a student push modifying at least one protected file, **when** the
  push webhook is received, **then** the system pushes a revert commit (bot
  identity) restoring these files to their last legitimate version, without touching the
  other files of the push.
- **Given** the revert commit, **when** it is pushed, **then** its message
  identifies the restored files and the event is logged and visible to the
  teacher.
- **Given** a bot push or a teacher synchronization (US-06) touching a protected file,
  **when** the webhook is received, **then** no revert is triggered (no
  loop).
- **Given** more than 5 reverts in one hour on the same repository, **when** a
  new push touching a protected file arrives, **then** the system suspends the
  reverts, marks the repository "protected files in conflict", notifies teacher and student
  and reports that the current grade is no longer reliable; the teacher re-arms the protection
  from the UI (final revert + reset of the counter, GH-35).

### US-22 — Apply the deadline strategy

As the system, I apply the deadline strategy at the due time in order to freeze
the state of the submissions.

- **Given** a published assignment, **when** the deadline (Europe/Zurich) is
  reached, **then** the deadline job **starts at most 60 s after the due time** and
  the application over the whole set of repositories (up to 100) finishes in less than
  5 minutes (global budget, NFR-13).
- **Given** the `lock` strategy with rulesets available, **when** the job
  executes, **then** each repository becomes read-only for the student on the
  distributed branches; the GitHub App (bot) **and** the organization admins
  (teacher) keep write access through the bypass actors of the ruleset (GH-41).
- **Given** the `archiving` fallback (rulesets unavailable), **when** it is
  applied, **then** the whole repository becomes read-only **for everyone, bot
  included**; this degraded mode is reported to the teacher, and any remaining bot write
  (final revert, corrective commit) is performed before the archiving.
- **Given** the `deadline commit` strategy, **when** the deadline is reached,
  **then** the bot pushes an empty timestamped "deadline" commit on each distributed
  branch of each repository; the repository stays open and the frozen grade is determined
  by GR-12 to GR-14 (the runs triggered by the bot commit are ignored, GH-44).
- **Given** an unavailability of the job at time H, **when** the job resumes,
  **then** it catches up the missed deadlines without double application.

### US-23 — Collect the metrics through webhooks

As the system, I collect the GitHub events in order to keep the
dashboards up to date without polling.

- **Given** a push on a student repository, **when** the webhook is received,
  **then** the date and hash of the last commit are updated in the database, with the **server
  reception time persisted per SHA** (reference for the grade freeze, GR-14).
- **Given** a lost or rejected webhook, **when** the periodic catch-up job
  executes, **then** the state is reconciled through the GitHub API (backup polling
  only).
- **Given** any incoming webhook, **when** it is processed, **then** its
  signature (shared secret) has been verified, otherwise it is rejected.

### US-24 — Extract the grade from the CI

As the system, I extract the grade emitted by `grading.yml` in order to display it to
both roles.

- **Given** a finished `workflow_run` event for the grading workflow on
  a distributed branch, with a head commit not pushed by the bot, **when** the
  system reads the associated check-runs, **then** it extracts the grade from
  the annotation conforming to the **GR-02** convention (specified in the functional
  specs) and saves it with run, hash and timestamp.
- **Given** an absent, malformed or multiple annotation while
  `grading.yml` exists, **when** the extraction fails, **then** the run is marked
  `undetermined grade` (distinct from fail) and the anomaly is logged and visible to the
  teacher.
- **Given** a repository without `grading.yml`, **when** a CI run finishes,
  **then** only the aggregated pass/fail status (GR-06) is recorded.
- **Given** a run bearing on a synchronization ref (`sync/*`) or on a bot
  commit, **when** the event is received, **then** it is ignored (no GradeRun,
  GR-05).

# Non-functional requirements

## Security

- **NFR-01** — Every authentication to the portal goes through Switch edu-ID (OIDC);
  no local password. The GitHub linking uses OAuth with the minimal scope
  necessary.
- **NFR-02** — Operations on GitHub are carried out through short-lived GitHub App
  installation tokens; no personal user token is stored (the
  OAuth linking token is discarded after the identity has been read, AU-09).
- **NFR-03** — The API keys are stored hashed, scoped to the owning teacher,
  immediately revocable; the key-based API is read-only.
- **NFR-04** — All incoming webhooks are authenticated by signature; the
  unsigned or invalid payloads are rejected and counted.
- **NFR-05** — The sensitive actions (roster claim and attachment, revert, lock,
  key generation/revocation, synchronization, role change) are logged in an
  immutable way (timestamped audit trail), subject to the pseudonymization provided
  for by NFR-07.

## Confidentiality

- **NFR-06** — All the repositories (source, squashed, student) are private. A student
  only has access to their own repository; no student can see the repository, the status or
  the grade of another one.
- **NFR-07** — The personal data (name, e-mail, GitHub login) are limited to the
  strict minimum and visible only to the teacher of the classroom and to the student
  concerned. Deletion on request (LPD compliance): the account and the roster
  entries are **anonymized** (personal fields replaced by a pseudonym), the
  GradeRuns and metrics are kept attached to the pseudonym, the audit entries
  are pseudonymized (the immutability of NFR-05 bears on the facts, not on the
  identity). The GitHub repositories are not deleted by the platform: the student's
  collaborator access is removed and the fate of the repository is up to the teacher and
  the organization.

## Availability, reliability and backup

- **NFR-08** — Target availability of the portal: 99 %, measured **monthly during
  the academic semesters** (HEIG-VD calendar), by an external probe on a health
  endpoint (`/healthz`, period 60 s). Planned maintenance announced at least
  48 h in advance is excluded from the measurement. An unavailability of the portal never
  prevents the students from working (the GitHub repositories remain accessible).
- **NFR-09** — The critical jobs (deadline, revert, provisioning) are idempotent
  and replayable; the deadlines missed during an outage are caught up
  automatically when service resumes.
- **NFR-10** — The system respects the rate limits of the GitHub API: collection through
  webhooks, API calls with backoff, polling limited to catch-up.
- **NFR-16** — The data for which the platform is the source of truth (accounts and
  links, roster and claims, API keys, audit trail, GradeRuns and frozen grades,
  assignment configuration — see C-01) are subject to a **daily
  backup** of the database, 30-day retention, with a restore procedure tested
  at least once per semester. Objectives: RPO ≤ 24 h, RTO ≤ 4 h.

## Performance

- **NFR-11** — Reference sizing: 30 to 100 students per classroom,
  up to 20 classrooms active simultaneously. The table views (roster, assignment
  state) are displayed in less than 2 s at 100 rows.
- **NFR-12** — End-to-end latency: grade visible in the portal less than 2 minutes
  after the end of the CI run; protected file revert pushed less than 60 s after
  reception of the webhook; provisioning of a repository (creation + **sending** of
  the collaborator invitation) in less than 60 s — the acceptance of the invitation by
  the student is out of SLA.
- **NFR-13** — Deadline budget (aligned with US-22 and §2.3): job start ≤ 60 s after
  the due time; full application of the strategy over 100 repositories ≤ 5 minutes, without
  exceeding the GitHub quotas.

## Internationalization and accessibility

- **NFR-14** — The interface ships in French; the UI architecture externalizes
  the strings to allow adding English without a redesign. Dates and times
  displayed in Europe/Zurich.
- **NFR-15** — Accessibility on the four main journeys (login, claim,
  assignment acceptance, status consultation): conformance to the following
  WCAG 2.1 AA criteria — 1.1.1 (text alternatives), 1.3.1 (info and relationships),
  1.4.3 (minimum contrast), 2.1.1/2.1.2 (keyboard, no trap), 2.4.6 (headings and
  labels), 2.4.7 (focus visible), 3.3.1 and 3.3.2 (error identification,
  form labels), 4.1.2 (name, role, value). Verification at acceptance:
  tooled audit (axe-core or equivalent) with no violation on these criteria + full
  keyboard journey.

## Notifications

- **NFR-17** — The notifications (NT-01 to NT-03 of the specs) are delivered **in-app**
  mandatorily; e-mail is an optional channel (opt-in per user), sent
  asynchronously with retry on failure, without superfluous personal data in
  the body of the message. No functional requirement relies on the sole
  delivery of an e-mail.

# Constraints

- **C-01 — Shared sources of truth**: GitHub is the source of truth (SoT) for
  the **Git content** (repositories, history, branches), the CI runs and their raw
  results; for these data, the platform database is only a rebuildable
  cache/index and, in case of divergence, GitHub prevails. The platform is on the
  other hand the **only** source of truth for: accounts and links, roster and claims,
  assignment configuration, API keys, audit trail, GradeRuns and frozen grades —
  hence the NFR-16 backup requirement.
- **C-02 — Timezone**: all the deadlines are entered and evaluated in Europe/Zurich
  (correct handling of the daylight saving changes); the internal storage is in UTC with
  conversion at display time.
- **C-03 — GitHub App**: the integration with the organization relies on a GitHub App
  installed by an admin of the organization; without an installation, no classroom
  can be activated.
- **C-04 — CI on GitHub Actions**: the grading executes exclusively on GitHub
  Actions in the student repository; the platform never executes student code.
- **C-05 — Bot identity**: all the automatic commits (revert, deadline, synchronization)
  use a dedicated and identifiable bot identity, distinct from the human accounts.
- **C-06 — Personal GitHub accounts**: the students use their own GitHub
  account; the platform does not create GitHub accounts and does not store any user
  GitHub credential (see NFR-02, AU-09).
- **C-07 — Prior GitHub checks (blocking, before milestone M2)**: the
  following points condition the feasibility of provisioning for 100 students and
  must be verified on the target organization before any development of the
  provisioning:

  1. Plan of the organization (Team/Enterprise via GitHub Education) and availability
     of **rulesets on private repositories** (required by GH-21 and GH-41).
  2. **Billing policy for outside collaborators** on private repositories (one
     seat per collaborator on the Team plan: 100 students = 100 seats).
  3. **Anti-abuse invitation quotas** per organization and per 24 h.

  A plan B is documented if one of these points blocks: organization verified by GitHub
  Education (free seats), spreading the invitations over time, or adding the
  students as members of the organization with base permission `none`.

  **State as of 2026-07-03** (verified on the target organization `heig-tin-info`):

  1. Verified — **GitHub Team** plan with 100 % GitHub Education discount (0 CHF/month). The
     branch rulesets on private repositories are therefore available (GH-21, GH-41 OK).
     The *push rulesets* (path restriction) remain reserved to Enterprise, but
     the retained strategy (revert commit, GH-30+) does not use them.
  2. Handled (2026-07-03) — **15 licenses** for 9 current members: each outside
     collaborator on a private repository consumes a seat. Seat request through the
     GitHub Education program made (≥ student headcount + margin; the 100 %
     discount applies to the additional seats).
  3. To be verified — invitation quotas per 24 h. The S2 spike (2026-07-06, see
     `docs/spikes/S2-rapport.md`) validated the whole provisioning chain
     (30 repositories, 4 s each, zero 403); the invitation quota remains measured
     passively in M2 through the configurable rate limiter.
  4. Action required — **GitHub Actions minutes**: 3,000 min/month included (Team plan) and the student
     repositories are private — the CI grading of ~100 students may exceed this budget.
     Plan for a **self-hosted runner** for the grading, or check an extension of
     minutes through Education (to be settled in phase 3).

# Glossary

| Term | Definition |
| --- | --- |
| **Classroom** | Grouping of assignments and of a roster, backed by a GitHub organization, owned by a teacher. |
| **Assignment** | Work distributed to the students: source repository, dates, strategies, protected files. States: draft, published, locked. |
| **Roster** | List of the students of a classroom imported by the teacher (last name, first name, e-mail). |
| **Roster entry (Enrollment)** | Row of the roster; statuses `pending` ("unclaimed") / `claimed` ("claimed"). |
| **Claim** | Automatic attachment of a roster entry to the platform account of a student, on a verified e-mail match. |
| **Source repository** | Private repository of the organization where the teacher writes the statement. |
| **Squashed repository** | Private repository generated by the platform when the assignment is created, the base of the student repositories and of the synchronization PRs. |
| **Primary commit** | Commit of the squashed repository representing the complete published state of the source at a given moment (`squash` strategy). |
| **Student repository** | Personal private repository provisioned upon acceptance of an assignment. |
| **Protected files** | Files of the statement automatically restored (revert commit) if they are modified by the student. |
| **Lock** | Deadline strategy making the repository read-only for the student (ruleset; archiving fallback). |
| **Deadline commit** | Deadline strategy: empty timestamped commit pushed by the bot, repository left open. |
| **GradeRun** | Immutable record of a captured CI run (run, commit, conclusion, possible grade). |
| **Indicative grade** | Grade extracted from the CI, not contractual, never exported to the academic information system. |
| **Frozen grade** | Grade retained at the deadline according to GR-12 to GR-14 (commit received before the due time, server time). |
| **GitHub App / bot** | Machine identity of the platform; the installation tokens serve all the GitHub operations. |
| **Ruleset** | GitHub rules per repository/branches (force push blocking, lock) with bypass actors. |
| **Squash (source strategy)** | Distribution of the state of the source in the form of primary commits, without the teacher's history. |
| **Whole repository (source strategy)** | Distribution of the full mirror of the selected branches (history included). |

# Assumptions to be validated {#sec:assumptions}

Decisions taken to resolve the ambiguities noted; each one is to be confirmed (or
disproved) by the project owner.

> **Status**: assumptions H1 to H12 validated as they stand by the project owner
> on 2026-07-03. They are now part of the contractual scope of v1.
> **Revision of 2026-07-07 — H2**: an application **admin** role is introduced.
> The super administrator (unique, e-mail in the server configuration) manages the
> teachers **in the database** from an administration screen: grant by e-mail
> (identity completed at the first login), revocation with immediate effect, counters
> of classrooms/assignments. The role is still recomputed at each login.

- **H1 — Individual deadline extensions excluded from v1.** The lock ruleset is
  retained notably because it makes this evolution possible later, but no
  unlocking/re-deadline flow is specified or delivered in v1.
- **H2 — No application admin role in v1.** The teacher role is granted through a
  list of e-mails/edu-ID `sub` in the server configuration, managed by the operator.
- **H3 — Automatic roster claim** at login, on a verified e-mail, without
  explicit confirmation from the student (informative summary screen). The GitHub
  linking is not required for the claim, only to accept an assignment.
- **H4 — Atomic CSV import**: total rejection in case of an intra-file duplicate; the
  e-mails already in the database are updated (upsert), never ignored or deleted.
- **H5 — Falsifiable grade accepted.** The student code executing in the run can
  emit a `GRADE` annotation itself: the risk is documented (GR-02) and judged
  acceptable because the grade is indicative. Mitigation: any multiple `GRADE`
  annotation (even with identical values) invalidates the grade of the run. The
  "signed artifact" alternative (GR-16) is reserved for a later version.
- **H6 — Grade freeze on the server time**: the reference for the freeze is the
  reception time of the push webhook by the platform (persisted per SHA), never
  the git timestamp (falsifiable). Default grace period: 30 minutes.
- **H7 — Minimal CLI delivered** (`hgc`: `classrooms`, `assignments`, `repos`, `clone`),
  in addition to the API — see milestone M7 of the phase 1 plan.
- **H8 — Archiving fallback assumed**: if the rulesets are unavailable, the lock is
  done by archiving, which removes write access from everyone (bot included); degraded
  mode reported, with no revert or post-deadline synchronization possible.
- **H9 — Aggregated CI status** (repositories without `grading.yml`): aggregation of all the
  workflows finished on the last student commit of the distributed branches — `fail`
  if there is at least one failure (GR-06).
- **H10 — Anti-loop revert ceiling**: 5 reverts/hour/repository, then suspension and
  manual resolution by the teacher (GH-33, GH-35).
- **H11 — LPD deletion by anonymization** (no physical erasure of the
  GradeRuns or of the audit, which are pseudonymized); the GitHub repositories are never deleted
  by the platform.
- **H12 — `grading.yml` protected by default**: pre-checked in the protected files
  if it exists in the source; the teacher can uncheck it (warning displayed).
