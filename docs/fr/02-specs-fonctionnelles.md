---
title: Spécifications fonctionnelles
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
> Cadre : `01-cahier-des-charges.md` (US-xx, NFR-xx, C-xx) ;
> analyse : `00-analyse-besoins.md`.
> Conventions : exigences numérotées par domaine — `AU-xx` (authentification, prise en main, API),
> `GH-xx` (intégration GitHub), `GR-xx` (notation et métriques), `CLI-xx` (CLI),
> `NT-xx` (notifications). MUST = obligatoire, SHOULD = recommandé. Les identifiants
> sont stables et uniques.

# Authentification et prise en main (AU)

## Connexion à la plateforme — Switch edu-ID (OIDC)

Switch edu-ID est le seul fournisseur d'identité pour la session web. Aucun mot de
passe local (NFR-01).

- **AU-01** — La plateforme MUST authentifier les utilisateurs par OpenID Connect avec
  Switch edu-ID, flux *Authorization Code + PKCE*, avec `state` et `nonce` vérifiés.
- **AU-02** — Portées demandées : `openid profile email`. Claims attendus dans le jeton
  d'identité / userinfo :

| Claim | Usage | Obligatoire |
| --- | --- | --- |
| `sub` | Identifiant stable du compte local (clé de rattachement) | Oui |
| `email` | Correspondance avec la liste des étudiants, affichage | Oui |
| `email_verified` | La réclamation de la liste des étudiants exige `true` | Oui |
| `given_name` | Prénom | Oui |
| `family_name` | Nom | Oui |
| `swissEduPersonUniqueID` | Identifiant académique, stocké s'il est présent (déduplication) | Non |

- **AU-02b** — (GH-11) Face à Switch edu-ID, la portée `https://eduid.ch/scope/userinfo.read`
  MUST être demandée en plus : c'est derrière elle que se trouvent les adresses des
  affiliations institutionnelles (`swissEduIDLinkedAffiliationMail`) et les affiliations
  elles-mêmes, sans lesquelles un étudiant inscrit avec une adresse privée reste
  introuvable dans la liste des étudiants. La portée n'est ajoutée que pour un émetteur
  edu-ID — un IdP qui ne la connaît pas répondrait `invalid_scope`. edu-ID ne libère ces
  claims **par défaut que sur le point d'accès userinfo** : il MUST donc être interrogé à
  chaque connexion, et un échec de cet appel MUST rester sans effet sur la session tant
  que le jeton d'identité suffit. Ce qu'edu-ID libère réellement dépend de la
  configuration du client dans le Resource Registry.
- **AU-02c** — (GH-11) L'ensemble des claims libérés MUST être persisté à chaque connexion
  (`user_idp_claims`, une ligne par compte, écrasée). Dérogation assumée à la
  minimisation : un incident d'authentification coûte cher à diagnostiquer après coup. En
  contrepartie, la table MUST rester confinée au serveur — jamais jointe à une vue
  utilisateur, jamais affichée, jamais exposée par l'API.
- **AU-02d** — (GH-11) Un compte est identifié par un **ensemble d'adresses** :
  l'adresse de connexion (`email`) et les adresses institutionnelles portées par
  `swissEduIDLinkedAffiliationMail`. Elles sont enregistrées dans `user_emails` à
  chaque connexion et ne sont jamais retirées — une affiliation qui prend fin ne doit pas
  détacher un étudiant en milieu de semestre. Tout rattachement (liste des étudiants,
  places du personnel, octrois d'enseignant, rôle) MUST se faire sur cet ensemble, jamais
  sur la seule adresse de connexion. Seules les adresses vérifiées comptent : celle de
  connexion porte l'`email_verified` de l'IdP, celles affirmées par l'organisation sont
  vérifiées par construction.
- **AU-02e** — (GH-11) Un rattachement ambigu MUST être signalé, jamais deviné. Trois
  cas : l'adresse d'une ligne de la liste des étudiants est détenue par deux comptes ;
  plusieurs lignes de la même classe correspondent au même compte ; le compte détient
  déjà une ligne dans cette classe. Les trois lèvent `conflict_flag` (AU-21) et n'écrivent
  aucun rattachement. Une place du personnel ambiguë reste non réclamée.
- **AU-02f** — (GH-11) Le rôle `teacher` est octroyé, en plus des `teacher_grants` et des
  places du personnel (GH-9), à un compte dont les affiliations edu-ID contiennent `staff`
  sans `student`. Un assistant étudiant porte les deux et reste `student`. Les gardes de
  classe sont inchangées : ce rôle ne donne accès à la classe de personne d'autre.
- **AU-03** — À la première connexion réussie, le backend MUST créer un compte local :
  `{ oidc_sub, email, email_verified, given_name, family_name, role, created_at }`.
  Le compte est identifié par `oidc_sub`, jamais par le courriel (le courriel edu-ID peut
  changer).
- **AU-04** — À chaque connexion, les champs de profil (`email`, noms) MUST être
  resynchronisés depuis les claims.
- **AU-05** — Si `email_verified` est absent ou `false`, la connexion est acceptée
  mais la réclamation de la liste des étudiants (§1.4) MUST être bloquée avec un message
  explicite.
- **AU-06** — Session web : cookie de session `HttpOnly`, `Secure`, `SameSite=Lax`,
  durée maximale 12 h, invalidable côté serveur. Aucun jeton OIDC n'est exposé au frontend.
- **AU-07** — Le rôle par défaut d'un nouveau compte est `student`. Le rôle `teacher`
  MUST être octroyé exclusivement par une **liste de courriels/`sub` autorisés dans la
  configuration du serveur** (rechargée sans redéploiement), gérée par l'exploitant de la
  plateforme. Il n'existe pas de rôle d'administrateur applicatif en v1 (hypothèse H2 du
  cahier des charges) ; aucune auto-promotion n'est possible.

## Liaison du compte GitHub (OAuth séparé)

La liaison GitHub ne sert qu'à établir l'identité GitHub de l'utilisateur ; les
opérations sur les dépôts passent par la GitHub App de l'organisation, jamais par un
token utilisateur (NFR-02, C-06).

- **AU-08** — La liaison MUST utiliser un flux OAuth GitHub (web application flow)
  distinct de la connexion, déclenchable uniquement par un utilisateur déjà authentifié
  avec edu-ID. Portée minimale : `read:user` (aucune portée d'écriture).
- **AU-09** — Après le callback, le backend MUST stocker sur le compte :
  `github_user_id` (immuable, clé de référence), `github_login` (affichage,
  resynchronisé périodiquement puisqu'il est modifiable), `github_linked_at`. Le token
  OAuth GitHub MUST être **jeté** immédiatement après la lecture de l'identité ; il n'est
  jamais persisté (conformité C-06 et NFR-02).
- **AU-10** — Un `github_user_id` MUST être lié à au plus un compte local. En cas de
  conflit, la liaison est refusée avec un message indiquant qu'un autre compte de la
  plateforme utilise déjà ce compte GitHub.
- **AU-11** — Un étudiant sans liaison GitHub MUST pouvoir naviguer et consulter ses
  devoirs ; seule l'**acceptation d'un devoir** est bloquée tant que la liaison n'est pas
  faite (bandeau de prise en main). Comportement de référence pour
  US-10.
- **AU-12** — Déliaison : l'utilisateur MUST pouvoir délier son compte GitHub. La
  déliaison ne retire pas les accès de collaborateur déjà provisionnés sur les dépôts
  existants ; elle bloque toute nouvelle acceptation de devoir. Une reliaison vers un
  autre compte GitHub MUST être journalisée (audit) et notifiée aux enseignants des
  classes concernées (NT-03).

## Import de la liste des étudiants par l'enseignant

- **AU-13** — L'enseignant MUST pouvoir importer la liste des étudiants d'une classe
  par un fichier CSV, encodage UTF-8, séparateur `,` ou `;` (détecté automatiquement),
  avec une ligne d'en-tête obligatoire :

```text
nom,prenom,email
Dupont,Marie,marie.dupont@heig-vd.ch
Martin,Luc,luc.martin@heig-vd.ch
```

- **AU-14** — Validation à l'import : courriel syntaxiquement valide, normalisé (trim,
  minuscules) ; lignes vides ignorées ; doublons de courriel **intra-fichier** rejetés
  avec le numéro de ligne. L'import est **atomique : tout ou rien**, avec un rapport
  d'erreurs. Cette sémantique est la référence unique (US-02 s'y conforme).
- **AU-15** — Chaque ligne crée une entrée de liste des étudiants
  `Enrollment { classroom_id, nom, prenom, email, status }` avec `status = pending`.
  Statuts : `pending` / `claimed` (libellés français « non réclamée » / « réclamée » à
  l'affichage — vocabulaire unique pour tous les documents). Le même courriel peut
  apparaître dans plusieurs classes (une entrée par classe).
- **AU-16** — Réimport : **upsert par courriel** — les entrées existantes (y compris
  celles en `claimed`) sont conservées et leurs nom/prénom mis à jour, les nouvelles sont
  ajoutées. Les entrées absentes du fichier ne sont PAS supprimées automatiquement ;
  l'enseignant les retire individuellement (AU-17).
- **AU-17** — L'enseignant MUST pouvoir ajouter/modifier/supprimer une entrée de la liste
  des étudiants manuellement (mêmes champs que le CSV). S'il existe un dépôt étudiant pour
  cette entrée, la suppression directe est bloquée : une **désinscription explicite** est
  requise, dont les effets sont : retrait de l'accès de collaborateur de l'étudiant sur
  les dépôts de la classe, **conservation** des dépôts (archivage à la discrétion de
  l'enseignant, GH-25), conservation des GradeRuns et des métriques, journalisation (audit).

## Réclamation de la liste des étudiants par l'étudiant

Flux unique : **réclamation automatique** à la connexion, sur un courriel vérifié, sans
confirmation explicite et sans exiger la liaison GitHub (référence pour US-11 ;
hypothèse H3).

- **AU-18** — Après la connexion edu-ID (avec `email_verified = true`), le backend MUST
  chercher les entrées `pending` de la liste des étudiants dont le courriel normalisé est
  égal au courriel edu-ID normalisé, et les rattacher automatiquement au compte :
  `status = claimed`, `user_id` renseigné, `claimed_at` horodaté. Toutes les classes
  correspondantes sont réclamées en une fois ; un écran de synthèse informe l'étudiant des
  classes rejointes. Le `github_login` n'apparaît dans la liste des étudiants qu'après la
  liaison GitHub (AU-09), qui n'est pas une condition de la réclamation.
- **AU-19** — La correspondance MUST être exacte (insensible à la casse) sur le courriel
  complet. Aucune correspondance approximative automatique (nom/prénom).
- **AU-20** — Cas sans correspondance : le compte est créé mais sans inscription.
  L'étudiant voit un écran « aucune classe trouvée pour `<email>` » l'invitant à
  contacter son enseignant. L'enseignant MUST pouvoir résoudre le cas soit en corrigeant
  le courriel de l'entrée de la liste des étudiants (la réclamation se rejoue à la
  prochaine connexion ou via un bouton « nouvelle tentative »), soit en rattachant
  manuellement l'entrée à un compte existant depuis la vue de la liste des étudiants.
- **AU-21** — Cas ambigus : une entrée de la liste des étudiants ne peut être `claimed`
  que par un seul compte (contrainte d'unicité `enrollment → user`). Si le courriel d'un
  compte correspond à une entrée déjà réclamée par un autre compte, aucun rattachement
  n'a lieu et l'anomalie est signalée à l'enseignant (badge « conflit » dans la vue de la
  liste des étudiants) ; résolution manuelle par l'enseignant uniquement.
- **AU-22** — Un rattachement manuel par l'enseignant (AU-20, AU-21) MUST être
  journalisé (qui, quand, quelle entrée, quel compte).

## Rôles et autorisations

- **AU-23** — Deux rôles applicatifs : `teacher` et `student` (octroi du rôle
  d'enseignant : AU-07). Matrice d'accès :

| Ressource | Enseignant (propriétaire) | Étudiant |
| --- | --- | --- |
| Classe (création, modification, suppression) | Oui (les siennes) | Non |
| Liste des étudiants (import, modification, conflits, github_login, dernière connexion) | Oui | Non |
| Devoirs (création, publication, modification contrôlée US-08, suppression avec archivage GH-25, synchronisation, verrouillage) | Oui | Lecture seule, uniquement ceux de ses classes |
| Dépôts étudiants (liens, métriques, notes) | Tous ceux de ses classes | Uniquement les siens (lien, statut CI, note indicative) |
| Dépôt source et dépôt squashé | Oui | Non (ni le lien, ni l'existence) |
| Clés d'API | Oui (les siennes) | Non |

- **AU-24** — Toute autorisation MUST être vérifiée côté backend à chaque requête
  (propriété de la classe pour l'enseignant, inscription `claimed` pour l'étudiant).
  Le filtrage dans l'interface n'est jamais suffisant.
- **AU-25** — Un enseignant ne voit pas les classes d'un autre enseignant. (Le partage
  de classe entre co-enseignants est hors du périmètre v1 ; le modèle
  `classroom → teacher` reste extensible en 1-N.)
- **AU-26** — Les notes et les métriques d'un étudiant ne sont jamais visibles par un
  autre étudiant.

## Dernière connexion

- **AU-27** — Le backend MUST horodater `last_login_at` à chaque création de session
  edu-ID réussie. C'est cette valeur (connexion au portail) qui est affichée dans le
  tableau de la liste des étudiants de l'enseignant — décision sur la question ouverte
  §5.5 de l'analyse.
- **AU-28** — La date du dernier push (`last_commit_at` par dépôt) est une métrique
  distincte, affichée au niveau du devoir, et ne remplace PAS `last_login_at`.

# Intégration GitHub (GH)

## GitHub App

### Modèle et permissions

- **GH-01** — L'intégration repose sur une unique **GitHub App** (pas d'OAuth App pour
  les opérations serveur), installée sur chaque organisation adossée à une classe.
  Les tokens d'installation offrent des permissions fines, un quota de 5 000 req/h
  **par installation** (donc par organisation) et une identité de bot dédiée
  (`<app-slug>[bot]`).
- **GH-02** — L'App demande les **permissions minimales** suivantes :

| Permission (dépôt) | Niveau | Usage |
| --- | --- | --- |
| Metadata | Read | Obligatoire (base de l'API) |
| Administration | Read & write | Créer les dépôts, gérer les collaborateurs, rulesets, archivage |
| Contents | Read & write | Push squashé, commits de revert, commit de délai de rendu, lecture des arbres |
| Workflows | Read & write | Pousser des dépôts contenant `.github/workflows/grading.yml` |
| Pull requests | Read & write | PR de synchronisation |
| Checks | Read | Lecture des check-runs et des annotations (notation, §3) |
| Actions | Read | Détails du `workflow_run` |

Aucune permission d'*organisation* n'est requise hormis **Members: Read** (optionnelle,
validation de l'appartenance de l'enseignant à l'org). Toute permission supplémentaire est
interdite sans révision de cette spécification.

- **GH-03** — L'authentification de l'App suit le schéma standard : JWT signé avec la clé
  privée (durée ≤ 10 min) → `POST /app/installations/{id}/access_tokens` →
  **token d'installation** (durée 1 h). Le backend met le token en cache par
  installation et le renouvelle à T−10 min ; il n'est jamais persisté en base ni
  exposé au front. Les opérations git (push) utilisent
  `https://x-access-token:<token>@github.com/...`.

### Installation sur l'organisation

- **GH-04** — À la création d'une classe, l'enseignant choisit l'organisation cible :
  la plateforme le redirige vers la page d'installation de l'App
  (`https://github.com/apps/<slug>/installations/new`) avec un `state` signé (CSRF + id
  de classe). Portée recommandée : **All repositories** (les dépôts étudiants sont
  créés dynamiquement ; la portée « selected » imposerait un ajout manuel à chaque
  provisionnement).
- **GH-05** — Le webhook `installation` (`created`) confirme l'installation ; le
  backend enregistre `installation_id` sur l'`Organization` et vérifie que le compte
  installé correspond à l'organisation attendue. Une classe ne peut être activée
  qu'avec une installation valide.
- **GH-06** — Les événements `installation` (`deleted`, `suspend`) et
  `installation_repositories` marquent l'organisation comme **dégradée** : les opérations
  d'écriture sont suspendues, l'enseignant est notifié (NT-03) avec un lien de
  réinstallation. Aucune donnée n'est supprimée.

## Dépôts sources et stratégies de source

### Création du dépôt squashé

- **GH-10** — À la création d'un devoir, le backend valide que le dépôt source
  appartient à l'organisation de la classe et que les branches sélectionnées
  existent, puis crée le dépôt **squashé** : privé, nommé `<source>-squashed`
  (suffixe numérique en cas de collision), description renvoyant au devoir.
  Son URL est exposée dans l'interface enseignant.
- **GH-11** — Le contenu du dépôt squashé est produit selon la **stratégie de source** du
  devoir (GH-12/GH-13) et poussé par le bot via git (pas l'API Contents,
  inadaptée aux arbres complets). Le dépôt squashé est **géré exclusivement par le bot** :
  un push manuel sur celui-ci est détecté (webhook `push`, auteur ≠ bot) et signalé à
  l'enseignant.

### Stratégie « dépôt entier »

- **GH-12** — Le dépôt squashé est un **miroir des branches sélectionnées** de la source :
  mêmes commits, mêmes SHA (`git push` des refs sélectionnées, sans tags ni autres
  refs). L'historique complet est donc transmis aux étudiants.

### Stratégie « squash en commits primaires »

- **GH-13** — Définition retenue : pour chaque branche sélectionnée, un **commit
  primaire** est l'état complet de la branche à un instant de publication.
  Concrètement :

  1. À la création du devoir, le dépôt squashé reçoit, par branche, **exactement un
     commit racine** dont l'arbre est celui du HEAD de la branche source.
     Auteur/committer : identité du bot. Message :

     ```text
     Initial version — <assignment>

     Source: <org>/<source>@<short-sha>
     ```

  2. À chaque synchronisation ultérieure (GH-50), un **nouveau commit primaire** est
     ajouté **par-dessus** le précédent : arbre = HEAD de la source, parent = HEAD du
     dépôt squashé. L'historique du dépôt squashé est donc la suite linéaire des versions
     publiées, sans exposer les commits intermédiaires de l'enseignant.
  3. Chaque commit primaire porte le SHA source dans son message (traçabilité) ; le
     backend persiste la correspondance `commit primaire ↔ sha source`.

- **GH-14** — Cette définition garantit que les dépôts étudiants et le dépôt squashé
  partagent un **ancêtre commun**, condition de PR de synchronisation propres (GH-52).
  Extension possible (hors périmètre v1) : des tags `primary/*` sur la source pour publier
  plusieurs jalons à la fois.

### Sélection des branches

- **GH-15** — Par défaut, la branche récupérée est la **branche par défaut de la
  source** ; si le devoir ne la précise pas, la règle est : `main` si elle existe,
  sinon `master`, sinon la branche par défaut GitHub. L'enseignant peut sélectionner
  des branches supplémentaires ; la première sélectionnée devient la branche par défaut des
  dépôts étudiants.

## Provisionnement du dépôt étudiant

- **GH-20** — À l'acceptation par l'étudiant, une tâche idempotente (clé
  `assignment_id + user_id`) s'exécute :

  1. Création du dépôt privé `<assignment-slug>-<github_login>` dans l'organisation
     (`POST /orgs/{org}/repos`, `auto_init: false`).
  2. **Push git des refs du dépôt squashé** (branches sélectionnées) — et non « generate
     from template », qui réécrirait l'historique et casserait l'ancêtre commun
     (GH-14).
  3. Ajout de l'étudiant comme collaborateur avec le rôle **push** (jamais
     maintain/admin) ; l'invitation GitHub est acceptée par l'étudiant (lien et état
     affichés dans l'interface tant qu'il est `pending`).
  4. Pose du ruleset de protection (GH-21).
  5. Enregistrement de `repo_url`, `default_branch`, `accepted_at` ; l'URL est
     affichée à l'étudiant.

  Tout échec partiel est repris par la tâche (le nom de dépôt existant est réutilisé,
  jamais dupliqué). Le SLA de 60 s (NFR-12) couvre les étapes 1 à 5, c'est-à-dire
  jusqu'à l'**envoi** de l'invitation ; l'acceptation de l'invitation par l'étudiant
  est hors SLA.
- **GH-21** — **Interdiction du force push et de la suppression de branche** : un
  **ruleset** au niveau du dépôt cible les branches sélectionnées avec les règles
  *block force pushes* et *restrict deletions*, **sans** contournement pour les
  collaborateurs ; l'App et le rôle **Organization admin** figurent comme acteurs de
  contournement. Contrainte : les rulesets sur les dépôts privés exigent un plan GitHub
  Team/Enterprise — vérification obligatoire avant M2, avec le coût en places des
  collaborateurs externes et les quotas d'invitations (**C-07** du cahier des charges).
- **GH-22** — Repli si les rulesets sont indisponibles : le webhook `push` expose
  `forced: true` ; le backend restaure alors la branche au dernier SHA connu d'un
  push du bot et notifie enseignant et étudiant. À cette fin (et pour le gel de la note,
  GR-14), le backend persiste **à chaque webhook push** : branche, SHA de tête et
  **heure de réception serveur**. Mode dégradé documenté, non silencieux.
- **GH-23** — L'étudiant n'obtient jamais de droit d'administration : il ne peut ni
  supprimer le dépôt, ni modifier les rulesets, ni gérer les webhooks (l'App reçoit
  ses événements au niveau de l'installation, sans webhook par dépôt).
- **GH-24** — **Cycle de vie des invitations** : les invitations de collaborateur GitHub
  expirent après 7 jours et il n'existe pas de webhook d'expiration. La tâche de
  réconciliation (GH-62) liste les invitations `pending`
  (`GET /repos/{owner}/{repo}/invitations`) ; si une invitation a expiré alors que
  l'étudiant n'a pas accès au dépôt, une réinvitation est envoyée automatiquement (au
  plus une par 24 h et par dépôt) et l'étudiant est notifié. L'étudiant et l'enseignant
  disposent en outre d'une action « renvoyer l'invitation » dans l'interface. L'état de
  l'invitation (`pending` / `expired` / `accepted`) est visible pour les deux rôles.
- **GH-25** — **Cascades de suppression** : la plateforme ne supprime **jamais** un
  dépôt GitHub silencieusement.

  1. Désinscription d'un étudiant (AU-17) : retrait de l'accès de collaborateur,
     conservation du dépôt (archivage proposé à l'enseignant).
  2. Suppression d'un devoir : confirmation explicite requise ; les dépôts
     étudiants sont **archivés** (jamais supprimés) et le dépôt squashé est conservé.
  3. Suppression d'une classe : refusée tant que des devoirs publiés subsistent ;
     mêmes règles d'archivage.

## Fichiers protégés — commit de revert

- **GH-30** — La liste des fichiers protégés (chemins exacts relatifs à la racine, pas de
  glob en v1) est définie sur le devoir. Pré-cochage à la création :
  `criteria.yml`, `README.md` **et `.github/workflows/grading.yml`** s'ils existent
  dans la source (cohérent avec GR-01 ; décocher `grading.yml` déclenche un
  avertissement, voir US-04). La **version de référence** d'un fichier protégé est
  celle du **dernier commit primaire/de synchronisation** poussé par le bot (pas la version
  initiale : une synchronisation peut légitimement les mettre à jour).
- **GH-31** — **Détection** : à chaque webhook `push` sur une branche sélectionnée
  d'un dépôt étudiant, si `sender` ≠ bot, le backend compare `before...after`
  (`GET /repos/.../compare`) et extrait l'intersection des fichiers touchés avec la
  liste protégée (modification, suppression ou renommage).
- **GH-32** — **Algorithme de revert** (Git Data API, atomique) :

  1. Lire le HEAD courant de la branche.
  2. Créer un arbre `base_tree = HEAD` en remplaçant chaque chemin protégé par le blob
     de référence (recréation s'il a été supprimé).
  3. Si l'arbre obtenu est identique à celui du HEAD, ne rien faire (déjà
     conforme).
  4. Créer le commit (auteur/committer bot) et avancer la ref en **fast-forward**
     (`update ref`, non forcé) — le travail de l'étudiant n'est jamais réécrit,
     seulement recouvert.

  Message de commit :

  ```text
  chore(protected): restore protected files

  Restored files: criteria.yml, README.md
  Reference: squashed@<short-sha>. These files are managed by the assignment
  and must not be modified.
  ```

- **GH-33** — **Anti-boucle** : les pushs dont l'auteur est le bot sont ignorés par
  GH-31. Si l'étudiant les remodifie, le revert se répète ; au-delà de **5 reverts /
  heure / dépôt**, le backend cesse de revert, marque le dépôt « fichiers protégés en
  conflit » et notifie l'enseignant (protection contre un script étudiant qui boucle et
  contre l'épuisement du quota). Ce plafond est un critère d'acceptation de US-21.
- **GH-34** — **Notification** : chaque revert notifie l'étudiant (NT-01, courriel
  optionnel NT-02) avec la liste des fichiers restaurés ; le compteur de reverts
  apparaît dans la vue enseignant du dépôt. La course « push étudiant pendant le revert »
  est bénigne : la mise à jour non forcée échoue et le webhook du nouveau push relance
  l'analyse.
- **GH-35** — **Résolution de l'état « fichiers protégés en conflit »** :

  1. Vue enseignant : le dépôt est signalé (badge), avec l'historique des reverts et une
     action **« réactiver la protection »** qui pousse un dernier revert, remet le
     compteur à zéro et réarme la détection.
  2. Vue étudiant : un bandeau explique que les fichiers protégés du dépôt ne sont plus
     restaurés automatiquement et l'invite à revenir à la version de référence.
  3. Tant que l'état persiste, la note courante du dépôt est marquée « à vérifier »
     dans la vue enseignant (les fichiers de critères peuvent être altérés) ; les
     GradeRuns continuent d'être enregistrés.

## Délai de rendu

- **GH-40** — Comparaison des mécanismes de **verrouillage** :

| Mécanisme | Effet | Le bot garde l'accès en écriture | L'étudiant garde l'accès en lecture | Réversible | Limites |
| --- | --- | --- | --- | --- | --- |
| Archivage du dépôt | Tout devient en lecture seule (code, issues, PR) | Non (désarchiver d'abord) | Oui | Oui (API) | Bloque aussi la synchronisation et le revert ; grossier mais simple |
| Retrait/rétrogradation des droits | Collaborateur passé en `pull` | Oui | Oui | Oui | Par collaborateur ; l'étudiant perd aussi la gestion de ses PR |
| Ruleset « lock branch » | Push bloqué sur les branches ciblées | **Oui (contournement App)** | Oui | Oui | Exige un plan Team/Enterprise (voir GH-21, C-07) |

- **GH-41** — Stratégie retenue : **ruleset de verrouillage**. Acteurs de contournement du
  ruleset : la **GitHub App** (revert tardif, commit correctif) **et le rôle Organization
  admin** (l'enseignant garde l'accès en écriture, comme US-22 le garantit) ; ces deux
  contournements font partie des critères d'acceptation. La réversibilité du ruleset est un
  atout pour une évolution future (prolongations individuelles du délai de rendu),
  **hors périmètre v1** (voir §3.2 du cahier des charges, hypothèse H1). L'**archivage**
  est le repli si les rulesets sont indisponibles : il est appliqué **après** toute
  écriture restante du bot et retire l'accès en écriture à tout le monde, bot et enseignant
  compris — la garantie d'accès en écriture de US-22 ne tient donc qu'en mode ruleset ; le
  mode archivage est signalé comme dégradé dans l'interface enseignant.
- **GH-42** — La stratégie du **commit de délai de rendu** pousse, à l'échéance, un commit
  **vide** signé par le bot sur chaque branche sélectionnée :

  ```text
  chore(deadline): deadline reached — <assignment> (2026-07-03T23:59:00+02:00)
  ```

  Le dépôt reste ouvert ; la **note indicative gelée** est déterminée par GR-12 à
  GR-14 (commits reçus avant le délai de rendu, heure serveur — le commit de délai de rendu
  lui-même et les exécutions qu'il déclenche sont ignorés, GH-44 et GR-05). Les deux
  stratégies sont exclusives et fixées par devoir.
- **GH-43** — La tâche de délai de rendu (ordonnanceur, fuseau **Europe/Zurich**) est
  idempotente, reprend les dépôts en échec, se replanifie si le délai de rendu est modifié
  (US-08), et journalise `locked_at` / `deadline_commit_sha` par dépôt. Budget de
  temps (unique, aligné sur US-22 et NFR-13) : **démarrage ≤ 60 s après l'échéance,
  application complète sur 100 dépôts ≤ 5 min**. Pour tout litige sur un push proche
  de l'échéance, c'est l'**heure de réception serveur du webhook push** qui prévaut
  (GR-14), jamais l'horodatage git.
- **GH-44** — **Effets de bord des pushs du bot** : les pushs effectués avec un token
  d'installation de GitHub App déclenchent les workflows Actions (contrairement au
  `GITHUB_TOKEN`). Conséquences et mitigations obligatoires :

  1. Les exécutions dont le commit de tête est un commit du bot (revert, commit de délai
     de rendu, synchronisation) sont **ignorées par la notation** : aucun GradeRun n'est
     créé (GR-05).
  2. Le modèle `grading.yml` fourni aux enseignants contient une condition de job
     `if: github.actor != '<app-slug>[bot]'` pour éviter les exécutions inutiles.
  3. Impact sur le quota : un commit de délai de rendu sur 100 dépôts peut déclencher
     jusqu'à 100 exécutions simultanées ; la consommation Actions correspondante est mesurée
     lors de l'étude préliminaire S3 et documentée avant le jalon M4.

## Synchronisation source → squashé → dépôts étudiants

- **GH-50** — **Déclenchement** : le webhook `push` sur une branche sélectionnée du
  dépôt **source** rend la synchronisation *disponible* dans l'interface enseignant (état
  « source en avance de N commits »). La propagation vers les étudiants est
  **déclenchée explicitement par l'enseignant** (pas d'auto-push : éviter d'inonder les
  étudiants de PR à chaque commit intermédiaire).
- **GH-51** — Sur demande de synchronisation, le backend met à jour le **dépôt squashé** :
  fast-forward des refs (stratégie dépôt entier) ou ajout d'un commit primaire
  (GH-13). Puis, pour chaque dépôt étudiant provisionné et non verrouillé :

  1. Push de la branche squashée vers la ref `sync/<branch>` du dépôt étudiant (mise à jour
     forcée autorisée sur cette seule ref du bot).
  2. Ouverture d'une PR `sync/<branch>` → `<branch>`, auteur bot, titre
     `Sync assignment update (<short-sha>)`, corps listant les fichiers modifiés.
  3. Si une **PR de synchronisation ouverte** existe déjà, elle est réutilisée (la ref est
     mise à jour, un commentaire signale la nouvelle version) — jamais deux PR de
     synchronisation ouvertes simultanément.

  Les pushs sur `sync/<branch>` peuvent déclencher des workflows : ces exécutions (branche
  non sélectionnée, commit du bot) sont **exclues de la notation et des métriques** (GR-05,
  GR-15).
- **GH-52** — **Conflits** : ils sont portés par la PR (GitHub les affiche) et résolus
  par l'étudiant ; le bot ne fusionne jamais automatiquement. Si le diff est vide pour un
  dépôt (étudiant déjà à jour), aucune PR n'est ouverte. L'état des PR de synchronisation
  (ouverte / fusionnée / en conflit) est agrégé dans la vue enseignant via les webhooks
  `pull_request`.
- **GH-53** — Toutes les écritures de synchronisation utilisent l'**identité de bot** de l'App
  (`<app-slug>[bot]`, courriel no-reply GitHub associé), jamais l'identité de l'enseignant.

## Webhooks

- **GH-60** — Un unique point d'accès `POST /webhooks/github` reçoit les événements de
  l'App. Chaque livraison est vérifiée par **signature HMAC**
  (`X-Hub-Signature-256`, secret dédié), dédupliquée par `X-GitHub-Delivery`,
  acquittée en < 5 s (traitement asynchrone dans une file de tâches).
- **GH-61** — Événements souscrits et usages :

| Événement | Usage |
| --- | --- |
| `installation`, `installation_repositories` | Cycle de vie de l'installation (GH-05, GH-06) |
| `push` | Métriques (dernier commit/hash + heure de réception serveur, GH-22), détection des fichiers protégés (GH-31), détection de repli du force push (GH-22), détection de l'avance de la source (GH-50) |
| `workflow_run` (`requested`, `in_progress`) | Passage du statut CI à `pending` (GR-04, GR-15) |
| `workflow_run` (`completed`) | Statut CI pass/fail ; déclenche la lecture des check-runs pour la note (§3) |
| `pull_request` | Suivi des PR de synchronisation (GH-52) |
| `repository` | Détection de renommage/suppression/archivage hors plateforme → alerte enseignant |

Il n'existe pas de webhook pour l'expiration des invitations de collaborateur : elle est
couverte par la réconciliation (GH-24, GH-62).

- **GH-62** — **Rattrapage** : une tâche périodique (quotidienne, et à la demande)
  réconcilie l'état via l'API (`GET /repos/.../branches`, listage des invitations
  `pending` pour GH-24, listage des livraisons manquées via
  `GET /app/hook/deliveries` avec redélivrance) afin qu'aucune perte de webhook
  ne corrompe durablement les métriques ou les protections. La réconciliation des
  GradeRuns suit GR-07.
- **GH-63** — Toutes les opérations GitHub passent par un client centralisé (Octokit)
  avec gestion des réponses `403 rate limit` / `secondary rate limit` (backoff +
  reprise de la tâche), journalisation des mutations (dépôt, opération, SHA avant/après)
  pour audit.

# Notation et collecte des métriques (GR)

## Convention `grading.yml`

### GR-01 — Workflow de notation

Un devoir est « noté » si le dépôt étudiant contient le workflow
`.github/workflows/grading.yml`. Ce fichier provient du dépôt source et est
**pré-coché dans les fichiers protégés** à la création du devoir (GH-30,
US-04) ; l'enseignant peut le décocher, auquel cas la suppression ou l'altération du
workflow par l'étudiant n'est pas revertée (avertissement affiché). Le système
identifie le workflow par son chemin (`path` du webhook `workflow_run`), non par son
nom d'affichage.

### GR-02 — Format de l'annotation de note

Le workflow émet la note via une commande de workflow GitHub Actions de type
`notice`, avec un titre réservé `GRADE` :

```bash
echo "::notice title=GRADE::4.5/6"
```

Le message MUST respecter la grammaire suivante (regex appliquée par le backend) :
```text
^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*$
```

soit `points_obtenus/points_max`, décimales avec un point, `points_max > 0`,
`points_obtenus <= points_max`.

**Justification** : la commande `::notice` crée une annotation attachée au check run
du job, lisible via l'API REST
(`GET /repos/{owner}/{repo}/check-runs/{id}/annotations`) avec la seule
portée `checks:read` de la GitHub App. Aucun artefact à téléverser, aucun token à injecter
dans le workflow étudiant, une seule ligne de shell dans `grading.yml`, et
l'annotation est visible telle quelle dans l'interface GitHub (transparence pour
l'étudiant).

**Limitation assumée — note falsifiable** : le code de l'étudiant s'exécute dans la même
exécution (tests) et peut lui-même imprimer une commande `::notice title=GRADE::...` sur la
sortie standard, forgeant une note. Protéger `grading.yml` n'empêche pas cette
injection. Le risque est **accepté** parce que la note est strictement indicative (GR-10,
§3.2 du cahier des charges — hypothèse H5). Mitigations : toute annotation `GRADE`
multiple dans une exécution, **même à valeurs identiques**, invalide la note
(`parse_status = multiple`, alerte enseignant, GR-17) ; l'enseignant conserve l'accès aux
journaux de l'exécution pour vérification. Si l'intégrité devient exigée, l'extension
« artefact signé » (GR-16) remplace cette convention.

**Alternative écartée** : publication d'un artefact JSON (`grade.json`) téléchargé
par le backend. Plus expressive (barème détaillé par exercice), mais plus lourde
(téléversement d'artefact, téléchargement de zip, rétention limitée) et invisible dans
l'interface GitHub. Retenue comme extension future possible (GR-16), non requise pour le MVP.

### GR-03 — Unicité de l'annotation

Le workflow MUST émettre exactement une annotation `GRADE` par exécution. Le kit de
démarrage fourni aux enseignants (modèle `grading.yml`) documente cette contrainte et
fournit une unique étape finale qui agrège les points et émet le notice avec
`if: always()`, afin que la note soit publiée même si des étapes de test échouent. Le
modèle inclut également la condition anti-bot de GH-44.

## Capture par le backend

### GR-04 — Déclencheurs webhook

Le backend souscrit à l'événement `workflow_run` de la GitHub App (GH-61) :

1. `requested` / `in_progress` : le statut CI du dépôt passe à `pending` (GR-15) si
   l'exécution est éligible (GR-05, étape 1).
2. `completed` : traitement complet ci-dessous (GR-05).

Seuls les événements dont le dépôt correspond à un `StudentRepo` connu sont traités ;
les autres sont ignorés (204).

### GR-05 — Pipeline d'extraction

À la réception d'un `workflow_run` terminé :

1. **Filtre d'éligibilité** : résoudre le `StudentRepo` depuis `repository.id`,
   puis vérifier que `head_branch` est une **branche sélectionnée** du devoir
   (les refs `sync/*` et toute autre branche sont ignorées) et que le commit de tête
   (`head_sha`) n'est **pas un commit poussé par le bot** (revert, commit de délai de rendu,
   synchronisation — GH-44). Une exécution non éligible est ignorée : aucun GradeRun n'est créé.
2. Si `workflow.path == .github/workflows/grading.yml` : lister les check runs du
   `head_sha` (`GET /commits/{sha}/check-runs`), filtrer ceux du `check_suite` de l'exécution,
   puis lire leurs annotations et chercher `title == "GRADE"` de niveau `notice`.
3. Analyser le message selon GR-02 et créer un `GradeRun` (GR-08).
4. Traiter le webhook de manière idempotente : le triplet
   (`StudentRepo`, `workflow_run.id`, `run_attempt`) est unique ; un événement rejoué
   ne crée pas de doublon.

### GR-06 — Repli pass/fail (dépôts sans `grading.yml`)

Si le dépôt ne contient pas `grading.yml`, le statut CI est **agrégé** sur le dernier
commit étudiant éligible (GR-05, étape 1) de la branche par défaut du dépôt :

1. `pass` si **toutes** les exécutions `workflow_run` terminées portant sur ce commit ont
   `conclusion = success` ;
2. `fail` si **au moins une** exécution terminée a une autre conclusion ;
3. `pending` si au moins une exécution est `requested`/`in_progress` et qu'aucune n'a échoué ;
4. `none` si aucun workflow n'existe.

Un `GradeRun` est créé sans note (`grade_points = null`, `parse_status = fallback`)
par exécution terminée éligible. Cette règle d'agrégation est la référence unique pour
`ci_status` (US-05, US-14, AU-35).

### GR-07 — Rattrapage

Une tâche de réconciliation s'exécute **toutes les 15 minutes** (période configurable,
15 min par défaut) et réinterroge les exécutions des `StudentRepo` actifs dont le dernier
webhook reçu est plus ancien que **N = 30 minutes** (configurable), afin de compenser les
webhooks perdus. Le pipeline GR-05 est réutilisé à l'identique.

## Stockage — le modèle `GradeRun`

### GR-08 — Schéma

Chaque exécution CI éligible capturée produit un enregistrement immuable :

| Champ | Type | Description |
| --- | --- | --- |
| `id` | uuid | Identifiant interne |
| `student_repo_id` | fk | Dépôt étudiant concerné |
| `workflow_run_id` | bigint | Id GitHub de l'exécution |
| `run_attempt` | int | Tentative (re-run) |
| `head_branch` | text | Branche de l'exécution (sélectionnée, voir GR-05) |
| `head_sha` | char(40) | Commit évalué |
| `conclusion` | enum | `success`, `failure`, `cancelled`, `timed_out`, … |
| `grade_points` | numeric nullable | Points obtenus |
| `grade_max` | numeric nullable | Points maximum |
| `parse_status` | enum | `ok`, `no_annotation`, `malformed`, `multiple`, `fallback` |
| `after_deadline` | bool | `true` si le `head_sha` a été **reçu** (webhook push, heure serveur, GH-22) après le délai de rendu, ou si son heure de réception est inconnue alors que le délai de rendu est passé (GR-14) |
| `completed_at` | timestamptz | Fin de l'exécution (heure GitHub) |
| `created_at` | timestamptz | Insertion |

### GR-09 — Note courante

Le champ dénormalisé `StudentRepo.current_grade` référence le `GradeRun` retenu : le
plus récent (par `completed_at`) dont `after_deadline = false` et
`parse_status IN (ok, fallback)`. Comme les exécutions non éligibles (branche non
sélectionnée, commit du bot) n'existent pas en base (GR-05), elles ne peuvent jamais devenir
la note courante. L'historique complet reste consultable.

## Affichage

### GR-10 — Vue étudiant

Après chaque exécution CI, l'étudiant voit sur son devoir : la note indicative
(`x/y` ou pass/fail), le commit évalué (hash court, lien GitHub), l'horodatage de l'exécution
et la mention explicite « note indicative, non contractuelle ». La mise à jour est
poussée en temps réel (SSE/WebSocket, voir architecture).

### GR-11 — Vue enseignant

L'enseignant voit, par devoir, un tableau des étudiants avec note courante, statut
CI, dernier commit, et peut ouvrir l'historique des `GradeRun` d'un étudiant. Ces
données sont également exposées par l'API par clé (§4).

## Gel au délai de rendu

### GR-12 — Gel de la note

Au délai de rendu (tâche de délai de rendu GH-43, fuseau Europe/Zurich), la note courante est
gelée : `StudentRepo.frozen_grade_run_id` pointe vers le `GradeRun` retenu selon GR-09 au
moment du gel. Les exécutions marquées `after_deadline = true` ne modifient jamais la
note gelée.

### GR-13 — Visibilité après le délai de rendu

Après le délai de rendu, la note gelée et le statut restent visibles côté étudiant et
côté enseignant. Les exécutions postérieures au délai de rendu (re-runs manuels, dépôt non
verrouillé dans la stratégie du commit de délai de rendu) sont affichées dans l'historique avec
un badge « après le délai de rendu », côté enseignant uniquement.

### GR-14 — Critère de gel : heure de réception serveur

Le critère de gel est le **moment où la plateforme a reçu le commit évalué**, jamais
l'horodatage git (fixé par le client, trivialement falsifiable via
`GIT_COMMITTER_DATE`) :

1. À chaque webhook `push` sur une branche sélectionnée, le backend persiste le SHA
   de tête et l'**heure de réception serveur** (GH-22).
2. Une exécution compte pour la note gelée (`after_deadline = false`) si et seulement si son
   `head_sha` a été reçu par webhook **avant le délai de rendu** et porte sur une branche
   sélectionnée (GR-05).
3. Un `head_sha` sans heure de réception connue (webhook perdu, réconcilié après
   coup) est traité comme `after_deadline = true` dès que le délai de rendu est passé —
   choix conservateur, arbitrable par l'enseignant au vu de l'historique.
4. Une exécution portant sur un commit reçu avant le délai de rendu mais **terminée après** compte
   pour la note gelée : le gel effectif attend la fin des exécutions en cours sur des
   commits éligibles, dans la limite d'un **délai de grâce configurable (30 min par
   défaut)** après le délai de rendu. Passé ce délai, `frozen_grade_run_id` est fixé
   définitivement.

Ce critère est la référence unique du gel (US-14, US-22, GH-42, GH-43).

## Métriques de dépôt

### GR-15 — Collecte

Le backend maintient par `StudentRepo`, alimenté par les webhooks `push` et
`workflow_run` (jamais par interrogation périodique en fonctionnement nominal, voir GR-07 pour le rattrapage) :

- `last_commit_at` et `last_commit_sha` (dernier push sur les branches sélectionnées,
  commits du bot et refs `sync/*` exclus), avec l'heure de réception serveur par SHA
  (GH-22) ;
- `ci_status` : `none` / `pending` / `pass` / `fail` — `pending` est posé par les
  événements `workflow_run` `requested`/`in_progress` (GR-04), les autres valeurs par
  GR-05/GR-06. Cette énumération est la source unique des valeurs exposées (AU-35) ;
- `current_grade` (GR-09) et horodatage de la dernière exécution.

Ces métriques alimentent le tableau enseignant et l'API par clé.

## Extensions et cas limites

### GR-16 — Extension future : artefact de note signé

Hors périmètre v1. Si l'intégrité de la note devient exigée (au-delà de
l'indicatif), `grading.yml` publie un artefact `grade.json` (barème détaillé par
exercice) que le backend télécharge et vérifie ; cette variante remplace alors
l'annotation GR-02. Référencée par GR-02 comme alternative écartée pour le MVP.

### GR-17 — Tableau des cas limites

| Cas | Comportement |
| --- | --- |
| Exécution en échec (`conclusion=failure`) avec une annotation `GRADE` présente | La note est capturée normalement (l'étape notice s'exécute avec `if: always()`) ; `conclusion` reflète l'échec |
| Exécution en échec sans annotation | `GradeRun` avec `parse_status=no_annotation`, `grade_points=null` ; la note courante n'est pas modifiée ; statut CI = `fail` |
| Annotation absente sur une exécution réussie | `parse_status=no_annotation` ; alerte visible côté enseignant (probablement un `grading.yml` défectueux) |
| Annotation malformée (regex GR-02 non satisfaite, `points > max`, `max = 0`) | `parse_status=malformed`, `grade_points=null`, message d'erreur conservé pour le diagnostic de l'enseignant |
| Plusieurs annotations `GRADE` dans la même exécution, **même à valeurs identiques** | `parse_status=multiple`, `grade_points=null`, alerte enseignant (mitigation anti-falsification, GR-02) |
| Exécution annulée ou `timed_out` | `GradeRun` enregistré avec la conclusion ; pas d'extraction de note |
| Exécution sur une ref `sync/*`, une branche non sélectionnée ou un commit du bot (revert, commit de délai de rendu) | **Ignorée** : aucun `GradeRun` créé (GR-05, GH-44, GH-51) |
| Re-run après le délai de rendu (`run_attempt > 1` ou nouvelle exécution sur un commit reçu après l'échéance) | Enregistré avec `after_deadline=true` ; note gelée inchangée (GR-12) ; visible par l'enseignant uniquement (GR-13) |
| Push après le délai de rendu avec un commit antidaté (`GIT_COMMITTER_DATE`) | Sans effet : le gel se fonde sur l'heure de réception serveur du webhook, non sur l'horodatage git (GR-14) |
| Webhook dupliqué ou rejoué | Idempotence par (`repo`, `run_id`, `run_attempt`) (GR-05) |
| `grading.yml` supprimé par l'étudiant | S'il est protégé (par défaut, GH-30/GR-01) : revert automatique ; les exécutions intermédiaires sans notation retombent sur GR-06. S'il a été délibérément déprotégé par l'enseignant : bascule assumée vers le repli |
| Annotation `GRADE` forgée par le code de l'étudiant | Risque documenté et accepté (note indicative) ; une annotation surnuméraire invalide la note (GR-02, hypothèse H5) |
| Dépôt dans l'état « fichiers protégés en conflit » | GradeRuns enregistrés, note marquée « à vérifier » côté enseignant (GH-35) |

# API par clé et CLI

Objectif : permettre au CLI (§4.4) de lister puis de cloner les dépôts étudiants d'un
devoir.

## Cycle de vie des clés

- **AU-29** — Un enseignant MUST pouvoir créer plusieurs clés d'API, chacune avec : un
  libellé libre, des portées, une liste de classes autorisées (ou `*` = toutes ses classes),
  une date d'expiration optionnelle (SHOULD par défaut : 12 mois).
- **AU-30** — Format de clé : `hgc_` + 40 caractères aléatoires (≥ 200 bits, CSPRNG).
  La clé complète n'est affichée qu'une seule fois à la création. En base :
  `{ id, teacher_id, label, key_prefix (12 premiers caractères, pour l'identification),
  key_hash = SHA-256(key), scopes, classroom_ids, expires_at, created_at,
  last_used_at, revoked_at }`. La clé en clair n'est jamais stockée.
- **AU-31** — Portées v1 : `classrooms:read` (classes, listes des étudiants, devoirs) et
  `repos:read` (liste des dépôts étudiants et métadonnées de clonage). Aucune portée
  d'écriture en v1.
- **AU-32** — Révocation immédiate par l'enseignant (suppression logique `revoked_at`) ; une
  clé révoquée ou expirée MUST être refusée avec un `401`. La liste des clés de l'enseignant
  affiche préfixe, libellé, portées, `last_used_at`, expiration — jamais la clé.
- **AU-33** — Une clé n'accorde jamais plus que les droits courants de son enseignant :
  si l'enseignant perd une classe, la clé la perd aussi.

## Points d'accès

- **AU-34** — Authentification : en-tête `Authorization: Bearer hgc_...`. Réponses
  d'erreur : `401` (clé absente/invalide/révoquée/expirée), `403` (portée ou classe
  hors périmètre), `404` (ressource inexistante ou hors périmètre — indiscernables).
  Points d'accès v1 :

| Méthode | Chemin | Portée | Rôle |
| --- | --- | --- | --- |
| `GET` | `/api/v1/classrooms` | `classrooms:read` | Lister les classes accessibles |
| `GET` | `/api/v1/classrooms/{id}/assignments` | `classrooms:read` | Lister les devoirs d'une classe |
| `GET` | `/api/v1/assignments/{id}/repos` | `repos:read` | Lister les dépôts étudiants (cible du CLI) |

- **AU-35** — Format de réponse : JSON, enveloppe
  `{ "data": [...], "pagination": { "page", "per_page", "total" } }`, pagination par
  `?page=&per_page=` (50 par défaut, 200 au maximum). Les valeurs de `ci_status` sont celles de
  l'énumération GR-15 (`none` / `pending` / `pass` / `fail`) ; la note est exposée sous forme
  de couple `grade_points` / `grade_max` (GR-08), sans normalisation. Réponse de
  `GET /api/v1/assignments/{id}/repos` :

```json
{
  "data": [
    {
      "student": {
        "nom": "Dupont",
        "prenom": "Marie",
        "email": "marie.dupont@heig-vd.ch",
        "github_login": "mdupont"
      },
      "repo": {
        "full_name": "heig-vd-tic/tp1-mdupont",
        "clone_url_https": "https://github.com/heig-vd-tic/tp1-mdupont.git",
        "clone_url_ssh": "git@github.com:heig-vd-tic/tp1-mdupont.git",
        "default_branch": "main",
        "locked": false
      },
      "status": {
        "accepted_at": "2026-07-01T08:12:00Z",
        "last_commit_hash": "a1b2c3d",
        "last_commit_at": "2026-07-02T21:47:00Z",
        "ci_status": "pass",
        "grade_points": 5.2,
        "grade_max": 6
      }
    }
  ],
  "pagination": { "page": 1, "per_page": 50, "total": 34 }
}
```

- **AU-36** — Champs explicitement nullables : `github_login`, `accepted_at`,
  `last_commit_*`, `ci_status`, `grade_points`, `grade_max` valent `null` tant que
  l'événement correspondant n'a pas eu lieu (un étudiant qui n'a pas accepté = entrée
  présente avec `repo: null`), afin que le CLI voie aussi les étudiants sans dépôt.
- **AU-37** — L'API par clé ne fournit PAS d'identifiants git : le clonage s'effectue avec
  les droits GitHub propres à l'enseignant (membre de l'organisation). L'API ne sert qu'à
  la découverte des URL et des métadonnées.

## Considérations de sécurité

- **AU-38** — Transport : HTTPS obligatoire partout (redirection + HSTS). Comparaison
  des empreintes de clés en temps constant.
- **AU-39** — Limitation de débit : l'API par clé SHOULD être limitée à 120 req/min par clé
  (réponse `429` + `Retry-After`) ; les points d'accès d'authentification (callbacks OIDC/OAuth,
  réclamation) limités par IP.
- **AU-40** — Rotation : la création d'une nouvelle clé alors qu'une ancienne est
  active MUST être possible (rotation sans interruption : créer → basculer le CLI →
  révoquer). Le système SHOULD notifier l'enseignant avant l'expiration d'une clé
  (NT-03).
- **AU-41** — Aucun secret dans les journaux : les clés d'API (au-delà du préfixe),
  les tokens OIDC/OAuth, les cookies de session et le `client_secret` MUST être masqués dans les
  journaux applicatifs, les journaux d'accès et les messages d'erreur. Les URL de callback contenant
  `code` ne sont pas journalisées en clair.
- **AU-42** — Audit : événements journalisés avec acteur et horodatage —
  création/révocation de clé, liaison/déliaison GitHub, réclamation et rattachement manuel à la
  liste des étudiants, désinscription, changement de rôle.
- **AU-43** — Les secrets du serveur (client secrets OIDC/GitHub, clé privée de la GitHub App)
  MUST provenir de l'environnement ou d'un gestionnaire de secrets, jamais du dépôt ni
  de la base de données.

## CLI (livrable v1, hypothèse H7)

- **CLI-01** — Un CLI `hgc` est livré (binaire ou paquet npm). Configuration :
  variables d'environnement `HGC_API_KEY` et `HGC_BASE_URL`, ou le fichier
  `~/.config/hgc/config.toml` (la variable d'environnement prévaut). La clé n'est
  jamais passée en argument de ligne de commande (visible dans l'historique et dans
  `ps`).
- **CLI-02** — Commandes v1 :

  1. `hgc classrooms` — liste les classes accessibles.
  2. `hgc assignments <classroom-id>` — liste les devoirs d'une classe.
  3. `hgc repos <assignment-id>` — liste les dépôts étudiants (tableau ; `--json`
     pour la sortie brute AU-35).
  4. `hgc clone <assignment-id> [--dir <path>] [--ssh | --https]` — clone en masse
     les dépôts du devoir dans un répertoire par étudiant ; idempotent : si le
     dépôt est déjà cloné, un `git fetch` est effectué à la place.
- **CLI-03** — Le clonage utilise les identifiants git **propres** à l'enseignant (AU-37) :
  le CLI n'injecte aucun token dans les URL. Parallélisme borné (par défaut : 4 clonages
  simultanés, option `--parallel`) pour respecter les quotas GitHub.
- **CLI-04** — Codes de sortie : `0` succès complet, `1` échec partiel (au moins un
  dépôt en erreur, listé sur stderr), `2` erreur d'authentification ou d'usage. Les
  étudiants sans dépôt (`repo: null`, AU-36) sont listés à la fin de l'exécution sans
  constituer un échec.

# Notifications (NT)

Cadre transversal pour toutes les mentions « notifié » des exigences (NFR-17 du cahier
des charges).

- **NT-01** — Canal **in-app obligatoire** : centre de notifications dans le portail
  (badge + liste horodatée, marquage lu/non lu). Toute exigence « X est notifié » est
  satisfaite par une notification in-app.
- **NT-02** — Canal **courriel optionnel** : opt-in par utilisateur, envoi asynchrone
  avec nouvelle tentative en cas d'échec, contenu minimal (lien vers le portail, aucune donnée
  sensible). Aucun comportement fonctionnel ne dépend de la délivrance d'un courriel.
- **NT-03** — Événements notifiés en v1 :

| Événement | Destinataire | Référence |
| --- | --- | --- |
| Échec de provisionnement | Enseignant + étudiant | US-13, GH-20 |
| Invitation expirée / réinvitation | Étudiant | GH-24 |
| Revert de fichiers protégés | Étudiant (enseignant : compteur dans la vue du dépôt) | GH-34 |
| Dépôt en « fichiers protégés en conflit » | Enseignant + étudiant | GH-33, GH-35 |
| Force push détecté (repli) | Enseignant + étudiant | GH-22 |
| Installation de la GitHub App dégradée | Enseignant | GH-06 |
| Synchronisation terminée (synthèse) | Enseignant | US-06 |
| PR de synchronisation ouverte / mise à jour | Étudiant | GH-51 |
| Reliaison GitHub d'un étudiant | Enseignants des classes concernées | AU-12 |
| Conflit de réclamation de la liste des étudiants | Enseignant | AU-21 |
| Expiration prochaine d'une clé d'API | Enseignant | AU-40 |
| Délai de rendu appliqué (synthèse par devoir) | Enseignant | GH-43 |
