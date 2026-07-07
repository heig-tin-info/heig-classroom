# Phase 1 — Réanalyse des besoins

> Source : `IDEA.md` — HEIG GitHub Classroom, portail web deux rôles (student / teacher).
> Statut : draft d'analyse. Les points marqués ❓ sont des décisions à prendre ou à vérifier avant la phase 2.

## 1. Vision

Un clone de GitHub Classroom adapté aux besoins HEIG-VD : le teacher gère des classrooms
adossées à une organisation GitHub, publie des assignments à partir d'un dépôt source,
le système provisionne un dépôt privé par étudiant, collecte les métriques et notes via CI,
et applique une stratégie de deadline automatique.

## 2. Acteurs et cas d'utilisation

### Teacher

- Créer une classroom (nom + organisation GitHub + liste d'étudiants).
- Voir par classroom : nb d'assignments, dates début/échéance, tableau étudiants
  (nom, prénom, e-mail, compte GitHub, dernière connexion).
- Créer un assignment (nom, début, deadline, dépôt source, stratégie de source,
  branches, protected files, deadline strategy).
- Suivre l'état des dépôts étudiants (dernier commit, hash, statut CI, note indicative).
- Pousser des modifications sur le dépôt source et **synchroniser** les dépôts étudiants via PR.
- Utiliser une **API à clé** pour automatiser (clone en masse via CLI).

### Student

- Se connecter (Switch edu-ID, puis liaison GitHub).
- Voir ses assignments et le lien vers son dépôt de travail.
- Accepter un assignment → provisionnement de son dépôt.
- Voir le statut CI et la note indicative après chaque passe.

### Système (backend)

- Authentification et liaison compte GitHub ↔ identité HEIG.
- Provisionnement des dépôts (création, droits, protections).
- Collecte des métriques (webhooks GitHub de préférence au polling).
- Tâche de fond deadline (lock ou commit de deadline, gel des statuts).
- Extraction de la note depuis le CI `grading.yml`.

## 3. Modèle de domaine (esquisse)

```text
User (rôle: teacher|student, github_login, email, last_login)
Organization (github_org, installation_id GitHub App)
Classroom (nom, → Organization, → teacher)
Enrollment (Classroom ↔ User étudiant, statut de liaison GitHub)
Assignment (nom, start_at, deadline_at, source_repo, squashed_repo,
            source_strategy, branches[], protected_files[], deadline_strategy)
StudentRepo (Assignment ↔ User, repo_url, accepted_at, locked_at,
             last_commit_hash, last_commit_at, ci_status, grade)
GradeRun (StudentRepo, run_id CI, statut, note, timestamp)
ApiKey (→ teacher, hash, scopes)
```

Trois dépôts par assignment :

1. **Source** (privé) — le teacher y travaille.
2. **Source squashed** (privé) — créé à la création de l'assignment, base des dépôts
   étudiants et base des PR de synchro. Lien visible dans l'UI teacher.
3. **Dépôts étudiants** (privé, un par étudiant).

## 4. Points durs techniques et risques

| # | Sujet | Analyse | Risque |
| --- | --- | --- | --- |
| 1 | **GitHub App vs OAuth App** | Il faut une GitHub App installée sur l'organisation : permissions fines (repos, webhooks), tokens d'installation, quotas plus élevés. L'OAuth ne suffit pas pour « demander les droits d'accès à l'organisation ». | Faible — voie standard |
| 2 | **Protected files** | Décidé : modification autorisée, mais détection (webhook push) + **commit de revert** automatique restaurant les fichiers protégés. | Moyen — à prototyper |
| 3 | **Interdire le force push** | Faisable via branch protection / rulesets sur les dépôts étudiants (l'étudiant n'est pas admin). | Faible |
| 4 | **Lock à la deadline** | Options : archiver le dépôt (read-only, réversible), retirer le droit d'écriture, ou ruleset « lock branch ». L'archivage API est le plus simple. Le commit de deadline = commit vide poussé par le bot. | Moyen — précision du cron, timezone Europe/Zurich |
| 5 | **Extraction de la note** | Orientation : `grading.yml` émet une **annotation** GitHub Actions ; le backend écoute le webhook `workflow_run` et lit l'annotation via l'API check-runs. Sans `grading.yml` : simple pass/fail du dernier run. | Moyen — convention à spécifier |
| 6 | **Squash « into primary commits »** | ❓ Définition ambiguë : un seul commit initial ? Un commit par « jalon » ? À clarifier. Le squashed repo est régénéré comment quand le source avance ? | Moyen |
| 7 | **Synchro par PR** | Push teacher sur source → mise à jour du squashed → PR bot vers chaque dépôt étudiant. Conflits avec le travail étudiant possibles : la PR est la bonne réponse (l'étudiant résout). Nécessite une identité bot propre. | Moyen |
| 8 | **Auth Switch edu-ID + GitHub** | Décidé : login plateforme via Switch edu-ID (OIDC), puis liaison du compte GitHub via OAuth séparé. Le roster (liste importée par le teacher) doit être « réclamé » par l'étudiant à sa première connexion. | Moyen — impacte tout le flux d'onboarding |
| 9 | **Quotas API GitHub** | Collecte des métriques par webhooks (push, workflow_run) plutôt que polling ; polling seulement en rattrapage. | Faible si webhooks |
| 10 | **Sécurité API clé** | Clés hashées, scopées par teacher/classroom, révocables. | Faible |

## 5. Décisions et questions ouvertes

### Décisions actées (2026-07-03)

1. **Auth** ✅ : login plateforme via **Switch edu-ID** (OIDC), puis liaison du compte GitHub
   via une auth GitHub séparée (OAuth) pour matcher l'identité au compte GitHub.
2. **Protected files** ✅ : la modification par l'étudiant est **autorisée**, mais le système
   détecte le changement et pousse un **commit de revert** restaurant les fichiers protégés.
3. **Note** 🟡 : orientation — le `grading.yml` émet une **annotation** GitHub Actions que le
   backend capture (webhook `workflow_run` + API check-runs). Format exact à spécifier en phase 2.

### Restent ouvertes

1. **Squash** : définition précise de « primary commits ».
2. **Volumétrie** : ordre de grandeur (classes ~30-100 étudiants ? nb de classrooms simultanées ?) — influence peu la stack mais dimensionne les jobs.
3. **Travail en groupe** : assignments individuels seulement, ou aussi en équipe ?
4. **Extension de deadline** par étudiant (cas fréquents en réalité) ?
5. **« Dernière connexion »** : connexion au portail, ou dernier push ?

## 6. Plan de travail (workflow des phases)

| Phase | Livrable | Contenu |
| --- | --- | --- |
| **1. Réanalyse des besoins** | `docs/00-analyse-besoins.md` (ce document) | Acteurs, domaine, risques, questions ouvertes |
| **2. Cahier des charges & specs** | `docs/01-cahier-des-charges.md`, `docs/02-specs-fonctionnelles.md` | User stories + critères d'acceptation, réponses aux questions §5, spec de la convention grading, spec du flux GitHub App |
| **3. Architecture & stack** | `docs/03-architecture.md` + ADRs | Choix front/back/DB, GitHub App, webhooks, jobs, WebSocket/SSE pour le live CI, schéma DB, contrat API REST + clé API |
| **4. Implémentation** | code par jalons | M1 auth+classrooms → M2 assignments+provisionnement → M3 webhooks+métriques → M4 deadline jobs → M5 grading → M6 synchro PR → M7 API/CLI |
| **5. Tests** | CI du projet | Unitaires, intégration (GitHub API mockée + org sandbox), E2E |

**Spikes recommandés avant/pendant la phase 3** (dérisquage) :

- S1 : prototyper le **commit de revert** des protected files (webhook push → revert bot) sur une org de test.
- S2 : prototyper création de repo + invitation + branch protection via GitHub App.
- S3 : valider la chaîne `grading.yml` → annotation → webhook → extraction de note.

## 7. Proposition de stack (à valider en phase 3)

- **Backend** : TypeScript (Node), Fastify ou NestJS, **Octokit** (client GitHub officiel), PostgreSQL, BullMQ (jobs/cron) — écosystème GitHub le plus mature.
- **Frontend** : React + Vite (ou Next.js si SSR souhaité), tableau/dashboard, SSE ou WebSocket pour le statut CI live.
- **Infra** : conteneur unique + Postgres pour commencer ; webhooks GitHub exposés (tunnel en dev).
