# ADR-014 — Devoirs en groupe : groupes par devoir, formés par l'équipe enseignante, livrés en trois lots

## Statut

Acceptée (2026-09-21, phase 4, issue #2). Lot 1 (constitution des groupes) implémenté et déployé
le 2026-09-21 ; lot 2 (un dépôt par groupe) implémenté le 2026-09-24, voir « Lot 2 » plus bas ;
lot 3 spécifié ici et pas encore écrit.

## Contexte

Les laboratoires se font souvent à deux ou à trois, et jusqu'ici la plateforme ne connaissait que
les devoirs individuels : un dépôt par étudiant, une note par étudiant. Les enseignants
dupliquaient le travail à la main — un étudiant pousse, les autres regardent, et la note est
recopiée ensuite.

Trois questions ont décidé de la conception, toutes trois tranchées avec l'enseignant sur
l'issue #2 :

1. **Où vivent les groupes ?** Deux laboratoires d'une même classe sont rarement faits dans les
   mêmes équipes, si bien qu'une liste de groupes à l'échelle de la classe serait fausse une fois
   sur deux.
2. **Qui les forme ?** Laisser les étudiants former leurs propres groupes suppose des invitations,
   des acceptations, un délai pour clore la formation, et un enseignant qui doit arbitrer les
   restes.
3. **Que se passe-t-il une fois qu'un dépôt existe ?** Ajouter quelqu'un à un groupe qui a déjà un
   dépôt est une invitation ; retirer quelqu'un est une révocation — et aucune des deux n'est une
   opération purement en base de données.

La plateforme propose aussi un mode de travail en ligne (ADR-013) où le portail codespace possède
l'espace de travail et pousse pour le compte de l'étudiant. Un espace de travail sert un seul
étudiant, par construction, si bien qu'un travail partagé n'y a aucun sens.

## Décision

1. **Un groupe appartient à UN devoir** (`assignment_groups.assignment_id`), pas à la classe.
   Pour éviter la ressaisie, l'écran des groupes propose **« Copier depuis… »** : les groupes d'un
   autre devoir en mode groupe de la même classe sont dupliqués, membres compris.
2. **L'équipe enseignante forme les groupes**, sur un écran dédié : choisir un groupe, cliquer les
   étudiants dedans, groupe suivant. Les étudiants ne forment, ne rejoignent ni ne quittent
   jamais un groupe. `POST /groups/split` (groupes de N dans l'ordre de la liste des étudiants)
   et `POST /groups/singles` (chacun des autres seul) font le gros de la saisie.
3. **L'appartenance se fait par entrée de la liste des étudiants** (`enrollments.id`), pas par
   compte utilisateur : un étudiant est dans un groupe avant même de s'être connecté, exactement
   comme le reste de la liste. `UNIQUE(assignment_id, enrollment_id)` énonce l'invariant — au
   plus un groupe par étudiant et par devoir — et ajouter quelqu'un à un autre groupe le
   *déplace*.
4. **Un groupe qui possède un dépôt est verrouillé** : pas de renommage (le dépôt porte le nom du
   slug), pas de suppression, pas de retrait de membre — tous répondus `409 has_repo`, et l'écran
   affiche un cadenas. L'ajout d'un membre reste permis : le lot 2 n'a qu'à l'inviter. (Le lot 2
   lève le refus pour le seul retrait de membre, en révoquant réellement l'accès.) Le verrou
   se lit dans `student_repos.group_id`, c'est donc un fait sur GitHub, pas un drapeau à garder
   synchronisé.
5. **La taille maximale est indicative** (`assignments.group_max_size`) : la dépasser affiche un
   avertissement, jamais un refus. Les vraies classes ont un étudiant en trop, un redoublant, un
   arrivant tardif.
6. **Le mode groupe exige `work_mode = 'free'`** (`400 group_mode_requires_free`, dans les deux
   sens) et ne peut être activé ou désactivé **que tant que le devoir est un brouillon**
   (`409 not_draft`). La taille indicative reste modifiable à tout moment.
7. **La publication refuse de laisser quelqu'un de côté** : un devoir en mode groupe avec un
   étudiant sans groupe — ou sans aucun groupe — répond `409 unassigned_students` avec les noms,
   avant tout changement d'état et avant tout courriel. L'écran propose « les mettre en groupes
   individuels » et réessaie. La publication automatique programmée applique la même règle à
   l'intérieur de sa réclamation atomique (`ticker.ts`), si bien qu'un brouillon en groupe avec
   quelqu'un de côté reste un brouillon passé sa date de début au lieu de se publier en silence —
   et se met en ligne au tick qui suit la correction.
8. **Trois lots**, chacun livrable seul :
   - **Lot 1 (celui-ci)** : schéma, API, écran de constitution des groupes, garde à la
     publication. Aucun appel GitHub, acceptation inchangée.
   - **Lot 2** : un dépôt par groupe à la première acceptation, chaque membre collaborateur ;
     délai de rendu, gel et revue par dépôt. Retirer un membre redevient possible (révocation du
     collaborateur). Les teams GitHub ne sont *pas* utilisées : les étudiants sont des
     collaborateurs externes, pas des membres de l'organisation, et une team ne donne accès qu'à
     ses membres — chaque membre est donc invité individuellement sur le dépôt du groupe. Retirer
     un étudiant de la liste des étudiants doit alors refuser, ou révoquer d'abord son accès :
     aujourd'hui la cascade le sort d'un groupe verrouillé sans rien dire à GitHub.
   - **Lot 3** : suivi de l'invitation GitHub par membre, et ajustement par membre de la note du
     groupe par l'enseignant.

## Lot 2 — un dépôt par groupe

**Modèle de données : une ligne `student_repos` par dépôt de groupe**, `group_id` renseigné,
`user_id` l'étudiant dont l'acceptation l'a créé. Les membres se lisent dans
`assignment_group_members`, jamais recopiés sur la ligne. Rejeté : une ligne par membre pointant
vers le même dépôt — `github_repo_id` est unique, et chaque flux indexé sur le dépôt (webhooks,
capture CI, délai de rendu, gel, déclenchement LLM, pull requests de synchronisation) aurait dû
apprendre à se démultiplier, ou aurait lancé la revue une fois par membre. Avec une ligne par
dépôt, aucun n'a changé : délai de rendu, gel, note CI et revue LLM sont par dépôt, donc par
groupe, par construction.

Ce qui a changé, c'est la seule question « quel dépôt est celui de cet étudiant ? », tranchée à
un seul endroit (`apps/server/src/group-repos.ts`, règle `pickStudentRepo` dans `@hgc/domain`)
et utilisée par le tableau de détail, le relevé de notes de la classe, l'export par devoir et
l'accueil étudiant. Notes et exports restent **une ligne par étudiant**, chaque membre lisant la
note du dépôt du groupe. Les indications de rafraîchissement et le courriel de note finale vont à
chaque membre.

- **Acceptation.** Le premier membre qui accepte crée le dépôt
  `<assignment-slug>-<group-slug>` (tronqué aux 100 caractères de GitHub ; désambiguïsé avec
  l'identifiant du groupe quand un autre dépôt suivi de l'organisation porte déjà ce nom, puisque
  le provisionnement adopte un dépôt existant de ce nom) et chaque membre dont le compte GitHub
  est lié est invité (`push`) aussitôt. Les acceptations suivantes ne font que rattacher le
  membre (invitation idempotente). Un index unique partiel sur `(assignment_id, group_id)` —
  migration additive `0029_group-repos` — est la clé d'idempotence : deux membres qui acceptent
  à la même seconde insèrent une seule ligne et provisionnent le même dépôt. Un étudiant sans
  groupe reçoit `409 no_group`. Un membre sans identifiant GitHub est invité quand il lie son
  compte, ou quand il accepte.
- **Les changements de membres suivent sur GitHub.** Ajouter (ou déplacer vers) invite ; retirer
  (ou déplacer hors de) révoque la place de collaborateur et annule une invitation en attente
  **d'abord** — un refus de GitHub répond `502 revoke_failed` et laisse l'appartenance intacte.
  Renommer, supprimer et copier par-dessus un groupe qui a un dépôt restent `409 has_repo`.
  Retirer un étudiant de la liste des étudiants révoque son accès aux groupes avant la cascade,
  avec le même refus.
- **Les données existantes ne sont pas migrées.** Des devoirs en groupe peuvent contenir des
  dépôts individuels créés par des acceptations du lot 1. Ils continuent de fonctionner pour leur
  étudiant : un dépôt individuel vivant l'emporte sur celui du groupe dans chaque vue, son
  titulaire n'est pas invité dans le dépôt du groupe, et une acceptation le renvoie tel quel. Une
  fois supprimé sur GitHub, le dépôt du groupe prend le relais.
- Chaque écriture sur GitHub est auditée (`group.repo.invite`, `group.repo.revoke`), à côté des
  entrées existantes `assignment.accept`, `group.member.*` et `roster.remove`, qui nomment
  désormais ce qui a été invité ou révoqué.

Reste pour le lot 3 : le suivi de l'invitation par membre (aujourd'hui l'`invitation_status` de
la ligne et la réconciliation ne suivent que l'invitation du créateur), et l'ajustement par
membre de la note du groupe par l'enseignant.

## Conséquences

- La migration additive `0028_assignment-groups` ajoute deux tables et trois colonnes ; rien
  n'est supprimé et aucun devoir existant ne change de comportement (`group_mode` vaut false par
  défaut).
- `student_repos.group_id` est nullable et `ON DELETE SET NULL` : supprimer un groupe ne supprime
  jamais un dépôt, et le lot 1 peut lire le verrou avant que le lot 2 n'écrive jamais la colonne.
- L'écran des groupes est un outil d'enseignant, si bien que chaque route est derrière la garde
  enseignant et `accessibleAssignment` ; un devoir individuel répond `409 group_mode_off` même
  en lecture.
- Le tableau de détail reste par étudiant au lot 1 : la colonne du dépôt est simplement vide pour
  un devoir en groupe tant que le lot 2 ne la remplit pas. C'est délibéré — le lot 1 doit être
  déployable pendant que le lot 2 s'écrit encore. Le lot 2 regroupe le tableau par équipe : une
  ligne par groupe, ses membres listés sous son nom.
- Chaque écriture est auditée (`group.create`, `group.rename`, `group.delete`,
  `group.member.add`, `group.member.remove`, `group.copy`, `group.split`, `group.singles`) et
  publie une indication de rafraîchissement `assignments` sur le sujet de la classe.

## Alternatives rejetées

1. **Des groupes à l'échelle de la classe** (une seule liste d'équipes par classe, réutilisée par
   chaque devoir) : plus simple, et faux pour le cas courant — les équipes changent d'un
   laboratoire à l'autre. « Copier depuis… » offre la même économie de saisie sans le faux
   invariant.
2. **Les étudiants forment leurs propres groupes** (invitations, acceptations, un délai de
   formation) : tout un workflow, ses courriels et ses cas d'arbitrage, pour une décision que les
   enseignants prennent déjà en cinq minutes en classe. Cela pourra s'ajouter plus tard sur les
   mêmes tables.
3. **Une taille maximale de groupe contraignante** : la première classe de 23 étudiants avec des
   groupes de 3 aurait été bloquée par la plateforme. Un avertissement dit à l'enseignant ce
   qu'il sait déjà.
4. **Créer le dépôt du groupe dès que le groupe existe** : cela ferait de chaque groupe un groupe
   verrouillé et transformerait une erreur de constitution en nettoyage GitHub. Le dépôt est créé
   à la première acceptation (lot 2), comme dans le flux individuel.
5. **Autoriser le retrait d'un membre d'un groupe qui a un dépôt, et réconcilier plus tard** :
   l'étudiant garderait un accès en écriture à un dépôt auquel il n'appartient plus jusqu'à ce
   qu'une tâche rattrape. Refuser (`409 has_repo`) est honnête, et le lot 2 lève le refus en
   faisant la révocation pour de vrai.
