# TODO / dette technique

Notes de suivi des points connus mais volontairement reportés. Chaque entrée
donne le contexte, la cause et une piste de correction pour pouvoir y revenir
sans re-diagnostiquer.

## Infra / déploiement

> Pipeline build CI → GHCR → deploy : **fait et validé end-to-end le
> 2026-07-13** (voir README §Deployment et `deploy.md` §7). Reste :

### 1. Copie off-VM des backups (rclone)
- Le service `backup` du compose fait un `pg_dump -Fc` quotidien dans
  `./backups/` sur la VM, mais la copie hors droplet n'est **pas câblée** :
  un disque perdu = backups perdus.
- **À faire** : `rclone copy backups remote:hgc-backups` en cron (DigitalOcean
  Spaces, stockage SWITCH…). Voir `compose.prod.yml` service `backup` et
  `deploy.md` §Sauvegardes.

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

## Refactoring — reste

> Le brief clean-code P1–P4 (2026-07-13) puis les lots A (harnais PGlite +
> tests DB : GR-09, GR-14.3, ingestion LLM, claim roster — 45 tests serveur)
> et B (code-split : bundle initial 838 → ~203 kB minifié, xlsx lazy au drop,
> une page = un chunk) ont été exécutés. Le fan-out `fetchRepoLiveState` de
> `GET …/detail` est instrumenté (log `detail: live repo states fetched`,
> repos + ms). Reste :

### Lot C — Cache du live-state GitHub (mesures d'abord — instrumentation posée)

- Lire les logs `detail: live repo states fetched` sur quelques classes
  réelles (30+ repos), puis décider : TTL court en mémoire (30-60 s) par
  `fullName` dans `github/metrics.ts`, ou rafraîchissement asynchrone poussé
  par SSE. Décider sur mesures, pas avant. (Attention : un TTL rend le bouton
  « Refresh » partiellement stale — à trancher.)

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
