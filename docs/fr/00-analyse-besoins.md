# Phase 1 — Ré-analyse des besoins

> Source : note produit initiale (absorbée dans ce document) — HEIG GitHub Classroom, portail web à deux rôles (étudiant / enseignant).
> Statut : brouillon d'analyse. Les points marqués ❓ sont des décisions à prendre ou à vérifier avant la phase 2.

## 1. Vision

Un clone de GitHub Classroom adapté aux besoins de la HEIG-VD : l'enseignant gère des classes
adossées à une organisation GitHub, publie des devoirs depuis un dépôt source,
le système provisionne un dépôt privé par étudiant, collecte les métriques et les notes via la CI,
et applique une stratégie de délai de rendu automatique.

## 2. Acteurs et cas d'usage

### Enseignant

- Créer une classe (nom + organisation GitHub + liste des étudiants).
- Voir par classe : nombre de devoirs, dates de début/échéance, tableau des étudiants
  (nom, prénom, e-mail, compte GitHub, dernière connexion).
- Créer un devoir (nom, début, délai de rendu, dépôt source, stratégie de source,
  branches, fichiers protégés, stratégie de délai de rendu).
- Suivre l'état des dépôts étudiants (dernier commit, hash, statut CI, note indicative).
- Pousser des modifications sur le dépôt source et **synchroniser** les dépôts étudiants via PR.
- Utiliser une **API par clé** pour l'automatisation (clonage en masse via CLI).

### Étudiant

- Se connecter (Switch edu-ID, puis liaison GitHub).
- Voir ses devoirs et le lien vers son dépôt de travail.
- Accepter un devoir → provisionnement de son dépôt.
- Voir le statut CI et la note indicative après chaque exécution.

### Système (backend)

- Authentification et liaison du compte GitHub ↔ identité HEIG.
- Provisionnement des dépôts (création, permissions, protections).
- Collecte des métriques (webhooks GitHub préférés à l'interrogation périodique).
- Tâche de fond de délai de rendu (verrouillage ou commit de délai de rendu, gel des statuts).
- Extraction de la note depuis la CI `grading.yml`.

## 3. Modèle du domaine (esquisse)

```text
User (role: teacher|student, github_login, email, last_login)
Organization (github_org, installation_id GitHub App)
Classroom (name, → Organization, → teacher)
Enrollment (Classroom ↔ student User, GitHub linking status)
Assignment (name, start_at, deadline_at, source_repo, squashed_repo,
            source_strategy, branches[], protected_files[], deadline_strategy)
StudentRepo (Assignment ↔ User, repo_url, accepted_at, locked_at,
             last_commit_hash, last_commit_at, ci_status, grade)
GradeRun (StudentRepo, CI run_id, status, grade, timestamp)
ApiKey (→ teacher, hash, scopes)
```

Trois dépôts par devoir :

1. **Source** (privé) — là où travaille l'enseignant.
2. **Source squashée** (privée) — créée à la création du devoir, base des dépôts
   étudiants et base des PR de synchronisation. Lien visible dans l'UI enseignant.
3. **Dépôts étudiants** (privés, un par étudiant).

## 4. Points durs techniques et risques

| # | Sujet | Analyse | Risque |
| --- | --- | --- | --- |
| 1 | **GitHub App vs OAuth App** | Une GitHub App installée sur l'organisation est indispensable : permissions fines (dépôts, webhooks), jetons d'installation, quotas plus élevés. OAuth ne suffit pas pour « demander des droits d'accès à l'organisation ». | Faible — voie standard |
| 2 | **Fichiers protégés** | Décidé : modification autorisée, mais détection (webhook push) + **commit de revert** automatique restaurant les fichiers protégés. | Moyen — à prototyper |
| 3 | **Interdire le force push** | Faisable via la protection de branche / les rulesets sur les dépôts étudiants (l'étudiant n'est pas admin). | Faible |
| 4 | **Verrouillage au délai de rendu** | Options : archiver le dépôt (lecture seule, réversible), retirer la permission d'écriture, ou un ruleset « lock branch ». L'archivage via l'API est le plus simple. Le commit de délai de rendu = un commit vide poussé par le bot. | Moyen — précision du cron, fuseau horaire Europe/Zurich |
| 5 | **Extraction de la note** | Direction : `grading.yml` émet une **annotation** GitHub Actions ; le backend écoute le webhook `workflow_run` et lit l'annotation via l'API check-runs. Sans `grading.yml` : simple pass/fail de la dernière exécution. | Moyen — convention à spécifier |
| 6 | **Squash « en commits primaires »** | ❓ Définition ambiguë : un unique commit initial ? Un commit par « jalon » ? À clarifier. Comment le dépôt squashé est-il régénéré quand la source avance ? | Moyen |
| 7 | **Synchronisation par PR** | Push de l'enseignant sur source → mise à jour du dépôt squashé → PR du bot vers chaque dépôt étudiant. Des conflits avec le travail de l'étudiant sont possibles : la PR est la bonne réponse (l'étudiant les résout). Nécessite une identité de bot propre. | Moyen |
| 8 | **Switch edu-ID + auth GitHub** | Décidé : connexion à la plateforme via Switch edu-ID (OIDC), puis liaison du compte GitHub via un OAuth séparé. La liste des étudiants (liste importée par l'enseignant) doit être « revendiquée » par l'étudiant à sa première connexion. | Moyen — impacte tout le flux de prise en main |
| 9 | **Quotas de l'API GitHub** | Collecte des métriques par webhooks (push, workflow_run) plutôt que par interrogation périodique ; interrogation périodique en rattrapage uniquement. | Faible si webhooks |
| 10 | **Sécurité des clés d'API** | Clés hachées, à portée limitée par enseignant/classe, révocables. | Faible |

## 5. Décisions et questions ouvertes

### Décisions prises (2026-07-03)

1. **Auth** ✅ : connexion à la plateforme via **Switch edu-ID** (OIDC), puis liaison du compte GitHub
   via une auth GitHub séparée (OAuth) pour faire correspondre l'identité au compte GitHub.
2. **Fichiers protégés** ✅ : la modification par l'étudiant est **autorisée**, mais le système
   détecte le changement et pousse un **commit de revert** restaurant les fichiers protégés.
3. **Note** 🟡 : direction — `grading.yml` émet une **annotation** GitHub Actions que le
   backend capture (webhook `workflow_run` + API check-runs). Format exact à spécifier en phase 2.

### Encore ouvert

1. **Squash** : définition précise des « commits primaires ».
2. **Volumétrie** : ordre de grandeur (classes de ~30-100 étudiants ? nombre de classes simultanées ?) — influe peu sur la stack mais dimensionne les tâches.
3. **Travail de groupe** : devoirs individuels uniquement, ou aussi en équipe ?
4. **Prolongation du délai de rendu** par étudiant (cas fréquents en pratique) ?
5. **« Dernière connexion »** : connexion au portail, ou dernier push ?

## 6. Plan de travail (workflow par phases)

| Phase | Livrable | Contenu |
| --- | --- | --- |
| **1. Ré-analyse des besoins** | `docs/00-analyse-besoins.md` (ce document) | Acteurs, domaine, risques, questions ouvertes |
| **2. Cahier des charges & specs** | `docs/01-cahier-des-charges.md`, `docs/02-specs-fonctionnelles.md` | User stories + critères d'acceptation, réponses aux questions du §5, spécification de la convention de notation, spécification du flux GitHub App |
| **3. Architecture & stack** | `docs/03-architecture.md` + décisions d'architecture | Choix front/back/BD, GitHub App, webhooks, tâches, WebSocket/SSE pour la CI en direct, schéma de BD, contrat de l'API REST + clé d'API |
| **4. Implémentation** | code par jalons | M1 auth+classes → M2 devoirs+provisionnement → M3 webhooks+métriques → M4 tâches de délai de rendu → M5 notation → M6 synchronisation par PR → M7 API/CLI |
| **5. Tests** | CI du projet | Unitaires, intégration (API GitHub mockée + organisation bac à sable), E2E |

**Études préliminaires recommandées avant/pendant la phase 3** (dérisquage) :

- S1 : prototyper le **commit de revert** pour les fichiers protégés (webhook push → bot de revert) sur une organisation de test.
- S2 : prototyper la création de dépôt + invitation + protection de branche via la GitHub App.
- S3 : valider la chaîne `grading.yml` → annotation → webhook → extraction de la note.

## 7. Stack proposée (à valider en phase 3)

- **Backend** : TypeScript (Node), Fastify ou NestJS, **Octokit** (client GitHub officiel), PostgreSQL, BullMQ (tâches/cron) — l'écosystème GitHub le plus mature.
- **Frontend** : React + Vite (ou Next.js si le SSR est souhaité), tableau/tableau de bord, SSE ou WebSocket pour le statut CI en direct.
- **Infra** : conteneur unique + Postgres pour commencer ; webhooks GitHub exposés (tunnel en dev).
