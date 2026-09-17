# ADR-013 — Environnement en ligne : pas de credential étudiant, donc pas de droit d'écriture

## Statut

Accepté (2026-09-17, jalon 2 du portail).

## Contexte

Le portail `apps/codespace` fait travailler l'étudiant dans un conteneur durci servi par
code-server, éventuellement sous Safe Exam Browser. Son invariant fondateur est qu'**aucun
secret n'entre dans le conteneur étudiant** : ni jeton GitHub, ni clé SSH, ni credential
helper. C'est le conteneur qui pousse — par un relais authentifié par l'adresse IP source sur
le pont interne — et non l'étudiant depuis son éditeur.

Or, dans le flux historique de classroom (mode « libre »), le dépôt étudiant est provisionné
avec la permission `push` : l'étudiant clone et pousse avec son propre compte GitHub. Si on
garde ce droit en mode en ligne, deux chemins d'écriture coexistent sur le même dépôt (le
relais du portail, et l'étudiant depuis n'importe quel navigateur), ce qui rend le contenu
d'un examen indéfendable : rien ne distingue un commit produit dans la session surveillée d'un
commit poussé depuis la maison.

Il faut aussi décider qui peut activer la fonctionnalité. Le moteur de conteneurs est un
composant privilégié sur une VM dédiée, à capacité bornée (quelques dizaines de sessions) ;
l'ouvrir à tous les enseignants de `classroom.chevallier.io` d'un coup n'a pas de sens tant
que le pilote porte sur une ou deux classes.

## Décision

1. **Un devoir a un mode de travail** (`assignments.work_mode`, `WorkMode` du contrat
   partagé) : `free` (inchangé), `online`, `online_seb`. Le défaut est `free` : tous les
   devoirs existants gardent exactement leur comportement.
2. **Pas de credential étudiant, donc pas de droit d'écriture.** Le provisionnement
   (`github/provision.ts`) invite l'étudiant avec la permission :
   - `free` → `push` (flux historique, strictement inchangé) ;
   - `online` → `pull` : l'étudiant lit son dépôt, relit ses commits, mais seul le relais du
     portail y écrit — il n'existe donc aucun credential étudiant à distribuer, à faire
     expirer ou à révoquer ;
   - `online_seb` → **aucune invitation** : en examen, l'étudiant n'a pas accès au dépôt
     avant la notation.
   Le ruleset anti force-push et anti-suppression (`hgc-protect`, GH-21..23) reste posé dans
   les trois modes : il protège aussi contre le relais.
3. **Porte à sens unique.** Un devoir publié en mode `online*` ne peut pas revenir à `free`
   (409 `work_mode_frozen`). Ses dépôts ont été provisionnés sans droit d'écriture ; repasser
   à `free` laisserait chaque étudiant devant un dépôt qu'il ne peut pas pousser, et
   re-accorder `push` après coup contredirait précisément l'invariant que ce mode protège. On
   crée un nouveau devoir.
4. **Activation par l'administrateur, enseignant par enseignant**, avec un quota de sessions
   simultanées : deux colonnes sur `teacher_grants` (`codespace_enabled` à `false`,
   `codespace_max_active_sessions` à 2). Un enseignant sans habilitation ne voit pas la
   section « Work mode » du formulaire (le front lit `Me.codespace`) et l'API refuse tout mode
   non `free` par un 403 — la vérification serveur est la seule qui fasse foi.
5. **Absence globale possible.** `CODESPACE_URL` vide = la fonctionnalité n'existe pas :
   pas de colonne d'administration, pas de sélecteur, et les routes `/app/codespace/*`
   répondent 404. `CODESPACE_URL` sans `CODESPACE_LAUNCH_SECRET` d'au moins 32 caractères
   fait échouer le démarrage (ADR-010 : les secrets passent par l'environnement).
6. **Deux messages signés HS256, jamais d'import croisé** (règle d'import du `CLAUDE.md`
   racine) :
   - classroom → portail : `PUT ${CODESPACE_URL}/api/assignments/:id` avec le corps
     `CodespaceAssignmentSync` et un `ServiceTokenClaims` de 2 minutes en `Authorization:
     Bearer`. L'appel passe par **un job pg-boss** (`codespace.sync`, clé singleton
     `codespace:<assignment>`, ADR-004/ADR-011) : un portail en cours de redémarrage ne fait
     jamais échouer l'enregistrement d'un devoir, la reprise est gratuite, et l'état de la
     dernière tentative (`codespace_synced_at`, `codespace_sync_error`) est affiché à
     l'enseignant avec un bouton « Resync ».
   - étudiant → portail : `GET /app/codespace/start/:aid` vérifie inscription, acceptation,
     publication et mode, émet un `LaunchTokenClaims` de 5 minutes avec un `jti` aléatoire et
     redirige en 303 vers `${CODESPACE_URL}/launch?token=…`. C'est un **GET navigable** parce
     que le portail s'en sert aussi comme `startURL` de Safe Exam Browser, qui ne sait que
     naviguer. L'émission est journalisée (`codespace.launch_issued`) par son `jti` ; le jeton
     lui-même n'entre jamais dans le journal (AU-41).
7. **Les Browser Exam Keys sont des secrets côté enseignant.** Elles sont stockées sur le
   devoir (`browser_exam_keys`), envoyées au portail dans le message de synchronisation, et
   **jamais** incluses dans une charge utile étudiante.

## Conséquences

- En mode en ligne, un étudiant ne peut plus pousser depuis son poste : c'est l'effet
  recherché, mais cela veut dire que le portail devient indispensable au rendu. La panne du
  portail pendant un TP en ligne est donc un incident de rendu, pas seulement de confort —
  le mode `free` reste le défaut pour tout ce qui n'a pas besoin de surveillance.
- La CI de notation est inchangée : elle se déclenche sur les pushes du relais exactement
  comme sur ceux d'un étudiant, et toute la chaîne de notation (GR-05..16) ignore le mode.
- La migration est purement additive (colonnes à défaut, aucune réécriture) : la production en
  service reçoit `work_mode = 'free'` partout et ne change pas de comportement.
- Le quota est porté par le **propriétaire de la classe**, pas par le membre du staff qui
  enregistre le devoir : c'est le porteur du cours qui consomme la capacité de la VM.
- Le portail reste extractible : il ne connaît de classroom que ces deux messages signés.

## Alternatives rejetées

1. **Garder `push` en mode en ligne** et se fier à la surveillance : deux chemins d'écriture
   sur le même dépôt, contenu d'examen indéfendable, et l'invariant « aucun secret dans le
   conteneur » perdrait son intérêt puisque l'étudiant aurait de toute façon un credential.
2. **Distribuer un jeton à durée de vie courte dans le conteneur** pour que l'étudiant pousse
   lui-même : c'est exactement le secret que le durcissement du conteneur interdit, et il
   serait exfiltrable par n'importe quel terminal de l'éditeur.
3. **Appel HTTP synchrone vers le portail à l'enregistrement du devoir** : une VM de portail
   indisponible ferait échouer une action d'enseignant sans rapport, et il faudrait
   réinventer la reprise que pg-boss fournit déjà.
4. **Activation globale par variable d'environnement** : impossible de piloter une classe sans
   exposer toutes les autres, et aucun endroit où poser le quota par enseignant.
5. **Un quota unique global** plutôt que par enseignant : un enseignant qui lance un examen
   consommerait la capacité de tous les autres sans qu'aucun écran ne le montre.
