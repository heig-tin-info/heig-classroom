# Deployment on the Hetzner VM

Production runs on a Hetzner Cloud VM shared by three services: heig-classroom,
heig-quiz and heig-bt-grading (evaluation-tb). Until 2026-09-25 it ran on a DigitalOcean
droplet (1 CPU / 956 MiB, rootful Docker, everything as root under `/opt`).

## 1. The VM

Hetzner Cloud CPX12, server `heig-portal`, Ubuntu 26.04 LTS: 1 vCPU, 2 GB of RAM plus a 2 GB
swap file, 38 GB of disk. Public name `portal.heig.chevallier.io` (A `128.140.71.35`,
AAAA `2a01:4f8:1c19:1164::1`).

```bash
# 2 GB of swap (useful below 2 GB of RAM)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Update + basic tools
apt update && apt upgrade -y
apt install -y curl git ufw gnupg ca-certificates

# Host firewall: SSH + HTTP + HTTPS only
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable
```

Two firewalls: ufw on the host, and the **Hetzner Cloud Firewall** in front of it (inbound
TCP 22, 80, 443, UDP 443 for HTTP/3, ICMP; no outbound rule).

### Accounts and SSH

- `srv` — the service account. It owns `/srv` (mode 2775, group `srv`) and the three
  checkouts `/srv/quiz`, `/srv/heig-classroom`, `/srv/evaluation-tb`. It runs the
  containers, can read the services' secrets and databases, and cannot touch the system:
  its only sudo rights are `systemctl reload caddy` and
  `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`
  (`/etc/sudoers.d/srv-caddy`). It is the account the CI and the agents use.
- `ycr`, `tmz` — humans, groups `sudo` and `srv`, sudo with a password. To act as the
  service: `sudo machinectl shell srv@`.
- root cannot log in over SSH; it is reached through sudo or the Hetzner console.

`/etc/ssh/sshd_config.d/10-hardening.conf`:

```
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers ycr tmz srv
```

The SSH host keys are the previous host's, copied over: the host key pinned in CI did not
change.

### Docker (rootless, as `srv`)

No Node.js and no pnpm on the VM: the application only ever runs as a container built in CI
(see §7), so Docker and Caddy are all that is installed.

```bash
# Docker CE + compose plugin + rootless extras (official repository)
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-ce-rootless-extras

# No root daemon: Docker runs only in srv's user session
systemctl disable --now docker.service docker.socket
loginctl enable-linger srv    # srv's containers restart at boot
```

`srv` runs **rootless Docker** in its systemd user session: socket
`/run/user/1000/docker.sock`, `DOCKER_HOST` exported in its `~/.bashrc` and `~/.profile`.
Ubuntu restricts unprivileged user namespaces with AppArmor; the Ubuntu-shipped profile
`/etc/apparmor.d/rootlesskit` is what lets rootlesskit work. Do **not** add a second profile
for `/usr/bin/rootlesskit`: two profiles conflict ("conflicting profile attachments").

Rootless consequence: inside a container uid 0 is `srv` on the host, and uid 1000 (`node`)
is host uid 100999 (subuid range 100000–165535). A host-side `chown 1000:1000` is therefore
wrong; ownership the container must see as 1000 is set through a container (§4).

### Caddy (native, apt)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

`/etc/caddy/Caddyfile` holds a single line, `import /etc/caddy/conf.d/*.caddy`.
`/etc/caddy/conf.d/` is `root:srv`, mode 2775: each project drops its own fragment there
(`quiz.caddy`, `classroom.caddy`, `tb.caddy`, mode 664), see §5. Loopback ports: classroom
3000, tb 3001, quiz 3002.

## 2. DNS: `classroom.chevallier.io` is a CNAME to `portal.heig.chevallier.io`

At Gandi, TTL 300, like `quiz.chevallier.io` and `tb.chevallier.io`; a new service is one
more CNAME. Propagation checked with `dig +short classroom.chevallier.io`.

## 3. **Production** GitHub applications (same screens as in dev, GH-02 permissions
in `docs/02-specs-fonctionnelles.md`):

- **GitHub App** `heig-classroom` (a single one, owned by `heig-tin-info`, it also serves
  account linking): webhook
  `https://classroom.chevallier.io/webhooks/github`, callback
  `https://classroom.chevallier.io/app/auth/github/callback`, setup URL
  `https://classroom.chevallier.io/setup/github/installed`, installable on
  **Any account**; generate the PEM plus a client secret. Installing it on each
  teaching organization then happens from the portal (the class wizard).
  See `docs/deployment/github-app.md`.

## 4. Code and secrets

As `srv` (from a human account: `sudo machinectl shell srv@`):

```bash
cd /srv && git clone <repository-url> heig-classroom && cd heig-classroom
mkdir -p secrets backups
# Drop in (never in git), then chmod 600:
#   secrets/hgc-prod.private-key.pem   (production GitHub App)
#   secrets/eduid-private-key.pem      (private_key_jwt edu-ID, already generated)
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD/COOKIE_SECRET: openssl rand -base64 32
# The containers must see secrets/ and backups/ as uid 1000: under rootless Docker
# that ownership is set through a container, never with a host-side chown.
docker run --rm -v "$PWD":/w alpine chown -R 1000:1000 /w/secrets /w/backups
```

Once handed over, a secret file is owned by host uid 100999 with mode 600: `srv` reads it
through a container, not with `cat`:
`docker run --rm -v /srv/heig-classroom/secrets:/s:ro alpine cat /s/<file>`.
`.env.prod` stays owned by `srv` and is readable directly.

An encrypted copy of the secrets in the vault (`age`) is a precondition of the 4 h RTO
(ADR-010).

## 5. Caddy (native): the vhost is versioned in [Caddyfile](Caddyfile)

It is installed as this project's fragment, never over the host Caddyfile (which only
imports the fragments). As `srv`, from `/srv/heig-classroom`:

```bash
cp Caddyfile /etc/caddy/conf.d/classroom.caddy \
  && sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
  && sudo systemctl reload caddy
```

## 6. First deployment

The image is **never built on the VM**: it is built in CI and pulled from GHCR (§7), so the
first start is a pull followed by an `up -d`, exactly like every later deployment. Log in to
GHCR first if the package is still private (see the manual deployment in §7).

```bash
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
docker compose -f compose.prod.yml logs -f app   # migrations, then "hgc-server started"
curl -s https://classroom.chevallier.io/healthz  # {"status":"ok",...}
```

This starts the `app`, `postgres` and `backup` services. The `keycloak` service sits behind
the `keycloak` Compose profile and is **disabled by default** (edu-ID is the production IdP):
it only starts with `docker compose -f compose.prod.yml --env-file .env.prod --profile keycloak up -d`.
When that fallback IdP is enabled, its console is served at
`https://classroom.chevallier.io/kc/` (the admin account comes from `.env.prod`) — that is
where the real realm accounts are created, or the imported test passwords changed. The super
administrator is `SUPER_ADMIN_EMAIL`; teachers are managed from the Admin screen.

## 7. Update / rollback

Deployment is done by CI (`.github/workflows/ci.yml`): every push to `main` passes the
checks, builds the image on GitHub Actions, pushes it to GHCR
(`ghcr.io/heig-tin-info/heig-classroom`, tags `latest` + sha), and then the `deploy` job
connects to the VM over SSH and triggers `deploy.sh` (image pull + `up -d`) — a few seconds,
zero contention.

**Never build on the VM** (1 vCPU / 2 GB, shared by three services): a local build makes
the host swap and strangles Postgres — `Connection terminated` timeouts on
login/ticker/pg-boss, experienced on 2026-07-10 on the previous host — and fills the disk
(~1 GB of builder cache per cycle).

### Security of the CI → VM access (forced command)

The CI key is pinned to `deploy.sh` in `authorized_keys`: with that key the runner can
**only** deploy, never open a shell (even if the secret leaks). The GHCR package stays
private: the runner passes its ephemeral token as the SSH "command" (→
`$SSH_ORIGINAL_COMMAND`), which `deploy.sh` uses for the `docker login` for the duration of
the pull — no registry credential is stored on the VM. The login lives in a throwaway
`DOCKER_CONFIG` (removed on exit): quiz deploys through the same `srv` account, and two
concurrent deploys overwrote each other's login in `~/.docker/config.json` between login
and pull ("denied", 2026-09-25).

### Setup (once)

1. Generate a dedicated key pair:
   ```bash
   ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@heig-classroom
   ```
2. **Private** key → **Actions secret** (⚠ not a Deploy Key):
   ```bash
   gh secret set DEPLOY_SSH_KEY --repo heig-tin-info/heig-classroom < ci_deploy
   ```
3. **Public** key → `srv`'s `authorized_keys`, pinned to `deploy.sh`:
   ```bash
   # on the VM, as srv
   printf 'command="/srv/heig-classroom/deploy.sh",restrict %s\n' \
     "$(cat ci_deploy.pub)" >> /home/srv/.ssh/authorized_keys
   ```
   (`deploy.sh` arrives through `git pull`; it is versioned and already executable. It
   enters its own directory and, when not run as root, defaults `DOCKER_HOST` to the
   rootless socket.)
4. Repository **variable** `DEPLOY_USER=srv`: the workflow connects as
   `${{ vars.DEPLOY_USER || 'root' }}@classroom.chevallier.io`.
   ```bash
   gh variable set DEPLOY_USER --repo heig-tin-info/heig-classroom --body srv
   ```

Without the secret, the `deploy` job skips cleanly (the image is published to GHCR anyway).

### Manual deployment (if CI is unavailable)

As `srv`, the simplest is to run `deploy.sh` with the PAT where the CI token would be:

```bash
cd /srv/heig-classroom && SSH_ORIGINAL_COMMAND=<PAT read:packages> ./deploy.sh
```

or, step by step, with the login kept out of `~/.docker/config.json`:

```bash
cd /srv/heig-classroom && git pull --ff-only
export DOCKER_CONFIG=$(mktemp -d)
echo <PAT read:packages> | docker login ghcr.io -u heig-tin-info --password-stdin
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
rm -rf "$DOCKER_CONFIG"
```

### Rollback

The sha tags stay on GHCR:

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml \
  --env-file .env.prod up -d
# additive migrations — when in doubt, restore the database (§8).
```

## 8. Backups (NFR-16: RPO 24 h, RTO 4 h)

Two complementary layers:

- **Hetzner Backups**: a daily backup of the whole VM, taken by Hetzner, off the VM
  (Backups tab of the server in the Hetzner console, 7 daily slots). It replaces the previous
  host's daily snapshot and **must be enabled in the console** — check it is. It
  covers losing the machine outright: the whole VM comes back, secrets and volumes
  included. It is a disk image of a *running* Postgres, so it is crash-consistent —
  Postgres replays its WAL on the way up. That is sound, but it is not the equivalent of a
  clean dump, and the granularity is the day.
- **A daily `pg_dump -Fc`** from the compose `backup` service into
  `/srv/heig-classroom/backups/` (30-day retention). A logical dump, restorable table by
  table: the right tool for backing out of a migration or recovering precise data. It lives
  **on the VM it protects**, so if the VM is lost it is the Hetzner backup that saves you.
- **Before any migration**, take a fresh dump rather than trusting the daily one:

```bash
cd /srv/heig-classroom && docker compose -f compose.prod.yml --env-file .env.prod \
  exec -T postgres pg_dump -Fc -U hgc hgc > "backups/pre-<migration>-$(date +%F-%H%M).dump"
```

- **Still to wire**, for a logical dump off the VM: `rclone copy backups
  remote:hgc-backups` in cron (SWITCH storage, etc.). The Hetzner backup covers the
  machine-loss case, so this is no longer a gaping hole — but restoring a single table out
  of a VM backup stays laborious.
- Restore: `pg_restore --clean` into the existing database fails on pg-boss's partitioned
  tables (`cannot drop inherited constraint … job_common`, seen during the 2026-09-25
  migration). Restore a full dump into a freshly recreated database instead, app stopped:

```bash
cd /srv/heig-classroom
docker compose -f compose.prod.yml --env-file .env.prod stop app
docker compose -f compose.prod.yml --env-file .env.prod exec -T postgres \
  psql -U hgc -d postgres -c 'DROP DATABASE hgc WITH (FORCE)' -c 'CREATE DATABASE hgc OWNER hgc'
docker compose -f compose.prod.yml --env-file .env.prod exec -T postgres \
  pg_restore -U hgc -d hgc --no-owner --role=hgc --exit-on-error < backups/hgc-<date>.dump
docker compose -f compose.prod.yml --env-file .env.prod start app
```

- VM lost: new VM → §1 → secrets from the vault → restore the dump → re-point the A/AAAA
  records of `portal.heig.chevallier.io` (the service names are CNAMEs to it). Timed
  restore test every semester.

## 9. SWITCH edu-ID switchover (as soon as the resource is approved) — in `.env.prod`:

```bash
OIDC_ISSUER=<edu-ID issuer>
OIDC_CLIENT_ID=<issued client id>
OIDC_PRIVATE_KEY_PATH=secrets/eduid-private-key.pem
OIDC_PRIVATE_KEY_KID=hgc-eduid-2026
```

`docker compose -f compose.prod.yml --env-file .env.prod up -d app`, test a real login, then
remove the `keycloak` service from the compose file and the `/kc/*` block from the Caddyfile.

## 10. Monitoring: an external 60 s probe on `/healthz` (Uptime-Kuma); logs through
`docker compose logs -f app` (credentials masked), from a workstation:
`ssh srv@portal.heig.chevallier.io 'cd /srv/heig-classroom && docker compose -f compose.prod.yml --env-file .env.prod logs --tail 50 app'`.
