# Jalon 0 et portail v0 : découpage pour agents

Suite de [analyse.md](analyse.md). Chaque tâche a une entrée, une sortie, un critère d'acceptation exécutable. Les tâches P1 à P4 sont indépendantes et se lancent en parallèle ; V1 les assemble. Aucune interface graphique avant V1, et V1 n'a que des pages HTML servies par Fastify.

Prérequis manuels, faits le 2026-09-17 sur le poste de développement : Podman 5.7 rootful, netavark, plage `containers` dans `/etc/subuid`, socket accessible au groupe `podman`, connexion distante par défaut. Procédure dans [setup-poste.md](setup-poste.md).

Résultats déjà acquis sur ce poste, que les agents n'ont pas à redémontrer mais doivent conserver dans leurs tests : réseau `internal` + `--gateway` → hôte joignable sur la passerelle et aucune route sortante ; `--dns=none` → aucune résolution ; `--userns=auto` → plage d'UID hôte distincte par conteneur ; trafic inter-conteneurs **ouvert** tant que la règle nftables n'est pas posée.

## État au 2026-09-17

| Tâche | État | Preuve |
| --- | --- | --- |
| P1 image durcie | terminé | `images/c-dev/test.sh` : 33 assertions vertes, démarrage 1 s |
| P2 réseau clos | terminé | `sudo infra/net/test.sh` : 11 PASS, 0 FAIL, 0 BLOQUÉ (9 assertions + 2 régressions), règles nftables chargées |
| P3 canal Git | terminé | `vitest src/git` : 56 tests dont 5 d'intégration Podman + Forgejo |
| P4 vérification SEB | terminé | `vitest src/seb` : 91 tests, 4 vecteurs Config Key sourcés de Moodle |
| V1 portail v0 | terminé | `scripts/e2e.sh` : 57 assertions vertes contre Keycloak, Forgejo et de vrais conteneurs (reproduit deux fois) ; compte rendu dans [v1.md](v1.md) |

Suite complète : `pnpm typecheck` vert, `pnpm test` 237 tests verts (17 fichiers). Démarrer → workbench 0,93 s, → websocket 0,96 s, push → Forgejo 0,24 s. Conteneurs permanents sur le poste : `codespace-anchor` (pont `cs0`), `infra_forgejo_1` (forge de dev, jeton dans `.env`).

### Consignes pour V1 issues de P1 à P4

- `engine/` lance l'image `codespace/c-dev:4.137.0` avec exactement les options de `images/c-dev/run-hardened.sh` (les reprendre, pas les réécrire), plus `--network codespace --dns=none --add-host portal.internal:10.77.0.254` et le label `heig-codespace.session=<id>`. Le conteneur `codespace-anchor` (label `heig-codespace.role=anchor`) doit être ignoré par le ramasse-miettes et la réconciliation.
- Le service Git (`startGitServer` de `src/git`) se lie à `CODESPACE_GATEWAY` ; ses interfaces `SessionLookup` et `stagingTargets` se branchent sur la table `Session` et le devoir. `src/git/db.ts` disparaît au profit de `db/client.ts` + migrations drizzle-kit ; `db/schema.ts` contient déjà `push_events`.
- `sebRoutes` de `src/seb` s'enregistre avec un `AssignmentLookup` et un `onStart` ; le proxy appelle `checkExamRequest` (cookie seul, invariant 5). Variables à ajouter à `.env.example` : `SEB_PUBLIC_ORIGIN`, `EXAM_COOKIE_SECRET`.
- Les réglages machine de code-server ne sont pas immuables (README P1) : le dépôt fantôme côté hôte est le vrai filet E15, à implémenter en V1 comme prévu.
- `webfreak.debug` n'a pas de `launch.json` : le fournir dans le dépôt modèle du devoir de test.
- Remplacer `docker.io/alpine/git` par `codespace/c-dev` dans `channel.integration.test.ts`.

## Arborescence cible

```
heig-codespace/
├── CLAUDE.md                  invariants et conventions pour les agents
├── project.md                 dossier de cadrage (ne pas modifier)
├── docs/                      analyse, jalons, ADR
├──                Fastify + TypeScript, seul code applicatif
│   └── src/
│       ├── server.ts
│       ├── auth/              OIDC (openid-client), sélecteur d'utilisateur dev
│       ├── engine/            podman CLI wrapper, un seul module qui connaît Podman
│       ├── proxy/             /s/<session>/* → code-server, websockets
│       ├── git/               http-backend CGI, dépôt de transit, relais
│       ├── seb/               vérification BEK/CK, réelle et simulée, génération .seb
│       ├── sessions/          état, battement, ramasse-miettes, réconciliation
│       └── db/                Drizzle + SQLite
├── images/c-dev/              Containerfile de l'image étudiante
├── infra/
│   ├── nft/codespace.nft      règles fixes (ICC, input pont)
│   ├── seccomp/codespace.json profil par défaut + personality(0x40000)
│   └── compose.dev.yml        Keycloak + Forgejo + miroirs doc
└── seed/                      devoirs YAML, utilisateurs de test
```

## P1. Image étudiante durcie, gdb fonctionnel

**Sortie** : `images/c-dev/Containerfile`, `infra/seccomp/codespace.json`, script `images/c-dev/run-hardened.sh` qui lance l'image avec toutes les options de durcissement.

Contenu de l'image : Debian stable slim, `gcc gdb make git man-db manpages-dev clangd`, code-server (release .deb épinglée), utilisateur `student` uid 1000, extensions préinstallées depuis Open VSX dans `/opt/code-server/extensions` (`llvm-vs-code-extensions.vscode-clangd`, `webfreak.debug`), réglages machine dans `/etc/code-server/settings.json` (`files.autoSave: afterDelay`, `files.autoSaveDelay: 1000`, `extensions.autoUpdate: false`, `update.mode: none`, `telemetry.telemetryLevel: off`, `chat.disableAIFeatures: true` si la version le connaît).

Point d'entrée : copie des réglages machine dans le `user-data-dir` (tmpfs) puis `code-server --auth none --bind-addr 0.0.0.0:8080 --disable-file-downloads --disable-file-uploads --disable-workspace-trust --disable-update-check --disable-getting-started-override --extensions-dir /opt/code-server/extensions --user-data-dir /run/code-server /work` avec `EXTENSIONS_GALLERY='{"serviceUrl":"","itemUrl":"","resourceUrlTemplate":""}'`. Vérifier que chaque option existe dans la version épinglée ; en retirer aucune sans le noter dans docs.

Options de lancement : `--userns=auto --cap-drop=ALL --security-opt no-new-privileges --security-opt seccomp=infra/seccomp/codespace.json --read-only --tmpfs /tmp --tmpfs /run --tmpfs /home/student/.cache --pids-limit 256 --memory 1536m --cpus 1 --dns=none -v <vol>/work:/work:U`.

**Acceptation** (script `images/c-dev/test.sh`, exécuté dans le conteneur lancé par `run-hardened.sh`) :

- `gcc -g -O0 hello.c && gdb -batch -ex run -ex bt ./a.out` termine sans "Operation not permitted" et `gdb -batch -ex 'show disable-randomization'` répond `on`.
- Deux exécutions successives d'un programme qui affiche `&main` sous gdb donnent la même adresse.
- `code-server --install-extension /tmp/x.vsix` échoue (répertoire en lecture seule) et un `.vsix` factice écrit dans `/work` ne s'installe pas non plus.
- `touch /usr/bin/x` échoue, `cat /proc/self/status | grep CapEff` vaut `0000000000000000`.
- `id -u` dans le conteneur vaut 1000 ; `podman top <ctr> huser` montre un UID hôte hors de la plage 0–65535 ; deux conteneurs lancés côte à côte ont des UID hôtes différents.
- Un `:(){ :|:& };:` est tué par la limite de processus sans affecter l'hôte.
- `curl http://localhost:8080/healthz` répond depuis le conteneur.

## P2. Réseau clos : preuve C, volet réseau

**Sortie** : `infra/nft/codespace.nft`, script `infra/net/setup.sh` (crée le réseau `codespace` en `--internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254`, charge la table nft), script `infra/net/test.sh`. La passerelle explicite est obligatoire : sans elle le pont n'a pas d'adresse et l'hôte est injoignable. Les conteneurs reçoivent `--add-host portal.internal:10.77.0.254`.

**Acceptation** (`infra/net/test.sh`, lance deux conteneurs de l'image P1 sur le réseau `codespace` et un serveur HTTP de test sur l'hôte lié à 10.77.0.254:9418 et un autre sur 10.77.0.254:9999) :

- Depuis le conteneur A : `curl -m 3 http://10.77.0.254:9418/` réussit.
- `curl -m 3 http://10.77.0.254:9999/` échoue (règle input).
- `curl -m 3 http://1.1.1.1/`, `curl -m 3 https://github.com/` échouent en moins de trois secondes (pas de route).
- `getent hosts github.com` échoue ; `getent hosts portal.internal` réussit via `--add-host`.
- `curl -m 3 http://<ip de B>:8080/` échoue (règle ICC) alors que le même `curl` depuis l'hôte réussit.
- Le test est vert avec une table nft **vide** sauf pour les deux règles fixes, et rouge si on retire chacune des deux règles (le test doit vérifier les deux régressions).

Si la règle ICC en famille `bridge` se révèle inopérante sous netavark, solution de repli documentée : un réseau `internal` par session. Ne pas passer plus d'une demi-journée sur la règle avant de basculer.

## P3. Canal Git : preuve C, volet Git

**Sortie** : `src/git/` avec `httpBackend.ts` (CGI vers `git http-backend`), `staging.ts` (création et amorçage du dépôt de transit), `relay.ts` (push vers la forge avec en-tête d'autorisation), `pushEvents.ts` ; tests vitest.

Règles : le remote côté conteneur est `http://portal.internal:9418/git/<sessionId>`. L'authentification est l'IP source, comparée à celle enregistrée pour la session ; toute autre IP reçoit 403. `http.receivepack=true` sur le dépôt de transit ; `http.uploadpack` piloté par le devoir (vrai par défaut). Après chaque receive-pack réussi, `for-each-ref` puis insertion d'un `PushEvent` par ref modifiée **avant** de planifier le relais. Le relais utilise `git push` avec `-c http.extraHeader=Authorization: ...` ; le jeton ne va jamais sur disque ni dans une ligne de commande visible dans `ps` (le passer par variable d'environnement `GIT_CONFIG_PARAMETERS` ou fichier temporaire 0600 en mémoire).

En développement, la forge cible est Forgejo dans `compose.dev.yml` avec un jeton d'accès personnel ; l'interface `Forge` a deux implémentations (`forgejo`, `github` via `octokit` et jeton d'installation).

**Acceptation** :

- Test d'intégration : un conteneur P1 sur le réseau P2 fait `git clone http://portal.internal:9418/git/<s>` (amorcé depuis un dépôt modèle local), commit, push ; le `PushEvent` apparaît en base avec le bon sha ; le commit apparaît dans Forgejo moins de dix secondes plus tard.
- Le même push depuis l'hôte (IP hors session) reçoit 403.
- Forgejo arrêté : le push de l'étudiant réussit quand même, le `PushEvent` est en état `pending`, puis passe `relayed` quand Forgejo revient.
- `grep -r` du jeton dans `/proc/*/cmdline` et sur le disque hôte pendant un relais ne trouve rien.
- Devoir avec `uploadpack: false` : `git fetch` reçoit une erreur propre, `git push` fonctionne.

## P4. Vérification SEB : preuve B

**Sortie** : `src/seb/` avec `configKey.ts` (normalisation et hachage, porté de `quizaccess_seb`), `verify.ts` (interface `SebVerifier`, implémentations `real` et `simulated`), `sebFile.ts` (génération du `.seb` : `startURL`, `URLFilterRules`, `allowDownUploads: false`, `enablePrivateClipboard: true`, kiosque, `sendBrowserExamKey: true`), route `GET /exam/<assignment>.seb` et lien `sebs://`.

Sémantique de vérification : sur `GET /exam/<assignment>/start`, exiger `X-SafeExamBrowser-ConfigKeyHash == sha256(urlSansFragment + configKey)` et `X-SafeExamBrowser-RequestHash == sha256(urlSansFragment + bek)` pour **un** des BEK acceptés du devoir. Succès : cookie `exam_session` signé, lié à l'identifiant de devoir et à l'adresse client. Le proxy `/s/<session>/*` n'examine **jamais** d'en-tête SEB : il exige le cookie, vérifie l'adresse, et refuse sinon avec une page explicite "session hors SEB". Le mode `simulated` accepte un en-tête `X-Dev-SEB: ok` en développement seulement, et est **impossible à activer** si `NODE_ENV=production` (test qui l'affirme).

**Acceptation** (vitest, les deux implémentations) :

- Vecteurs de test de Config Key : au moins trois configurations dont la clé attendue a été obtenue par l'outil de configuration SEB ou par le jeu de tests de `quizaccess_seb`. Une modification d'un seul réglage change la clé.
- Requête sans en-tête, avec en-tête forgé, avec URL modifiée (fragment, query réordonnée), avec un BEK d'une autre version : toutes refusées avec 403 et journalisées.
- Cookie valide présenté depuis une autre adresse client : refusé.
- Le `.seb` généré se recharge en JSON et redonne la même Config Key (idempotence).
- Test manuel documenté dans `docs/preuve-b-manuelle.md` : ouvrir le lien `sebs://` depuis un vrai SEB, obtenir l'éditeur ; copier l'URL de session dans Edge, obtenir le refus.

## V1. Portail v0 : un étudiant fictif démarre, écrit, compile, pousse

Assemble P1 à P4. Sans interface enseignant, sans pool, sans mode examen actif (la vérification P4 est branchée mais le devoir de test est en mode travaux pratiques).

Composants :

- `auth/` : `openid-client` contre le Keycloak dev (realm repris de heig-classroom, client `codespace-portal`). Rôle déduit d'un attribut du realm. Sélecteur d'utilisateur en dev = simple lien de déconnexion, Keycloak fait le reste.
- `engine/` : enveloppe de `podman --remote --url unix:///run/podman/podman.sock ... --format json`. Jamais `podman` nu : sans `--remote` le binaire bascule silencieusement en rootless local.
- `sessions/` : table `Session` (étudiant, devoir, conteneur, ip, état, dernier battement, cookie). `POST /assignments/<a>/start` : crée ou reprend la session, `engine.run(...)`, attend `/healthz` du conteneur, redirige vers `/s/<session>/`. Battement : le proxy met à jour `lastSeen` sur chaque requête ; ramasse-miettes toutes les minutes ; grâce 10 min puis destruction du conteneur, volume conservé. Au démarrage du portail : `podman ps --filter label=codespace.session --format json` et réconciliation avec la base.
- `proxy/` : `@fastify/http-proxy` avec `websocket: true`, upstream `http://<ip conteneur>:8080`, préfixe `/s/<session>` retiré ; refus sans cookie de session valide.
- Dépôt fantôme : tâche toutes les trois minutes, `git --git-dir=<vol>/shadow.git --work-tree=<vol>/work add -A && commit`, exclusion de `.git`.
- Pages HTML : liste des devoirs ouverts avec bouton Démarrer ; tableau `/teacher/sessions` (état, dernier battement, dernier push, bouton Fermer).
- `seed/assignments.yaml` : un devoir TP (`uploadpack: true`, modèle local), un devoir examen (`mode: exam`, BEK de test, `uploadpack: true`, modèle uniquement).

**Acceptation** (script `scripts/e2e.sh` + tests Playwright ou curl) :

- Connexion Keycloak en `student`, clic Démarrer, éditeur chargé en moins de dix secondes (mesure imprimée par le script).
- Dans le terminal de code-server : écrire `hello.c`, `make`, `gdb`, `git push` ; le commit est dans Forgejo ; `PushEvent` en base.
- `podman kill` du conteneur pendant la session : rechargement de la page, le portail relance sur le même volume, le fichier est là.
- Fermer l'onglet, attendre la grâce : conteneur détruit, volume et `shadow.git` présents avec au moins un commit.
- Redémarrer le portail avec une session active : la session reste accessible sans recréer le conteneur.
- `pnpm build && pnpm typecheck && pnpm test` verts.

## Hors périmètre du jalon 0 et de v0

Mode examen de bout en bout en salle (jalon 3), interface enseignant de création de devoir (jalon 4), miroirs de documentation (jalon 3, ne demande que de servir des répertoires statiques), pool préchauffé (à ne construire qu'après mesure), gVisor, sauvegarde hors hôte, quotas disque.
