# TODO / dette technique

Notes de suivi des points connus mais volontairement reportés. Chaque entrée
donne le contexte, la cause et une piste de correction pour pouvoir y revenir
sans re-diagnostiquer.

## Infra / déploiement

> Pipeline build CI → GHCR → deploy : **fait et validé end-to-end le
> 2026-07-13** (voir README §Deployment et `deploy.md` §7). Reste :

### 1. Copie off-VM des backups — SOLDÉ (2026-07-15)
- Les backups droplet sont gérés automatiquement par DigitalOcean ; pas de
  copie rclone à câbler. Le `pg_dump -Fc` quotidien du service `backup`
  reste en place comme filet local.

## Pipeline de correction

### 7. score/grading.yml : push du commit de review fragile — CORRIGÉ (0.7.5, 2026-07-15)
- Le fallback `--force HEAD:refs/heads/grading` est remplacé par l'API :
  ref `grading` pointée sur le sha dispatché (git refs API), puis PUT du seul
  fichier de review (contents API) — les workflows n'entrent plus dans le
  diff, aucune permission élargie. score taggé 0.7.5 (release PyPI auto).
- **Reste** : bump des shims `@0.7.4 → @0.7.5` (canonique labo-02-quadratic,
  squashed + repo étudiant de heig-test-classroom2) — bloqué en mode auto,
  à faire à la main ou en autorisant la commande.

## Fonctionnalités reportées

> 5b (avertissement plan Free), 5c (webhooks `organization` renamed/deleted)
> et le volet plateforme des milestones (6) : **faits le 2026-07-13**
> (colonne `organizations.plan` + bandeau classroom, `handleOrganization`
> dans webhooks.ts + e-mail `org.deleted`, table `assignment_milestones` +
> ticker/dispatch `grade-milestone` + section UI). Migration
> `0018_milestones-org-plan.sql`.

### 6b. Milestones — volet score : FAIT (0.7.3/0.7.4, 2026-07-14)
- score 0.7.3 : tag `milestone:` par critère + `score grade --milestone` ;
  0.7.4 : la review finale écrit awarded_points + rationale EN PLACE dans
  criteria.yml (commit « grading: <mark>/6 ») ; les milestones gardent
  `GRADING-<name>.yml` (leur filtre élague le barème). Shims bumped @0.7.4 :
  canonique heig-tin-info/labo-02-quadratic + source heig-test-classroom2.
- Reste : taguer des critères `milestone:` dans les labos qui en veulent, et
  E2E d'un jalon via l'UI. Note ingestion : une review de milestone reste
  « trace-only » (le slot `llm_grade_run_id` n'est réclamé qu'après
  `frozen_at`).

### 7. Flow de validation des notes — FAIT (2026-07-15)
- Implémenté sans machine à états (migration `0021_grade-validation.sql`) :
  `student_repos.teacher_points/comment/graded_by/at` (override par étudiant,
  PATCH `…/repos/:rid/grade`, ouvert après le freeze) +
  `assignments.grades_validated_at/by` (POST `…/validate-grades`, re-stamp
  idempotent). Résolution finale : teacher ?? LLM ?? CI gelée. UI : crayon
  d'ajustement + bouton « Valider les notes » côté prof ; l'étudiant voit la
  note finale (badge « note finale ») une fois validée, l'ajustement reste
  privé avant. Export Excel (nom, prénom, email, note, source) dans la vue
  assignment. Reste éventuel : email `grades.validated` aux étudiants, export
  classroom-wide (étudiants × assignments).

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

### Lot D — Vars OAuth legacy (SOLDÉ le 2026-07-14, reste un clic owner)

- Fait : client secret de l'App `heig-classroom` généré (owner), callback
  `https://classroom.chevallier.io/app/auth/github/callback` posé,
  `GITHUB_APP_CLIENT_ID=Iv23liMUKbpSHj7l4jpc` + secret dans `.env.prod`
  (vars `GITHUB_OAUTH_*` retirées), fallback `config.ts` et champs legacy
  supprimés du schéma. Le linking GitHub passe par l'OAuth user-to-server de
  l'App elle-même.
- **Reste** : un unlink/relink de contrôle dans le portail (audit
  `github.link`), puis supprimer l'ancienne OAuth App `Ov23li…` sur GitHub
  (UI owner ; révoque aussi les vieux grants — les utilisateurs concernés
  relient simplement leur compte).

