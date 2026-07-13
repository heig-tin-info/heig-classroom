# Deployment on a DigitalOcean Droplet

## 1. Create an Ubuntu/Debian droplet

```bash
# Swap 2 Go (utile si < 2 Go de RAM)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# MàJ + outils de base
apt update && apt upgrade -y
apt install -y curl git ufw gnupg ca-certificates

# Utilisateur applicatif dédié
adduser --system --group --home /opt/heig-classroom hgc

# Pare-feu : SSH + HTTP + HTTPS uniquement
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

```bash
# Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
corepack enable    # active pnpm (version pinée par le repo : 10.34.4)

# Docker + plugin compose (dépôt officiel)
install -m0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update && apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Caddy (reverse proxy + TLS automatique)
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

```
root@heig-classroom:~# node -v
v22.23.1
root@heig-classroom:~# pnpm -v
do! Corepack is about to download https://registry.npmjs.org/pnpm/-/pnpm-11.10.0.tgz
? Do you want to continue? [Y/n

11.10.0
root@heig-classroom:~# docker --version
Docker version 29.6.1, build 8900f1d
root@heig-classroom:~# caddy version
v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=
```

## 2. DNS : `classroom.chevallier.io` → IP du droplet (A/AAAA), propagation vérifiée
(`dig +short classroom.chevallier.io`).

## 3. Applications GitHub de **production** (mêmes écrans qu'en dev, permissions
GH-02 dans `docs/02-specs-fonctionnelles.md`) :

- **GitHub App** `heig-classroom` (unique, possédée par `heig-tin-info`, sert
  aussi le lien de compte) : webhook
  `https://classroom.chevallier.io/webhooks/github`, callback
  `https://classroom.chevallier.io/app/auth/github/callback`, setup URL
  `https://classroom.chevallier.io/setup/github/installed`, installable sur
  **Any account** ; générer le PEM + un client secret. L'installation sur chaque
  org d'enseignement se fait ensuite depuis le portail (wizard de la classe).
  Voir `docs/deployment/github-app.md`.

## 4. Code et secrets

```bash
cd /opt/heig-classroom
sudo -u hgc git clone <url-du-depot> app && cd app
mkdir -p secrets backups
# Déposer (jamais dans git), puis chmod 600 :
#   secrets/hgc-prod.private-key.pem   (GitHub App de prod)
#   secrets/eduid-private-key.pem      (private_key_jwt edu-ID, déjà générée)
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod    # POSTGRES_PASSWORD/COOKIE_SECRET : openssl rand -base64 32
```

Copie chiffrée des secrets dans le coffre (`age`) — condition du RTO 4 h (ADR-010).

## 5. Caddy (natif) : le vhost est versionné dans [Caddyfile](Caddyfile)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## 6. Premier déploiement

```bash
docker compose -f compose.prod.yml --env-file .env.prod up -d --build
docker compose -f compose.prod.yml logs -f app   # migrations puis « hgc-server démarré »
curl -s https://classroom.chevallier.io/healthz  # {"status":"ok",...}
```

Ensuite : console Keycloak sur `https://classroom.chevallier.io/kc/` (compte admin
de `.env.prod`) → créer les comptes réels du realm ou changer les mots de passe de
test importés ; l'admin est `SUPER_ADMIN_EMAIL` ; les teachers se gèrent dans l'écran Admin.

## 7. Mise à jour / rollback

```bash
cd /opt/heig-classroom/app && git pull
docker compose -f compose.prod.yml --env-file .env.prod up -d --build
# rollback : git checkout <tag-précédent> puis même commande ;
# migrations additives — en cas de doute, restaurer la base (§8).
```

## 8. Sauvegardes (NFR-16 : RPO 24 h, RTO 4 h)

- Le service `backup` du compose fait un `pg_dump -Fc` quotidien dans `./backups/`
  (rétention 30 jours). **À câbler** : copie hors droplet, p. ex.
  `rclone copy backups remote:hgc-backups` en cron (DigitalOcean Spaces, stockage
  SWITCH…).
- Restauration :

```bash
docker compose -f compose.prod.yml stop app
docker compose -f compose.prod.yml exec -T postgres \
  pg_restore -U hgc -d hgc --clean --if-exists < backups/hgc-<date>.dump
docker compose -f compose.prod.yml start app
```

- Droplet perdu : nouveau droplet → §1 → secrets depuis le coffre → restaurer le
  dump → re-pointer le DNS. Test de restauration chronométré chaque semestre.

## 9. Bascule SWITCH edu-ID (dès validation de la ressource) — dans `.env.prod` :

```bash
OIDC_ISSUER=<issuer edu-ID>
OIDC_CLIENT_ID=<client id délivré>
OIDC_PRIVATE_KEY_PATH=secrets/eduid-private-key.pem
OIDC_PRIVATE_KEY_KID=hgc-eduid-2026
```

`docker compose -f compose.prod.yml --env-file .env.prod up -d app`, tester un
login réel, puis retirer le service `keycloak` du compose et le bloc `/kc/*` du
Caddyfile.

## 10. Supervision : sonde externe 60 s sur `/healthz` (Uptime-Kuma, ou le monitoring
DigitalOcean) ; logs via `docker compose logs -f app` (credentials masqués).
