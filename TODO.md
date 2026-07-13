# TODO / dette technique

Notes de suivi des points connus mais volontairement reportés. Chaque entrée
donne le contexte, la cause et une piste de correction pour pouvoir y revenir
sans re-diagnostiquer.

## Infra / déploiement

### 1. Sortir le build d'image de la VM de prod — TOUJOURS À FAIRE (vérifié 2026-07-13)
- **État vérifié le 2026-07-13** : `ci.yml` ne fait que les checks
  (build/typecheck/test), aucun build d'image ni push GHCR ; sur la VM,
  `compose.prod.yml` a toujours `build: .` → le déploiement builde sur place.
  Disque : monté à **95 %** ; `docker builder prune -f` + `image prune -f`
  passés ce jour → **83 %** (1.5 G libres). Le prune n'est qu'un palliatif :
  chaque rebuild on-VM régénère ~1 G de cache.
- **Problème** : le build sur la VM (453 MiB / 1 CPU) fait swapper l'hôte
  (load 3-4) et **étrangle l'app en fonctionnement** : toutes les requêtes
  Postgres échouent avec `Connection terminated due to connection timeout`
  (login, ticker, pg-boss). Vécu le 2026-07-10 (500 au login pendant un
  déploiement). Aggravé par `NODE_OPTIONS=--max-old-space-size=1536` du
  `Dockerfile`. Un disque plein arrêterait net toutes les écritures Postgres.
- **Correctif visé** : job `image` dans `ci.yml` (sur main) : build →
  push `ghcr.io/heig-tin-info/heig-classroom:latest` + sha ; job `deploy` :
  ssh sur la VM, `docker compose pull && up -d`. `compose.prod.yml` :
  remplacer `build: .` par `image: ghcr.io/...`. Déploiement = simple pull,
  zéro contention, zéro downtime. Mettre à jour `deploy.md` §7 dans la foulée
  (le gotcha du build on-VM y est absent).
- **Contournement en attendant** : ne pas redéployer (rebuild) pendant que
  quelqu'un utilise la plateforme.
- **Lié** : la copie off-VM des backups (rclone) n'est toujours pas câblée
  (voir `compose.prod.yml`, service `backup`, et `deploy.md` §Backups).

## Pipeline de correction

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

## Refactoring — plan de finalisation (brief pour agent)

> Le brief clean-code P1–P4 a été exécuté le 2026-07-13 (commits
> `refactor(...)`). Ce plan couvre le reliquat. Mêmes garde-fous : un commit
> par lot, `pnpm -r typecheck && pnpm -r test && pnpm --filter @hgc/web build`
> vert après chaque lot, invariants commentés (GR-xx…) conservés. Ordre
> suggéré : A → B → C ; D et E dès que leurs préconditions tombent.

### Lot A — Harnais DB de test + tests manquants (le plus rentable)

1. Ajouter `@electric-sql/pglite` en devDependency du serveur et un helper
   `src/test/db.ts` : PGlite en mémoire + `drizzle-orm/pglite` +
   `migrate()` sur `apps/server/drizzle/` → retourne un `db` compatible
   `app.db` (et un stub `app` minimal `{ db, log }`).
2. `grading.test.ts` (données insérées via drizzle, pas de GitHub) :
   - `selectGradeRun` (GR-09) : ignore les runs `kind='llm'`, ignore
     `afterDeadline=true`, ignore `parseStatus` malformed/multiple, prend le
     plus récent `completedAt` parmi ok|fallback.
   - `isAfterDeadline` (GR-14.3) : receipt avant/après deadline ; sans
     receipt → conservateur dès que la deadline est passée. (Fonction privée :
     l'exporter, ou la couvrir via `ingestCompletedRun`.)
   - Ingestion LLM : `conclusion !== "success"` ou parse != ok → la ligne
     gradeRuns existe mais `llmGradeRunId` inchangé (bug réel vécu) ;
     idempotence sur (workflowRunId, runAttempt) → second ingest = null.
3. `roster.test.ts` : claim avec UNIQUE(classroom_id, user_id) déjà pris →
   `conflictFlag` posé (AU-18).
4. Si PGlite s'avère incompatible (extensions, types), repli : Postgres
   jetable dans le CI (service container) + `TEST_DATABASE_URL`, tests
   marqués `describe.skipIf(!process.env.TEST_DATABASE_URL)`.

### Lot B — Code-split du bundle web (mesuré : 838 kB / 261 kB gzip, 1 chunk)

1. Le plus gros poste : `xlsx` (SheetJS) importé statiquement dans
   `RosterImport.tsx` → `const XLSX = await import("xlsx")` au moment du
   parse (drop de fichier). À lui seul devrait faire tomber le warning.
2. `React.lazy` + `<Suspense>` dans `App.tsx` pour les vues par rôle :
   `TeacherHome`/`ClassroomView`/`AssignmentDetail` (teacher) vs
   `StudentHome` (student) — un étudiant ne télécharge plus l'UI teacher,
   et réciproquement. `SettingsPage`/`AdminPanel` lazy aussi.
3. Vérifier `pnpm --filter @hgc/web build` avant/après et noter les tailles
   ici. Cible : chunk initial < ~300 kB minifié.

### Lot C — Cache du live-state GitHub (mesurer d'abord)

1. Instrumenter `GET …/detail` : logguer nb de repos et durée totale des
   `fetchRepoLiveState` (N appels GitHub par affichage → latence + rate
   limit sur une classe de 30+).
2. Puis TTL court en mémoire (30-60 s) par `fullName` dans
   `github/metrics.ts` (Map + timestamp, pas de dépendance), ou
   rafraîchissement asynchrone poussé par SSE si la mesure montre que le
   blocage vient de la requête. Décider sur mesures, pas avant.

### Lot D — Vars OAuth legacy (précondition NON remplie, vérifié 2026-07-13)

- `.env.prod` sur la VM utilise toujours `GITHUB_OAUTH_CLIENT_ID/SECRET` ;
  `GITHUB_APP_CLIENT_SECRET` n'y est pas posé.
- **Étape ops d'abord** : poser `GITHUB_APP_CLIENT_ID/SECRET` (client secret
  de l'App `heig-classroom`) dans `.env.prod`, redéployer, vérifier le login
  GitHub. **Ensuite seulement** : supprimer les deux vars legacy et le
  fallback `config.ts:111-113`, et les retirer de `.env.example`.

### Lot E — Ops (manuel, hors code)

- Supprimer les dépôts `*-squashed` vides orphelins dans
  `heig-test-classroom` (essais des 7-10 juillet), le dépôt sonde
  `heig-test-classroom/secret-probe`, le secret d'org `TEST_SECRET`,
  l'ancienne app `hgc-prod` et l'ancienne OAuth App (après le lot D), et
  `/opt/heig-classroom/deploy.old` sur la VM.
