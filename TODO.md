# TODO / dette technique

Notes de suivi des points connus mais volontairement reportés. Chaque entrée
donne le contexte, la cause et une piste de correction pour pouvoir y revenir
sans re-diagnostiquer.

## Infra / déploiement

### 1. Sortir le build d'image de la VM de prod
- **Problème** : le déploiement se fait par `docker compose ... up -d --build`
  directement sur la VM (453 MiB / 1 CPU). Le build fait swapper l'hôte
  (load 3-4) pendant toute sa durée et **étrangle l'app en fonctionnement** :
  toutes les requêtes Postgres échouent alors avec `Connection terminated due
  to connection timeout` (login, ticker, pg-boss). Se manifeste comme un bug de
  requête mais n'en est pas un — la SQL tourne très bien en direct via psql.
  Vécu le 2026-07-10 (erreur 500 au login pendant un déploiement).
- **Cause aggravante** : `NODE_OPTIONS=--max-old-space-size=1536` dans le
  `Dockerfile` (nécessaire pour éviter l'OOM du build) fait swapper d'autant
  plus.
- **Correctif visé** : builder l'image en CI (GitHub Actions) → push sur GHCR →
  `docker pull` + `up -d` sur la VM. Retirer `build:` de `compose.prod.yml` au
  profit de `image: ghcr.io/...`. Déploiement = simple pull (quelques secondes),
  zéro contention, zéro downtime.
- **Contournement en attendant** : ne pas redéployer (rebuild) pendant que
  quelqu'un utilise la plateforme.

### 2. Disque de la VM à ~93 %
- **Problème** : `/` à 7.9G/8.6G (651 MiB libres). Un disque plein arrête net
  **toutes les écritures Postgres** — plus grave que la pression RAM.
- **Cause** : les builds Docker successifs sur la VM accumulent des couches
  d'images et un cache builder.
- **Correctif** : `docker image prune -f` + `docker builder prune -f`
  (récupère probablement plusieurs centaines de Mo). Résolu structurellement
  par le point 1 (plus de build sur la VM).
- **Lié** : la copie off-VM des backups (rclone) n'est toujours pas câblée
  (voir `compose.prod.yml`, service `backup`, et `deploy.md` §Backups).

### 3. Réglage mémoire Postgres — FAIT, à surveiller
- `compose.prod.yml` : `shared_buffers` 128→32 MiB, `max_connections` 100→40,
  workers parallèles désactivés, etc. (commit du 2026-07-10). Correction plutôt
  que performance, adapté à la VM. À réévaluer si la charge augmente
  (plus d'étudiants / classes simultanées).

## Pipeline de correction

### 4. Création du dépôt squashé — HTTP 500 au push (bug préexistant)
- **Problème** : `createSquashedRepo` (`apps/server/src/github/squash.ts`) crée
  le dépôt cible via l'API puis pousse **immédiatement** dedans. GitHub renvoie
  `HTTP 500` / `the remote end hung up unexpectedly` car pousser dans un dépôt
  vide fraîchement créé heurte une **course avec le provisioning asynchrone**
  du backend git. Pas de retry → l'assignment ne se crée pas.
- **Symptômes** : message UI « Could not create the squashed repository — try
  again » ; « try again » ne marche pas (au 2e essai le dépôt existe → 409
  « already exists »). L'org `heig-test-classroom` est jonchée de dépôts
  `*-squashed` **vides** (taille 0) de tentatives ratées (7, 8, 10 juillet).
- **Correctif visé** :
  1. Retry du push avec backoff (3-4 essais, ~1s/2s/4s) sur erreur transitoire
     (500/502/503, « hung up »).
  2. Réutiliser un dépôt cible déjà existant et vide au lieu de renvoyer 409,
     pour que le retry soit idempotent.
  3. Nettoyer les `*-squashed` vides orphelins dans l'org de test.
  - Alternative : créer le dépôt avec `auto_init: true` (provisionné de façon
    synchrone) puis force-push par-dessus.
- **Vérifié OK** : les installations App `hgc-dev`/`hgc-prod` sur
  `heig-test-classroom` ont bien `contents: write` **et** `workflows: write`,
  donc le push du `grading.yml` passera une fois le 500 réglé.

### 5. Vérifier le secret `ANTHROPIC_API_KEY` avant le test E2E
- **Confirmé manquant** (E2E du 2026-07-12, run 29186485269 sur
  `quadratic-2-yves-chevallier`) : `ANTHROPIC_API_KEY` vide dans l'env du job
  `llm-review` → « Could not resolve authentication method », pas de
  `GRADING.yml`, pas de commit de review. À poser en secret d'organisation sur
  `heig-test-classroom` (org admin requis ; token `gh` local sans `admin:org`).
  Procédure documentée dans `docs/guide/grading.md` §« Configuring the Anthropic
  API key ».

### 6. score/grading.yml : ne pas émettre de GRADE quand le job LLM échoue
- **Problème** : dans le workflow réutilisable (`heig-tin-info/score`,
  `.github/workflows/grading.yml@0.7.0`), l'étape notice fait
  `MARK=$(score json GRADING.yml … || echo 1)` : quand l'étape LLM meurt
  (clé absente, panne API), `GRADING.yml` n'existe pas et le fallback publie
  quand même `::notice title=GRADE::1/6` — un échec d'infra devient une note
  étudiante. Côté plateforme c'est maintenant neutralisé (l'ingestion GR-16
  exige `conclusion == success` pour retenir la review), mais l'annotation
  mensongère reste visible sur GitHub.
- **Correctif visé** : si `GRADING.yml` absent → fail sans annotation GRADE ;
  release `0.7.1` + bump du shim de `labo-02-quadratic` (et des handouts).

## Fonctionnalités reportées

### 6. Milestones (jalons intermédiaires)
- Le dispatch LLM ne se déclenche qu'à la deadline (`grade-final`). Les jalons
  intermédiaires (`grade-milestone`) sont conçus mais pas implémentés.
- **Socle déjà en place** : la table `grade_dispatches` a une colonne
  `milestone_id` nullable et un index unique coalescé (repo, trigger,
  milestone) — prêt pour les jalons.
- **À faire** : table `assignment_milestones` (id, assignment_id, name, due_at
  résolu, offset_days nullable pour la saisie J+/J-, dispatched_at) ; job
  planifié qui émet `grade-milestone` ; filtre `score grade --milestone <name>`
  côté StudentScore + tag `milestone:` par critère dans `criteria.yml` (la
  plateforme reste ignorante du barème) ; section « Milestones » dans la vue
  assignment (affichage date + J-n côte à côte).

### 7. Flow de validation des notes (phases)
- Note indicative (CI) → note LLM (deadline) → **note validée par le prof**
  (ajouts/ajustements) → note finale. À dériver des colonnes existantes
  (`deadlineAt`, `frozenAt`, un futur `validatedAt` + `finalGrade`) plutôt que
  d'introduire une machine à états.
