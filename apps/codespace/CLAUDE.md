# heig-codespace

Portail d'environnements de développement supervisés (VS Code dans le navigateur, conteneurs durcis, mode examen SEB). Dossier de cadrage : [project.md](project.md). Analyse et arbitrages : [docs/analyse.md](docs/analyse.md). Découpage des tâches : [docs/jalon-0.md](docs/jalon-0.md). Frontière avec classroom : [docs/integration-classroom.md](docs/integration-classroom.md). En cas de contradiction, analyse.md prime sur project.md ; les sections 3 et 4 de project.md (exigences, non-objectifs) priment sur tout.

Projet frère : `~/heig-classroom` (même auteur, même pile, même IdP, même GitHub App). Reprendre ses conventions et ses ADR plutôt que d'en inventer.

## Pile

Node 22, TypeScript strict, Fastify 5, Zod, Drizzle sur SQLite, `openid-client`, `octokit`, vitest, pnpm. Pas d'injection de dépendances, pas de décorateurs, pas de framework front en v0 (HTML servi par Fastify). Code et identifiants en anglais, documentation et commits en français.

Moteur de conteneurs : Podman **rootful**, piloté par la CLI depuis le seul module `src/engine/`, toujours sous la forme `podman --remote --url unix:///run/podman/podman.sock ... --format json`. Sans `--remote`, le binaire bascule silencieusement en rootless local et tous les tests réseau mesurent autre chose. Jamais Docker, jamais Docker Desktop, jamais rootless.

## Invariants (ne jamais contourner, même "temporairement")

1. **Aucun secret dans le conteneur étudiant.** Pas de jeton, pas de clé, pas de credential helper. Le canal Git s'authentifie par l'adresse IP source sur le pont `codespace`. La liste **close** des variables posées au `podman run` est `CONTAINER_ENV_KEYS` (`src/sessions/manager.ts`) : trois `CODESPACE_*` pour l'extension de barre d'état, quatre `GIT_{AUTHOR,COMMITTER}_{NAME,EMAIL}` pour l'identité git de l'étudiant (`users.display_name`, `users.email`). Aucune n'est un secret ; un test unitaire et `images/c-dev/test.sh` § 9 affirment qu'il n'y en a pas d'autre. Y ajouter une clé se fait dans cette liste, avec son test.
2. **Réseau clos par construction.** Réseau Podman `codespace` créé par `infra/net/setup.sh` (`--internal --disable-dns --subnet 10.77.0.0/24 --gateway 10.77.0.254 --interface-name cs0` ; la passerelle explicite est ce qui rend l'hôte joignable), conteneurs lancés avec `--dns=none --add-host portal.internal:10.77.0.254`. Les deux règles nftables de `infra/nft/codespace.nft` (pas de trafic inter-conteneurs, seul le port Git joignable sur l'hôte) sont fixes et chargées au démarrage. Aucune règle par session. Le conteneur `codespace-anchor` (label `heig-codespace.role=anchor`) maintient le pont : ne jamais le supprimer ni le compter comme session.
3. **Durcissement dès le premier `podman run`** : les options exactes sont dans `images/c-dev/run-hardened.sh` (`--userns=auto --cap-drop=ALL --security-opt no-new-privileges --security-opt seccomp=infra/seccomp/codespace.json --read-only --pids-limit --memory --cpus`, tmpfs en `mode=1777`). Le module moteur les reprend telles quelles. Un test qui a besoin de relâcher une option doit le dire dans docs, pas dans un commentaire.
4. **OIDC réel même en dev** (Keycloak, découverte, PKCE, validation de jeton). Pas de variable d'environnement "utilisateur courant".
5. **Le proxy vers code-server ne lit jamais d'en-tête SEB.** Il ne connaît que le cookie de session lié à l'adresse client. La vérification SEB se fait une fois, sur la route où SEB arrive par une navigation de premier niveau : `/exam/<devoir>/start` pour un devoir autonome, `GET /launch` pour un devoir venu de classroom.
6. **Le dépôt de transit d'un devoir en mode examen est amorcé depuis le modèle de l'enseignant, jamais depuis le dépôt de l'étudiant.**
7. **`PushEvent` est écrit avant toute tentative de relais** vers la forge.
8. Le mode `simulated` de la vérification SEB est impossible en `NODE_ENV=production` et un test l'affirme.
9. **Un jeton de lancement ne sert qu'une fois.** Le `jti` est consommé par l'insertion d'une ligne dans `launch_tokens_used`, avant tout autre contrôle : la clé primaire est la garantie, pas une lecture suivie d'une écriture. Un jeton refusé pour une autre raison est brûlé ; classroom en émet un neuf au clic suivant.
10. **Le quota est par enseignant, tous devoirs confondus**, compté sur `sessions.teacherId` dans les états vivants. La reprise d'une session déjà vivante ne le consulte pas : elle n'ouvre pas de conteneur de plus.
11. **La `startURL` d'un `.seb` de devoir synchronisé est celle de classroom**, pas celle du portail : c'est classroom qui authentifie l'étudiant puis redirige vers `/launch`. Le filtre d'URL de SEB doit donc autoriser classroom, le portail et `SEB_EXTRA_ALLOWED_HOSTS` (le fournisseur d'identité).
12. **Un jeton de lancement n'attribue jamais de rôle.** `users.role` n'est écrit que par la connexion OIDC ; un compte né d'un lancement est étudiant.

## Ce qui n'est pas dans le périmètre

Voir project.md section 4. En plus, pour v0 : interface enseignant de création, pool préchauffé, gVisor, miroirs de documentation, quotas disque. Ne pas les commencer sans demande explicite.

## Commandes

```bash
pnpm install
podman compose -f infra/compose.dev.yml up -d      # Keycloak, Forgejo
sudo infra/net/setup.sh                             # réseau codespace + nft
podman build -t codespace/c-dev:4.137.0 images/c-dev            # puis images/c-dev/test.sh
pnpm dev                                            # portail sur :3100 (classroom occupe 3000)
pnpm build && pnpm typecheck && pnpm test
```

`CODESPACE_LAUNCH_SECRET` vide (le défaut) désactive l'intégration : `/launch` et `/api/assignments/*` répondent 404 et le portail reste utilisable en autonome, avec sa graine YAML et sa propre connexion OIDC. Voir [docs/integration-classroom.md](docs/integration-classroom.md).

Le portail parle au socket rootful `/run/podman/podman.sock` ; en dev, l'utilisateur est dans le groupe `podman` qui possède le socket et son répertoire (voir [docs/setup-poste.md](docs/setup-poste.md)). Ce composant est privilégié et doit être traité comme tel. Les règles nftables demandent sudo ; c'est le seul usage de sudo attendu.

## Conventions de travail

- Une tâche = un répertoire de `docs/jalon-0.md`, avec son script de test d'acceptation exécutable. La tâche n'est terminée que si le script est vert et lancé par l'agent, pas décrit.
- Toute option de code-server, Podman ou nftables dont l'existence n'a pas été vérifiée dans la version épinglée est marquée `TODO(verify)` avec la version.
- Les décisions non triviales vont dans `docs/adr/ADR-NNN-*.md`, même format que heig-classroom.
- Ne pas modifier `project.md`.
