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

> YCR Note: Backup is automatically done in digital ocean.

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

> 5b (avertissement plan Free), 5c (webhooks `organization` renamed/deleted)
> et le volet plateforme des milestones (6) : **faits le 2026-07-13**
> (colonne `organizations.plan` + bandeau classroom, `handleOrganization`
> dans webhooks.ts + e-mail `org.deleted`, table `assignment_milestones` +
> ticker/dispatch `grade-milestone` + section UI). Migration
> `0018_milestones-org-plan.sql`.

### 6b. Milestones — volet score (repo heig-tin-info/score)
- La plateforme émet `grade-milestone` avec `client_payload.milestone`
  (nom du jalon) ; reste côté score : tag `milestone:` par critère dans
  `criteria.yml` + filtre `score grade --milestone <name>` (StudentScore),
  et le shim `grading.yml` doit écouter `repository_dispatch:
  types: [grade-final, grade-milestone]`.
- Note ingestion : une review de milestone reste « trace-only » côté
  plateforme (le slot `llm_grade_run_id` n'est réclamé qu'après `frozen_at`).

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

