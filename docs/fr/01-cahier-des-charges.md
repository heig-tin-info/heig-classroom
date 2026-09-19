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
> Source : note produit initiale (absorbée dans `00-analyse-besoins.md`), `00-analyse-besoins.md`.
> Spécifications détaillées : `02-specs-fonctionnelles.md`.
> Statut : consolidé (édition finale de la phase 2). Les décisions prises pour lever les
> ambiguïtés sont listées dans [Hypothèses à valider](#sec:assumptions).

# Objet du document

Ce document définit le besoin : contexte, objectifs, périmètre, acteurs, récits
utilisateur avec critères d'acceptation (US-xx), exigences non fonctionnelles
(NFR-xx) et contraintes (C-xx). Les règles d'implémentation détaillées (AU-xx,
GH-xx, GR-xx, API/CLI) figurent dans les spécifications fonctionnelles
(`02-specs-fonctionnelles.md`).

# Contexte et objectifs

## Contexte

GitHub Classroom couvre mal certains besoins de la HEIG-VD : authentification
institutionnelle (Switch edu-ID), stratégies de délai de rendu configurables,
protection des fichiers d'énoncé, extraction des notes depuis la CI et
synchronisation des énoncés après publication. Le projet « HEIG GitHub Classroom »
est un portail web qui reproduit et adapte ces fonctions, en s'appuyant
exclusivement sur GitHub (organisations, dépôts, Actions) comme infrastructure
d'exécution.

## Objectifs

- **O1** — Permettre à l'enseignant de gérer ses classes et ses devoirs depuis un
  portail unique, adossé à une organisation GitHub.
- **O2** — Provisionner automatiquement un dépôt privé par étudiant lors de
  l'acceptation d'un devoir, avec les permissions et protections appropriées.
- **O3** — Appliquer automatiquement les politiques pédagogiques : fichiers protégés
  (revert automatique), stratégie de délai de rendu (verrouillage ou commit de délai).
- **O4** — Restituer en continu l'état des dépôts étudiants (dernier commit, statut CI,
  note indicative issue de `grading.yml`).
- **O5** — Offrir une API par clé et une CLI minimale permettant l'automatisation côté
  enseignant (clone en masse des dépôts).

## Critères de succès

- Un devoir pour une classe de 100 étudiants est publié, accepté et provisionné
  sans intervention manuelle de l'enseignant (sous réserve des vérifications GitHub de la
  contrainte C-07).
- La note indicative apparaît dans le portail en moins de 2 minutes après la fin d'un
  run CI.
- Au délai de rendu (heure Europe/Zurich), la tâche de verrouillage démarre au plus 60 s
  après l'échéance et l'application complète sur 100 dépôts s'achève en moins de
  5 minutes (budget global unique, repris par US-22 et NFR-13).

# Périmètre

## Inclus

- Portail web à deux rôles (enseignant, étudiant) avec authentification Switch edu-ID (OIDC)
  et liaison du compte GitHub (OAuth distinct).
- Gestion des classes : création, association à une organisation GitHub
  (installation de la GitHub App), import de la liste des étudiants, réclamation automatique
  des lignes par les étudiants à la connexion.
- Gestion des devoirs : cycle de vie complet (brouillon, publication, acceptation,
  délai de rendu), stratégie de source (dépôt entier ou squashé), branches sélectionnées,
  fichiers protégés, stratégie de délai de rendu, modification contrôlée après publication.
- Provisionnement des dépôts étudiants privés dans l'organisation, avec force push
  interdit.
- Détection et revert automatique des modifications des fichiers protégés (identité
  bot), avec plafond anti-boucle.
- Collecte des métriques par webhooks GitHub (push, `workflow_run`) ; extraction de la
  note via une annotation de check run ; repli pass/fail.
- Tâches de délai de rendu : verrouillage du dépôt ou commit de délai de rendu, gel de la
  note retenue.
- Synchronisation de l'énoncé : push de l'enseignant sur le dépôt source → mise à jour du
  dépôt squashé → PR du bot vers chaque dépôt étudiant.
- API REST par clé pour l'enseignant (accès en lecture aux classes, devoirs, dépôts, notes)
  et CLI minimale de clone en masse.
- Notifications in-app (e-mail optionnel).

## Exclus

- Devoirs de groupe (dépôt partagé par plusieurs étudiants) — reportés à une
  version ultérieure.
- Prolongations individuelles du délai de rendu par étudiant — exclues de la v1. Le
  mécanisme de verrouillage retenu (ruleset, réversible par dépôt) est choisi pour rendre
  cette évolution possible sans refonte, mais aucun flux n'est spécifié ni livré en v1.
- Notation officielle et export vers le système d'information académique (GAPS ou
  équivalent) : la note collectée est **indicative** et non contractuelle.
- Hébergement ou exécution de la CI : les runs s'exécutent sur GitHub Actions, jamais sur
  la plateforme.
- Anti-plagiat, détection de similarité entre dépôts.
- Application mobile ; le portail est une application web responsive.

# Acteurs et rôles

| Acteur | Description | Authentification |
| --- | --- | --- |
| **Enseignant** | Enseignant HEIG-VD. Crée et administre les classes, les devoirs, la liste des étudiants ; consulte l'état et les notes ; gère ses clés d'API. | Switch edu-ID + compte GitHub lié (admin de l'organisation cible) |
| **Étudiant** | Étudiant inscrit dans la liste des étudiants d'une classe. Rattaché automatiquement à sa ligne de liste, accepte les devoirs, travaille dans son dépôt. | Switch edu-ID + compte GitHub lié |
| **Système (bot)** | Identité machine de la plateforme (GitHub App + identité de commit du bot). Provisionne les dépôts, pousse les reverts et les commits de délai de rendu, ouvre les PR de synchronisation. | Jetons d'installation de la GitHub App |
| **Client API** | CLI fournie ou script de l'enseignant consommant l'API REST. | Clé d'API (à portée limitée, révocable) |

Trois rôles applicatifs (révision H2 du 2026-07-07) : `admin`, `teacher` et
`student`. Le super-administrateur (unique, e-mail dans la configuration du serveur)
accorde et révoque le rôle enseignant depuis l'écran d'administration ; l'admin hérite
des capacités de l'enseignant. Un enseignant peut être étudiant d'une autre classe.

# Récits utilisateur

Convention : critères d'acceptation au format Étant donné / Quand / Alors. Les statuts
de la liste des étudiants utilisent les valeurs techniques `pending` / `claimed`,
affichées en français « non réclamée » / « réclamée ».

## Enseignant

### US-01 — Créer une classe

En tant qu'enseignant, je crée une classe liée à une organisation GitHub afin d'y
regrouper mes devoirs.

- **Étant donné** un enseignant connecté avec un compte GitHub lié, **quand** il crée une
  classe (nom + organisation), **alors** le système demande l'installation de la
  GitHub App sur l'organisation si elle n'y est pas déjà installée.
- **Étant donné** une organisation sans installation valide, **quand** l'installation
  échoue ou est refusée, **alors** la classe n'est pas activée et l'enseignant voit
  la cause de l'erreur.
- **Étant donné** une installation valide, **quand** la classe est créée, **alors**
  elle apparaît dans la liste de l'enseignant avec 0 devoir et 0 étudiant.

### US-02 — Importer la liste des étudiants

En tant qu'enseignant, j'importe la liste des étudiants (nom, prénom, e-mail) afin de
maîtriser qui peut rejoindre la classe.

- **Étant donné** une classe existante, **quand** l'enseignant importe un fichier CSV
  (nom, prénom, e-mail), **alors** l'import est **atomique** (tout ou rien) : s'il est
  valide, chaque ligne devient une entrée de liste au statut `pending` ; sinon aucune
  modification n'est appliquée et un rapport d'erreur indique les lignes fautives.
- **Étant donné** un fichier contenant des e-mails en doublon **intra-fichier**,
  **quand** l'import est soumis, **alors** il est rejeté avec les numéros des lignes en
  doublon (AU-14).
- **Étant donné** un fichier contenant des e-mails **déjà présents** dans la liste,
  **quand** l'import est validé, **alors** les entrées existantes (y compris
  `claimed`) sont conservées et leurs nom/prénom mis à jour (upsert, AU-16) ; les
  entrées absentes du fichier ne sont pas supprimées.
- **Étant donné** une liste importée, **quand** l'enseignant consulte la classe,
  **alors** il voit chaque ligne avec son statut (`pending` / `claimed`) et, si elle est
  réclamée, le login GitHub associé (vide tant que l'étudiant n'a pas lié GitHub).

### US-03 — Consulter le tableau de bord d'une classe

En tant qu'enseignant, je consulte l'état de ma classe afin de suivre l'activité des
étudiants.

- **Étant donné** une classe avec des devoirs et des étudiants, **quand** l'enseignant
  ouvre sa vue, **alors** il voit le nombre de devoirs, leurs dates de début et
  d'échéance, et le tableau des étudiants (nom, prénom, e-mail, compte GitHub,
  dernière connexion au portail).
- **Étant donné** une ligne de liste non réclamée, **quand** le tableau est affiché,
  **alors** les colonnes compte GitHub et dernière connexion sont vides et le statut
  `pending` est visible.

### US-04 — Créer un devoir

En tant qu'enseignant, je crée un devoir à partir d'un dépôt source afin de le
distribuer aux étudiants.

- **Étant donné** une classe active, **quand** l'enseignant crée un devoir,
  **alors** il renseigne : nom, date de début, délai de rendu, dépôt source (obligatoirement
  dans l'organisation), stratégie de source (`whole repository` | `squash`), branches
  à distribuer (par défaut : `main` ou `master` selon celle qui existe), fichiers protégés,
  stratégie de délai de rendu (`lock` | `deadline commit`). Le devoir est créé à l'état
  `draft` (US-08).
- **Étant donné** un dépôt source contenant `criteria.yml`, `README.md` ou
  `.github/workflows/grading.yml`, **quand** le formulaire s'ouvre, **alors** ces
  fichiers sont précochés comme protégés (modifiable par l'enseignant). Décocher
  `grading.yml` affiche un avertissement : sans protection, l'étudiant peut altérer ou
  supprimer le workflow de notation.
- **Étant donné** un dépôt source hors de l'organisation, **quand** l'enseignant valide,
  **alors** la création est refusée avec un message explicite.
- **Étant donné** un devoir validé, **quand** la création réussit, **alors** le
  système crée le dépôt **source squashé** privé dans l'organisation et affiche son
  lien dans l'interface enseignant.

### US-05 — Suivre l'état des dépôts d'un devoir

En tant qu'enseignant, je consulte l'état de chaque dépôt étudiant afin de suivre
l'avancement et les notes.

- **Étant donné** un devoir accepté par des étudiants, **quand** l'enseignant ouvre
  la vue du devoir, **alors** il voit par étudiant : lien du dépôt, date et hash
  du dernier commit, statut CI (`none` / `pending` / `pass` / `fail`, règle d'agrégation
  GR-06), note indicative si `grading.yml` est présent.
- **Étant donné** un dépôt sans aucun push étudiant, **quand** la vue est affichée,
  **alors** l'étudiant apparaît avec l'état `accepted, no work` ; s'il n'a pas
  accepté, `not accepted`.

### US-06 — Synchroniser l'énoncé après publication

En tant qu'enseignant, je propage une correction de l'énoncé vers les dépôts étudiants
afin de corriger un devoir déjà distribué.

- **Étant donné** un push de l'enseignant sur le dépôt source, **quand** l'enseignant
  déclenche la synchronisation depuis l'interface, **alors** le système met à jour le dépôt
  squashé puis ouvre une PR (identité bot) vers chaque dépôt étudiant existant.
- **Étant donné** une PR de synchronisation en conflit avec le travail d'un étudiant,
  **quand** la PR est créée, **alors** elle reste ouverte avec le conflit à résoudre
  par l'étudiant ; le système ne force jamais la fusion.
- **Étant donné** une synchronisation lancée, **quand** elle se termine, **alors**
  l'enseignant voit un récapitulatif (PR créées, déjà à jour, échecs).

### US-07 — Gérer ses clés d'API

En tant qu'enseignant, je génère et révoque des clés d'API afin d'automatiser la
récupération des dépôts via la CLI.

- **Étant donné** un enseignant connecté, **quand** il génère une clé, **alors** le
  secret n'est affiché qu'une seule fois et seul un hash est stocké.
- **Étant donné** une clé révoquée, **quand** un appel d'API l'utilise, **alors** la
  requête est rejetée avec `401`.
- **Étant donné** une clé valide, **quand** la CLI appelle l'API, **alors** elle peut
  lister les classes, les devoirs, les dépôts étudiants (URL de clone), les statuts et les
  notes — en lecture seule et limité aux classes de l'enseignant propriétaire.

### US-08 — Publier et modifier un devoir

En tant qu'enseignant, je publie mon devoir puis le corrige si nécessaire afin de
maîtriser ce que voient les étudiants.

Cycle de vie : `draft` → `published` → `locked`.

- **Étant donné** un devoir à l'état `draft`, **quand** l'enseignant le
  consulte, **alors** il est invisible pour les étudiants et tous ses champs sont
  librement modifiables.
- **Étant donné** un devoir en brouillon, **quand** l'enseignant le publie,
  **alors** le devoir devient visible pour les étudiants de la classe (acceptable dès
  la date de début) et la tâche de délai de rendu est planifiée.
- **Étant donné** un devoir `published`, **quand** l'enseignant le modifie, **alors**
  seuls sont modifiables : le nom, le délai de rendu (tant qu'il n'est pas passé ; la
  nouvelle valeur ne peut pas être dans le passé), la stratégie de délai de rendu (tant que
  l'échéance n'est pas passée) et la liste des fichiers protégés. Le dépôt source, la
  stratégie de source et les branches ne sont plus modifiables dès la première
  acceptation.
- **Étant donné** un délai de rendu modifié, **quand** la modification est enregistrée,
  **alors** la tâche de délai de rendu est replanifiée (GH-43) et les étudiants voient la
  nouvelle échéance.
- **Étant donné** une liste de fichiers protégés modifiée, **quand** elle est
  enregistrée, **alors** la nouvelle liste s'applique aux pushs suivants (la version de
  référence reste celle du dernier commit du bot, GH-30) ; aucun revert rétroactif
  n'est déclenché.
- **Étant donné** un devoir publié avec des dépôts étudiants, **quand** l'enseignant
  le supprime, **alors** une confirmation explicite est requise, les dépôts étudiants
  sont **archivés** sur GitHub (jamais supprimés, GH-25) et le devoir disparaît des
  vues étudiantes. Une fois le délai de rendu passé, le devoir passe à `locked`
  automatiquement.

## Étudiant

### US-10 — Se connecter et lier son compte GitHub

En tant qu'étudiant, je me connecte avec Switch edu-ID et je lie mon compte GitHub
afin d'accéder à mes dépôts de travail.

- **Étant donné** un utilisateur non authentifié, **quand** il accède au portail,
  **alors** il est redirigé vers la connexion Switch edu-ID (OIDC).
- **Étant donné** une connexion réussie sans compte GitHub lié, **quand** la session
  s'ouvre, **alors** l'étudiant peut naviguer et consulter ses devoirs ; une
  bannière de prise en main l'invite à lier son compte GitHub (flux OAuth), et
  l'**acceptation d'un devoir est bloquée** tant que la liaison n'est pas faite
  (AU-11).
- **Étant donné** un compte GitHub déjà lié à un autre utilisateur de la plateforme,
  **quand** la liaison est tentée, **alors** elle est refusée avec un message
  explicite.

### US-11 — Être rattaché à la liste des étudiants (réclamation automatique)

En tant qu'étudiant, je suis rattaché automatiquement à mes classes à la connexion
afin de n'avoir aucune démarche manuelle à effectuer.

- **Étant donné** un étudiant qui se connecte avec un e-mail edu-ID **vérifié**
  correspondant à une ou plusieurs entrées de liste `pending`, **quand** la session
  s'ouvre, **alors** ces entrées passent à `claimed`, rattachées à son compte de
  plateforme, et un écran récapitulatif lui présente les classes qu'il a rejointes
  (AU-18). Le login GitHub n'apparaît dans la liste qu'après la liaison GitHub
  (US-10) ; il n'est pas requis pour la réclamation.
- **Étant donné** un e-mail sans correspondance dans la liste, **quand** l'étudiant
  se connecte, **alors** il voit un message l'invitant à contacter son enseignant,
  sans accès à aucune classe. L'enseignant peut corriger l'e-mail de l'entrée (la
  réclamation rejoue à la connexion suivante ou via « réessayer ») ou rattacher l'entrée
  manuellement (AU-20).
- **Étant donné** une entrée déjà `claimed` par un autre compte dont l'e-mail
  correspond, **quand** la connexion a lieu, **alors** aucun rattachement n'est
  effectué, l'anomalie est journalisée et signalée à l'enseignant (badge « conflit »,
  AU-21) ; la résolution est manuelle, par l'enseignant uniquement.

### US-12 — Voir ses devoirs

En tant qu'étudiant, je consulte mes devoirs afin de connaître mes échéances et
d'accéder à mes dépôts.

- **Étant donné** un étudiant rattaché à une ou plusieurs classes, **quand** il
  ouvre le portail, **alors** il voit ses devoirs publiés avec nom, date de début,
  délai de rendu (Europe/Zurich), statut (`to accept`, `in progress`, `locked`) et le lien
  vers son dépôt s'il existe.
- **Étant donné** un devoir dont la date de début est dans le futur, **quand** la liste
  est affichée, **alors** le devoir est visible mais non acceptable.

### US-13 — Accepter un devoir

En tant qu'étudiant, j'accepte un devoir afin d'obtenir mon dépôt de travail
personnel.

- **Étant donné** un devoir ouvert (publié, début atteint, délai de rendu non passé) et
  un compte GitHub lié, **quand** l'étudiant accepte, **alors** le système provisionne
  son dépôt privé (US-20) : la création du dépôt et l'**envoi de l'invitation**
  de collaborateur ont lieu en moins de 60 secondes, et le lien apparaît dans sa vue
  avec l'état de l'invitation (à accepter côté GitHub).
- **Étant donné** une invitation GitHub non acceptée ou expirée, **quand** l'étudiant
  consulte le devoir, **alors** il voit le lien d'invitation et un bouton
  « renvoyer l'invitation » (GH-24).
- **Étant donné** un provisionnement en échec, **quand** l'erreur survient, **alors**
  l'étudiant voit un statut d'erreur rejouable et l'enseignant est notifié.
- **Étant donné** un devoir dont le délai de rendu est passé, **quand** l'étudiant
  tente d'accepter, **alors** l'acceptation est refusée.

### US-14 — Suivre son statut CI et sa note indicative

En tant qu'étudiant, je vois le résultat de la CI et ma note indicative afin de connaître
ma progression.

- **Étant donné** un push sur une branche distribuée de son dépôt déclenchant
  `grading.yml`, **quand** le run se termine, **alors** le portail affiche le statut
  du run et la note extraite de l'annotation (convention GR-02), avec la mention
  « note indicative, non contractuelle ».
- **Étant donné** un dépôt sans `grading.yml`, **quand** un workflow CI se termine,
  **alors** le portail n'affiche que le statut pass/fail agrégé (GR-06).
- **Étant donné** un délai de rendu passé, **quand** l'étudiant consulte le devoir,
  **alors** la note affichée est la **note gelée** : dernier run éligible portant sur
  un commit **reçu par la plateforme avant le délai de rendu** (heure serveur du webhook,
  GR-14) ; le gel devient définitif après une période de grâce (30 min par défaut)
  laissant les runs en cours se terminer. Les runs ultérieurs ne modifient jamais la
  note gelée.

## Système

### US-20 — Provisionner un dépôt étudiant

En tant que système, je crée le dépôt de travail à l'acceptation afin de donner à
l'étudiant un environnement prêt à l'emploi.

- **Étant donné** une acceptation (US-13), **quand** le provisionnement s'exécute,
  **alors** le système crée un dépôt privé dans l'organisation à partir du dépôt
  correspondant à la stratégie de source (entier ou squashé), avec les branches
  configurées.
- **Étant donné** le dépôt créé, **quand** les permissions sont posées, **alors**
  l'étudiant a les droits de push (pas admin) et le force push est interdit par un
  ruleset sur les branches distribuées (GH-21, repli GH-22).
- **Étant donné** une étape en échec, **quand** le provisionnement est rejoué,
  **alors** l'opération est idempotente (pas de dépôt ni d'invitation en double).
- **Étant donné** une invitation de collaborateur expirée (7 jours GitHub), **quand** la
  tâche de rattrapage la détecte, **alors** une réinvitation est envoyée
  automatiquement (au plus une par 24 h) et l'étudiant est notifié (GH-24).

### US-21 — Rétablir les fichiers protégés

En tant que système, je restaure les fichiers protégés modifiés par l'étudiant afin de
garantir l'intégrité de l'énoncé et des critères.

- **Étant donné** un push étudiant modifiant au moins un fichier protégé, **quand** le
  webhook de push est reçu, **alors** le système pousse un commit de revert (identité
  bot) rétablissant ces fichiers dans leur dernière version légitime, sans toucher aux
  autres fichiers du push.
- **Étant donné** le commit de revert, **quand** il est poussé, **alors** son message
  identifie les fichiers restaurés et l'événement est journalisé et visible par
  l'enseignant.
- **Étant donné** un push du bot ou une synchronisation de l'enseignant (US-06) touchant
  un fichier protégé, **quand** le webhook est reçu, **alors** aucun revert n'est
  déclenché (pas de boucle).
- **Étant donné** plus de 5 reverts en une heure sur le même dépôt, **quand** un
  nouveau push touchant un fichier protégé arrive, **alors** le système suspend les
  reverts, marque le dépôt « fichiers protégés en conflit », notifie enseignant et étudiant
  et signale que la note courante n'est plus fiable ; l'enseignant réarme la protection
  depuis l'interface (revert final + remise à zéro du compteur, GH-35).

### US-22 — Appliquer la stratégie de délai de rendu

En tant que système, j'applique la stratégie de délai de rendu à l'échéance afin de figer
l'état des rendus.

- **Étant donné** un devoir publié, **quand** le délai de rendu (Europe/Zurich) est
  atteint, **alors** la tâche de délai de rendu **démarre au plus 60 s après l'échéance** et
  l'application sur l'ensemble des dépôts (jusqu'à 100) s'achève en moins de
  5 minutes (budget global, NFR-13).
- **Étant donné** la stratégie `lock` avec des rulesets disponibles, **quand** la tâche
  s'exécute, **alors** chaque dépôt devient en lecture seule pour l'étudiant sur les
  branches distribuées ; la GitHub App (bot) **et** les admins de l'organisation
  (enseignant) conservent l'accès en écriture via les bypass actors du ruleset (GH-41).
- **Étant donné** le repli `archiving` (rulesets indisponibles), **quand** il est
  appliqué, **alors** le dépôt entier devient en lecture seule **pour tous, bot
  compris** ; ce mode dégradé est signalé à l'enseignant, et toute écriture restante du bot
  (revert final, commit correctif) est effectuée avant l'archivage.
- **Étant donné** la stratégie `deadline commit`, **quand** le délai de rendu est atteint,
  **alors** le bot pousse un commit « deadline » vide horodaté sur chaque branche distribuée
  de chaque dépôt ; le dépôt reste ouvert et la note gelée est déterminée
  par GR-12 à GR-14 (les runs déclenchés par le commit du bot sont ignorés, GH-44).
- **Étant donné** une indisponibilité de la tâche à l'heure H, **quand** la tâche reprend,
  **alors** elle rattrape les délais de rendu manqués sans double application.

### US-23 — Collecter les métriques par webhooks

En tant que système, je collecte les événements GitHub afin de tenir les
tableaux de bord à jour sans interrogation périodique.

- **Étant donné** un push sur un dépôt étudiant, **quand** le webhook est reçu,
  **alors** la date et le hash du dernier commit sont mis à jour en base, avec l'**heure
  serveur de réception persistée par SHA** (référence pour le gel de la note, GR-14).
- **Étant donné** un webhook perdu ou rejeté, **quand** la tâche de rattrapage périodique
  s'exécute, **alors** l'état est réconcilié via l'API GitHub (interrogation périodique
  de secours uniquement).
- **Étant donné** tout webhook entrant, **quand** il est traité, **alors** sa
  signature (secret partagé) a été vérifiée, faute de quoi il est rejeté.

### US-24 — Extraire la note depuis la CI

En tant que système, j'extrais la note émise par `grading.yml` afin de l'afficher aux
deux rôles.

- **Étant donné** un événement `workflow_run` terminé pour le workflow de notation sur
  une branche distribuée, avec un head commit non poussé par le bot, **quand** le
  système lit les check runs associés, **alors** il extrait la note de
  l'annotation conforme à la convention **GR-02** (spécifiée dans les spécifications
  fonctionnelles) et l'enregistre avec run, hash et horodatage.
- **Étant donné** une annotation absente, malformée ou multiple alors que
  `grading.yml` existe, **quand** l'extraction échoue, **alors** le run est marqué
  `undetermined grade` (distinct de fail) et l'anomalie est journalisée et visible par
  l'enseignant.
- **Étant donné** un dépôt sans `grading.yml`, **quand** un run CI se termine,
  **alors** seul le statut pass/fail agrégé (GR-06) est enregistré.
- **Étant donné** un run portant sur une ref de synchronisation (`sync/*`) ou sur un commit
  du bot, **quand** l'événement est reçu, **alors** il est ignoré (pas de GradeRun,
  GR-05).

# Exigences non fonctionnelles

## Sécurité

- **NFR-01** — Toute authentification au portail passe par Switch edu-ID (OIDC) ;
  aucun mot de passe local. La liaison GitHub utilise OAuth avec la portée minimale
  nécessaire.
- **NFR-02** — Les opérations sur GitHub sont réalisées via des jetons d'installation
  GitHub App de courte durée ; aucun token personnel d'utilisateur n'est stocké (le
  token OAuth de liaison est jeté après lecture de l'identité, AU-09).
- **NFR-03** — Les clés d'API sont stockées hachées, à portée limitée à l'enseignant
  propriétaire, révocables immédiatement ; l'API par clé est en lecture seule.
- **NFR-04** — Tous les webhooks entrants sont authentifiés par signature ; les
  payloads non signés ou invalides sont rejetés et comptabilisés.
- **NFR-05** — Les actions sensibles (réclamation et rattachement de liste, revert,
  verrouillage, génération/révocation de clé, synchronisation, changement de rôle) sont
  journalisées de manière immuable (piste d'audit horodatée), sous réserve de la
  pseudonymisation prévue par NFR-07.

## Confidentialité

- **NFR-06** — Tous les dépôts (source, squashé, étudiant) sont privés. Un étudiant
  n'a accès qu'à son propre dépôt ; aucun étudiant ne peut voir le dépôt, le statut ou
  la note d'un autre.
- **NFR-07** — Les données personnelles (nom, e-mail, login GitHub) sont limitées au
  strict minimum et visibles uniquement par l'enseignant de la classe et par l'étudiant
  concerné. Suppression sur demande (conformité LPD) : le compte et les entrées de
  liste sont **anonymisés** (champs personnels remplacés par un pseudonyme), les
  GradeRuns et les métriques sont conservés rattachés au pseudonyme, les entrées d'audit
  sont pseudonymisées (l'immuabilité de NFR-05 porte sur les faits, pas sur
  l'identité). Les dépôts GitHub ne sont pas supprimés par la plateforme : l'accès
  collaborateur de l'étudiant est retiré et le sort du dépôt revient à l'enseignant et à
  l'organisation.

## Disponibilité, fiabilité et sauvegarde

- **NFR-08** — Disponibilité cible du portail : 99 %, mesurée **mensuellement pendant
  les semestres académiques** (calendrier HEIG-VD), par une sonde externe sur un endpoint
  de santé (`/healthz`, période 60 s). Les maintenances planifiées annoncées au moins
  48 h à l'avance sont exclues de la mesure. Une indisponibilité du portail n'empêche
  jamais les étudiants de travailler (les dépôts GitHub restent accessibles).
- **NFR-09** — Les tâches critiques (délai de rendu, revert, provisionnement) sont
  idempotentes et rejouables ; les délais de rendu manqués pendant une panne sont
  rattrapés automatiquement à la reprise du service.
- **NFR-10** — Le système respecte les limites de débit de l'API GitHub : collecte par
  webhooks, appels d'API avec backoff, interrogation périodique limitée au rattrapage.
- **NFR-16** — Les données dont la plateforme est la source de vérité (comptes et
  liaisons, liste des étudiants et réclamations, clés d'API, piste d'audit, GradeRuns et
  notes gelées, configuration des devoirs — voir C-01) font l'objet d'une **sauvegarde
  quotidienne** de la base de données, rétention de 30 jours, avec une procédure de
  restauration testée au moins une fois par semestre. Objectifs : RPO ≤ 24 h, RTO ≤ 4 h.

## Performance

- **NFR-11** — Dimensionnement de référence : 30 à 100 étudiants par classe,
  jusqu'à 20 classes actives simultanément. Les vues tabulaires (liste des étudiants,
  état d'un devoir) s'affichent en moins de 2 s à 100 lignes.
- **NFR-12** — Latence de bout en bout : note visible dans le portail moins de 2 minutes
  après la fin du run CI ; revert de fichier protégé poussé moins de 60 s après
  réception du webhook ; provisionnement d'un dépôt (création + **envoi** de
  l'invitation de collaborateur) en moins de 60 s — l'acceptation de l'invitation par
  l'étudiant est hors SLA.
- **NFR-13** — Budget de délai de rendu (aligné avec US-22 et §2.3) : démarrage de la
  tâche ≤ 60 s après l'échéance ; application complète de la stratégie sur 100 dépôts
  ≤ 5 minutes, sans dépasser les quotas GitHub.

## Internationalisation et accessibilité

- **NFR-14** — L'interface est livrée en français ; l'architecture de l'interface
  externalise les chaînes pour permettre l'ajout de l'anglais sans refonte. Dates et
  heures affichées en Europe/Zurich.
- **NFR-15** — Accessibilité sur les quatre parcours principaux (connexion, réclamation,
  acceptation d'un devoir, consultation des statuts) : conformité aux critères
  WCAG 2.1 AA suivants — 1.1.1 (alternatives textuelles), 1.3.1 (information et relations),
  1.4.3 (contraste minimum), 2.1.1/2.1.2 (clavier, pas de piège), 2.4.6 (en-têtes et
  étiquettes), 2.4.7 (focus visible), 3.3.1 et 3.3.2 (identification des erreurs,
  étiquettes de formulaire), 4.1.2 (nom, rôle, valeur). Vérification à la recette :
  audit outillé (axe-core ou équivalent) sans violation sur ces critères + parcours
  complet au clavier.

## Notifications

- **NFR-17** — Les notifications (NT-01 à NT-03 des spécifications) sont délivrées
  **in-app** obligatoirement ; l'e-mail est un canal optionnel (opt-in par utilisateur),
  envoyé de manière asynchrone avec nouvelle tentative en cas d'échec, sans données
  personnelles superflues dans le corps du message. Aucune exigence fonctionnelle ne
  repose sur la seule délivrance d'un e-mail.

# Contraintes

- **C-01 — Sources de vérité partagées** : GitHub est la source de vérité (SoT) pour
  le **contenu Git** (dépôts, historique, branches), les runs CI et leurs résultats
  bruts ; pour ces données, la base de la plateforme n'est qu'un cache/index
  reconstructible et, en cas de divergence, GitHub prévaut. La plateforme est en
  revanche la **seule** source de vérité pour : les comptes et liaisons, la liste des
  étudiants et les réclamations, la configuration des devoirs, les clés d'API, la piste
  d'audit, les GradeRuns et les notes gelées — d'où l'exigence de sauvegarde NFR-16.
- **C-02 — Fuseau horaire** : tous les délais de rendu sont saisis et évalués en
  Europe/Zurich (gestion correcte des changements d'heure) ; le stockage interne est en
  UTC avec conversion à l'affichage.
- **C-03 — GitHub App** : l'intégration avec l'organisation repose sur une GitHub App
  installée par un admin de l'organisation ; sans installation, aucune classe ne peut
  être activée.
- **C-04 — CI sur GitHub Actions** : la notation s'exécute exclusivement sur GitHub
  Actions dans le dépôt étudiant ; la plateforme n'exécute jamais de code étudiant.
- **C-05 — Identité bot** : tous les commits automatiques (revert, délai de rendu,
  synchronisation) utilisent une identité bot dédiée et identifiable, distincte des
  comptes humains.
- **C-06 — Comptes GitHub personnels** : les étudiants utilisent leur propre compte
  GitHub ; la plateforme ne crée pas de compte GitHub et ne stocke aucune information
  d'authentification GitHub d'utilisateur (voir NFR-02, AU-09).
- **C-07 — Vérifications GitHub préalables (bloquantes, avant le jalon M2)** : les
  points suivants conditionnent la faisabilité du provisionnement pour 100 étudiants et
  doivent être vérifiés sur l'organisation cible avant tout développement du
  provisionnement :

  1. Plan de l'organisation (Team/Enterprise via GitHub Education) et disponibilité
     des **rulesets sur dépôts privés** (requis par GH-21 et GH-41).
  2. **Politique de facturation des outside collaborators** sur dépôts privés (une
     place par collaborateur sur le plan Team : 100 étudiants = 100 places).
  3. **Quotas d'invitation anti-abus** par organisation et par 24 h.

  Un plan B est documenté si l'un de ces points bloque : organisation vérifiée par GitHub
  Education (places gratuites), étalement des invitations dans le temps, ou ajout des
  étudiants comme membres de l'organisation avec la permission de base `none`.

  **État au 2026-07-03** (vérifié sur l'organisation cible `heig-tin-info`) :

  1. Vérifié — plan **GitHub Team** avec 100 % de remise GitHub Education (0 CHF/mois). Les
     rulesets de branche sur dépôts privés sont donc disponibles (GH-21, GH-41 OK).
     Les *push rulesets* (restriction de chemin) restent réservés à Enterprise, mais
     la stratégie retenue (commit de revert, GH-30+) ne les utilise pas.
  2. Traité (2026-07-03) — **15 licences** pour 9 membres actuels : chaque outside
     collaborator sur un dépôt privé consomme une place. Demande de places via le
     programme GitHub Education effectuée (≥ effectif étudiant + marge ; la remise de
     100 % s'applique aux places supplémentaires).
  3. À vérifier — quotas d'invitation par 24 h. L'étude préliminaire S2 (2026-07-06, voir
     `docs/spikes/S2-rapport.md`) a validé toute la chaîne de provisionnement
     (30 dépôts, 4 s chacun, zéro 403) ; le quota d'invitation reste mesuré
     passivement en M2 via le limiteur de débit configurable.
  4. Action requise — **minutes GitHub Actions** : 3 000 min/mois incluses (plan Team) et les
     dépôts étudiants sont privés — la notation CI d'environ 100 étudiants peut dépasser ce budget.
     Prévoir un **runner auto-hébergé** pour la notation, ou vérifier une extension des
     minutes via Education (à trancher en phase 3).

# Glossaire

| Terme | Définition |
| --- | --- |
| **Classe** | Regroupement de devoirs et d'une liste des étudiants, adossé à une organisation GitHub, possédé par un enseignant. |
| **Devoir** | Travail distribué aux étudiants : dépôt source, dates, stratégies, fichiers protégés. États : draft, published, locked. |
| **Liste des étudiants** | Liste des étudiants d'une classe importée par l'enseignant (nom, prénom, e-mail). |
| **Entrée de liste (Enrollment)** | Ligne de la liste des étudiants ; statuts `pending` (« non réclamée ») / `claimed` (« réclamée »). |
| **Réclamation** | Rattachement automatique d'une entrée de liste au compte de plateforme d'un étudiant, sur correspondance d'e-mail vérifié. |
| **Dépôt source** | Dépôt privé de l'organisation où l'enseignant rédige l'énoncé. |
| **Dépôt squashé** | Dépôt privé généré par la plateforme à la création du devoir, base des dépôts étudiants et des PR de synchronisation. |
| **Commit primaire** | Commit du dépôt squashé représentant l'état publié complet de la source à un instant donné (stratégie `squash`). |
| **Dépôt étudiant** | Dépôt privé personnel provisionné à l'acceptation d'un devoir. |
| **Fichiers protégés** | Fichiers de l'énoncé automatiquement restaurés (commit de revert) s'ils sont modifiés par l'étudiant. |
| **Verrouillage** | Stratégie de délai de rendu rendant le dépôt en lecture seule pour l'étudiant (ruleset ; repli par archivage). |
| **Commit de délai de rendu** | Stratégie de délai de rendu : commit vide horodaté poussé par le bot, dépôt laissé ouvert. |
| **GradeRun** | Enregistrement immuable d'un run CI capté (run, commit, conclusion, note éventuelle). |
| **Note indicative** | Note extraite de la CI, non contractuelle, jamais exportée vers le système d'information académique. |
| **Note gelée** | Note retenue au délai de rendu selon GR-12 à GR-14 (commit reçu avant l'échéance, heure serveur). |
| **GitHub App / bot** | Identité machine de la plateforme ; les jetons d'installation servent toutes les opérations GitHub. |
| **Ruleset** | Règles GitHub par dépôt/branches (blocage du force push, verrouillage) avec bypass actors. |
| **Squash (stratégie de source)** | Distribution de l'état de la source sous forme de commits primaires, sans l'historique de l'enseignant. |
| **Dépôt entier (stratégie de source)** | Distribution du miroir complet des branches sélectionnées (historique inclus). |

# Hypothèses à valider {#sec:assumptions}

Décisions prises pour lever les ambiguïtés relevées ; chacune est à confirmer (ou à
infirmer) par le maître d'ouvrage.

> **Statut** : hypothèses H1 à H12 validées en l'état par le maître d'ouvrage
> le 2026-07-03. Elles font désormais partie du périmètre contractuel de la v1.
> **Révision du 2026-07-07 — H2** : un rôle applicatif **admin** est introduit.
> Le super-administrateur (unique, e-mail dans la configuration du serveur) gère les
> enseignants **en base de données** depuis un écran d'administration : octroi par e-mail
> (identité complétée à la première connexion), révocation à effet immédiat, compteurs
> de classes/devoirs. Le rôle est toujours recalculé à chaque connexion.

- **H1 — Prolongations individuelles du délai de rendu exclues de la v1.** Le ruleset de
  verrouillage est retenu notamment parce qu'il rend cette évolution possible plus tard,
  mais aucun flux de déverrouillage/nouveau délai n'est spécifié ni livré en v1.
- **H2 — Pas de rôle admin applicatif en v1.** Le rôle enseignant est accordé via une
  liste d'e-mails/`sub` edu-ID dans la configuration du serveur, gérée par l'exploitant.
- **H3 — Réclamation automatique de la liste des étudiants** à la connexion, sur e-mail
  vérifié, sans confirmation explicite de l'étudiant (écran récapitulatif informatif). La
  liaison GitHub n'est pas requise pour la réclamation, seulement pour accepter un devoir.
- **H4 — Import CSV atomique** : rejet total en cas de doublon intra-fichier ; les
  e-mails déjà en base sont mis à jour (upsert), jamais ignorés ni supprimés.
- **H5 — Note falsifiable acceptée.** Le code étudiant qui s'exécute dans le run peut
  émettre lui-même une annotation `GRADE` : le risque est documenté (GR-02) et jugé
  acceptable car la note est indicative. Mitigation : toute annotation `GRADE`
  multiple (même à valeurs identiques) invalide la note du run. L'alternative
  « artefact signé » (GR-16) est réservée à une version ultérieure.
- **H6 — Gel de la note sur l'heure serveur** : la référence pour le gel est l'heure de
  réception du webhook de push par la plateforme (persistée par SHA), jamais
  l'horodatage git (falsifiable). Période de grâce par défaut : 30 minutes.
- **H7 — CLI minimale livrée** (`hgc` : `classrooms`, `assignments`, `repos`, `clone`),
  en complément de l'API — voir le jalon M7 du plan de phase 1.
- **H8 — Repli par archivage assumé** : si les rulesets sont indisponibles, le verrouillage
  se fait par archivage, ce qui retire l'accès en écriture à tout le monde (bot compris) ;
  mode dégradé signalé, sans revert ni synchronisation post-délai possibles.
- **H9 — Statut CI agrégé** (dépôts sans `grading.yml`) : agrégation de tous les
  workflows terminés sur le dernier commit étudiant des branches distribuées — `fail`
  s'il y a au moins un échec (GR-06).
- **H10 — Plafond anti-boucle des reverts** : 5 reverts/heure/dépôt, puis suspension et
  résolution manuelle par l'enseignant (GH-33, GH-35).
- **H11 — Suppression LPD par anonymisation** (pas d'effacement physique des
  GradeRuns ni de l'audit, qui sont pseudonymisés) ; les dépôts GitHub ne sont jamais
  supprimés par la plateforme.
- **H12 — `grading.yml` protégé par défaut** : précoché dans les fichiers protégés
  s'il existe dans la source ; l'enseignant peut le décocher (avertissement affiché).
