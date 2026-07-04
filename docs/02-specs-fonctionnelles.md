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
> Conventions : exigences numérotées par domaine — `AU-xx` (auth, onboarding, API),
> `GH-xx` (intégration GitHub), `GR-xx` (grading et métriques), `CLI-xx` (CLI),
> `NT-xx` (notifications). MUST = obligatoire, SHOULD = recommandé. Les identifiants
> sont stables et uniques.

# Authentification et onboarding (AU)

## Login plateforme — Switch edu-ID (OIDC)

Switch edu-ID est l'unique fournisseur d'identité pour la session web. Aucun mot de
passe local (NFR-01).

- **AU-01** — La plateforme MUST authentifier les utilisateurs via OpenID Connect avec
  Switch edu-ID, flux *Authorization Code + PKCE*, avec `state` et `nonce` vérifiés.
- **AU-02** — Scopes demandés : `openid profile email`. Claims attendus dans l'ID
  token / userinfo :

| Claim | Usage | Obligatoire |
| --- | --- | --- |
| `sub` | Identifiant stable du compte local (clé de rattachement) | Oui |
| `email` | Matching roster, affichage | Oui |
| `email_verified` | Le claim de roster exige `true` | Oui |
| `given_name` | Prénom | Oui |
| `family_name` | Nom | Oui |
| `swissEduPersonUniqueID` | Identifiant académique, stocké si présent (déduplication) | Non |

- **AU-03** — À la première connexion réussie, le backend MUST créer un compte local :
  `{ oidc_sub, email, email_verified, given_name, family_name, role, created_at }`.
  Le compte est identifié par `oidc_sub`, jamais par l'e-mail (l'e-mail edu-ID peut
  changer).
- **AU-04** — À chaque connexion, les champs profil (`email`, noms) MUST être
  resynchronisés depuis les claims.
- **AU-05** — Si `email_verified` est absent ou `false`, la connexion est acceptée
  mais le claim de roster (§1.4) MUST être bloqué avec un message explicite.
- **AU-06** — Session web : cookie de session `HttpOnly`, `Secure`, `SameSite=Lax`,
  durée max 12 h, invalidable côté serveur. Aucun token OIDC n'est exposé au frontend.
- **AU-07** — Le rôle par défaut d'un nouveau compte est `student`. Le rôle `teacher`
  MUST être attribué exclusivement via une **liste d'e-mails/`sub` autorisés en
  configuration serveur** (rechargée sans redéploiement), gérée par l'exploitant de la
  plateforme. Il n'existe pas de rôle admin applicatif en v1 (hypothèse H2 du cahier
  des charges) ; aucune auto-promotion n'est possible.

## Liaison du compte GitHub (OAuth séparé)

La liaison GitHub sert uniquement à établir l'identité GitHub de l'utilisateur ; les
opérations sur les dépôts passent par la GitHub App de l'organisation, jamais par un
token utilisateur (NFR-02, C-06).

- **AU-08** — La liaison MUST utiliser un flux GitHub OAuth (web application flow)
  distinct du login, déclenchable uniquement par un utilisateur déjà authentifié
  edu-ID. Scope minimal : `read:user` (aucun scope d'écriture).
- **AU-09** — Après le callback, le backend MUST stocker sur le compte :
  `github_user_id` (immuable, clé de référence), `github_login` (affichage,
  resynchronisé périodiquement car modifiable), `github_linked_at`. Le token OAuth
  GitHub MUST être **jeté** immédiatement après lecture de l'identité ; il n'est
  jamais persisté (conformité C-06 et NFR-02).
- **AU-10** — Un `github_user_id` MUST être lié à au plus un compte local. En cas de
  conflit, la liaison est refusée avec un message indiquant qu'un autre compte
  plateforme utilise déjà ce compte GitHub.
- **AU-11** — Un étudiant sans liaison GitHub MUST pouvoir naviguer et consulter ses
  assignments ; seule l'**acceptation d'un assignment** est bloquée tant que la
  liaison n'est pas faite (bandeau d'onboarding). Comportement de référence pour
  US-10.
- **AU-12** — Déliaison : l'utilisateur MUST pouvoir délier son compte GitHub. La
  déliaison ne retire pas les accès collaborateur déjà provisionnés sur les dépôts
  existants ; elle bloque toute nouvelle acceptation d'assignment. La reliaison à un
  autre compte GitHub MUST être journalisée (audit) et notifiée aux teachers des
  classrooms concernées (NT-03).

## Import du roster par le teacher

- **AU-13** — Le teacher MUST pouvoir importer la liste des étudiants d'une classroom
  par fichier CSV, encodage UTF-8, séparateur `,` ou `;` (auto-détecté), avec ligne
  d'en-tête obligatoire :

```text
nom,prenom,email
Dupont,Marie,marie.dupont@heig-vd.ch
Martin,Luc,luc.martin@heig-vd.ch
```

- **AU-14** — Validation à l'import : e-mail syntaxiquement valide, normalisé (trim,
  minuscules) ; lignes vides ignorées ; doublons d'e-mail **intra-fichier** rejetés
  avec numéro de ligne. L'import est **atomique : tout ou rien**, avec rapport
  d'erreurs. Cette sémantique est la référence unique (US-02 s'y conforme).
- **AU-15** — Chaque ligne crée une entrée de roster
  `Enrollment { classroom_id, nom, prenom, email, status }` avec `status = pending`.
  Statuts : `pending` / `claimed` (libellés FR « non réclamée » / « réclamée » à
  l'affichage — vocabulaire unique pour tous les documents). Le même e-mail peut
  figurer dans plusieurs classrooms (une entrée par classroom).
- **AU-16** — Ré-import : **upsert par e-mail** — les entrées existantes (y compris
  `claimed`) sont conservées et leurs nom/prénom mis à jour, les nouvelles sont
  ajoutées. Les entrées absentes du fichier ne sont PAS supprimées automatiquement ;
  le teacher les retire individuellement (AU-17).
- **AU-17** — Le teacher MUST pouvoir ajouter/éditer/supprimer une entrée de roster
  manuellement (mêmes champs que le CSV). Si un dépôt étudiant existe pour cette
  entrée, la suppression directe est bloquée : une **désinscription explicite** est
  requise, dont les effets sont : retrait de l'accès collaborateur de l'étudiant sur
  les dépôts de la classroom, **conservation** des dépôts (archivage au choix du
  teacher, GH-25), conservation des GradeRuns et métriques, journalisation (audit).

## Claim du roster par l'étudiant

Flux unique : **claim automatique** à la connexion, sur e-mail vérifié, sans
confirmation explicite et sans exiger la liaison GitHub (référence pour US-11 ;
hypothèse H3).

- **AU-18** — Après login edu-ID (avec `email_verified = true`), le backend MUST
  rechercher les entrées de roster `pending` dont l'e-mail normalisé égale l'e-mail
  edu-ID normalisé, et les rattacher automatiquement au compte : `status = claimed`,
  `user_id` renseigné, `claimed_at` horodaté. Toutes les classrooms correspondantes
  sont réclamées en une fois ; un écran récapitulatif informe l'étudiant des
  classrooms rejointes. Le `github_login` n'apparaît dans le roster qu'après la
  liaison GitHub (AU-09), qui n'est pas une condition du claim.
- **AU-19** — Le matching MUST être exact (insensible à la casse) sur l'e-mail
  complet. Aucun matching flou (nom/prénom) automatique.
- **AU-20** — Cas sans correspondance : le compte est créé mais sans inscription.
  L'étudiant voit un écran « aucune classroom trouvée pour `<email>` » l'invitant à
  contacter son enseignant. Le teacher MUST pouvoir résoudre le cas soit en corrigeant
  l'e-mail de l'entrée roster (le claim se rejoue à la connexion suivante ou via un
  bouton « réessayer »), soit en rattachant manuellement l'entrée à un compte existant
  depuis la vue roster.
- **AU-21** — Cas ambigus : une entrée roster ne peut être `claimed` que par un seul
  compte (contrainte d'unicité `enrollment → user`). Si l'e-mail d'un compte
  correspond à une entrée déjà réclamée par un autre compte, aucun rattachement n'a
  lieu et l'anomalie est signalée au teacher (badge « conflit » dans la vue roster) ;
  résolution manuelle par le teacher uniquement.
- **AU-22** — Un rattachement manuel par le teacher (AU-20, AU-21) MUST être
  journalisé (qui, quand, quelle entrée, quel compte).

## Rôles et autorisations

- **AU-23** — Deux rôles applicatifs : `teacher` et `student` (attribution du rôle
  teacher : AU-07). Matrice d'accès :

| Ressource | Teacher (propriétaire) | Student |
| --- | --- | --- |
| Classroom (création, édition, suppression) | Oui (les siennes) | Non |
| Roster (import, édition, conflits, github_login, dernière connexion) | Oui | Non |
| Assignments (création, publication, modification encadrée US-08, suppression avec archivage GH-25, synchro, verrouillage) | Oui | Lecture seule, uniquement ceux de ses classrooms |
| Dépôts étudiants (liens, métriques, notes) | Tous ceux de ses classrooms | Uniquement le sien (lien, statut CI, note indicative) |
| Dépôt source et squashed | Oui | Non (ni lien, ni existence) |
| Clés API | Oui (les siennes) | Non |

- **AU-24** — Toute autorisation MUST être vérifiée côté backend à chaque requête
  (ownership de la classroom pour le teacher, enrollment `claimed` pour l'étudiant).
  Le filtrage UI n'est jamais suffisant.
- **AU-25** — Un teacher ne voit pas les classrooms d'un autre teacher. (Le partage de
  classroom entre co-enseignants est hors périmètre v1 ; le modèle
  `classroom → teacher` reste 1-N extensible.)
- **AU-26** — Les notes et métriques d'un étudiant ne sont jamais visibles par un
  autre étudiant.

## Dernière connexion

- **AU-27** — Le backend MUST horodater `last_login_at` à chaque création de session
  edu-ID réussie. C'est cette valeur (connexion au portail) qui est affichée dans le
  tableau roster du teacher — décision de la question ouverte §5.5 de l'analyse.
- **AU-28** — La date du dernier push (`last_commit_at` par dépôt) est une métrique
  distincte, affichée au niveau assignment, et NE remplace PAS `last_login_at`.

# Intégration GitHub (GH)

## GitHub App

### Modèle et permissions

- **GH-01** — L'intégration repose sur une **GitHub App** unique (pas d'OAuth App pour
  les opérations serveur), installée sur chaque organisation adossée à une classroom.
  Les jetons d'installation offrent des permissions fines, un quota de 5 000 req/h
  **par installation** (donc par organisation) et une identité bot dédiée
  (`<app-slug>[bot]`).
- **GH-02** — L'App demande les **permissions minimales** suivantes :

| Permission (repository) | Niveau | Usage |
| --- | --- | --- |
| Metadata | Read | Obligatoire (base API) |
| Administration | Read & write | Créer les dépôts, gérer les collaborateurs, rulesets, archivage |
| Contents | Read & write | Push squashed, commits de revert, commit de deadline, lecture des arbres |
| Workflows | Read & write | Pousser des dépôts contenant `.github/workflows/grading.yml` |
| Pull requests | Read & write | PR de synchronisation |
| Checks | Read | Lecture des check-runs et annotations (grading, §3) |
| Actions | Read | Détails des `workflow_run` |

Aucune permission *organization* n'est requise hormis **Members : Read** (optionnelle,
validation de l'appartenance du teacher à l'org). Toute permission supplémentaire est
proscrite sans révision de cette spec.

- **GH-03** — L'authentification App suit le schéma standard : JWT signé avec la clé
  privée (durée ≤ 10 min) → `POST /app/installations/{id}/access_tokens` →
  **installation token** (durée 1 h). Le backend met en cache le token par
  installation et le renouvelle à T−10 min ; il n'est jamais persisté en base ni
  exposé au front. Les opérations git (push) utilisent
  `https://x-access-token:<token>@github.com/...`.

### Installation sur l'organisation

- **GH-04** — À la création d'une classroom, le teacher choisit l'organisation cible :
  la plateforme le redirige vers la page d'installation de l'App
  (`https://github.com/apps/<slug>/installations/new`) avec `state` signé (CSRF + id
  classroom). Portée recommandée : **All repositories** (les dépôts étudiants sont
  créés dynamiquement ; la portée « selected » imposerait un ajout manuel à chaque
  provisionnement).
- **GH-05** — Le webhook `installation` (`created`) confirme l'installation ; le
  backend enregistre `installation_id` sur l'`Organization` et vérifie que le compte
  installé correspond à l'organisation attendue. Une classroom ne peut être activée
  qu'avec une installation valide.
- **GH-06** — Les événements `installation` (`deleted`, `suspend`) et
  `installation_repositories` marquent l'organisation **dégradée** : les opérations
  d'écriture sont suspendues, le teacher est notifié (NT-03) avec un lien de
  réinstallation. Aucune donnée n'est supprimée.

## Dépôts sources et stratégies de source

### Création du dépôt squashed

- **GH-10** — À la création d'un assignment, le backend valide que le dépôt source
  appartient à l'organisation de la classroom et que les branches sélectionnées
  existent, puis crée le dépôt **squashed** : privé, nommé `<source>-squashed`
  (suffixe numérique en cas de collision), description renvoyant vers l'assignment.
  Son URL est exposée dans l'UI teacher.
- **GH-11** — Le contenu du squashed est produit selon la **stratégie de source** de
  l'assignment (GH-12/GH-13) et poussé par le bot via git (pas l'API Contents,
  inadaptée aux arbres complets). Le squashed est **géré exclusivement par le bot** :
  un push manuel dessus est détecté (webhook `push`, auteur ≠ bot) et signalé au
  teacher.

### Stratégie « whole repository »

- **GH-12** — Le squashed est un **miroir des branches sélectionnées** du source :
  mêmes commits, mêmes SHA (`git push` des refs sélectionnées, sans tags ni autres
  refs). L'historique complet est donc transmis aux étudiants.

### Stratégie « squash into primary commits »

- **GH-13** — Définition retenue : pour chaque branche sélectionnée, un **commit
  primaire** est l'état complet de la branche à un instant de publication.
  Concrètement :

  1. À la création de l'assignment, le squashed reçoit, par branche, **exactement un
     commit racine** dont l'arbre est celui du HEAD de la branche source.
     Auteur/committer : identité bot. Message :

     ```text
     Initial version — <assignment>

     Source: <org>/<source>@<sha-abrégé>
     ```

  2. À chaque synchronisation ultérieure (GH-50), un **nouveau commit primaire** est
     ajouté **au-dessus** du précédent : arbre = HEAD du source, parent = HEAD du
     squashed. L'historique du squashed est donc la suite linéaire des versions
     publiées, sans exposer les commits intermédiaires du teacher.
  3. Chaque commit primaire porte le SHA source dans son message (traçabilité) ; le
     backend persiste le mapping `commit primaire ↔ sha source`.

- **GH-14** — Cette définition garantit que dépôts étudiants et squashed partagent un
  **ancêtre commun**, condition des PR de synchro propres (GH-52). Extension possible
  (hors périmètre v1) : des tags `primary/*` sur le source pour publier plusieurs
  jalons d'un coup.

### Sélection des branches

- **GH-15** — Par défaut, la branche récupérée est la **branche par défaut du
  source** ; si l'assignment ne la précise pas, la règle est : `main` si elle existe,
  sinon `master`, sinon la branche par défaut GitHub. Le teacher peut sélectionner des
  branches additionnelles ; la première sélectionnée devient la branche par défaut des
  dépôts étudiants.

## Provisionnement du dépôt étudiant

- **GH-20** — À l'acceptation par l'étudiant, un job idempotent (clé
  `assignment_id + user_id`) exécute :

  1. Création du dépôt privé `<assignment-slug>-<github_login>` dans l'organisation
     (`POST /orgs/{org}/repos`, `auto_init: false`).
  2. **Push git des refs du squashed** (branches sélectionnées) — et non « generate
     from template », qui réécrirait l'historique et casserait l'ancêtre commun
     (GH-14).
  3. Ajout de l'étudiant comme collaborateur avec le rôle **push** (jamais
     maintain/admin) ; l'invitation GitHub est acceptée par l'étudiant (lien et état
     affichés dans l'UI tant que `pending`).
  4. Pose du ruleset de protection (GH-21).
  5. Enregistrement de `repo_url`, `default_branch`, `accepted_at` ; l'URL est
     affichée à l'étudiant.

  Tout échec partiel est repris par le job (le nom de dépôt existant est réutilisé,
  jamais dupliqué). Le SLA de 60 s (NFR-12) couvre les étapes 1 à 5, c'est-à-dire
  jusqu'à l'**envoi** de l'invitation ; l'acceptation de l'invitation par l'étudiant
  est hors SLA.
- **GH-21** — **Interdiction du force push et de la suppression de branche** : un
  **ruleset** au niveau du dépôt cible les branches sélectionnées avec les règles
  *block force pushes* et *restrict deletions*, **sans** bypass pour les
  collaborateurs ; l'App et le rôle **Organization admin** figurent en acteurs de
  bypass. Contrainte : les rulesets sur dépôts privés exigent un plan GitHub
  Team/Enterprise — vérification obligatoire avant M2, avec le coût en sièges des
  outside collaborators et les quotas d'invitations (**C-07** du cahier des charges).
- **GH-22** — Fallback si les rulesets sont indisponibles : le webhook `push` expose
  `forced: true` ; le backend restaure alors la branche au dernier SHA connu par un
  push bot et notifie teacher et étudiant. À cette fin (et pour le gel de note,
  GR-14), le backend persiste **à chaque webhook push** : branche, SHA de tête et
  **heure de réception serveur**. Mode dégradé documenté, non silencieux.
- **GH-23** — L'étudiant n'obtient jamais de droit d'administration : il ne peut ni
  supprimer le dépôt, ni modifier les rulesets, ni gérer les webhooks (l'App reçoit
  ses événements au niveau installation, sans webhook par dépôt).
- **GH-24** — **Cycle de vie des invitations** : les invitations collaborateur GitHub
  expirent après 7 jours et il n'existe pas de webhook d'expiration. Le job de
  réconciliation (GH-62) liste les invitations `pending`
  (`GET /repos/{owner}/{repo}/invitations`) ; si une invitation est expirée alors que
  l'étudiant n'a pas accès au dépôt, une ré-invitation est envoyée automatiquement (au
  plus une par 24 h et par dépôt) et l'étudiant est notifié. L'étudiant et le teacher
  disposent en outre d'une action « renvoyer l'invitation » dans l'UI. L'état
  d'invitation (`pending` / `expirée` / `acceptée`) est visible des deux rôles.
- **GH-25** — **Cascades de suppression** : la plateforme ne supprime **jamais** un
  dépôt GitHub silencieusement.

  1. Désinscription d'un étudiant (AU-17) : retrait de l'accès collaborateur,
     conservation du dépôt (archivage proposé au teacher).
  2. Suppression d'un assignment : confirmation explicite requise ; les dépôts
     étudiants sont **archivés** (jamais supprimés) et le squashed conservé.
  3. Suppression d'une classroom : refusée tant qu'il reste des assignments publiés ;
     mêmes règles d'archivage.

## Fichiers protégés — commit de revert

- **GH-30** — La liste des fichiers protégés (chemins exacts relatifs à la racine, pas
  de glob en v1) est définie sur l'assignment. Pré-cochage à la création :
  `criteria.yml`, `README.md` **et `.github/workflows/grading.yml`** s'ils existent
  dans le source (cohérent avec GR-01 ; décocher `grading.yml` déclenche un
  avertissement, cf. US-04). La **version de référence** d'un fichier protégé est
  celle du **dernier commit primaire/sync** poussé par le bot (pas la version
  initiale : une synchro peut légitimement les mettre à jour).
- **GH-31** — **Détection** : à chaque webhook `push` sur une branche sélectionnée
  d'un dépôt étudiant, si `sender` ≠ bot, le backend compare `before...after`
  (`GET /repos/.../compare`) et extrait l'intersection des fichiers touchés avec la
  liste protégée (modification, suppression ou renommage).
- **GH-32** — **Algorithme de revert** (API Git Data, atomique) :

  1. Lire le HEAD courant de la branche.
  2. Créer un arbre `base_tree = HEAD` remplaçant chaque chemin protégé par le blob de
     référence (recréation si supprimé).
  3. Si l'arbre résultant est identique à celui de HEAD, ne rien faire (déjà
     conforme).
  4. Créer le commit (auteur/committer bot) et avancer la ref par **fast-forward**
     (`update ref`, non forcé) — le travail de l'étudiant n'est jamais réécrit,
     uniquement recouvert.

  Message de commit :

  ```text
  chore(protected): restore protected files

  Fichiers restaurés : criteria.yml, README.md
  Référence : squashed@<sha-abrégé>. Ces fichiers sont gérés par l'assignment
  et ne doivent pas être modifiés.
  ```

- **GH-33** — **Anti-boucle** : les pushes dont l'auteur est le bot sont ignorés par
  GH-31. Si l'étudiant re-modifie, le revert se répète ; au-delà de **5 reverts /
  heure / dépôt**, le backend cesse de reverter, marque le dépôt « protected files en
  conflit » et notifie le teacher (protection contre un script étudiant en boucle et
  contre l'épuisement du quota). Ce plafond est un critère d'acceptation d'US-21.
- **GH-34** — **Notification** : chaque revert notifie l'étudiant (NT-01, e-mail
  optionnel NT-02) avec la liste des fichiers restaurés ; le compteur de reverts
  apparaît dans la vue teacher du dépôt. La course « push étudiant pendant le revert »
  est bénigne : l'update non forcé échoue et le webhook du nouveau push redéclenche
  l'analyse.
- **GH-35** — **Résolution de l'état « protected files en conflit »** :

  1. Vue teacher : le dépôt est signalé (badge), avec l'historique des reverts et une
     action **« réactiver la protection »** qui pousse un revert final, remet le
     compteur à zéro et réarme la détection.
  2. Vue student : un bandeau explique que les fichiers protégés du dépôt ne sont plus
     restaurés automatiquement et invite à revenir à la version de référence.
  3. Tant que l'état persiste, la note courante du dépôt est marquée « à vérifier »
     dans la vue teacher (les fichiers de critères peuvent être altérés) ; les
     GradeRuns continuent d'être enregistrés.

## Deadline

- **GH-40** — Comparaison des mécanismes de **lock** :

| Mécanisme | Effet | Bot garde l'écriture | Étudiant garde la lecture | Réversible | Limites |
| --- | --- | --- | --- | --- | --- |
| Archivage du dépôt | Tout devient read-only (code, issues, PR) | Non (désarchiver d'abord) | Oui | Oui (API) | Bloque aussi la synchro et le revert ; grossier mais simple |
| Retrait/downgrade des droits | Collaborateur passé à `pull` | Oui | Oui | Oui | Par collaborateur ; l'étudiant perd aussi la gestion de ses PR |
| Ruleset « lock branch » | Push bloqué sur les branches ciblées | **Oui (bypass App)** | Oui | Oui | Requiert plan Team/Enterprise (cf. GH-21, C-07) |

- **GH-41** — Stratégie retenue : **ruleset lock**. Acteurs de bypass du ruleset : la
  **GitHub App** (revert tardif, commit correctif) **et le rôle Organization admin**
  (le teacher conserve l'écriture, comme le garantit US-22) ; ces deux bypass font
  partie des critères d'acceptation. La réversibilité du ruleset est un atout pour une
  évolution future (extensions de délai individuelles), **hors périmètre v1**
  (cf. §3.2 du cahier des charges, hypothèse H1). L'**archivage** est le fallback si
  les rulesets sont indisponibles : il est appliqué **après** toute écriture bot
  restante et retire l'écriture à tous, bot et teacher compris — la garantie d'accès
  en écriture d'US-22 ne vaut donc qu'en mode ruleset ; le mode archivage est signalé
  comme dégradé dans l'UI teacher.
- **GH-42** — La stratégie **deadline commit** pousse, à l'échéance, un commit
  **vide** signé bot sur chaque branche sélectionnée :

  ```text
  chore(deadline): deadline reached — <assignment> (2026-07-03T23:59:00+02:00)
  ```

  Le dépôt reste ouvert ; la **note indicative gelée** est déterminée par GR-12 à
  GR-14 (commits reçus avant la deadline, heure serveur — le commit de deadline
  lui-même et les runs qu'il déclenche sont ignorés, GH-44 et GR-05). Les deux
  stratégies sont exclusives et fixées par assignment.
- **GH-43** — Le job de deadline (scheduler, timezone **Europe/Zurich**) est
  idempotent, reprend les dépôts en échec, se replanifie si la deadline est modifiée
  (US-08), et journalise `locked_at` / `deadline_commit_sha` par dépôt. Budget
  temporel (unique, aligné US-22 et NFR-13) : **démarrage ≤ 60 s après l'échéance,
  application complète sur 100 dépôts ≤ 5 min**. Pour tout litige sur un push proche
  de l'échéance, c'est l'**heure de réception serveur du webhook push** qui fait foi
  (GR-14), jamais l'horodatage git.
- **GH-44** — **Effets de bord des pushes bot** : les pushes effectués avec un token
  d'installation GitHub App déclenchent les workflows Actions (contrairement au
  `GITHUB_TOKEN`). Conséquences et mitigations obligatoires :

  1. Les runs dont le commit de tête est un commit bot (revert, deadline commit,
     synchro) sont **ignorés par le grading** : aucun GradeRun n'est créé (GR-05).
  2. Le template `grading.yml` fourni aux teachers contient une condition de job
     `if: github.actor != '<app-slug>[bot]'` pour éviter les runs inutiles.
  3. Impact quota : un commit de deadline sur 100 dépôts peut déclencher jusqu'à
     100 runs simultanés ; la consommation Actions correspondante est mesurée lors du
     spike S3 et documentée avant le jalon M4.

## Synchronisation source → squashed → dépôts étudiants

- **GH-50** — **Déclenchement** : le webhook `push` sur une branche sélectionnée du
  dépôt **source** rend la synchro *disponible* dans l'UI teacher (état « source en
  avance de N commits »). La propagation vers les étudiants est **déclenchée
  explicitement par le teacher** (pas d'auto-push : éviter de spammer les étudiants de
  PR à chaque commit intermédiaire).
- **GH-51** — À la demande de synchro, le backend met à jour le **squashed** :
  fast-forward des refs (stratégie whole repository) ou ajout d'un commit primaire
  (GH-13). Puis, pour chaque dépôt étudiant provisionné et non verrouillé :

  1. Push de la branche squashed vers la ref `sync/<branche>` du dépôt étudiant (mise
     à jour forcée autorisée sur cette ref bot uniquement).
  2. Ouverture d'une PR `sync/<branche>` → `<branche>`, auteur bot, titre
     `Sync assignment update (<sha-abrégé>)`, corps listant les fichiers modifiés.
  3. S'il existe déjà une **PR de synchro ouverte**, elle est réutilisée (la ref est
     mise à jour, un commentaire signale la nouvelle version) — jamais deux PR de
     synchro ouvertes simultanément.

  Les pushes sur `sync/<branche>` peuvent déclencher des workflows : ces runs (branche
  non sélectionnée, commit bot) sont **exclus du grading et des métriques** (GR-05,
  GR-15).
- **GH-52** — **Conflits** : ils sont portés par la PR (GitHub les affiche) et résolus
  par l'étudiant ; le bot ne merge jamais automatiquement. Si le diff est vide pour un
  dépôt (étudiant déjà à jour), aucune PR n'est ouverte. L'état des PR de synchro
  (ouverte / mergée / en conflit) est agrégé dans la vue teacher via les webhooks
  `pull_request`.
- **GH-53** — Toutes les écritures de synchro utilisent l'**identité bot** de l'App
  (`<app-slug>[bot]`, e-mail no-reply GitHub associé), jamais l'identité du teacher.

## Webhooks

- **GH-60** — Un unique endpoint `POST /webhooks/github` reçoit les événements de
  l'App. Chaque livraison est vérifiée par **signature HMAC**
  (`X-Hub-Signature-256`, secret dédié), dédupliquée par `X-GitHub-Delivery`,
  acquittée en < 5 s (traitement asynchrone en file de jobs).
- **GH-61** — Événements souscrits et usages :

| Événement | Usage |
| --- | --- |
| `installation`, `installation_repositories` | Cycle de vie de l'installation (GH-05, GH-06) |
| `push` | Métriques (dernier commit/hash + heure de réception serveur, GH-22), détection protected files (GH-31), détection force push fallback (GH-22), détection d'avance du source (GH-50) |
| `workflow_run` (`requested`, `in_progress`) | Passage du statut CI à `pending` (GR-04, GR-15) |
| `workflow_run` (`completed`) | Statut CI pass/fail ; déclenche la lecture des check-runs pour la note (§3) |
| `pull_request` | Suivi des PR de synchro (GH-52) |
| `repository` | Détection de renommage/suppression/archivage hors plateforme → alerte teacher |

Il n'existe pas de webhook pour l'expiration des invitations collaborateur : elle est
couverte par la réconciliation (GH-24, GH-62).

- **GH-62** — **Rattrapage** : un job périodique (quotidien, et à la demande)
  réconcilie l'état via l'API (`GET /repos/.../branches`, listing des invitations
  `pending` pour GH-24, listing des livraisons manquées via
  `GET /app/hook/deliveries` avec re-livraison) afin qu'aucune perte de webhook ne
  corrompe durablement les métriques ou les protections. La réconciliation des
  GradeRuns suit GR-07.
- **GH-63** — Toutes les opérations GitHub passent par un client centralisé (Octokit)
  avec gestion des réponses `403 rate limit` / `secondary rate limit` (backoff +
  reprise du job), journalisation des mutations (dépôt, opération, SHA avant/après)
  pour audit.

# Grading et collecte de métriques (GR)

## Convention `grading.yml`

### GR-01 — Workflow de grading

Un assignment est « gradé » si le dépôt étudiant contient le workflow
`.github/workflows/grading.yml`. Ce fichier provient du dépôt source et est
**pré-coché dans les fichiers protégés** à la création de l'assignment (GH-30,
US-04) ; le teacher peut le décocher, auquel cas la suppression ou l'altération du
workflow par l'étudiant n'est pas revertée (avertissement affiché). Le système
identifie le workflow par son chemin (`path` du webhook `workflow_run`), pas par son
nom d'affichage.

### GR-02 — Format d'annotation de la note

Le workflow émet la note via une commande de workflow GitHub Actions de type
`notice`, avec un titre réservé `GRADE` :

```bash
echo "::notice title=GRADE::4.5/6"
```

Le message DOIT respecter la grammaire suivante (regex appliquée par le backend) :

```text
^\s*(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*$
```

soit `points_obtenus/points_max`, décimales avec point, `points_max > 0`,
`points_obtenus <= points_max`.

**Justification** : la commande `::notice` crée une annotation attachée au check run
du job, lisible via l'API REST
(`GET /repos/{owner}/{repo}/check-runs/{id}/annotations`) avec le seul scope
`checks:read` de la GitHub App. Aucun artefact à téléverser, aucun token à injecter
dans le workflow étudiant, une seule ligne de shell dans `grading.yml`, et
l'annotation est visible telle quelle dans l'UI GitHub (transparence pour
l'étudiant).

**Limite assumée — note falsifiable** : le code de l'étudiant s'exécute dans le même
run (tests) et peut lui-même imprimer une commande `::notice title=GRADE::...` sur la
sortie standard, forgeant une note. Protéger `grading.yml` n'empêche pas cette
injection. Le risque est **accepté** car la note est strictement indicative (GR-10,
§3.2 du cahier des charges — hypothèse H5). Mitigations : toute annotation `GRADE`
multiple dans un run, **même à valeurs identiques**, invalide la note
(`parse_status = multiple`, alerte teacher, GR-17) ; le teacher garde l'accès aux
logs du run pour vérification. Si l'intégrité devient requise, l'extension « artefact
signé » (GR-16) remplace cette convention.

**Alternative écartée** : publication d'un artefact JSON (`grade.json`) téléchargé
par le backend. Plus expressive (barème détaillé par exercice), mais plus lourde
(upload d'artefact, téléchargement zip, rétention limitée) et invisible dans l'UI
GitHub. Retenue comme extension future possible (GR-16), non requise pour le MVP.

### GR-03 — Unicité de l'annotation

Le workflow DOIT émettre exactement une annotation `GRADE` par run. Le kit de
démarrage fourni aux teachers (template `grading.yml`) documente cette contrainte et
fournit un step final unique qui agrège les points et émet la notice avec
`if: always()`, afin que la note soit publiée même si des steps de test échouent. Le
template inclut aussi la condition anti-bot de GH-44.

## Capture par le backend

### GR-04 — Déclencheurs webhook

Le backend s'abonne à l'événement `workflow_run` de la GitHub App (GH-61) :

1. `requested` / `in_progress` : le statut CI du dépôt passe à `pending` (GR-15) si le
   run est éligible (GR-05, étape 1).
2. `completed` : traitement complet ci-dessous (GR-05).

Seuls les événements dont le dépôt correspond à un `StudentRepo` connu sont traités ;
les autres sont ignorés (204).

### GR-05 — Pipeline d'extraction

À réception d'un `workflow_run` completed :

1. **Filtre d'éligibilité** : résoudre le `StudentRepo` à partir de `repository.id`,
   puis vérifier que `head_branch` est une **branche sélectionnée** de l'assignment
   (les refs `sync/*` et toute autre branche sont ignorées) et que le commit de tête
   (`head_sha`) n'est **pas un commit poussé par le bot** (revert, deadline commit,
   synchro — GH-44). Un run non éligible est ignoré : aucun GradeRun n'est créé.
2. Si `workflow.path == .github/workflows/grading.yml` : lister les check runs du
   `head_sha` (`GET /commits/{sha}/check-runs`), filtrer ceux du `check_suite` du run,
   puis lire leurs annotations et rechercher `title == "GRADE"` de niveau `notice`.
3. Parser le message selon GR-02 et créer un `GradeRun` (GR-08).
4. Traiter le webhook de manière idempotente : la paire
   (`StudentRepo`, `workflow_run.id`, `run_attempt`) est unique ; un événement rejoué
   ne crée pas de doublon.

### GR-06 — Fallback pass/fail (dépôts sans `grading.yml`)

Si le dépôt ne contient pas `grading.yml`, le statut CI est **agrégé** sur le dernier
commit étudiant éligible (GR-05, étape 1) de la branche par défaut du dépôt :

1. `pass` si **tous** les `workflow_run` completed portant sur ce commit ont
   `conclusion = success` ;
2. `fail` si **au moins un** run completed a une autre conclusion ;
3. `pending` si au moins un run est `requested`/`in_progress` et aucun n'a échoué ;
4. `none` s'il n'existe aucun workflow.

Un `GradeRun` est créé sans note (`grade_points = null`, `parse_status = fallback`)
par run completed éligible. Cette règle d'agrégation est la référence unique pour
`ci_status` (US-05, US-14, AU-35).

### GR-07 — Rattrapage

Un job de réconciliation s'exécute **toutes les 15 minutes** (période configurable,
défaut 15 min) et re-interroge les runs des `StudentRepo` actifs dont le dernier
webhook reçu date de plus de **N = 30 minutes** (configurable), pour compenser les
webhooks perdus. Le pipeline GR-05 est réutilisé à l'identique.

## Stockage — modèle `GradeRun`

### GR-08 — Schéma

Chaque passe CI éligible capturée produit un enregistrement immuable :

| Champ | Type | Description |
| --- | --- | --- |
| `id` | uuid | Identifiant interne |
| `student_repo_id` | fk | Dépôt étudiant concerné |
| `workflow_run_id` | bigint | Id GitHub du run |
| `run_attempt` | int | Tentative (re-run) |
| `head_branch` | text | Branche du run (sélectionnée, cf. GR-05) |
| `head_sha` | char(40) | Commit évalué |
| `conclusion` | enum | `success`, `failure`, `cancelled`, `timed_out`, … |
| `grade_points` | numeric nullable | Points obtenus |
| `grade_max` | numeric nullable | Points maximum |
| `parse_status` | enum | `ok`, `no_annotation`, `malformed`, `multiple`, `fallback` |
| `after_deadline` | bool | `true` si le `head_sha` a été **reçu** (webhook push, heure serveur, GH-22) après la deadline, ou si son heure de réception est inconnue alors que la deadline est passée (GR-14) |
| `completed_at` | timestamptz | Fin du run (heure GitHub) |
| `created_at` | timestamptz | Insertion |

### GR-09 — Note courante

Le champ dénormalisé `StudentRepo.current_grade` référence le `GradeRun` retenu : le
plus récent (par `completed_at`) dont `after_deadline = false` et
`parse_status IN (ok, fallback)`. Les runs non éligibles (branche non sélectionnée,
commit bot) n'existant pas en base (GR-05), ils ne peuvent jamais devenir la note
courante. L'historique complet reste consultable.

## Affichage

### GR-10 — Vue student

Après chaque passe CI, l'étudiant voit sur son assignment : la note indicative
(`x/y` ou pass/fail), le commit évalué (hash court, lien GitHub), l'horodatage du run
et la mention explicite « note indicative, non contractuelle ». La mise à jour est
poussée en temps réel (SSE/WebSocket, cf. architecture).

### GR-11 — Vue teacher

Le teacher voit, par assignment, un tableau des étudiants avec note courante, statut
CI, dernier commit, et peut ouvrir l'historique des `GradeRun` d'un étudiant. Ces
données sont aussi exposées par l'API à clé (§4).

## Gel à la deadline

### GR-12 — Gel de la note

À la deadline (job de deadline GH-43, timezone Europe/Zurich), la note courante est
gelée : `StudentRepo.frozen_grade_run_id` pointe le `GradeRun` retenu selon GR-09 au
moment du gel. Les runs marqués `after_deadline = true` ne modifient jamais la note
gelée.

### GR-13 — Visibilité post-deadline

Après la deadline, la note gelée et le statut restent visibles côté student et
teacher. Les runs post-deadline (re-runs manuels, dépôt non verrouillé en stratégie
deadline commit) sont affichés dans l'historique avec un badge « après deadline »,
côté teacher uniquement.

### GR-14 — Critère de gel : heure de réception serveur

Le critère de gel est le **moment où la plateforme a reçu le commit évalué**, jamais
l'horodatage git (fixé par le client, trivialement falsifiable via
`GIT_COMMITTER_DATE`) :

1. À chaque webhook `push` sur une branche sélectionnée, le backend persiste le SHA
   de tête et l'**heure de réception serveur** (GH-22).
2. Un run compte pour la note gelée (`after_deadline = false`) si et seulement si son
   `head_sha` a été reçu par webhook **avant la deadline** et porte sur une branche
   sélectionnée (GR-05).
3. Un `head_sha` sans heure de réception connue (webhook perdu, réconcilié après
   coup) est traité `after_deadline = true` dès lors que la deadline est passée —
   choix conservateur, arbitrable par le teacher au vu de l'historique.
4. Un run portant sur un commit reçu avant la deadline mais **terminé après** compte
   pour la note gelée : le gel effectif attend la fin des runs en cours sur des
   commits éligibles, dans la limite d'un **délai de grâce configurable (défaut
   30 min)** après la deadline. Passé ce délai, `frozen_grade_run_id` est figé
   définitivement.

Ce critère est la référence unique du gel (US-14, US-22, GH-42, GH-43).

## Métriques de dépôt

### GR-15 — Collecte

Le backend maintient par `StudentRepo`, alimenté par les webhooks `push` et
`workflow_run` (jamais par polling en régime nominal, cf. GR-07 pour le rattrapage) :

- `last_commit_at` et `last_commit_sha` (dernier push sur les branches sélectionnées,
  commits du bot et refs `sync/*` exclus), avec l'heure de réception serveur par SHA
  (GH-22) ;
- `ci_status` : `none` / `pending` / `pass` / `fail` — `pending` est posé par les
  événements `workflow_run` `requested`/`in_progress` (GR-04), les autres valeurs par
  GR-05/GR-06. Cette énumération est la source unique des valeurs exposées (AU-35) ;
- `current_grade` (GR-09) et horodatage du dernier run.

Ces métriques alimentent le tableau teacher et l'API à clé.

## Extensions et cas limites

### GR-16 — Extension future : artefact de note signé

Hors périmètre v1. Si l'intégrité de la note devient requise (au-delà de
l'indicatif), `grading.yml` publie un artefact `grade.json` (barème détaillé par
exercice) que le backend télécharge et vérifie ; cette variante remplace alors
l'annotation GR-02. Référencée par GR-02 comme alternative écartée pour le MVP.

### GR-17 — Table des cas limites

| Cas | Comportement |
| --- | --- |
| Run échoué (`conclusion=failure`) avec annotation `GRADE` présente | La note est capturée normalement (le step notice tourne en `if: always()`) ; `conclusion` reflète l'échec |
| Run échoué sans annotation | `GradeRun` avec `parse_status=no_annotation`, `grade_points=null` ; la note courante n'est pas modifiée ; statut CI = `fail` |
| Annotation absente sur un run réussi | `parse_status=no_annotation` ; alerte visible côté teacher (probable `grading.yml` défectueux) |
| Annotation malformée (regex GR-02 non satisfaite, `points > max`, `max = 0`) | `parse_status=malformed`, `grade_points=null`, message d'erreur conservé pour diagnostic teacher |
| Plusieurs annotations `GRADE` dans le même run, **même à valeurs identiques** | `parse_status=multiple`, `grade_points=null`, alerte teacher (mitigation anti-forge, GR-02) |
| Run annulé ou `timed_out` | `GradeRun` enregistré avec la conclusion ; pas d'extraction de note |
| Run sur une ref `sync/*`, une branche non sélectionnée ou un commit bot (revert, deadline commit) | **Ignoré** : aucun `GradeRun` créé (GR-05, GH-44, GH-51) |
| Re-run après deadline (`run_attempt > 1` ou nouveau run sur commit reçu après l'échéance) | Enregistré avec `after_deadline=true` ; note gelée inchangée (GR-12) ; visible teacher seulement (GR-13) |
| Push post-deadline avec commit antidaté (`GIT_COMMITTER_DATE`) | Sans effet : le gel se fonde sur l'heure de réception serveur du webhook, pas sur l'horodatage git (GR-14) |
| Webhook dupliqué ou rejoué | Idempotence par (`repo`, `run_id`, `run_attempt`) (GR-05) |
| `grading.yml` supprimé par l'étudiant | S'il est protégé (défaut, GH-30/GR-01) : revert automatique ; les runs intermédiaires sans grading passent en fallback GR-06. S'il a été volontairement déprotégé par le teacher : bascule assumée en fallback |
| Annotation `GRADE` forgée par le code étudiant | Risque documenté et accepté (note indicative) ; une annotation surnuméraire invalide la note (GR-02, hypothèse H5) |
| Dépôt en état « protected files en conflit » | GradeRuns enregistrés, note marquée « à vérifier » côté teacher (GH-35) |

# API à clé et CLI

Objectif : permettre au CLI (§4.4) de lister puis cloner les dépôts étudiants d'un
assignment.

## Cycle de vie des clés

- **AU-29** — Un teacher MUST pouvoir créer plusieurs clés API, chacune avec : label
  libre, scopes, liste de classrooms autorisées (ou `*` = toutes ses classrooms), date
  d'expiration optionnelle (défaut SHOULD : 12 mois).
- **AU-30** — Format de clé : `hgc_` + 40 caractères aléatoires (≥ 200 bits, CSPRNG).
  La clé complète n'est affichée qu'une seule fois à la création. En base :
  `{ id, teacher_id, label, key_prefix (12 premiers caractères, pour identification),
  key_hash = SHA-256(clé), scopes, classroom_ids, expires_at, created_at,
  last_used_at, revoked_at }`. La clé en clair n'est jamais stockée.
- **AU-31** — Scopes v1 : `classrooms:read` (classrooms, rosters, assignments) et
  `repos:read` (liste des dépôts étudiants et métadonnées de clone). Aucun scope
  d'écriture en v1.
- **AU-32** — Révocation immédiate par le teacher (soft delete `revoked_at`) ; une clé
  révoquée ou expirée MUST être refusée avec `401`. La liste des clés du teacher
  affiche prefix, label, scopes, `last_used_at`, expiration — jamais la clé.
- **AU-33** — Une clé n'accorde jamais plus que les droits courants de son teacher :
  si le teacher perd une classroom, la clé la perd aussi.

## Endpoints

- **AU-34** — Authentification : en-tête `Authorization: Bearer hgc_...`. Réponses
  d'erreur : `401` (clé absente/invalide/révoquée/expirée), `403` (scope ou classroom
  hors périmètre), `404` (ressource inexistante ou hors périmètre — indiscernables).
  Endpoints v1 :

| Méthode | Chemin | Scope | Rôle |
| --- | --- | --- | --- |
| `GET` | `/api/v1/classrooms` | `classrooms:read` | Lister les classrooms accessibles |
| `GET` | `/api/v1/classrooms/{id}/assignments` | `classrooms:read` | Lister les assignments d'une classroom |
| `GET` | `/api/v1/assignments/{id}/repos` | `repos:read` | Lister les dépôts étudiants (cible du CLI) |

- **AU-35** — Format de réponse : JSON, enveloppe
  `{ "data": [...], "pagination": { "page", "per_page", "total" } }`, pagination par
  `?page=&per_page=` (défaut 50, max 200). Les valeurs de `ci_status` sont celles de
  l'énumération GR-15 (`none` / `pending` / `pass` / `fail`) ; la note est exposée en
  paire `grade_points` / `grade_max` (GR-08), sans normalisation. Réponse de
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

- **AU-36** — Champs nullables explicites : `github_login`, `accepted_at`,
  `last_commit_*`, `ci_status`, `grade_points`, `grade_max` valent `null` tant que
  l'événement correspondant n'a pas eu lieu (étudiant n'ayant pas accepté = entrée
  présente avec `repo: null`), afin que le CLI voie aussi les étudiants sans dépôt.
- **AU-37** — L'API à clé ne fournit PAS de credentials git : le clone s'effectue avec
  les droits GitHub propres du teacher (membre de l'organisation). L'API ne sert que
  la découverte des URLs et métadonnées.

## Considérations de sécurité

- **AU-38** — Transport : HTTPS obligatoire partout (redirection + HSTS). Comparaison
  des hash de clés en temps constant.
- **AU-39** — Rate limiting : API à clé SHOULD être limitée à 120 req/min par clé
  (réponse `429` + `Retry-After`) ; endpoints d'auth (callbacks OIDC/OAuth, claim)
  limités par IP.
- **AU-40** — Rotation : la création d'une nouvelle clé pendant qu'une ancienne est
  active MUST être possible (rotation sans interruption : créer → basculer le CLI →
  révoquer). Le système SHOULD notifier le teacher avant l'expiration d'une clé
  (NT-03).
- **AU-41** — Aucun secret dans les logs : clés API (au-delà du prefix), tokens
  OIDC/OAuth, cookies de session et `client_secret` MUST être masqués dans les logs
  applicatifs, journaux d'accès et messages d'erreur. Les URLs de callback contenant
  `code` ne sont pas journalisées en clair.
- **AU-42** — Audit : événements journalisés avec acteur et horodatage —
  création/révocation de clé, liaison/déliaison GitHub, claim et rattachement manuel
  de roster, désinscription, changement de rôle.
- **AU-43** — Secrets serveur (client secrets OIDC/GitHub, clé privée GitHub App)
  MUST provenir de l'environnement ou d'un gestionnaire de secrets, jamais du dépôt ni
  de la base.

## CLI (livrable v1, hypothèse H7)

- **CLI-01** — Un CLI `hgc` est livré (binaire ou paquet npm). Configuration :
  variables d'environnement `HGC_API_KEY` et `HGC_BASE_URL`, ou fichier
  `~/.config/hgc/config.toml` (la variable d'environnement prime). La clé n'est
  jamais passée en argument de ligne de commande (visible dans l'historique et
  `ps`).
- **CLI-02** — Commandes v1 :

  1. `hgc classrooms` — liste les classrooms accessibles.
  2. `hgc assignments <classroom-id>` — liste les assignments d'une classroom.
  3. `hgc repos <assignment-id>` — liste les dépôts étudiants (tableau ; `--json`
     pour la sortie brute AU-35).
  4. `hgc clone <assignment-id> [--dir <path>] [--ssh | --https]` — clone en masse
     les dépôts de l'assignment dans un répertoire par étudiant ; idempotent : si le
     dépôt est déjà cloné, un `git fetch` est effectué à la place.
- **CLI-03** — Le clone utilise les credentials git **propres du teacher** (AU-37) :
  le CLI n'injecte aucun token dans les URLs. Parallélisme borné (défaut : 4 clones
  simultanés, option `--parallel`) pour respecter les quotas GitHub.
- **CLI-04** — Codes de sortie : `0` succès complet, `1` échec partiel (au moins un
  dépôt en erreur, listé sur stderr), `2` erreur d'authentification ou d'usage. Les
  étudiants sans dépôt (`repo: null`, AU-36) sont listés en fin d'exécution sans
  constituer un échec.

# Notifications (NT)

Cadre transverse pour toutes les mentions « notifié » des exigences (NFR-17 du cahier
des charges).

- **NT-01** — Canal **in-app obligatoire** : centre de notifications dans le portail
  (badge + liste horodatée, marquage lu/non-lu). Toute exigence « X est notifié » est
  satisfaite par une notification in-app.
- **NT-02** — Canal **e-mail optionnel** : opt-in par utilisateur, envoi asynchrone
  avec reprise sur échec, contenu minimal (lien vers le portail, pas de données
  sensibles). Aucun comportement fonctionnel ne dépend de la délivrance d'un e-mail.
- **NT-03** — Événements notifiés v1 :

| Événement | Destinataire | Référence |
| --- | --- | --- |
| Échec de provisionnement | Teacher + student | US-13, GH-20 |
| Invitation expirée / ré-invitation | Student | GH-24 |
| Revert de fichiers protégés | Student (teacher : compteur en vue dépôt) | GH-34 |
| Dépôt « protected files en conflit » | Teacher + student | GH-33, GH-35 |
| Force push détecté (fallback) | Teacher + student | GH-22 |
| Installation GitHub App dégradée | Teacher | GH-06 |
| Synchronisation terminée (récapitulatif) | Teacher | US-06 |
| PR de synchro ouverte / mise à jour | Student | GH-51 |
| Reliaison GitHub d'un étudiant | Teachers des classrooms concernées | AU-12 |
| Conflit de claim roster | Teacher | AU-21 |
| Expiration prochaine d'une clé API | Teacher | AU-40 |
| Deadline appliquée (récapitulatif par assignment) | Teacher | GH-43 |
