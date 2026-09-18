# Deployment on a DigitalOcean Droplet

## 1. Create an Ubuntu/Debian droplet

```bash
# 2 GB of swap (useful below 2 GB of RAM)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# Update + basic tools
apt update && apt upgrade -y
apt install -y curl git ufw gnupg ca-certificates

# Dedicated application user
adduser --system --group --home /opt/heig-classroom hgc

# Firewall: SSH + HTTP + HTTPS only
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

```bash
root@heig-classroom:~# ufw status
Status: active

To                         Action      From
--                         ------      ----
OpenSSH                    ALLOW       Anywhere
80                         ALLOW       Anywhere
443                        ALLOW       Anywhere
OpenSSH (v6)               ALLOW       Anywhere (v6)
80 (v6)                    ALLOW       Anywhere (v6)
443 (v6)                   ALLOW       Anywhere (v6)
```

No Node.js and no pnpm on the VM: the application only ever runs as a container built in CI
(see §7), so Docker and Caddy are all that is installed.

```bash
# Docker + compose plugin (official repository)
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Caddy (reverse proxy + automatic TLS)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

```
root@heig-classroom:~# docker --version
Docker version 29.6.1, build 8900f1d
root@heig-classroom:~# caddy version
v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=
```

## 2. DNS: `classroom.chevallier.io` → the droplet's IP (A/AAAA), propagation checked
(`dig +short classroom.chevallier.io`).

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

```bash
cd /opt/heig-classroom
sudo -u hgc git clone <repository-url> app && cd app
mkdir -p secrets backups
# Drop in (never in git), then chmod 600:
#   secrets/hgc-prod.private-key.pem   (production GitHub App)
#   secrets/eduid-private-key.pem      (private_key_jwt edu-ID, already generated)
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD/COOKIE_SECRET: openssl rand -base64 32
```

An encrypted copy of the secrets in the vault (`age`) is a precondition of the 4 h RTO
(ADR-010).

## 5. Caddy (native): the vhost is versioned in [Caddyfile](Caddyfile)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
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

**Never build on the VM** (453 MiB / 1 CPU): a local build makes the host swap and strangles
Postgres — `Connection terminated` timeouts on login/ticker/pg-boss, experienced on
2026-07-10 — and fills the disk (~1 GB of builder cache per cycle).

### Security of the CI → VM access (forced command)

The CI key is pinned to `deploy.sh` in `authorized_keys`: with that key the runner can
**only** deploy, never open a shell (even if the secret leaks). The GHCR package stays
private: the runner passes its ephemeral token as the SSH "command" (→
`$SSH_ORIGINAL_COMMAND`), which `deploy.sh` uses for the `docker login` for the duration of
the pull — no registry credential is stored on the VM.

### Setup (once)

1. Generate a dedicated key pair:
   ```bash
   ssh-keygen -t ed25519 -f ci_deploy -N "" -C ci-deploy@heig-classroom
   ```
2. **Private** key → **Actions secret** (⚠ not a Deploy Key):
   ```bash
   gh secret set DEPLOY_SSH_KEY --repo heig-tin-info/heig-classroom < ci_deploy
   ```
3. **Public** key → the VM's `authorized_keys`, pinned to `deploy.sh`:
   ```bash
   # on the VM
   printf 'command="/opt/heig-classroom/deploy.sh",restrict %s\n' \
     "$(cat ci_deploy.pub)" >> /root/.ssh/authorized_keys
   ```
   (`deploy.sh` arrives through `git pull`; it is versioned and already executable.)

Without the secret, the `deploy` job skips cleanly (the image is published to GHCR anyway).

### Manual deployment (if CI is unavailable)

```bash
cd /opt/heig-classroom && git pull --ff-only
echo <PAT read:packages> | docker login ghcr.io -u heig-tin-info --password-stdin
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

### Rollback

The sha tags stay on GHCR:

```bash
IMAGE_TAG=<sha of the healthy commit> docker compose -f compose.prod.yml \
  --env-file .env.prod up -d
# additive migrations — when in doubt, restore the database (§8).
```

## 8. Backups (NFR-16: RPO 24 h, RTO 4 h)

- The compose `backup` service takes a daily `pg_dump -Fc` into `./backups/`
  (30-day retention). **Still to wire**: a copy off the droplet, e.g.
  `rclone copy backups remote:hgc-backups` in cron (DigitalOcean Spaces, SWITCH
  storage, etc.).
- Restore:

```bash
docker compose -f compose.prod.yml stop app
docker compose -f compose.prod.yml exec -T postgres \
  pg_restore -U hgc -d hgc --clean --if-exists < backups/hgc-<date>.dump
docker compose -f compose.prod.yml start app
```

- Droplet lost: new droplet → §1 → secrets from the vault → restore the dump → re-point the
  DNS. Timed restore test every semester.

## 9. SWITCH edu-ID switchover (as soon as the resource is approved) — in `.env.prod`:

```bash
OIDC_ISSUER=<edu-ID issuer>
OIDC_CLIENT_ID=<issued client id>
OIDC_PRIVATE_KEY_PATH=secrets/eduid-private-key.pem
OIDC_PRIVATE_KEY_KID=hgc-eduid-2026
```

`docker compose -f compose.prod.yml --env-file .env.prod up -d app`, test a real login, then
remove the `keycloak` service from the compose file and the `/kc/*` block from the Caddyfile.

## 10. Monitoring: an external 60 s probe on `/healthz` (Uptime-Kuma, or DigitalOcean
monitoring); logs through `docker compose logs -f app` (credentials masked).
