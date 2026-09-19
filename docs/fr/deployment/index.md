# Déployer HEIG Classroom

Cette section s'adresse à l'**opérateur** — la personne qui héberge le portail.
Les enseignants et les étudiants ne touchent jamais à rien de ce qui est décrit
ici : une fois la plateforme déployée, la prise en main d'une organisation
enseignante se fait entièrement depuis le portail (voir la page
[GitHub App](github-app.md), *Prise en main d'une organisation*).

## À quoi ressemble un déploiement

Une seule petite VM fait tourner l'ensemble (ADR-009) : le monolithe Node
(API + SPA compilée), PostgreSQL et une tâche de sauvegarde quotidienne sous
Docker Compose, derrière un Caddy natif pour le TLS. L'état ne vit que dans
PostgreSQL (ADR-004) ; les secrets transitent par l'environnement et un
répertoire `secrets/`, jamais par git (ADR-010).

```
Caddy (TLS) ──► app (Fastify + SPA, :3000) ──► PostgreSQL
                     ▲                              ▲
        GitHub webhooks / OIDC login          pg_dump backups
```

## Étapes

1. **Provisionner la VM** — Ubuntu/Debian, 2 Go de swap si la RAM est juste,
   UFW avec SSH/80/443, Docker + le plugin compose, Caddy. La liste complète
   des commandes se trouve dans [`deploy.md`](https://github.com/heig-tin-info/heig-classroom/blob/main/deploy.md)
   à la racine du dépôt.
2. **DNS** — pointer le nom d'hôte du portail vers la VM (enregistrements A/AAAA).
3. **Cloner et configurer** — cloner le dépôt dans `/opt/heig-classroom`,
   copier `.env.prod.example` vers `.env.prod` et le remplir : mot de passe
   PostgreSQL, secret de cookie, fournisseur d'identité OIDC (SWITCH edu-ID en
   production), e-mail du super-administrateur, identifiants Scaleway TEM pour
   l'e-mail, TTL de session.
4. **Créer la GitHub App** — une seule fois, globalement. Suivez
   [la page GitHub App](github-app.md) ; l'App ID, la clé privée, le slug,
   le secret de webhook et le client OAuth atterrissent dans `.env.prod` et `secrets/`.
5. **Premier démarrage** — l'image n'est jamais construite sur la VM, elle est
   tirée depuis GHCR :
   `docker compose -f compose.prod.yml --env-file .env.prod pull app` puis
   `docker compose -f compose.prod.yml --env-file .env.prod up -d`.
   Les migrations s'exécutent au démarrage (`MIGRATE_ON_START=1`) ; vérifiez que
   `https://<host>/healthz` renvoie `database: up, jobs: up`.
6. **Sauvegardes** — le service compose `backup` effectue un `pg_dump` quotidien
   avec 30 jours de rétention ; mettez en place une copie hors de la VM (rclone
   vers un stockage objet) pour respecter le RPO.

## Mise à jour

Chaque push sur `main` construit l'image dans la CI et la déploie
automatiquement ; l'équivalent manuel sur la VM est :

```bash
cd /opt/heig-classroom && git pull --ff-only
docker compose -f compose.prod.yml --env-file .env.prod pull app
docker compose -f compose.prod.yml --env-file .env.prod up -d
```

Retour arrière = redéployer une image antérieure par son sha de commit, qui
reste sur GHCR (`deploy.md` §7) :

```bash
IMAGE_TAG=<commit-sha> docker compose -f compose.prod.yml --env-file .env.prod up -d
```

Les migrations sont additives ; en cas de doute, restaurez le dump de la nuit précédente.
