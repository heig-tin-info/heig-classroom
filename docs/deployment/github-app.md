# The GitHub App

The portal talks to GitHub through **one single GitHub App** — in production:
[`heig-classroom`](https://github.com/apps/heig-classroom), owned by
`heig-tin-info`. It does everything the server does on repositories
(provisioning, rulesets, webhooks) under the `heig-classroom[bot]` identity,
**and** carries the user-to-server OAuth flow that links student accounts — a
GitHub App accepts up to ten callback URLs and its user tokens serve
`GET /user` without any scope, so no separate OAuth App is needed.

**The App is created once, by the operator, as part of deploying the
platform.** Teachers never create or configure an app: installing it on their
organization is one click in the portal (see *Onboarding an organization*
below). Note that a GitHub App can never change owners — create it under the
organization that should own it forever (`heig-tin-info`), not under a
test org.

## Creating the App (operator, one time)

Create it at `https://github.com/organizations/<owner-org>/settings/apps/new`
and fill in:

- **Name**: `heig-classroom` (the slug becomes the bot identity on commits)
- **Description** (shown on the installation and authorization screens):

```text
HEIG Classroom drives the student repositories of this organization: it creates
one private repository per student and assignment, grants push access, protects
assignment files, collects CI results, and locks repositories at the deadline.
Operated by the TIN department at HEIG-VD. Portal: https://classroom.chevallier.io
```

- **Homepage URL**: `https://classroom.chevallier.io`
- **Callback URL**: `https://classroom.chevallier.io/app/auth/github/callback`
  (account linking), and leave *Request user authorization (OAuth) during
  installation* **unchecked** — linking stays a separate act.
- **Setup URL**: `https://classroom.chevallier.io/setup/github/installed` and
  check *Redirect on update*. This makes the install wizard seamless: GitHub
  sends the owner back to the classroom and the badge turns green live.
- **Webhook**: *Active*, `https://classroom.chevallier.io/webhooks/github`,
  secret mirrored in `GITHUB_WEBHOOK_SECRET`.
- **Where can this App be installed**: **Any account** — this is what lets a
  teacher install it on a fresh organization with one click.

### Repository permissions

| Permission | Level | Why |
| --- | --- | --- |
| Actions | Read | read workflow runs (grading pipeline results) |
| Administration | Read & write | create repositories, rulesets, deadline locks |
| Checks | Read | read check-run annotations (GRADE / TESTS) |
| Contents | Read & write | push scaffolds, deadline markers, protected-file reverts |
| Metadata | Read | mandatory baseline |
| Pull requests | Read & write | open and track sync pull requests |
| Workflows | Read & write | ship `.github/workflows/grading.yml` to student repos |

### Organization permissions

| Permission | Level | Why |
| --- | --- | --- |
| Members | Read | clear the "accept the invitation" hint, roster cross-checks |
| Plan | Read | detect free-plan organizations (org secrets don't reach private repos there) and suggest the [teacher upgrade](https://education.github.com/globalcampus/teacher) |

### Webhook events

| Event | Why |
| --- | --- |
| Push | repository metrics, protected files, source-ahead detection, push receipts |
| Workflow run | CI status and grade capture |
| Pull request | sync pull-request tracking |
| Member | clears the "accept the GitHub invitation" hint on acceptance |
| Repository | out-of-band renames or deletions of student repositories |
| Organization | organization renamed or deleted — keep the portal's org records honest |

Installation events are always delivered to GitHub Apps; no subscription
needed.

Once created: note the **App ID** and **Client ID**, generate a **client
secret** (account linking) and a **private key** (a `.pem` downloads).

## Installing the values on the server

```bash
# From your workstation, ship the downloaded PEM
scp heig-classroom.*.private-key.pem root@classroom.chevallier.io:/opt/heig-classroom/secrets/heig-classroom.private-key.pem

ssh root@classroom.chevallier.io
chmod 600 /opt/heig-classroom/secrets/heig-classroom.private-key.pem
chown 1000:1000 /opt/heig-classroom/secrets/heig-classroom.private-key.pem   # container uid
```

In `/opt/heig-classroom/.env.prod`:

```bash
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=secrets/heig-classroom.private-key.pem
GITHUB_APP_SLUG=heig-classroom
GITHUB_WEBHOOK_SECRET=<webhook secret>
GITHUB_APP_CLIENT_ID=<Client ID of the App>
GITHUB_APP_CLIENT_SECRET=<client secret of the App>
```

Then `docker compose -f compose.prod.yml --env-file .env.prod up -d app`.

## Onboarding an organization (what a teacher does)

1. **Create the organization** on GitHub if needed (free plan works to start)
   — the classroom creation form links there.
2. **Create the classroom** in the portal, entering the organization login.
3. The classroom page shows the **Connect GitHub** wizard: one click on
   *Install the GitHub App* (the teacher must be an owner of the organization,
   pick **All repositories**), GitHub validates the permissions, and the badge
   turns green by itself.

Nothing to configure server-side, no secret to transport: **one App,
N installations**.

## Verify

In the portal header, **Link GitHub** should walk through the App
authorization and come back with your login as a green badge. Publish a test
assignment and accept it with a student account: the `slug-<login>` repository
appears in the organization, protected by the `hgc-protect` ruleset.

## Notes

The same App serves every classroom of every organization it is installed on.
The PEM key never goes into git or into the database (ADR-010); keep an
encrypted copy in the vault. GitHub accepts two active keys at once, which
makes rotation painless. Rate limits are **per installation**, so
organizations do not compete with each other. The trade-offs of the single-App
model — one shared bot identity, one private key for all organizations — are
acceptable for a single institution; if an external org ever demands
isolation, the GitHub App *manifest flow* is the escape hatch (a per-org app
generated in two clicks).
