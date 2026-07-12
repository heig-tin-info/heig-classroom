# Setting up the production GitHub App

The portal talks to GitHub through **one single GitHub App**. It does everything
the server does on repositories (provisioning, rulesets, webhooks) under the
`hgc-prod[bot]` identity, **and** carries the user-to-server OAuth flow that
lets students link their GitHub account — a GitHub App accepts up to ten
callback URLs and its user tokens serve `GET /user` without any scope, so the
former separate OAuth App is unnecessary.

The App is created **once**; onboarding a new teaching organization is then a
matter of clicking **Install** from the classroom page (the in-app wizard walks
the teacher through it — see *Onboarding an organization* below).

## 1. Create the GitHub App `hgc-prod` (one time)

Create it at `https://github.com/organizations/<home-org>/settings/apps/new`
and fill in:

- **Name**: `hgc-prod` (the slug becomes the bot identity on commits)
- **Description** (shown on the installation and authorization screens):

```text
HEIG Classroom drives the student repositories of this organization: it creates
one private repository per student and assignment, grants push access, protects
assignment files, collects CI results, and locks repositories at the deadline.
Operated by the TIN department at HEIG-VD. Portal: https://classroom.chevallier.io
```

- **Homepage URL**: `https://classroom.chevallier.io`
- **Callback URL**: `https://classroom.chevallier.io/app/auth/github/callback`
  (used by the account-linking flow), and leave *Request user authorization
  (OAuth) during installation* **unchecked** — linking stays a separate act.
- **Setup URL**: `https://classroom.chevallier.io/setup/github/installed` and
  check *Redirect on update*. This is what makes the install wizard seamless:
  GitHub sends the owner back to the classroom and the badge turns green live.
- **Webhook**: *Active*, `https://classroom.chevallier.io/webhooks/github`,
  secret mirrored in `GITHUB_WEBHOOK_SECRET`.
- **Repository permissions** (the GH-02 table, nothing more):

| Permission | Level |
| --- | --- |
| Actions | Read |
| Administration | Read & write |
| Checks | Read |
| Contents | Read & write |
| Metadata | Read (automatic) |
| Pull requests | Read & write |
| Workflows | Read & write |

- **Organization permissions**: Members, Read (optional)
- **Subscribe to events**: **Push**, **Workflow run**, **Pull request**,
  **Member** (and **Repository** for out-of-band renames). Installation events
  are always delivered to GitHub Apps, no subscription needed.
- **Where can this App be installed**: **Any account** — this is what lets a
  teacher install it on a fresh organization with one click. The App stays
  invisible to search; only people with the install link use it.

Once created, note the **App ID** and the **Client ID**, generate a **client
secret** (account linking) and a **private key** (a `.pem` file downloads).

## 2. Install the values on the server

```bash
# From your workstation, ship the downloaded PEM
scp hgc-prod.*.private-key.pem root@classroom.chevallier.io:/opt/heig-classroom/secrets/hgc-prod.private-key.pem

ssh root@classroom.chevallier.io
chmod 600 /opt/heig-classroom/secrets/hgc-prod.private-key.pem
chown 1000:1000 /opt/heig-classroom/secrets/hgc-prod.private-key.pem   # container uid
```

In `/opt/heig-classroom/.env.prod`:

```bash
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_PATH=secrets/hgc-prod.private-key.pem
GITHUB_APP_SLUG=hgc-prod
GITHUB_WEBHOOK_SECRET=<webhook secret>
GITHUB_APP_CLIENT_ID=<Client ID of the App>
GITHUB_APP_CLIENT_SECRET=<client secret of the App>
```

(The legacy `GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_SECRET` variables are
still read as a fallback during the migration; drop them once the App's client
is in place.)

Then restart the app:

```bash
cd /opt/heig-classroom
docker compose -f compose.prod.yml --env-file .env.prod up -d app
```

## 3. Onboarding an organization (what a teacher does)

1. **Create the organization** on GitHub if needed (free plan is fine) —
   `https://github.com/account/organizations/new`. The classroom creation form
   links there.
2. **Create the classroom** in the portal, entering the organization login.
3. The classroom page shows the **Connect GitHub** wizard: one click on
   *Install the GitHub App* (the teacher must be an owner of the organization,
   pick **All repositories**), GitHub validates the permissions and sends them
   straight back — the badge turns green without a refresh.

Nothing to configure server-side, no secret to transport: one App, N
installations.

## 4. Verify

In the header, **Link GitHub** should walk you through the App authorization
and come back with your login as a green badge. Publish a test assignment and
accept it with a student account: the `slug-<login>` repository appears in the
organization, protected by the `hgc-protect` ruleset.

## Notes

The same App serves every classroom of every organization it is installed on.
The PEM key never goes into git or into the database (ADR-010); keep an
encrypted copy in the vault. GitHub accepts two active keys at once, which
makes rotation painless. Rate limits are **per installation**, so organizations
do not compete with each other. The trade-off of the single-App model: one
shared bot identity and one private key for all organizations — acceptable for
a single institution; if an external org ever demands isolation, the GitHub
App *manifest flow* is the documented escape hatch (per-org app generated in
two clicks).
