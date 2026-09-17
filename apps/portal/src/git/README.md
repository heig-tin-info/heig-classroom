# Canal Git (P3)

Le dépôt de transit et le relais vers la forge, tels que décrits dans
[docs/analyse.md](../../../../docs/analyse.md) section 3.1 et dans
[docs/jalon-0.md](../../../../docs/jalon-0.md) section P3.

```
conteneur ──push──▶ portail 10.77.0.254:9418/git/<session>  (auth = IP source)
                       │  git http-backend  →  <VOLUMES_ROOT>/<e>/<d>/staging.git
                       │  PushEvent (ref, sha, horodatage, pending)
                       └─ relais ──push (jeton en variable d'env)──▶ forge
```

## Modules

| fichier           | rôle |
| ----------------- | ---- |
| `httpBackend.ts`  | plugin Fastify, contrôle d'IP, politique upload-pack, CGI vers `git http-backend` |
| `cgi.ts`          | lecture des en-têtes CGI (`Status:` compris) sans bufferiser le corps |
| `staging.ts`      | création et amorçage du dépôt nu de transit (modes TP, examen, vide) |
| `pushEvents.ts`   | `diffRefs`, `recordPush` (invariant 7), magasin Drizzle |
| `relay.ts`        | tâche de fond, reprise sur erreur, jeton hors argv et hors disque |
| `forge.ts`        | interface `Forge`, implémentations `forgejo` et `github` |
| `fixtures.ts`     | dépôts de test partagés (pas un `*.test.ts`, donc type-vérifié) |

Table `push_events` : [`src/db/schema.ts`](../db/schema.ts).

## Dépendances des tests d'intégration

`channel.integration.test.ts` a besoin de Podman **rootful** et de Forgejo.
Sans eux, ou sans `FORGE_TOKEN`, le fichier s'ignore avec un avertissement ;
les autres tests (dont le canal Git complet sur la boucle locale) tournent
sans rien.

### Podman en mode distant

Toute commande passe par le socket rootful. En zsh, une fonction, jamais une
variable :

```zsh
p() { /usr/bin/podman --remote --url unix:///run/podman/podman.sock "$@" }
p version
```

### Réseau `codespace`

Créé par `infra/net/setup.sh` (tâche P2). De façon idempotente, avec
exactement les options de l'invariant 2 :

```zsh
p network exists codespace || \
  p network create --internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254 codespace
```

Ne jamais le supprimer : d'autres sessions y sont peut-être attachées. P2 y
maintient un conteneur permanent `codespace-anchor`
(`label heig-codespace.role=anchor`) pour que le pont `cs0` et l'adresse
10.77.0.254 existent en permanence — ne pas le supprimer non plus.

`startGitServer` se lie donc à `CODESPACE_GATEWAY` (10.77.0.254 par défaut)
et ne retombe sur `0.0.0.0` que si cette adresse n'est pas présente
(`EADDRNOTAVAIL`, pont sans conteneur attaché). Le contrôle d'IP source est
appliqué dans les deux cas : une adresse d'écoute se défait par une variable
d'environnement (analyse.md 4.1).

### Forgejo

`podman-compose` appelle `podman` sans `--remote` ; on lui donne donc un
`podman` qui l'ajoute :

```zsh
mkdir -p /tmp/podman-remote
cat > /tmp/podman-remote/podman <<'EOF'
#!/bin/sh
exec /usr/bin/podman --remote --url unix:///run/podman/podman.sock "$@"
EOF
chmod +x /tmp/podman-remote/podman
PATH=/tmp/podman-remote:$PATH podman-compose -f infra/compose.dev.yml up -d forgejo
```

Le conteneur s'appelle `infra_forgejo_1` (nom de projet = répertoire
`infra`). Équivalent sans `podman-compose` :

```zsh
p volume create forgejo-data
p run -d --name infra_forgejo_1 -p 127.0.0.1:3300:3000 \
  -e USER_UID=1000 -e USER_GID=1000 \
  -e FORGEJO__server__ROOT_URL=http://localhost:3300/ \
  -e FORGEJO__server__HTTP_PORT=3000 \
  -e FORGEJO__security__INSTALL_LOCK=true \
  -e FORGEJO__database__DB_TYPE=sqlite3 \
  -v forgejo-data:/data codeberg.org/forgejo/forgejo:11
```

### Utilisateur et jeton de développement

`forgejo` refuse de tourner en root : le `exec` se fait en `-u 1000`.

```zsh
p exec -u 1000 infra_forgejo_1 forgejo admin user create \
  --username codespace --password '<mot de passe de dev>' \
  --email codespace@dev.local --admin --must-change-password=false

curl -s -X POST -u 'codespace:<mot de passe de dev>' -H 'Content-Type: application/json' \
  -d '{"name":"p3-dev","scopes":["write:repository","write:user"]}' \
  http://127.0.0.1:3300/api/v1/users/codespace/tokens
```

Le `sha1` renvoyé va dans le `.env` **local** (ignoré par git), jamais dans
un fichier suivi, jamais dans un rapport :

```
FORGE_URL=http://localhost:3300
FORGE_TOKEN=<sha1 renvoyé>
FORGE_USER=codespace
FORGE_CONTAINER=infra_forgejo_1
```

Le test lit ce `.env` lui-même (vitest ne le charge pas).

### Image du conteneur de test

`codespace/c-dev:4.137.0`, l'image étudiante de P1, depuis V1 : elle porte git
et c'est celle que les sessions lancent réellement. (`CODESPACE_IMAGE` permet
d'en désigner une autre.) Une image sans git ne conviendrait pas : le réseau
`codespace` est `--internal`, donc un `apk add git` à la volée y est
impossible.

## Lancer les tests

```bash
pnpm --filter @codespace/portal test
pnpm typecheck
```

`tsconfig.json` exclut les `*.test.ts` du typecheck ; pour les vérifier :

```bash
cd apps/portal && ./node_modules/.bin/tsc --noEmit \
  --target ES2022 --module NodeNext --moduleResolution NodeNext --strict \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes --esModuleInterop \
  --skipLibCheck --types node,vitest/globals src/git/*.test.ts
```

## Branchement fait en V1

- `db.ts` a disparu : la base est celle du portail
  ([`db/client.ts`](../db/client.ts)), avec les migrations drizzle-kit de
  `apps/portal/drizzle/`. `openGitDb` y survit sous le même nom, pour les
  tests de ce module.
- `SessionLookup` est branché sur la table `sessions`
  ([`sessions/manager.ts`](../sessions/manager.ts), champ `lookup`) : l'adresse
  du conteneur vient de la ligne de session.
- `stagingTargets` reçoit le dépôt cible du devoir (`targetRepo` ou la
  convention `targetRepoPattern`), via `manager.repoOfEvent`.
- `startGitServer` est lié à `CODESPACE_GATEWAY:9418` par `server.ts` ; les
  autres surfaces du portail écoutent sur `HOST:PORT`.
- L'espace de travail de la session reçoit un remote `origin` pointé sur
  `http://portal.internal:9418/git/<session>`
  ([`sessions/workspace.ts`](../sessions/workspace.ts)).

## Ce qui reste à faire après V1

- `createGithubForge` n'est pas éprouvé contre la vraie GitHub App
  (`TODO(verify)` dans `forge.ts`).
