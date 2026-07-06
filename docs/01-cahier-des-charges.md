---
title: Cahier des charges
subtitle: HEIG GitHub Classroom — Phase 2
authors:
  - Yves Chevallier — HEIG-VD
date: 2026-07-03
press:
  template: article
  paper: a4
  language: french
---
> Projet : HEIG GitHub Classroom.
> Sources : `IDEA.md`, `00-analyse-besoins.md`.
> Spécifications détaillées : `02-specs-fonctionnelles.md`.
> Statut : consolidé (édition finale phase 2). Les décisions prises pour lever les
> ambiguïtés sont listées en [Hypothèses à valider](#sec:hypotheses).

# Objet du document

Ce document définit le besoin : contexte, objectifs, périmètre, acteurs, user stories
avec critères d'acceptation (US-xx), exigences non fonctionnelles (NFR-xx) et
contraintes (C-xx). Les règles d'implémentation détaillées (AU-xx, GH-xx, GR-xx,
API/CLI) sont dans les spécifications fonctionnelles (`02-specs-fonctionnelles.md`).

# Contexte et objectifs

## Contexte

GitHub Classroom couvre mal certains besoins de la HEIG-VD : authentification
institutionnelle (Switch edu-ID), stratégies de deadline configurables, protection de
fichiers d'énoncé, extraction de note depuis le CI et synchronisation des énoncés après
publication. Le projet « HEIG GitHub Classroom » est un portail web qui reproduit et
adapte ces fonctions, en s'appuyant exclusivement sur GitHub (organisations, dépôts,
Actions) comme infrastructure d'exécution.

## Objectifs

- **O1** — Permettre au teacher de gérer classrooms et assignments depuis un portail
  unique, adossé à une organisation GitHub.
- **O2** — Provisionner automatiquement un dépôt privé par étudiant à l'acceptation
  d'un assignment, avec les droits et protections adéquats.
- **O3** — Appliquer automatiquement les politiques pédagogiques : fichiers protégés
  (revert automatique), stratégie de deadline (lock ou commit de deadline).
- **O4** — Remonter en continu l'état des dépôts étudiants (dernier commit, statut CI,
  note indicative issue de `grading.yml`).
- **O5** — Offrir une API à clé et un CLI minimal permettant l'automatisation côté
  teacher (clone en masse des dépôts).

## Critères de succès

- Un assignment pour une classe de 100 étudiants est publié, accepté et provisionné
  sans intervention manuelle du teacher (sous réserve des vérifications GitHub de la
  contrainte C-07).
- La note indicative apparaît dans le portail en moins de 2 minutes après la fin d'un
  run CI.
- À la deadline (heure Europe/Zurich), le job de verrouillage démarre au plus 60 s
  après l'échéance et l'application complète sur 100 dépôts se termine en moins de
  5 minutes (budget global unique, repris par US-22 et NFR-13).

# Périmètre

## Inclus

- Portail web deux rôles (teacher, student) avec authentification Switch edu-ID (OIDC)
  et liaison de compte GitHub (OAuth séparé).
- Gestion des classrooms : création, association à une organisation GitHub
  (installation GitHub App), import du roster, claim automatique des lignes par les
  étudiants à la connexion.
- Gestion des assignments : cycle de vie complet (brouillon, publication, acceptation,
  deadline), stratégie de source (dépôt complet ou squashé), branches sélectionnées,
  fichiers protégés, stratégie de deadline, modification encadrée après publication.
- Provisionnement des dépôts étudiants privés dans l'organisation, avec interdiction
  du force push.
- Détection et revert automatique des modifications de fichiers protégés (identité
  bot), avec plafond anti-boucle.
- Collecte des métriques par webhooks GitHub (push, `workflow_run`) ; extraction de la
  note via annotation de check-run ; fallback pass/fail.
- Jobs de deadline : lock du dépôt ou commit de deadline, gel de la note retenue.
- Synchronisation de l'énoncé : push teacher sur le dépôt source → mise à jour du
  dépôt squashé → PR bot vers chaque dépôt étudiant.
- API REST à clé pour le teacher (lecture des classrooms, assignments, dépôts, notes)
  et CLI minimal de clone en masse.
- Notifications in-app (e-mail optionnel).

## Exclu

- Assignments de groupe (dépôt partagé par plusieurs étudiants) — reporté à une
  version ultérieure.
- Extensions de deadline individuelles par étudiant — exclues de la v1. Le mécanisme
  de lock retenu (ruleset, réversible par dépôt) est choisi pour rendre cette
  évolution possible sans refonte, mais aucun flux n'est spécifié ni livré en v1.
- Notation officielle et export vers le SI académique (GAPS ou équivalent) : la note
  collectée est **indicative** et non contractuelle.
- Hébergement ou exécution du CI : les runs s'exécutent sur GitHub Actions, jamais sur
  la plateforme.
- Anti-plagiat, détection de similarité entre dépôts.
- Application mobile ; le portail est une application web responsive.
- Interface d'administration : l'attribution du rôle teacher se fait par configuration
  (liste d'e-mails/`sub` edu-ID), sans rôle admin applicatif en v1.

# Acteurs et rôles

| Acteur | Description | Authentification |
| --- | --- | --- |
| **Teacher** | Enseignant HEIG-VD. Crée et administre classrooms, assignments, roster ; consulte l'état et les notes ; gère ses clés d'API. | Switch edu-ID + compte GitHub lié (admin de l'organisation cible) |
| **Student** | Étudiant inscrit au roster d'une classroom. Rattaché automatiquement à sa ligne de roster, accepte des assignments, travaille dans son dépôt. | Switch edu-ID + compte GitHub lié |
| **Système (bot)** | Identité machine de la plateforme (GitHub App + identité bot de commit). Provisionne les dépôts, pousse les reverts et commits de deadline, ouvre les PR de synchro. | Tokens d'installation GitHub App |
| **Client API** | CLI fourni ou script du teacher consommant l'API REST. | Clé d'API (scopée, révocable) |

Il n'existe que deux rôles applicatifs : `teacher` et `student` (AU-23). Un
utilisateur possède exactement un rôle par classroom ; un teacher peut être student
d'une autre classroom. Le rôle teacher est attribué via une liste d'identités
autorisées en configuration serveur, gérée par l'exploitant de la plateforme (pas de
rôle admin applicatif en v1, cf. hypothèse H2).

# User stories

Convention : critères d'acceptation au format Étant donné / Quand / Alors. Les statuts
de roster utilisent les valeurs techniques `pending` / `claimed`, affichées en
français « non réclamée » / « réclamée ».

## Teacher

### US-01 — Créer une classroom

En tant que teacher, je crée une classroom liée à une organisation GitHub afin d'y
regrouper mes assignments.

- **Étant donné** un teacher connecté avec compte GitHub lié, **quand** il crée une
  classroom (nom + organisation), **alors** le système demande l'installation de la
  GitHub App sur l'organisation si elle n'y est pas déjà installée.
- **Étant donné** une organisation sans installation valide, **quand** l'installation
  échoue ou est refusée, **alors** la classroom n'est pas activée et le teacher voit
  la cause de l'erreur.
- **Étant donné** une installation valide, **quand** la classroom est créée, **alors**
  elle apparaît dans la liste du teacher avec 0 assignment et 0 étudiant.

### US-02 — Importer le roster

En tant que teacher, j'importe la liste des étudiants (nom, prénom, e-mail) afin de
contrôler qui peut rejoindre la classroom.

- **Étant donné** une classroom existante, **quand** le teacher importe un fichier CSV
  (nom, prénom, e-mail), **alors** l'import est **atomique** (tout ou rien) : s'il est
  valide, chaque ligne devient une entrée de roster au statut `pending` ; sinon aucun
  changement n'est appliqué et un rapport d'erreurs indique les lignes fautives.
- **Étant donné** un fichier contenant des e-mails en doublon **intra-fichier**,
  **quand** l'import est soumis, **alors** il est rejeté avec le numéro des lignes en
  doublon (AU-14).
- **Étant donné** un fichier contenant des e-mails **déjà présents** dans le roster,
  **quand** l'import est validé, **alors** les entrées existantes (y compris
  `claimed`) sont conservées et leurs nom/prénom mis à jour (upsert, AU-16) ; les
  entrées absentes du fichier ne sont pas supprimées.
- **Étant donné** un roster importé, **quand** le teacher consulte la classroom,
  **alors** il voit chaque ligne avec son statut (`pending` / `claimed`) et, si
  réclamée, le login GitHub associé (vide tant que l'étudiant n'a pas lié GitHub).

### US-03 — Consulter le tableau de bord d'une classroom

En tant que teacher, je consulte l'état de ma classroom afin de suivre l'activité des
étudiants.

- **Étant donné** une classroom avec assignments et étudiants, **quand** le teacher
  ouvre sa vue, **alors** il voit le nombre d'assignments, leurs dates de début et
  d'échéance, et le tableau des étudiants (nom, prénom, e-mail, compte GitHub,
  dernière connexion au portail).
- **Étant donné** une ligne de roster non réclamée, **quand** le tableau s'affiche,
  **alors** les colonnes compte GitHub et dernière connexion sont vides et le statut
  `pending` est visible.

### US-04 — Créer un assignment

En tant que teacher, je crée un assignment à partir d'un dépôt source afin de le
distribuer aux étudiants.

- **Étant donné** une classroom active, **quand** le teacher crée un assignment,
  **alors** il renseigne : nom, date de début, deadline, dépôt source (obligatoirement
  dans l'organisation), stratégie de source (`whole repository` | `squash`), branches
  à distribuer (défaut : `main` ou `master` selon existence), fichiers protégés,
  stratégie de deadline (`lock` | `deadline commit`). L'assignment est créé à l'état
  `brouillon` (US-08).
- **Étant donné** un dépôt source contenant `criteria.yml`, `README.md` ou
  `.github/workflows/grading.yml`, **quand** le formulaire s'ouvre, **alors** ces
  fichiers sont pré-cochés comme protégés (modifiables par le teacher). Décocher
  `grading.yml` affiche un avertissement : sans protection, l'étudiant peut altérer ou
  supprimer le workflow de notation.
- **Étant donné** un dépôt source hors de l'organisation, **quand** le teacher valide,
  **alors** la création est refusée avec un message explicite.
- **Étant donné** un assignment validé, **quand** la création aboutit, **alors** le
  système crée le dépôt **source squashé** privé dans l'organisation et affiche son
  lien dans l'UI teacher.

### US-05 — Suivre l'état des dépôts d'un assignment

En tant que teacher, je consulte l'état de chaque dépôt étudiant afin de suivre la
progression et les notes.

- **Étant donné** un assignment accepté par des étudiants, **quand** le teacher ouvre
  la vue de l'assignment, **alors** il voit par étudiant : lien du dépôt, date et hash
  du dernier commit, statut CI (`none` / `pending` / `pass` / `fail`, règle
  d'agrégation GR-06), note indicative si `grading.yml` est présent.
- **Étant donné** un dépôt sans aucun push étudiant, **quand** la vue s'affiche,
  **alors** l'étudiant apparaît avec l'état `accepté, aucun travail` ; s'il n'a pas
  accepté, `non accepté`.

### US-06 — Synchroniser l'énoncé après publication

En tant que teacher, je propage une correction de l'énoncé vers les dépôts étudiants
afin de corriger un assignment déjà distribué.

- **Étant donné** un push du teacher sur le dépôt source, **quand** le teacher
  déclenche la synchronisation depuis l'UI, **alors** le système met à jour le dépôt
  squashé puis ouvre une PR (identité bot) vers chaque dépôt étudiant existant.
- **Étant donné** une PR de synchro en conflit avec le travail d'un étudiant,
  **quand** la PR est créée, **alors** elle reste ouverte avec le conflit à résoudre
  par l'étudiant ; le système ne force jamais le merge.
- **Étant donné** une synchronisation lancée, **quand** elle se termine, **alors** le
  teacher voit un récapitulatif (PR créées, déjà à jour, échecs).

### US-07 — Gérer ses clés d'API

En tant que teacher, je génère et révoque des clés d'API afin d'automatiser la
récupération des dépôts via le CLI.

- **Étant donné** un teacher connecté, **quand** il génère une clé, **alors** le
  secret n'est affiché qu'une seule fois et seul un hash est stocké.
- **Étant donné** une clé révoquée, **quand** un appel API l'utilise, **alors** la
  requête est rejetée avec `401`.
- **Étant donné** une clé valide, **quand** le CLI appelle l'API, **alors** il peut
  lister classrooms, assignments, dépôts étudiants (URL de clone), statuts et notes —
  en lecture seule et limité aux classrooms du teacher propriétaire.

### US-08 — Publier et modifier un assignment

En tant que teacher, je publie mon assignment puis je le corrige si nécessaire afin de
maîtriser ce que voient les étudiants.

Cycle de vie : `brouillon` → `publié` → `verrouillé`.

- **Étant donné** un assignment à l'état `brouillon`, **quand** le teacher le
  consulte, **alors** il est invisible des étudiants et tous ses champs sont
  modifiables librement.
- **Étant donné** un assignment en brouillon, **quand** le teacher le publie,
  **alors** l'assignment devient visible des étudiants de la classroom (acceptable dès
  la date de début) et le job de deadline est planifié.
- **Étant donné** un assignment `publié`, **quand** le teacher le modifie, **alors**
  seuls sont modifiables : le nom, la deadline (tant qu'elle n'est pas passée ; la
  nouvelle valeur ne peut pas être dans le passé), la stratégie de deadline (tant que
  l'échéance n'est pas passée) et la liste des fichiers protégés. Le dépôt source, la
  stratégie de source et les branches ne sont plus modifiables dès la première
  acceptation.
- **Étant donné** une deadline modifiée, **quand** la modification est enregistrée,
  **alors** le job de deadline est replanifié (GH-43) et les étudiants voient la
  nouvelle échéance.
- **Étant donné** une liste de fichiers protégés modifiée, **quand** elle est
  enregistrée, **alors** la nouvelle liste s'applique aux pushes suivants (la version
  de référence reste celle du dernier commit bot, GH-30) ; aucun revert rétroactif
  n'est déclenché.
- **Étant donné** un assignment publié avec des dépôts étudiants, **quand** le teacher
  le supprime, **alors** une confirmation explicite est exigée, les dépôts étudiants
  sont **archivés** sur GitHub (jamais supprimés, GH-25) et l'assignment disparaît des
  vues étudiantes. La deadline passée, l'assignment passe à `verrouillé`
  automatiquement.

## Student

### US-10 — Se connecter et lier son compte GitHub

En tant que student, je me connecte avec Switch edu-ID et je lie mon compte GitHub
afin d'accéder à mes dépôts de travail.

- **Étant donné** un utilisateur non authentifié, **quand** il accède au portail,
  **alors** il est redirigé vers le login Switch edu-ID (OIDC).
- **Étant donné** une connexion réussie sans compte GitHub lié, **quand** la session
  s'ouvre, **alors** l'étudiant peut naviguer et consulter ses assignments ; un
  bandeau d'onboarding l'invite à lier son compte GitHub (flux OAuth), et
  l'**acceptation d'un assignment est bloquée** tant que la liaison n'est pas faite
  (AU-11).
- **Étant donné** un compte GitHub déjà lié à un autre utilisateur de la plateforme,
  **quand** la liaison est tentée, **alors** elle est refusée avec un message
  explicite.

### US-11 — Être rattaché au roster (claim automatique)

En tant que student, je suis rattaché automatiquement à mes classrooms à la connexion
afin de ne pas avoir de démarche manuelle.

- **Étant donné** un student qui se connecte avec un e-mail edu-ID **vérifié**
  correspondant à une ou plusieurs entrées de roster `pending`, **quand** la session
  s'ouvre, **alors** ces entrées passent à `claimed`, rattachées à son compte
  plateforme, et un écran récapitulatif lui présente les classrooms rejointes
  (AU-18). Le login GitHub n'apparaît dans le roster qu'après la liaison GitHub
  (US-10) ; il n'est pas requis pour le claim.
- **Étant donné** un e-mail sans correspondance dans le roster, **quand** le student
  se connecte, **alors** il voit un message l'invitant à contacter son enseignant,
  sans accès à aucune classroom. Le teacher peut corriger l'e-mail de l'entrée (le
  claim se rejoue à la connexion suivante ou via « réessayer ») ou rattacher
  manuellement l'entrée (AU-20).
- **Étant donné** une entrée déjà `claimed` par un autre compte dont l'e-mail
  correspond, **quand** la connexion a lieu, **alors** aucun rattachement n'est
  effectué, l'anomalie est journalisée et signalée au teacher (badge « conflit »,
  AU-21) ; la résolution est manuelle, par le teacher uniquement.

### US-12 — Voir ses assignments

En tant que student, je consulte mes assignments afin de connaître mes échéances et
d'accéder à mes dépôts.

- **Étant donné** un student rattaché à une ou plusieurs classrooms, **quand** il
  ouvre le portail, **alors** il voit ses assignments publiés avec nom, date de début,
  deadline (Europe/Zurich), statut (`à accepter`, `en cours`, `verrouillé`) et le lien
  vers son dépôt s'il existe.
- **Étant donné** un assignment dont la date de début est future, **quand** la liste
  s'affiche, **alors** l'assignment est visible mais non acceptable.

### US-13 — Accepter un assignment

En tant que student, j'accepte un assignment afin d'obtenir mon dépôt de travail
personnel.

- **Étant donné** un assignment ouvert (publié, début atteint, deadline non passée) et
  un compte GitHub lié, **quand** le student accepte, **alors** le système provisionne
  son dépôt privé (US-20) : la création du dépôt et l'**envoi de l'invitation**
  collaborateur interviennent en moins de 60 secondes, et le lien apparaît dans sa vue
  avec l'état de l'invitation (à accepter côté GitHub).
- **Étant donné** une invitation GitHub non acceptée ou expirée, **quand** le student
  consulte l'assignment, **alors** il voit le lien d'invitation et un bouton
  « renvoyer l'invitation » (GH-24).
- **Étant donné** un provisionnement en échec, **quand** l'erreur survient, **alors**
  le student voit un statut d'erreur relançable et le teacher est notifié.
- **Étant donné** un assignment dont la deadline est passée, **quand** le student
  tente d'accepter, **alors** l'acceptation est refusée.

### US-14 — Suivre son statut CI et sa note indicative

En tant que student, je vois le résultat du CI et ma note indicative afin de connaître
mon avancement.

- **Étant donné** un push sur une branche distribuée de son dépôt déclenchant
  `grading.yml`, **quand** le run se termine, **alors** le portail affiche le statut
  du run et la note extraite de l'annotation (convention GR-02), avec la mention
  « note indicative, non contractuelle ».
- **Étant donné** un dépôt sans `grading.yml`, **quand** un workflow CI se termine,
  **alors** le portail affiche uniquement le statut agrégé pass/fail (GR-06).
- **Étant donné** une deadline passée, **quand** le student consulte l'assignment,
  **alors** la note affichée est la **note gelée** : dernier run éligible portant sur
  un commit **reçu par la plateforme avant la deadline** (heure serveur du webhook,
  GR-14) ; le gel devient définitif après un délai de grâce (30 min par défaut)
  laissant se terminer les runs en cours. Les runs postérieurs ne modifient jamais la
  note gelée.

## Système

### US-20 — Provisionner un dépôt étudiant

En tant que système, je crée le dépôt de travail à l'acceptation afin de donner à
l'étudiant un environnement prêt.

- **Étant donné** une acceptation (US-13), **quand** le provisionnement s'exécute,
  **alors** le système crée un dépôt privé dans l'organisation à partir du dépôt
  correspondant à la stratégie de source (complet ou squashé), avec les branches
  configurées.
- **Étant donné** le dépôt créé, **quand** les droits sont posés, **alors** l'étudiant
  a le droit push (non admin) et le force push est interdit par ruleset sur les
  branches distribuées (GH-21, fallback GH-22).
- **Étant donné** une étape qui échoue, **quand** le provisionnement est relancé,
  **alors** l'opération est idempotente (pas de dépôt ni d'invitation en double).
- **Étant donné** une invitation collaborateur expirée (7 jours GitHub), **quand** le
  job de rattrapage la détecte, **alors** une ré-invitation est envoyée
  automatiquement (au plus une par 24 h) et l'étudiant est notifié (GH-24).

### US-21 — Reverter les fichiers protégés

En tant que système, je restaure les fichiers protégés modifiés par l'étudiant afin de
garantir l'intégrité de l'énoncé et des critères.

- **Étant donné** un push étudiant modifiant au moins un fichier protégé, **quand** le
  webhook push est reçu, **alors** le système pousse un commit de revert (identité
  bot) restaurant ces fichiers à leur dernière version légitime, sans toucher aux
  autres fichiers du push.
- **Étant donné** le commit de revert, **quand** il est poussé, **alors** son message
  identifie les fichiers restaurés et l'événement est journalisé et visible du
  teacher.
- **Étant donné** un push du bot ou une synchro teacher (US-06) touchant un fichier
  protégé, **quand** le webhook est reçu, **alors** aucun revert n'est déclenché (pas
  de boucle).
- **Étant donné** plus de 5 reverts en une heure sur un même dépôt, **quand** un
  nouveau push touchant un fichier protégé arrive, **alors** le système suspend les
  reverts, marque le dépôt « protected files en conflit », notifie teacher et étudiant
  et signale que la note courante n'est plus fiable ; le teacher réarme la protection
  depuis l'UI (revert final + remise à zéro du compteur, GH-35).

### US-22 — Appliquer la stratégie de deadline

En tant que système, j'applique la stratégie de deadline à l'échéance afin de figer
l'état des rendus.

- **Étant donné** un assignment publié, **quand** la deadline (Europe/Zurich) est
  atteinte, **alors** le job de deadline **démarre au plus 60 s après l'échéance** et
  l'application sur l'ensemble des dépôts (jusqu'à 100) se termine en moins de
  5 minutes (budget global, NFR-13).
- **Étant donné** la stratégie `lock` avec rulesets disponibles, **quand** le job
  s'exécute, **alors** chaque dépôt devient en lecture seule pour l'étudiant sur les
  branches distribuées ; la GitHub App (bot) **et** les admins de l'organisation
  (teacher) conservent l'écriture via les acteurs de bypass du ruleset (GH-41).
- **Étant donné** le fallback `archivage` (rulesets indisponibles), **quand** il est
  appliqué, **alors** le dépôt entier devient en lecture seule **pour tous, bot
  compris** ; ce mode dégradé est signalé au teacher, et toute écriture bot restante
  (revert final, commit correctif) est effectuée avant l'archivage.
- **Étant donné** la stratégie `deadline commit`, **quand** la deadline est atteinte,
  **alors** le bot pousse un commit vide horodaté « deadline » sur chaque branche
  distribuée de chaque dépôt ; le dépôt reste ouvert et la note gelée est déterminée
  par GR-12 à GR-14 (les runs déclenchés par le commit bot sont ignorés, GH-44).
- **Étant donné** une indisponibilité du job à l'heure H, **quand** le job reprend,
  **alors** il rattrape les deadlines manquées sans double application.

### US-23 — Collecter les métriques par webhooks

En tant que système, je collecte les événements GitHub afin de tenir à jour les
tableaux de bord sans polling.

- **Étant donné** un push sur un dépôt étudiant, **quand** le webhook est reçu,
  **alors** date et hash du dernier commit sont mis à jour en base, avec l'**heure de
  réception serveur persistée par SHA** (référence du gel de note, GR-14).
- **Étant donné** un webhook perdu ou rejeté, **quand** le job de rattrapage
  périodique s'exécute, **alors** l'état est réconcilié via l'API GitHub (polling de
  secours uniquement).
- **Étant donné** tout webhook entrant, **quand** il est traité, **alors** sa
  signature (secret partagé) a été vérifiée, sinon il est rejeté.

### US-24 — Extraire la note du CI

En tant que système, j'extrais la note émise par `grading.yml` afin de l'afficher aux
deux rôles.

- **Étant donné** un événement `workflow_run` terminé pour le workflow de grading sur
  une branche distribuée, avec un commit de tête non poussé par le bot, **quand** le
  système lit les check-runs associés, **alors** il extrait la note depuis
  l'annotation conforme à la convention **GR-02** (spécifiée dans les specs
  fonctionnelles) et l'enregistre avec run, hash et horodatage.
- **Étant donné** une annotation absente, malformée ou multiple alors que
  `grading.yml` existe, **quand** l'extraction échoue, **alors** le run est marqué
  `note indéterminée` (distinct de fail) et l'anomalie est journalisée et visible du
  teacher.
- **Étant donné** un dépôt sans `grading.yml`, **quand** un run CI se termine,
  **alors** seul le statut agrégé pass/fail (GR-06) est enregistré.
- **Étant donné** un run portant sur une ref de synchro (`sync/*`) ou sur un commit
  bot, **quand** l'événement est reçu, **alors** il est ignoré (aucun GradeRun,
  GR-05).

# Exigences non fonctionnelles

## Sécurité

- **NFR-01** — Toute authentification au portail passe par Switch edu-ID (OIDC) ;
  aucun mot de passe local. La liaison GitHub utilise OAuth avec le scope minimal
  nécessaire.
- **NFR-02** — Les opérations sur GitHub s'effectuent via des tokens d'installation
  GitHub App à durée courte ; aucun token personnel d'utilisateur n'est stocké (le
  token OAuth de liaison est jeté après lecture de l'identité, AU-09).
- **NFR-03** — Les clés d'API sont stockées hashées, scopées au teacher propriétaire,
  révocables immédiatement ; l'API à clé est en lecture seule.
- **NFR-04** — Tous les webhooks entrants sont authentifiés par signature ; les
  payloads non signés ou invalides sont rejetés et comptabilisés.
- **NFR-05** — Les actions sensibles (claim et rattachement de roster, revert, lock,
  génération/révocation de clé, synchro, changement de rôle) sont journalisées de
  façon immuable (audit trail horodaté), sous réserve de la pseudonymisation prévue
  par NFR-07.

## Confidentialité

- **NFR-06** — Tous les dépôts (source, squashé, étudiants) sont privés. Un étudiant
  n'a accès qu'à son propre dépôt ; aucun étudiant ne peut voir le dépôt, le statut ou
  la note d'un autre.
- **NFR-07** — Les données personnelles (nom, e-mail, login GitHub) sont limitées au
  strict nécessaire et visibles uniquement du teacher de la classroom et de l'étudiant
  concerné. Suppression sur demande (conformité LPD) : le compte et les entrées de
  roster sont **anonymisés** (champs personnels remplacés par un pseudonyme), les
  GradeRuns et métriques sont conservés rattachés au pseudonyme, les entrées d'audit
  sont pseudonymisées (l'immuabilité de NFR-05 porte sur les faits, pas sur
  l'identité). Les dépôts GitHub ne sont pas supprimés par la plateforme : l'accès
  collaborateur de l'étudiant est retiré et le sort du dépôt relève du teacher et de
  l'organisation.

## Disponibilité, fiabilité et sauvegarde

- **NFR-08** — Disponibilité cible du portail : 99 %, mesurée **mensuellement pendant
  les semestres académiques** (calendrier HEIG-VD), par sonde externe sur un endpoint
  de santé (`/healthz`, période 60 s). Les maintenances planifiées annoncées au moins
  48 h à l'avance sont exclues de la mesure. Une indisponibilité du portail n'empêche
  jamais les étudiants de travailler (les dépôts GitHub restent accessibles).
- **NFR-09** — Les jobs critiques (deadline, revert, provisionnement) sont idempotents
  et rejouables ; les deadlines manquées pendant une panne sont rattrapées
  automatiquement à la reprise.
- **NFR-10** — Le système respecte les rate limits de l'API GitHub : collecte par
  webhooks, appels API avec backoff, polling limité au rattrapage.
- **NFR-16** — Les données dont la plateforme est la source de vérité (comptes et
  liaisons, roster et claims, clés d'API, audit trail, GradeRuns et notes gelées,
  configuration des assignments — cf. C-01) font l'objet d'une **sauvegarde
  quotidienne** de la base, rétention 30 jours, avec procédure de restauration testée
  au moins une fois par semestre. Objectifs : RPO ≤ 24 h, RTO ≤ 4 h.

## Performance

- **NFR-11** — Dimensionnement de référence : 30 à 100 étudiants par classroom,
  jusqu'à 20 classrooms actives simultanément. Les vues tableau (roster, état
  d'assignment) s'affichent en moins de 2 s à 100 lignes.
- **NFR-12** — Latence de bout en bout : note visible au portail moins de 2 minutes
  après la fin du run CI ; revert de fichier protégé poussé moins de 60 s après
  réception du webhook ; provisionnement d'un dépôt (création + **envoi** de
  l'invitation collaborateur) en moins de 60 s — l'acceptation de l'invitation par
  l'étudiant est hors SLA.
- **NFR-13** — Budget deadline (aligné US-22 et §2.3) : démarrage du job ≤ 60 s après
  l'échéance ; application complète de la stratégie sur 100 dépôts ≤ 5 minutes, sans
  dépasser les quotas GitHub.

## Internationalisation et accessibilité

- **NFR-14** — L'interface est livrée en français ; l'architecture d'UI externalise
  les chaînes pour permettre l'ajout de l'anglais sans refonte. Dates et heures
  affichées en Europe/Zurich.
- **NFR-15** — Accessibilité sur les quatre parcours principaux (login, claim,
  acceptation d'assignment, consultation des statuts) : conformité aux critères
  WCAG 2.1 AA suivants — 1.1.1 (alternatives textuelles), 1.3.1 (info et relations),
  1.4.3 (contraste minimum), 2.1.1/2.1.2 (clavier, pas de piège), 2.4.6 (en-têtes et
  étiquettes), 2.4.7 (focus visible), 3.3.1 et 3.3.2 (identification des erreurs,
  étiquettes de formulaire), 4.1.2 (nom, rôle, valeur). Vérification en recette :
  audit outillé (axe-core ou équivalent) sans violation sur ces critères + parcours
  complet au clavier.

## Notifications

- **NFR-17** — Les notifications (NT-01 à NT-03 des specs) sont délivrées **in-app**
  obligatoirement ; l'e-mail est un canal optionnel (opt-in par utilisateur), envoyé
  de façon asynchrone avec reprise sur échec, sans donnée personnelle superflue dans
  le corps du message. Aucune exigence fonctionnelle ne repose sur la seule
  délivrance d'un e-mail.

# Contraintes

- **C-01 — Sources de vérité partagées** : GitHub est la source de vérité (SoT) pour
  le **contenu Git** (dépôts, historique, branches), les runs CI et leurs résultats
  bruts ; pour ces données, la base de la plateforme n'est qu'un cache/index
  reconstructible et, en cas de divergence, GitHub fait foi. La plateforme est en
  revanche la **seule** source de vérité pour : comptes et liaisons, roster et claims,
  configuration des assignments, clés d'API, audit trail, GradeRuns et notes gelées —
  d'où l'exigence de sauvegarde NFR-16.
- **C-02 — Timezone** : toutes les deadlines sont saisies et évaluées en Europe/Zurich
  (gestion correcte des changements d'heure) ; le stockage interne est en UTC avec
  conversion à l'affichage.
- **C-03 — GitHub App** : l'intégration à l'organisation repose sur une GitHub App
  installée par un admin de l'organisation ; sans installation, aucune classroom ne
  peut être activée.
- **C-04 — CI sur GitHub Actions** : le grading s'exécute exclusivement sur GitHub
  Actions dans le dépôt étudiant ; la plateforme n'exécute jamais de code étudiant.
- **C-05 — Identité bot** : tous les commits automatiques (revert, deadline, synchro)
  utilisent une identité bot dédiée et identifiable, distincte des comptes humains.
- **C-06 — Comptes GitHub personnels** : les étudiants utilisent leur propre compte
  GitHub ; la plateforme ne crée pas de comptes GitHub et ne stocke aucun credential
  GitHub d'utilisateur (cf. NFR-02, AU-09).
- **C-07 — Vérifications GitHub préalables (bloquant, avant le jalon M2)** : les
  points suivants conditionnent la faisabilité du provisionnement à 100 étudiants et
  doivent être vérifiés sur l'organisation cible avant tout développement du
  provisionnement :

  1. Plan de l'organisation (Team/Enterprise via GitHub Education) et disponibilité
     des **rulesets sur dépôts privés** (requis par GH-21 et GH-41).
  2. Politique de **facturation des outside collaborators** sur dépôts privés (un
     siège par collaborateur sur plan Team : 100 étudiants = 100 sièges).
  3. **Quotas anti-abus d'invitations** par organisation et par 24 h.

  Un plan B est documenté si l'un de ces points bloque : organisation vérifiée GitHub
  Education (sièges gratuits), étalement des invitations dans le temps, ou ajout des
  étudiants comme membres de l'organisation avec permission de base `none`.

  **État au 2026-07-03** (vérifié sur l'organisation cible `heig-tin-info`) :

  1. Vérifié — plan **GitHub Team** avec remise GitHub Education 100 % (0 CHF/mois). Les
     rulesets de branche sur dépôts privés sont donc disponibles (GH-21, GH-41 OK).
     Les *push rulesets* (restriction de chemins) restent réservés à Enterprise, mais
     la stratégie retenue (commit de revert, GH-30+) ne s'en sert pas.
  2. Traité (2026-07-03) — **15 licences** pour 9 membres actuels : chaque outside
     collaborator sur un dépôt privé consomme un siège. Demande de sièges via le
     programme GitHub Education effectuée (≥ effectif étudiant + marge ; la remise
     100 % s'applique aux sièges supplémentaires).
  3. À vérifier — quotas d'invitations par 24 h. Le spike S2 (2026-07-06, voir
     `docs/spikes/S2-rapport.md`) a validé toute la chaîne de provisionnement
     (30 dépôts, 4 s chacun, zéro 403) ; le quota d'invitations reste mesuré
     passivement en M2 via le rate limiter configurable.
  4. Action requise — **minutes GitHub Actions** : 3 000 min/mois incluses (plan Team) et les dépôts
     étudiants sont privés — le grading CI de ~100 étudiants peut dépasser ce budget.
     Prévoir un **runner self-hosted** pour le grading, ou vérifier une extension de
     minutes via Education (à trancher en phase 3).

# Glossaire

| Terme | Définition |
| --- | --- |
| **Classroom** | Regroupement d'assignments et d'un roster, adossé à une organisation GitHub, propriété d'un teacher. |
| **Assignment** | Travail distribué aux étudiants : dépôt source, dates, stratégies, fichiers protégés. États : brouillon, publié, verrouillé. |
| **Roster** | Liste des étudiants d'une classroom importée par le teacher (nom, prénom, e-mail). |
| **Entrée de roster (Enrollment)** | Ligne du roster ; statuts `pending` (« non réclamée ») / `claimed` (« réclamée »). |
| **Claim** | Rattachement automatique d'une entrée de roster au compte plateforme d'un étudiant, sur correspondance d'e-mail vérifié. |
| **Dépôt source** | Dépôt privé de l'organisation où le teacher rédige l'énoncé. |
| **Dépôt squashé** | Dépôt privé généré par la plateforme à la création de l'assignment, base des dépôts étudiants et des PR de synchro. |
| **Commit primaire** | Commit du dépôt squashé représentant l'état complet publié du source à un instant (stratégie `squash`). |
| **Dépôt étudiant** | Dépôt privé personnel provisionné à l'acceptation d'un assignment. |
| **Fichiers protégés** | Fichiers de l'énoncé restaurés automatiquement (commit de revert) s'ils sont modifiés par l'étudiant. |
| **Lock** | Stratégie de deadline rendant le dépôt en lecture seule pour l'étudiant (ruleset ; fallback archivage). |
| **Commit de deadline** | Stratégie de deadline : commit vide horodaté poussé par le bot, dépôt laissé ouvert. |
| **GradeRun** | Enregistrement immuable d'une passe CI capturée (run, commit, conclusion, note éventuelle). |
| **Note indicative** | Note extraite du CI, non contractuelle, jamais exportée vers le SI académique. |
| **Note gelée** | Note retenue à la deadline selon GR-12 à GR-14 (commit reçu avant l'échéance, heure serveur). |
| **GitHub App / bot** | Identité machine de la plateforme ; les tokens d'installation servent toutes les opérations GitHub. |
| **Ruleset** | Règles GitHub par dépôt/branches (blocage force push, lock) avec acteurs de bypass. |
| **Squash (stratégie de source)** | Distribution de l'état du source sous forme de commits primaires, sans l'historique du teacher. |
| **Whole repository (stratégie de source)** | Distribution du miroir complet des branches sélectionnées (historique inclus). |

# Hypothèses à valider {#sec:hypotheses}

Décisions prises pour lever les ambiguïtés relevées ; chacune est à confirmer (ou
infirmer) par le porteur du projet.

> **Statut** : hypothèses H1 à H12 validées telles quelles par le porteur du projet
> le 2026-07-03. Elles font désormais partie du périmètre contractuel de la v1.

- **H1 — Extensions de deadline individuelles exclues de la v1.** Le ruleset lock est
  retenu notamment parce qu'il rend cette évolution possible plus tard, mais aucun
  flux de déverrouillage/re-deadline n'est spécifié ni livré en v1.
- **H2 — Pas de rôle admin applicatif en v1.** Le rôle teacher est attribué via une
  liste d'e-mails/`sub` edu-ID en configuration serveur, gérée par l'exploitant.
- **H3 — Claim automatique du roster** à la connexion, sur e-mail vérifié, sans
  confirmation explicite de l'étudiant (écran récapitulatif informatif). La liaison
  GitHub n'est pas requise pour le claim, seulement pour accepter un assignment.
- **H4 — Import CSV atomique** : rejet total en cas de doublon intra-fichier ; les
  e-mails déjà en base sont mis à jour (upsert), jamais ignorés ni supprimés.
- **H5 — Note falsifiable acceptée.** Le code étudiant s'exécutant dans le run peut
  émettre lui-même une annotation `GRADE` : le risque est documenté (GR-02) et jugé
  acceptable car la note est indicative. Mitigation : toute annotation `GRADE`
  multiple (même à valeurs identiques) invalide la note du run. L'alternative
  « artefact signé » (GR-16) est réservée à une version ultérieure.
- **H6 — Gel de note sur l'heure serveur** : la référence du gel est l'heure de
  réception du webhook push par la plateforme (persistée par SHA), jamais
  l'horodatage git (falsifiable). Délai de grâce par défaut : 30 minutes.
- **H7 — CLI minimal livré** (`hgc` : `classrooms`, `assignments`, `repos`, `clone`),
  en plus de l'API — cf. jalon M7 du plan de phase 1.
- **H8 — Fallback archivage assumé** : si les rulesets sont indisponibles, le lock se
  fait par archivage, qui retire l'écriture à tout le monde (bot compris) ; mode
  dégradé signalé, sans revert ni synchro post-deadline possibles.
- **H9 — Statut CI agrégé** (dépôts sans `grading.yml`) : agrégation de tous les
  workflows terminés sur le dernier commit étudiant des branches distribuées — `fail`
  si au moins un échec (GR-06).
- **H10 — Plafond anti-boucle de revert** : 5 reverts/heure/dépôt, puis suspension et
  résolution manuelle par le teacher (GH-33, GH-35).
- **H11 — Suppression LPD par anonymisation** (pas d'effacement physique des
  GradeRuns ni de l'audit, pseudonymisés) ; les dépôts GitHub ne sont jamais supprimés
  par la plateforme.
- **H12 — `grading.yml` protégé par défaut** : pré-coché dans les fichiers protégés
  s'il existe dans le source ; le teacher peut le décocher (avertissement affiché).
