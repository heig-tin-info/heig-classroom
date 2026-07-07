# Setting up the production GitHub applications

The portal talks to GitHub through two distinct applications. The GitHub App does
everything the server does on repositories (provisioning, rulesets, webhooks) and
signs its work as the `hgc-prod[bot]` identity. The OAuth App only serves one
purpose: letting students link their GitHub account, with the minimal `read:user`
scope.

The development pair (`hgc-dev`, callbacks on `localhost:3000`) stays untouched. A
GitHub OAuth App accepts a single callback URL, so pointing it at production would
break local development. Production gets its own pair.

## 1. GitHub App `hgc-prod`

Create it inside the target organization at
`https://github.com/organizations/<org>/settings/apps/new` and fill in:

- **Name**: `hgc-prod` (the slug becomes the bot identity on commits)
- **Description** (shown to users on the installation and authorization screens):

```text
HEIG Classroom drives the student repositories of this organization: it creates
one private repository per student and assignment, grants push access, protects
assignment files, collects CI results, and locks repositories at the deadline.
Operated by the TIN department at HEIG-VD. Portal: https://classroom.chevallier.io
```

- **Homepage URL**: `https://classroom.chevallier.io`
- **Callback URL**: leave empty, and uncheck *Request user authorization (OAuth)
  during installation* (the App is server-only)
- **Webhook**: uncheck *Active* for now. It will be enabled with milestone M3,
  using `https://classroom.chevallier.io/webhooks/github` and a secret generated
  with `openssl rand -hex 32` (mirrored in `GITHUB_WEBHOOK_SECRET`)
- **Repository permissions** (the GH-02 table, nothing more):

| Permission | Level |
| --- | --- |
| Metadata | Read (automatic) |
| Administration | Read & write |
| Contents | Read & write |
| Workflows | Read & write |
| Pull requests | Read & write |
| Checks | Read |
| Actions | Read |

- **Organization permissions**: Members, Read (optional)
- **Where can this App be installed**: *Only on this account*

Once created, note the **App ID** (the `Iv23…` Client ID works too), generate a
**private key** under *Private keys* (a `.pem` file downloads), then open
**Install App** in the left menu and install it on the organization with
**All repositories**.

## 2. Production OAuth App

Create it at `https://github.com/organizations/<org>/settings/applications/new`:

- **Application name**: `HEIG Classroom`
- **Application description**:

```text
Links your GitHub account to your HEIG Classroom profile so assignments can be
delivered to you. Read-only access to your public profile, nothing else.
```

- **Homepage URL**: `https://classroom.chevallier.io`
- **Authorization callback URL**:
  `https://classroom.chevallier.io/app/auth/github/callback`

Note the **Client ID** and generate a client secret.

## 3. Install the values on the server

```bash
# From your workstation, ship the downloaded PEM
scp hgc-prod.*.private-key.pem root@classroom.chevallier.io:/opt/heig-classroom/secrets/hgc-prod.private-key.pem

ssh root@classroom.chevallier.io
chmod 600 /opt/heig-classroom/secrets/hgc-prod.private-key.pem
chown 1000:1000 /opt/heig-classroom/secrets/hgc-prod.private-key.pem   # container uid
```

In `/opt/heig-classroom/.env.prod`:

```bash
GITHUB_APP_ID=<hgc-prod App ID>
GITHUB_APP_PRIVATE_KEY_PATH=secrets/hgc-prod.private-key.pem
GITHUB_APP_SLUG=hgc-prod
GITHUB_WEBHOOK_SECRET=            # milestone M3
GITHUB_OAUTH_CLIENT_ID=<OAuth App Client ID>
GITHUB_OAUTH_CLIENT_SECRET=<client secret>
```

Then restart the app:

```bash
cd /opt/heig-classroom
docker compose -f compose.prod.yml --env-file .env.prod up -d app
```

## 4. Verify

Open a classroom bound to the organization: the **GitHub App installed** badge
should turn green (installation is resolved on view). In the header, **Link
GitHub** should walk you through the `read:user` authorization and come back with
your login as a green badge. Finally, publish a test assignment and accept it
with a student account: the `slug-<login>` repository appears in the
organization, protected by the `hgc-protect` ruleset.

## Notes

One App installed per teaching organization is all it takes; the same App serves
every classroom bound to that organization. The PEM key never goes into git or
into the database (ADR-010), keep an encrypted copy in the vault. GitHub accepts
two active keys at once, which makes rotation painless. Switching from the dev App
to the prod App does not invalidate repositories that were already provisioned, as
long as the new App is installed on the same organization.
