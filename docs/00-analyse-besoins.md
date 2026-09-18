# Phase 1 — Needs re-analysis

> Source: initial product note (absorbed into this document) — HEIG GitHub Classroom, two-role web portal (student / teacher).
> Status: analysis draft. Items marked ❓ are decisions to be taken or verified before phase 2.

## 1. Vision

A GitHub Classroom clone adapted to HEIG-VD needs: the teacher manages classrooms
backed by a GitHub organization, publishes assignments from a source repository,
the system provisions one private repository per student, collects metrics and grades via CI,
and applies an automatic deadline strategy.

## 2. Actors and use cases

### Teacher

- Create a classroom (name + GitHub organization + student list).
- See per classroom: number of assignments, start/due dates, student table
  (last name, first name, e-mail, GitHub account, last login).
- Create an assignment (name, start, deadline, source repository, source strategy,
  branches, protected files, deadline strategy).
- Track the state of student repositories (last commit, hash, CI status, indicative grade).
- Push changes to the source repository and **synchronize** the student repositories via PR.
- Use a **key-based API** for automation (bulk clone via CLI).

### Student

- Log in (Switch edu-ID, then GitHub linking).
- See their assignments and the link to their working repository.
- Accept an assignment → provisioning of their repository.
- See the CI status and the indicative grade after each run.

### System (backend)

- Authentication and linking of the GitHub account ↔ HEIG identity.
- Provisioning of repositories (creation, permissions, protections).
- Metrics collection (GitHub webhooks preferred over polling).
- Deadline background task (lock or deadline commit, freezing of statuses).
- Extraction of the grade from the `grading.yml` CI.

## 3. Domain model (sketch)

```text
User (role: teacher|student, github_login, email, last_login)
Organization (github_org, installation_id GitHub App)
Classroom (name, → Organization, → teacher)
Enrollment (Classroom ↔ student User, GitHub linking status)
Assignment (name, start_at, deadline_at, source_repo, squashed_repo,
            source_strategy, branches[], protected_files[], deadline_strategy)
StudentRepo (Assignment ↔ User, repo_url, accepted_at, locked_at,
             last_commit_hash, last_commit_at, ci_status, grade)
GradeRun (StudentRepo, CI run_id, status, grade, timestamp)
ApiKey (→ teacher, hash, scopes)
```

Three repositories per assignment:

1. **Source** (private) — where the teacher works.
2. **Squashed source** (private) — created when the assignment is created, the base of the student
   repositories and the base of the synchronization PRs. Link visible in the teacher UI.
3. **Student repositories** (private, one per student).

## 4. Technical sticking points and risks

| # | Topic | Analysis | Risk |
| --- | --- | --- | --- |
| 1 | **GitHub App vs OAuth App** | A GitHub App installed on the organization is required: fine-grained permissions (repos, webhooks), installation tokens, higher quotas. OAuth is not enough to "request access rights to the organization". | Low — standard route |
| 2 | **Protected files** | Decided: modification allowed, but detection (push webhook) + automatic **revert commit** restoring the protected files. | Medium — to be prototyped |
| 3 | **Forbidding force push** | Feasible via branch protection / rulesets on the student repositories (the student is not an admin). | Low |
| 4 | **Lock at the deadline** | Options: archive the repository (read-only, reversible), remove the write permission, or a "lock branch" ruleset. Archiving via the API is the simplest. The deadline commit = an empty commit pushed by the bot. | Medium — cron precision, Europe/Zurich timezone |
| 5 | **Grade extraction** | Direction: `grading.yml` emits a GitHub Actions **annotation**; the backend listens to the `workflow_run` webhook and reads the annotation via the check-runs API. Without `grading.yml`: plain pass/fail of the last run. | Medium — convention to be specified |
| 6 | **Squash "into primary commits"** | ❓ Ambiguous definition: a single initial commit? One commit per "milestone"? To be clarified. How is the squashed repo regenerated when the source moves forward? | Medium |
| 7 | **Synchronization by PR** | Teacher push on source → update of the squashed repo → bot PR towards each student repository. Conflicts with the student's work are possible: the PR is the right answer (the student resolves them). Requires a proper bot identity. | Medium |
| 8 | **Switch edu-ID + GitHub auth** | Decided: platform login via Switch edu-ID (OIDC), then linking of the GitHub account via a separate OAuth. The roster (list imported by the teacher) must be "claimed" by the student at their first login. | Medium — impacts the whole onboarding flow |
| 9 | **GitHub API quotas** | Metrics collection through webhooks (push, workflow_run) rather than polling; polling only as a catch-up. | Low if webhooks |
| 10 | **API key security** | Hashed keys, scoped per teacher/classroom, revocable. | Low |

## 5. Decisions and open questions

### Decisions taken (2026-07-03)

1. **Auth** ✅: platform login via **Switch edu-ID** (OIDC), then linking of the GitHub account
   via a separate GitHub auth (OAuth) to match the identity to the GitHub account.
2. **Protected files** ✅: modification by the student is **allowed**, but the system
   detects the change and pushes a **revert commit** restoring the protected files.
3. **Grade** 🟡: direction — `grading.yml` emits a GitHub Actions **annotation** that the
   backend captures (`workflow_run` webhook + check-runs API). Exact format to be specified in phase 2.

### Still open

1. **Squash**: precise definition of "primary commits".
2. **Volumetry**: order of magnitude (classes of ~30-100 students? number of simultaneous classrooms?) — has little influence on the stack but sizes the jobs.
3. **Group work**: individual assignments only, or team ones as well?
4. **Deadline extension** per student (frequent cases in practice)?
5. **"Last login"**: login to the portal, or last push?

## 6. Work plan (phase workflow)

| Phase | Deliverable | Content |
| --- | --- | --- |
| **1. Needs re-analysis** | `docs/00-analyse-besoins.md` (this document) | Actors, domain, risks, open questions |
| **2. Requirements & specs** | `docs/01-cahier-des-charges.md`, `docs/02-specs-fonctionnelles.md` | User stories + acceptance criteria, answers to the questions in §5, spec of the grading convention, spec of the GitHub App flow |
| **3. Architecture & stack** | `docs/03-architecture.md` + ADRs | Front/back/DB choices, GitHub App, webhooks, jobs, WebSocket/SSE for the live CI, DB schema, REST API contract + API key |
| **4. Implementation** | code by milestones | M1 auth+classrooms → M2 assignments+provisioning → M3 webhooks+metrics → M4 deadline jobs → M5 grading → M6 PR synchronization → M7 API/CLI |
| **5. Tests** | project CI | Unit, integration (mocked GitHub API + sandbox org), E2E |

**Spikes recommended before/during phase 3** (de-risking):

- S1: prototype the **revert commit** for protected files (push webhook → revert bot) on a test org.
- S2: prototype repository creation + invitation + branch protection via the GitHub App.
- S3: validate the `grading.yml` → annotation → webhook → grade extraction chain.

## 7. Proposed stack (to be validated in phase 3)

- **Backend**: TypeScript (Node), Fastify or NestJS, **Octokit** (official GitHub client), PostgreSQL, BullMQ (jobs/cron) — the most mature GitHub ecosystem.
- **Frontend**: React + Vite (or Next.js if SSR is wanted), table/dashboard, SSE or WebSocket for the live CI status.
- **Infra**: single container + Postgres to begin with; GitHub webhooks exposed (tunnel in dev).
