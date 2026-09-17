# Intégration avec heig-classroom

Comment classroom (`apps/server`) et le portail (`apps/codespace`) se parlent,
et comment les faire tourner ensemble sur un poste. Le contrat des messages est
[`packages/contracts/src/codespace.ts`](../../../packages/contracts/src/codespace.ts) ;
la signature est celle de
[`packages/domain/src/hs256.ts`](../../../packages/domain/src/hs256.ts).

Règle d'import du `CLAUDE.md` racine, inchangée : les deux applications
n'importent que `packages/*`, jamais le code l'une de l'autre. Tout passe par
HTTP et par des jetons HS256 signés d'un secret partagé.

## 1. Les trois appels

```
classroom                                     portail (apps/codespace)
─────────                                     ────────────────────────
enregistrement d'un devoir « en ligne »
  PUT /api/assignments/<id> ─────────────────► upsert du devoir
      Authorization: Bearer <jeton de service>  (mode, image, quota, dépôt
      corps : CodespaceAssignmentSync           modèle, BEK, fenêtre)
  ◄──────────────────────────────────────────── 200 { id, configKey, sebLink }

clic Démarrer de l'étudiant (déjà connecté)
  302 vers /launch?token=<jeton de lancement> ► GET /launch
      claims : LaunchTokenClaims                 vérifie, consomme le jti,
                                                 quota, SEB si examen,
                                                 crée ou reprend la session
  ◄──────────────────────────────────────────── 303 vers /s/<session>/
                                                 + cookie cs_session

tableau de l'enseignant
  GET /api/assignments/<id>/sessions ─────────► CodespaceSessionSummary[]
      Authorization: Bearer <jeton de service>
```

Trois audiences, jamais interchangeables :

| Jeton | `iss` | `aud` | Durée | Usage unique |
| --- | --- | --- | --- | --- |
| service (serveur → serveur) | `heig-classroom` | `heig-codespace-api` | courte | non |
| lancement (l'étudiant le porte) | `heig-classroom` | `heig-codespace` | 5 min | **oui**, par `jti` |

Un jeton de lancement présenté à l'API de service reçoit 401 ; un jeton de
service présenté à `/launch` reçoit 403. Deux tests l'affirment.

### L'étudiant ne se connecte pas deux fois

C'est le point de toute l'intégration. `/launch` ne demande **pas** de session
OIDC du portail : le jeton *est* la preuve d'identité, émise par classroom qui
vient d'authentifier l'étudiant. Le portail inscrit l'utilisateur depuis les
revendications, ouvre la session et pose lui-même le cookie `cs_session` que le
proxy exige. La connexion OIDC du portail (invariant 4) reste en place pour
l'usage autonome et pour le tableau enseignant du portail.

## 2. Variables des deux côtés

Le secret est le même des deux côtés, et c'est la seule chose qui doit l'être.

| Variable | Côté | Valeur de développement |
| --- | --- | --- |
| `CODESPACE_LAUNCH_SECRET` | les deux | 32 caractères au moins, **identique** |
| `CLASSROOM_URL` | portail | `http://localhost:3000` |
| `PUBLIC_URL` | portail | `http://localhost:3100` |
| `PORT` | portail | `3100` |
| `CODESPACE_DEFAULT_IMAGE` | portail | `codespace/c-dev:4.137.0` |
| `SEB_EXTRA_ALLOWED_HOSTS` | portail | `localhost:8080` (le fournisseur d'identité) |
| l'URL du portail | classroom | `http://localhost:3100` |

**Secret absent** : le greffon n'est pas enregistré, `PUT /api/assignments/*`,
`GET /api/assignments/*/sessions` et `GET /launch` répondent 404, et le portail
reste utilisable en autonome (graine YAML, connexion OIDC, bouton Démarrer).
C'est le mode par défaut d'un déploiement qui n'a pas de classroom en face.

En production, `loadConfig()` refuse un `CODESPACE_LAUNCH_SECRET` contenant
`change-me`, comme pour les autres secrets.

## 3. Lancer les deux applications en local

```bash
# --- classroom, sur :3000 ---
docker compose -f docker-compose.dev.yml up -d      # Postgres + Keycloak de classroom
pnpm --filter @hgc/server dev

# --- portail, sur :3100 ---
podman compose -f apps/codespace/infra/compose.dev.yml up -d   # Keycloak + Forgejo du portail
sudo apps/codespace/infra/net/setup.sh                          # réseau codespace + nft
pnpm --filter @hgc/codespace seed
pnpm --filter @hgc/codespace dev
```

Les deux applications ont chacune leur Keycloak de développement, **tous deux
sur le port 8080** : ils ne peuvent pas tourner en même temps. Pour un
lancement conjoint, ne démarrer que celui de classroom (l'étudiant s'y
connecte, le portail reçoit un jeton et n'a pas besoin du sien) et, côté
portail, seulement Forgejo :

```bash
podman compose -f apps/codespace/infra/compose.dev.yml up -d forgejo
```

Le Keycloak du portail ne sert qu'à son usage autonome (`pnpm dev` sans
classroom, connexion OIDC directe). En production les deux applications
partagent Switch edu-ID.

Vérifier la chaîne complète sans navigateur :

```bash
cd apps/codespace && ./scripts/e2e.sh     # étape 9 : « lancement depuis classroom »
```

L'étape 9 fabrique elle-même ses deux jetons avec `signHs256` et le secret du
`.env`, pousse un devoir, appelle `/launch`, vérifie que l'éditeur s'ouvre, que
le push est relayé vers le dépôt **du jeton**, que le rejeu du jeton est refusé
et que le quota de l'enseignant s'oppose à un second étudiant.

## 4. Ce que le portail fait du devoir reçu

| Contrat | Portail |
| --- | --- |
| `mode: "online"` | `assignments.mode = "lab"` |
| `mode: "online_seb"` | `assignments.mode = "exam"` |
| `image: null` | `CODESPACE_DEFAULT_IMAGE` |
| `sourceRepo` | `assignments.sourceRepo`, et `templateRepo` = son URL de clonage |
| `teacher`, `quota` | `teacherId`, `teacherEmail`, `maxActiveSessions` |
| `startAt`, `deadlineAt` | `opensAt`, `closesAt` |
| `browserExamKeys` | `assignments.beks` (une liste, cf. analyse.md § 4.4) |

Le **dépôt cible n'est plus un attribut du devoir**. Il arrive par le jeton de
lancement, étudiant par étudiant, et vit dans `sessions.targetRepo` : c'est la
cible du relais et, en mode travaux pratiques, la source du miroir du dépôt de
transit. Les colonnes `targetRepo` / `targetRepoPattern` du devoir restent pour
la graine YAML autonome, où le portail n'a personne pour les lui donner.

Le `PUT` est idempotent : rejoué à l'identique il rend exactement la même
réponse. En particulier le **sel du Browser Exam Key n'est jamais régénéré** —
le changer invaliderait la Config Key des `.seb` déjà distribués.

## 5. Mode examen : qui authentifie, qui vérifie

La `startURL` inscrite dans le `.seb` est celle de **classroom** :

```
${CLASSROOM_URL}/app/codespace/start/<assignmentId>
```

SEB démarre donc sur classroom, qui authentifie l'étudiant (il a déjà sa
session, ou il se connecte), puis redirige vers `/launch?token=…` du portail.
Le filtre d'URL de SEB doit par conséquent laisser passer **trois** familles
d'hôtes :

1. celui de la `startURL` — classroom ; `buildSebConfig` l'ajoute seul ;
2. celui du portail — sans quoi l'éditeur ne se charge pas ;
3. ceux de `SEB_EXTRA_ALLOWED_HOSTS` — le fournisseur d'identité, sans quoi la
   page de connexion est bloquée (docs/pistes.md, « Correction au cadrage
   relevée par le test SEB »).

**Invariant 5, précisé.** La vérification SEB — les deux en-têtes, la Config
Key, les BEK — se fait sur `GET /launch`, une fois, parce que c'est là que SEB
arrive par une navigation de premier niveau. Le proxy `/s/<session>/*` ne lit
toujours aucun en-tête SEB : il ne connaît que le cookie `exam_session`, que
`/launch` pose après la vérification, lié à l'adresse du client. La route
`/exam/<id>/start` du portail autonome garde exactement le même rôle pour un
devoir venu de la graine YAML.

Le fichier `.seb` lui-même reste servi par le portail
(`GET /exam/<id>.seb`) ; `sebLink` de la réponse du `PUT` est le lien
`seb://` que l'enseignant distribue.

## 6. Quota par enseignant

`quota.maxActiveSessions` est un plafond **par enseignant, tous devoirs
confondus** (docs/pistes.md : « la fonctionnalité est activée par
l'administrateur, enseignant par enseignant, avec un quota de sessions actives
par enseignant »). Le comptage :

- `sessions.teacherId` est recopié du devoir à la création de la session —
  recopié et non joint, pour que le compte tienne en une requête et qu'un
  devoir réaffecté ne déplace pas les sessions déjà ouvertes ;
- sont comptées les sessions dans un état **vivant** (`starting`, `running`,
  `stopped`) : `stopped` en fait partie parce que le volume et l'identifiant
  survivent et qu'un rechargement y revient ;
- **la reprise ne consomme pas de quota.** Si l'étudiant a déjà une session
  vivante sur ce devoir, le plafond n'est pas consulté : il ne va pas ouvrir un
  conteneur de plus (analyse.md D5).

Un dépassement rend une page 429 « quota atteint, réessayez plus tard », et une
ligne de journal qui porte l'enseignant, le compte courant et le plafond.

## 7. Identités : deux chemins, deux lignes

`users.login` est l'identifiant institutionnel, et c'est lui qui nomme le
répertoire de volume (`<VOLUMES_ROOT>/<login>/<devoir>/`), d'où la contrainte
`SAFE_ID` de `git/staging.ts`.

| Origine | `users.oidcSub` | `users.login` | `role` |
| --- | --- | --- | --- |
| connexion OIDC du portail | `sub` du jeton d'identité Keycloak | `preferred_username` | recalculé depuis le realm |
| jeton de lancement classroom | `classroom:<sub du jeton>` | `<sub du jeton>` | `student`, jamais modifié |

Le préfixe `classroom:` est là pour que les deux espaces de noms de sujets ne
puissent pas se croiser. Conséquence assumée : **un même humain arrivant par
les deux chemins est deux lignes**, donc deux arborescences de volumes, tant
que le sujet de classroom ne vaut pas son `preferred_username`. C'est le prix
de ne pas rapprocher deux comptes par leur adresse de courriel, ce qui serait
une reprise de compte déguisée.

Un jeton de lancement ne peut pas attribuer le rôle enseignant : `role` n'est
écrit que par la connexion OIDC (docs/v1.md § D-V1-3). Le tableau
`/teacher/sessions` du portail reste donc derrière le realm ; le tableau de
l'enseignant *dans classroom* passe par `GET /api/assignments/<id>/sessions`,
authentifié par le jeton de service. Son champ `userId` porte l'identifiant de
classroom quand le compte vient de là, pour que l'appelant le rapproche de ses
propres utilisateurs.

## 8. Usage unique du jeton de lancement

Le `jti` est consommé par un `INSERT` dans `launch_tokens_used` : la clé
primaire *est* la garantie, et non une lecture suivie d'une écriture — deux
requêtes simultanées portant le même jeton ne peuvent pas passer toutes les
deux. La consommation a lieu **avant** toute autre vérification, juste après la
signature : un jeton refusé pour une autre raison (devoir inconnu, quota,
SEB) est donc brûlé, et l'étudiant recommence par le bouton Démarrer de
classroom, qui en émet un neuf. C'est le comportement voulu — un lien de
lancement n'est pas une page à recharger.

Les lignes expirées sont purgées à chaque passage : au-delà de `exp`,
`verifyHs256` refuse déjà le jeton et la ligne n'empêche plus rien.

Rien de ce qui est journalisé ne porte le jeton, sa signature ni un Browser
Exam Key. Le `jti` seul est écrit : il n'est pas un secret et il relie les
journaux des deux applications.

## 9. `TODO(verify)`

- **SEB, redirection inter-hôtes.** La `startURL` est sur classroom et SEB
  atteint `/launch` du portail après une redirection vers un autre hôte. Que
  SEB ajoute bien ses deux en-têtes à *cette* requête, et qu'il les hache sur
  l'URL du portail avec sa chaîne de requête, n'a été observé sur aucun binaire
  SEB — le mode `simulated` ne le prouve pas. À confronter lors de la preuve B
  ([preuve-b-manuelle.md](preuve-b-manuelle.md)). Repli s'il fallait : la
  `startURL` revient sur le portail et c'est classroom qui pose le jeton par un
  formulaire.

## 10. Ce qui reste à faire

- La route `/app/codespace/start/<id>` de classroom (celle que la `startURL`
  du `.seb` désigne) est écrite du côté de classroom ; le portail ne fait que
  la nommer.
- `GET /api/assignments/<id>/sessions` ne sait pas encore dire qu'une requête
  d'examen est venue d'une autre adresse (alerte d'analyse.md D5, § 6.8 de
  docs/v1.md) : le refus est en place et journalisé, le résumé ne le porte pas.
- Le relais vers GitHub passe par `createGithubForge`, toujours pas éprouvé
  contre la vraie App (`TODO(verify)` de `git/forge.ts`).
