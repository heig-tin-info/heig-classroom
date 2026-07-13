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

## Refactoring dette clean-code — brief pour agent

> Document autoportant : un agent peut exécuter cette section sans autre
> contexte. Objectif : réduire la dette structurelle SANS changer aucun
> comportement observable.

### Garde-fous (à respecter à chaque étape)

- **Zéro changement fonctionnel** : mêmes routes, mêmes payloads JSON, même
  rendu. Les refactorings sont des déplacements/factorisations, pas des
  réécritures.
- **Vérification** après chaque lot : `pnpm -r typecheck && pnpm -r test &&
  pnpm --filter @hgc/web build` — tout doit rester vert.
- **Un commit par lot**, message `refactor(scope): …`, jamais de lot mixte
  (déplacement + changement de logique dans le même commit).
- Ne pas toucher : `apps/server/drizzle/**` (migrations figées), les fichiers
  d'aide `apps/web/src/help/*.md`, la doc `docs/**`.
- Les invariants métier commentés dans le code (GR-xx, GH-xx, AU-xx, ADR-xxx)
  doivent suivre le code déplacé — ne jamais perdre ces commentaires.

### P1 — Découpage des fichiers monstres (structure seule)

État mesuré (2026-07-13) : `App.tsx` 1564 lignes, `AssignmentDetail.tsx` 1074,
`modules/assignments.ts` 996, `AssignmentsCard.tsx` 783.

1. **`apps/web/src/App.tsx` → éclater par page**, sans changer un pixel :
   `Header.tsx` (Header, UserMenu, ThemeToggle, Logo, GithubBanner),
   `TeacherHome.tsx` (TeacherHome, ClassroomsList, RosterPopover, vue archives),
   `ClassroomView.tsx` (ClassroomView, ClassroomSettings, InstallWizard),
   `StudentHome.tsx` (StudentHome, StudentClassroomCard, StudentAssignmentRow,
   RepoMetrics, Countdown), `Breadcrumb.tsx`. `App.tsx` ne garde que le
   routage, `useMe`, `VIEW_AS_KEY` et la composition.
2. **`apps/web/src/AssignmentDetail.tsx`** : sortir `activity/` (ActivityPanel,
   ActivityChart, TestsChart, CommitList + buildGraph/LANE_COLORS) et
   `GradeHistoryModal` ; garder la table et les lignes.
3. **`apps/web/src/AssignmentsCard.tsx`** : sortir `AssignmentForm.tsx`
   (form + TreeView/buildTree + CreatingOverlay + humanize/compactDuration).
4. **`apps/server/src/modules/assignments.ts`** : découper en sous-modules
   enregistrés par le plugin existant (mêmes URLs) : `assignments/detail.ts`
   (GET detail + grade history + activity), `assignments/lifecycle.ts`
   (create/patch/publish/archive/unarchive/delete + reopen),
   `assignments/actions.ts` (grade-now, sync, lock/unlock, repos).

### P2 — Duplication mesurée à factoriser

1. **`requireTeacher` dupliqué** dans `modules/classrooms.ts:60` et
   `modules/assignments.ts:66` (+ `requireAdmin` dans `admin.ts`) → un
   `modules/guards.ts` unique. Même occasion : les helpers `ownedClassroom` /
   `ownedClassroomWithOrg` / `ownedAssignment` / `ownedStudentRepo` suivent le
   même motif « charge si teacherId = moi sinon 404 » → factoriser.
2. **`git()` / `gitBare()` définis 3×** (`github/squash.ts`,
   `github/provision.ts`, `github/sync.ts`) → `github/git.ts` unique (attention:
   squash.ts passe `-c user.name/email`, pas les autres — paramètre).
3. **Types API dupliqués main/serveur** : `GradeView` existe en double
   (`server/grading.ts` et `web/AssignmentDetail.tsx`) ; `ClassroomSummary`,
   `RosterEntry`, `Assignment`, `StudentRepo`, `ActivityData`… sont maintenus à
   la main dans `web/api.ts` et chaque composant. `packages/contracts` n'exporte
   que 2 fichiers → y déplacer tous les types de payload API et les importer
   des deux côtés. C'est le lot au meilleur ratio risque/valeur : toute dérive
   de payload devient une erreur de compilation.
4. **Extraction du message d'erreur API** répétée 5× côté web
   (`(err.body as { message?: string })?.message ?? "…"`) → helper
   `apiErrorMessage(err, fallback)` dans `web/api.ts`.
5. **Trois tables triables artisanales** (ClassroomsList dans App.tsx,
   StudentClassroomCard `Th`, RosterTable sort) → un composant/hook
   `useSortableTable` + `<SortHeader>` partagé.

### P3 — Cohérence

1. **i18n incomplète** : StudentHome/SettingsPage passent par `t()`, mais
   AssignmentsCard (tout le modal), ClassroomView (« Roster », wizard),
   RosterTable, AssignmentDetail sont en anglais codé en dur. Décision à
   inscrire : l'UI teacher reste EN ou passe par i18n — puis appliquer
   uniformément (les étudiants, eux, ont déjà le FR).
2. **Échelle de z-index ad hoc** (`z-30/40/50/[60]/[75]/[80]/[90]` semés dans
   Modal/help/CreatingOverlay/tooltip) → constantes documentées (ex.
   `Z.modal < Z.overlay < Z.help < Z.tooltip`) dans `ui.tsx`.
3. **`Field` className hack** (`className.includes("w-full")` dans `ui.tsx`)
   → props explicites (`fullWidth?: boolean`) ou `labelClassName`.
4. **Constantes d'événements** : actions d'audit (`"assignment.publish"`, …)
   et topics SSE (`classroom:`, `user:`, `teacher:`) en chaînes libres partout
   → module de constantes typées côté serveur.

### P4 — Nettoyage (petits lots indépendants)

1. `users.email_opt_in` (schema.ts:46) : colonne jamais lue ni écrite,
   remplacée de fait par `email_prefs` → migration de suppression + retrait du
   schéma (et de docs/03 §users).
2. Vars legacy `GITHUB_OAUTH_CLIENT_ID/SECRET` (config.ts) : supprimer le
   fallback **une fois** le client secret de l'App `heig-classroom` posé dans
   `.env.prod` (vérifier avant : `GITHUB_APP_CLIENT_SECRET` non vide en prod).
3. Ops (manuel, hors code) : supprimer les dépôts `*-squashed` vides orphelins
   dans `heig-test-classroom`, le dépôt sonde `heig-test-classroom/secret-probe`,
   le secret d'org `TEST_SECRET`, l'ancienne app `hgc-prod` et l'ancienne OAuth
   App (après bascule du client secret), et `/opt/heig-classroom/deploy.old`.
4. `deploy.md` : le §7 « Mise à jour » ne mentionne pas le gotcha du build
   on-VM (voir §1 Infra) — croiser les deux.

### P5 — Tests (couverture ciblée, pas de dogme)

Existant : 6 fichiers de tests (domain roster/grade, server dispatch/deadline/
app/session). **Zéro test web.** Manques les plus rentables, dans l'ordre :

1. `server/grading.ts` : `selectGradeRun` (GR-09 : kind/afterDeadline/
   parseStatus), `isAfterDeadline` (GR-14.3 conservateur sans receipt),
   ingestion LLM `conclusion !== success` jamais authoritative (bug réel vécu).
2. `server/mailer.ts` : `resolvedPrefs`, gate des préférences dans
   `queueEmail`, `verifyUnsubSignature` (bon/mauvais HMAC).
3. `modules/roster.ts` : claim en conflit (UNIQUE classroom/user → conflictFlag).
4. `github/retry.ts` : transitoire vs permanent, épuisement des retries.
5. Web : au minimum les purs utilitaires (`fuzzyFilter`, `buildGraph` lanes/
   edges, `compactDuration`, `humanize`, `parsePath`/`routeToPath`) en vitest
   sans DOM — gros gain pour presque rien.

### P6 — Performance (à instruire avant de coder)

- `GET …/detail` fait un `fetchRepoLiveState` GitHub **par repo étudiant** à
  chaque affichage (N appels, latence et rate limit) — mesurer, puis cache
  court (30-60 s) par repo ou rafraîchissement asynchrone (SSE) plutôt que
  bloquant dans la requête.
- Bundle web : 730 kB minifié, warning vite ; code-split par page une fois le
  découpage P1 fait (dynamic import des vues teacher/student).

### Ordre suggéré

P2.3 (contracts) → P1.1/P1.2/P1.3 (découpage web) → P2.1/P2.2/P2.4/P2.5 →
P1.4 (découpage serveur) → P5 (tests, peut se faire en parallèle) → P3 → P4.
P6 séparément, mesures d'abord.
