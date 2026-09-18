# Integration with heig-classroom

How classroom (`apps/server`) and the portal (`apps/codespace`) talk to each
other, and how to run them together on one workstation. The message contract is
[`packages/contracts/src/codespace.ts`](../../../packages/contracts/src/codespace.ts);
the signature is the one of
[`packages/domain/src/hs256.ts`](../../../packages/domain/src/hs256.ts).

Import rule of the root `CLAUDE.md`, unchanged: the two applications import
only `packages/*`, never each other's code. Everything goes through HTTP and
through HS256 tokens signed with a shared secret.

## 1. The three calls

```text
classroom                                     portal (apps/codespace)
─────────                                     ───────────────────────
registration of an "online" assignment
  PUT /api/assignments/<id> ─────────────────► upsert of the assignment
      Authorization: Bearer <service token>     (mode, image, quota, template
      body: CodespaceAssignmentSync             repository, BEK, window)
  ◄──────────────────────────────────────────── 200 { id, configKey, sebLink }

student clicks Start (already logged in)
  302 to /launch?token=<launch token> ───────► GET /launch
      claims: LaunchTokenClaims                  verifies, consumes the jti,
                                                 quota, SEB if exam,
                                                 creates or resumes the session
  ◄──────────────────────────────────────────── 303 to /s/<session>/
                                                 + cookie cs_session

teacher dashboard
  GET /api/assignments/<id>/sessions ─────────► CodespaceSessionSummary[]
      Authorization: Bearer <service token>
```

Three audiences, never interchangeable:

| Token | `iss` | `aud` | Lifetime | Single use |
| --- | --- | --- | --- | --- |
| service (server → server) | `heig-classroom` | `heig-codespace-api` | short | no |
| launch (carried by the student) | `heig-classroom` | `heig-codespace` | 5 min | **yes**, by `jti` |

A launch token presented to the service API gets 401; a service token
presented to `/launch` gets 403. Two tests assert it.

### The student does not log in twice

This is the whole point of the integration. `/launch` does **not** require a
portal OIDC session: the token *is* the proof of identity, issued by classroom
which has just authenticated the student. The portal registers the user from
the claims, opens the session and itself sets the `cs_session` cookie that the
proxy requires. The portal's OIDC login (invariant 4) stays in place for
standalone use and for the portal's teacher dashboard.

## 2. Variables on both sides

The secret is the same on both sides, and it is the only thing that has to be.

| Variable | Side | Development value |
| --- | --- | --- |
| `CODESPACE_LAUNCH_SECRET` | both | at least 32 characters, **identical** |
| `CLASSROOM_URL` | portal | `http://localhost:3000` |
| `PUBLIC_URL` | portal | `http://localhost:3100` |
| `PORT` | portal | `3100` |
| `CODESPACE_DEFAULT_IMAGE` | portal | `codespace/c-dev:4.137.0` |
| `SEB_EXTRA_ALLOWED_HOSTS` | portal | `localhost:8080` (the identity provider) |
| the portal URL | classroom | `http://localhost:3100` |

**Secret absent**: the plugin is not registered, `PUT /api/assignments/*`,
`GET /api/assignments/*/sessions` and `GET /launch` answer 404, and the portal
stays usable standalone (YAML seed, OIDC login, Start button). That is the
default mode of a deployment that has no classroom facing it.

In production, `loadConfig()` refuses a `CODESPACE_LAUNCH_SECRET` containing
`change-me`, as it does for the other secrets.

## 3. Running both applications locally

```bash
# --- classroom, on :3000 ---
docker compose -f docker-compose.dev.yml up -d      # classroom's Postgres + Keycloak
pnpm --filter @hgc/server dev

# --- portal, on :3100 ---
podman compose -f apps/codespace/infra/compose.dev.yml up -d   # the portal's Forgejo
sudo apps/codespace/infra/net/setup.sh                          # codespace network + nft
pnpm --filter @hgc/codespace seed
pnpm --filter @hgc/codespace dev
```

A single development Keycloak, classroom's (`docker-compose.dev.yml` at the
root, realm `hgc-dev`). The portal has its own client there
(`codespace-portal`, redirect on `localhost:3100`) for its standalone use; on
the portal side, only Forgejo has to be started:

```bash
podman compose -f apps/codespace/infra/compose.dev.yml up -d   # Forgejo only
```

In production, no Keycloak: both applications talk to Switch edu-ID.

Checking the whole chain without a browser:

```bash
cd apps/codespace && ./scripts/e2e.sh     # step 9: "launch from classroom"
```

Step 9 builds its two tokens itself with `signHs256` and the secret of the
`.env`, pushes an assignment, calls `/launch`, checks that the editor opens,
that the push is relayed to the repository **of the token**, that replaying the
token is refused and that the teacher's quota stands in the way of a second
student.

## 4. What the portal does with the assignment it receives

| Contract | Portal |
| --- | --- |
| `mode: "online"` | `assignments.mode = "lab"` |
| `mode: "online_seb"` | `assignments.mode = "exam"` |
| `image: null` | `CODESPACE_DEFAULT_IMAGE` |
| `sourceRepo` | `assignments.sourceRepo`, and `templateRepo` = its clone URL |
| `teacher`, `quota` | `teacherId`, `teacherEmail`, `maxActiveSessions` |
| `startAt`, `deadlineAt` | `opensAt`, `closesAt` |
| `browserExamKeys` | `assignments.beks` (a list, cf. analyse.md § 4.4) |

The **target repository is no longer an attribute of the assignment**. It
arrives through the launch token, student by student, and lives in
`sessions.targetRepo`: it is the target of the relay and, in lab mode, the
source of the mirror of the staging repository. The `targetRepo` /
`targetRepoPattern` columns of the assignment remain for the standalone YAML
seed, where the portal has nobody to give them to it.

The `PUT` is idempotent: replayed identically, it returns exactly the same
answer. In particular the **Browser Exam Key salt is never regenerated** —
changing it would invalidate the Config Key of the `.seb` files already
distributed.

## 5. Exam mode: who authenticates, who verifies

The `startURL` written into the `.seb` file is **classroom's**:

```text
${CLASSROOM_URL}/app/codespace/start/<assignmentId>
```

SEB therefore starts on classroom, which authenticates the student (they
already have their session, or they log in), then redirects to the portal's
`/launch?token=…`. SEB's URL filter must consequently let **three** families of
hosts through:

1. the one of the `startURL` — classroom; `buildSebConfig` adds that one by
   itself;
2. the portal's — without which the editor does not load;
3. those of `SEB_EXTRA_ALLOWED_HOSTS` — the identity provider, without which
   the login page is blocked (docs/pistes.md, "Correction to the framing
   document raised by the SEB test").

**Invariant 5, made precise.** The SEB verification — the two headers, the
Config Key, the BEKs — happens on `GET /launch`, once, because that is where
SEB arrives through a top-level navigation. The `/s/<session>/*` proxy still
reads no SEB header at all: it only knows the `exam_session` cookie, which
`/launch` sets after the verification, bound to the client address. The
`/exam/<id>/start` route of the standalone portal keeps exactly the same role
for an assignment coming from the YAML seed.

The `.seb` file itself is still served by the portal
(`GET /exam/<id>.seb`); `sebLink` in the `PUT` response is the `seb://` link
that the teacher distributes.

## 6. Quota per teacher

`quota.maxActiveSessions` is a ceiling **per teacher, across all assignments**
(docs/pistes.md: "the feature is enabled by the administrator, teacher by
teacher, with a quota of active sessions per teacher").
The counting:

- `sessions.teacherId` is copied from the assignment when the session is
  created — copied and not joined, so that the count holds in a single query
  and so that a reassigned assignment does not move the sessions already open;
- the sessions counted are those in a **live** state (`starting`, `running`,
  `stopped`): `stopped` is part of it because the volume and the identifier
  survive and a reload comes back to it;
- **resuming does not consume quota.** If the student already has a live
  session on that assignment, the ceiling is not consulted: it is not going to
  open one more container (analyse.md D5).

Going over returns a 429 page « quota atteint, réessayez plus tard » (the page
text is end-user UI), and a log line carrying the teacher, the current count
and the ceiling.

## 7. Identities: two paths, two rows

`users.login` is the institutional identifier, and it is the one that names the
volume directory (`<VOLUMES_ROOT>/<login>/<assignment>/`), hence the `SAFE_ID`
constraint of `git/staging.ts`.

| Origin | `users.oidcSub` | `users.login` | `role` |
| --- | --- | --- | --- |
| portal OIDC login | `sub` of the Keycloak identity token | `preferred_username` | recomputed from the realm |
| classroom launch token | `classroom:<sub of the token>` | `<sub of the token>` | `student`, never modified |

The `classroom:` prefix is there so that the two subject namespaces cannot
cross. Accepted consequence: **the same human arriving by both paths is two
rows**, hence two volume trees, as long as classroom's subject is not equal to
their `preferred_username`. That is the price of not reconciling two accounts
by their e-mail address, which would be account takeover in disguise.

A launch token cannot grant the teacher role: `role` is written only by the
OIDC login (docs/v1.md § D-V1-3). The portal's `/teacher/sessions` dashboard
therefore stays behind the realm; the teacher's dashboard *inside classroom*
goes through `GET /api/assignments/<id>/sessions`, authenticated by the service
token. Its `userId` field carries classroom's identifier when the account comes
from there, so that the caller can match it with its own users.

## 8. Single use of the launch token

The `jti` is consumed by an `INSERT` into `launch_tokens_used`: the primary key
*is* the guarantee, not a read followed by a write — two simultaneous requests
carrying the same token cannot both pass. The consumption happens **before**
any other check, right after the signature: a token refused for any other
reason (unknown assignment, quota, SEB) is therefore burnt, and the student
starts again from classroom's Start button, which issues a fresh one. That is
the intended behaviour — a launch link is not a page to reload.

Expired rows are purged on every pass: beyond `exp`, `verifyHs256` already
refuses the token and the row prevents nothing any more.

Nothing that is logged carries the token, its signature or a Browser Exam Key.
The `jti` alone is written: it is not a secret and it links the logs of the two
applications.

## 9. `TODO(verify)`

- **SEB, cross-host redirect.** The `startURL` is on classroom and SEB reaches
  the portal's `/launch` after a redirect to another host. That SEB does add
  its two headers to *that* request, and that it hashes them over the portal's
  URL with its query string, has not been observed on any SEB binary — the
  `simulated` mode does not prove it. To be confronted during proof B
  ([preuve-b-manuelle.md](preuve-b-manuelle.md)). Fallback if needed: the
  `startURL` comes back to the portal and it is classroom that posts the token
  through a form.

## 10. What remains to be done

- The `/app/codespace/start/<id>` route of classroom (the one the `startURL` of
  the `.seb` file designates) is written on classroom's side; the portal only
  names it.
- `GET /api/assignments/<id>/sessions` does not yet know how to say that an
  exam request came from a different address (alert of analyse.md D5, § 6.8 of
  docs/v1.md): the refusal is in place and logged, the summary does not carry
  it.
- The relay to GitHub goes through `createGithubForge`, and it **has** been
  exercised against the real GitHub App: on 2026-09-17, on the production VM, a
  `git push` from the container reached `staging.git` and the `PushEvent` went
  `relayed` in 2.2 s onto a private repository (deploy.md § 5, "Measured on the
  VM on 2026-09-17"). What remains is operational, not code: the App is not
  installed on the `heig-tin-info` organisation, so the smoke assignment's
  `PushEvent` stays `pending` there.
