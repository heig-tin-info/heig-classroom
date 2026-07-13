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

### 4. Création du dépôt squashé — HTTP 500 au push — RÉGLÉ (2026-07-13) sauf nettoyage
- **Corrigé** : retry du push avec backoff (1 s/2 s/4 s) sur erreur transitoire
  (500/502/503, « hung up », early EOF), et réutilisation d'un dépôt cible déjà
  existant **et vide** (leftover d'un essai raté) au lieu du 409 — « try
  again » fonctionne désormais. Reste : supprimer à la main les `*-squashed`
  vides orphelins dans l'org de test (7-10 juillet).

### 5. Vérifier le secret `ANTHROPIC_API_KEY` avant le test E2E
- **Confirmé manquant** (E2E du 2026-07-12, run 29186485269 sur
  `quadratic-2-yves-chevallier`) : `ANTHROPIC_API_KEY` vide dans l'env du job
  `llm-review` → « Could not resolve authentication method », pas de
  `GRADING.yml`, pas de commit de review. À poser en secret d'organisation sur
  `heig-test-classroom` (org admin requis ; token `gh` local sans `admin:org`).
  Procédure documentée dans `docs/guide/grading.md` §« Configuring the Anthropic
  API key ».

### 6. ~~score/grading.yml : ne pas émettre de GRADE quand le job LLM échoue~~ — RÉGLÉ (0.7.2)
- Corrigé dans `score@0.7.2` (2026-07-12) : `GRADING.yml` absent → le job
  échoue avec une annotation d'erreur, sans GRADE. La release apporte aussi
  l'annotation `TESTS::passed/total` (compteurs réels affichés par la
  plateforme) et le bump des actions Node 24 (checkout@v7, setup-python@v6,
  upload-artifact@v7). Shims bumpés : canonique + source/squashed/étudiant de
  l'assignment actif. Les squashed/étudiants des assignments verrouillés
  restent à 0.7.1 (sans effet tant qu'ils ne sont pas réouverts).

### 7. score/grading.yml : push du commit de review fragile après hot-fix du shim
- **Contexte** (E2E 2026-07-12) : `Commit the review file` pousse
  `HEAD:master` (échoue toujours en stratégie « commit » : le commit-bot de
  deadline a fait avancer master — attendu) puis fallback
  `--force HEAD:refs/heads/grading`. Ce fallback est rejeté si le workflow du
  sha gelé diffère de celui de master (« refusing to allow a GitHub App to
  update workflow without `workflows` permission ») — cas rencontré juste
  après le hot-fix du shim. En régime normal les deux coïncident et ça passe.
- **Correctif visé (0.7.2)** : pousser la review via l'API contents (créer la
  ref `grading` sur un sha existant, puis PUT `GRADING.yml` seul) — plus de
  sensibilité au diff de workflows, et pas besoin d'élargir les permissions.

## Fonctionnalités reportées

### 5b. Exploiter la permission « Plan » de l'App (org Free vs Team)
- L'App `heig-classroom` (heig-tin-info, App ID 4284518) a la permission
  organisation **Plan: read**. Les secrets d'organisation n'atteignent pas les
  dépôts privés d'une org **Free** → le tier LLM échouerait silencieusement.
- **À faire** : au setup_url / à la résolution d'installation, lire
  `GET /orgs/{org}` (champ `plan.name`) ; si `free`, afficher sur la page
  classroom un avertissement avec le lien d'upgrade enseignant
  <https://education.github.com/globalcampus/teacher>.

### 5c. Gérer les webhooks `organization` (rename / suppression)
- L'App est abonnée à l'événement **Organization**. À câbler dans
  `webhooks.ts` : `renamed` → mettre à jour `organizations.login` (et les
  `full_name` des dépôts ?), `deleted` → marquer l'org et ses classrooms,
  avertir le teacher.

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

## Refactoring dette clean-code — ÉTAT (exécuté le 2026-07-13)

Le brief P1–P5 a été exécuté (série de commits `refactor(...)` du
2026-07-13, un commit par lot, suite verte à chaque étape). Bilan :

- **P1 (découpage)** — fait. Web : `App.tsx` 1564 → 135 lignes
  (`Header.tsx`, `TeacherHome.tsx`, `ClassroomView.tsx`, `StudentHome.tsx`,
  `Breadcrumb.tsx`) ; `AssignmentDetail.tsx` → `activity/` (graph.ts pur +
  ActivityPanel.tsx) + `GradeHistoryModal.tsx` ; `AssignmentsCard.tsx` →
  `AssignmentForm.tsx`. Serveur : `modules/assignments.ts` →
  `assignments/{index,lifecycle,detail,actions,shared}.ts` (mêmes URLs).
- **P2 (duplication)** — fait. Types de payload API dans
  `packages/contracts/src/api.ts` (SSOT, importés des deux côtés ; `GradeView`
  dé-dupliqué, `completedAt` sérialisé en ISO — JSON identique) ;
  `modules/guards.ts` (teacherGuard/adminGuard + loaders `owned*`) ;
  `github/git.ts` (`gitRunner({identity})` + `authUrl`) ;
  `apiErrorMessage()` dans `web/api.ts` ; `useSortableTable`/`SortHeader`
  partagés (4 tables).
- **P3 (cohérence)** — fait. Échelle `Z.*` documentée dans `ui.tsx` ;
  `Field` a une prop `fullWidth` explicite ; `EventType`/`Topic` typés dans
  `events.ts` et catalogue `AuditAction` fermé dans `audit.ts`. Décision
  i18n inscrite dans `i18n.tsx` : l'UI teacher reste EN, les surfaces
  étudiantes passent par `t()` (en+fr).
- **P4.1** — fait : colonne `users.email_opt_in` supprimée (migration 0017).
- **P5 (tests)** — partiel : `github/retry`, `mailer` (prefs, HMAC unsub,
  gate `queueEmail`) côté serveur ; première suite vitest web (fuzzy,
  router, `buildGraph`, `compactDuration`/`humanize`). 32 tests serveur,
  18 web.

### Reste à faire

1. **P5.1/P5.3 — tests dépendants de la DB** : `selectGradeRun` (GR-09),
   `isAfterDeadline` (GR-14.3), ingestion LLM `conclusion !== success`
   jamais authoritative, claim roster en conflit. Nécessite un harnais DB
   de test (p. ex. PGlite + drizzle, ou Postgres jetable en CI) — à
   instruire avant d'écrire ces tests.
2. **P4.2** : supprimer le fallback `GITHUB_OAUTH_CLIENT_ID/SECRET`
   (config.ts) **une fois** `GITHUB_APP_CLIENT_SECRET` non vide en prod.
3. **P4.3 (ops, hors code)** : dépôts `*-squashed` orphelins,
   `secret-probe`, secret `TEST_SECRET`, ancienne app `hgc-prod` + OAuth
   App, `/opt/heig-classroom/deploy.old`.
4. **P4.4** : croiser `deploy.md` §7 avec le gotcha du build on-VM (§1 Infra).
5. **P6 — Performance (mesurer d'abord)** :
   - `GET …/detail` fait un `fetchRepoLiveState` par repo étudiant à chaque
     affichage → cache court (30-60 s) ou rafraîchissement SSE asynchrone.
   - Bundle web ~730 kB minifié (warning vite) : le découpage P1 étant fait,
     code-split par page (dynamic import des vues teacher/student).
