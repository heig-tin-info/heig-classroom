# ADR-013 — Espace de travail en ligne : aucun identifiant étudiant, donc aucun accès en écriture

## Statut

Acceptée (2026-09-17, jalon 2 du portail).

## Contexte

Le portail `apps/codespace` fait travailler l'étudiant dans un conteneur durci servi par
code-server, éventuellement sous Safe Exam Browser. Son invariant fondateur est qu'**aucun
secret n'entre dans le conteneur étudiant** : pas de token GitHub, pas de clé SSH, pas de
credential helper. C'est le conteneur qui pousse — par un relais authentifié par l'adresse IP
source sur le pont interne — et non l'étudiant depuis son éditeur.

Or, dans le flux classroom historique (le mode « libre »), le dépôt étudiant est provisionné
avec la permission `push` : l'étudiant clone et pousse avec son propre compte GitHub.
Conserver ce droit en mode en ligne signifierait deux voies d'écriture coexistant sur le même
dépôt (le relais du portail, et l'étudiant depuis n'importe quel navigateur), ce qui rend le
contenu d'un examen indéfendable : rien ne distingue un commit produit dans la session
surveillée d'un commit poussé depuis la maison.

Il faut aussi décider qui peut activer la fonctionnalité. Le moteur de conteneurs est un
composant privilégié sur une VM dédiée à la capacité bornée (quelques dizaines de sessions) ;
l'ouvrir d'un coup à tous les enseignants de `classroom.chevallier.io` n'a aucun sens tant que
le pilote couvre une ou deux classes.

## Décision

1. **Un devoir possède un mode de travail** (`assignments.work_mode`, `WorkMode` du contrat
   partagé) : `free` (inchangé), `online`, `online_seb`. La valeur par défaut est `free` :
   chaque devoir existant conserve exactement son comportement.
2. **Aucun identifiant étudiant, donc aucun accès en écriture.** Le provisionnement
   (`github/provision.ts`) invite l'étudiant avec la permission :
   - `free` → `push` (le flux historique, strictement inchangé) ;
   - `online` → `pull` : l'étudiant lit son dépôt et relit ses commits, mais seul le relais
     du portail y écrit — il n'y a donc aucun identifiant étudiant à distribuer, à faire
     expirer ou à révoquer ;
   - `online_seb` → **aucune invitation du tout** : pendant un examen, l'étudiant n'a aucun
     accès au dépôt avant la notation.
   Le ruleset anti force-push et anti-suppression (`hgc-protect`, GH-21..23) reste en place
   dans les trois modes : il protège aussi contre le relais.
3. **Une porte à sens unique.** Un devoir publié dans un mode `online*` ne peut pas revenir à
   `free` (409 `work_mode_frozen`). Ses dépôts ont été provisionnés sans accès en écriture ;
   revenir à `free` laisserait chaque étudiant devant un dépôt vers lequel il ne peut pas
   pousser, et accorder `push` après coup contredirait exactement l'invariant que ce mode
   protège. On crée un nouveau devoir à la place.
4. **Activation par l'administrateur, enseignant par enseignant**, avec un quota de sessions
   simultanées : deux colonnes sur `teacher_grants` (`codespace_enabled` à `false`,
   `codespace_max_active_sessions` à 2). Un enseignant sans cette autorisation ne voit pas la
   section « Mode de travail » du formulaire (le front-end lit `Me.codespace`) et l'API
   refuse tout mode autre que `free` avec un 403 — la vérification côté serveur est la seule
   qui fasse foi.
5. **L'absence globale est possible.** Un `CODESPACE_URL` vide signifie que la fonctionnalité
   n'existe pas : aucune colonne d'administration, aucun sélecteur, et les routes
   `/app/codespace/*` répondent 404. Un `CODESPACE_URL` sans `CODESPACE_LAUNCH_SECRET` d'au
   moins 32 caractères fait échouer le démarrage (ADR-010 : les secrets transitent par
   l'environnement).
6. **Deux messages signés en HS256, jamais un import croisé** (la règle d'import du
   `CLAUDE.md` racine) :
   - classroom → portail : `PUT ${CODESPACE_URL}/api/assignments/:id` avec un corps
     `CodespaceAssignmentSync` et un `ServiceTokenClaims` de 2 minutes dans
     `Authorization: Bearer`. L'appel passe par **une tâche pg-boss** (`codespace.sync`, clé
     singleton `codespace:<assignment>`, ADR-004/ADR-011) : un portail en cours de
     redémarrage ne fait jamais échouer l'enregistrement d'un devoir, la reprise est
     gratuite, et l'état de la dernière tentative (`codespace_synced_at`,
     `codespace_sync_error`) est présenté à l'enseignant avec un bouton « Resynchroniser ».
   - étudiant → portail : `GET /app/codespace/start/:aid` vérifie l'inscription,
     l'acceptation, la publication et le mode, émet un `LaunchTokenClaims` de 5 minutes avec
     un `jti` aléatoire et redirige en 303 vers `${CODESPACE_URL}/launch?token=…`. C'est un
     **GET navigable** parce que le portail s'en sert aussi comme `startURL` de Safe Exam
     Browser, qui ne sait que naviguer. L'émission est journalisée
     (`codespace.launch_issued`) par son `jti` ; le token lui-même n'entre jamais dans le
     journal (AU-41).
7. **Les Browser Exam Keys sont des secrets côté enseignant.** Elles sont stockées sur le
   devoir (`browser_exam_keys`), envoyées au portail dans le message de synchronisation, et
   **jamais** incluses dans une charge utile destinée à l'étudiant.

## Conséquences

- En mode en ligne, un étudiant ne peut plus pousser depuis sa propre machine : c'est l'effet
  recherché, mais cela signifie que le portail devient indispensable au rendu. Une panne du
  portail pendant un laboratoire en ligne est donc un incident de rendu, et pas seulement un
  incident de confort — le mode `free` reste la valeur par défaut pour tout ce qui n'exige
  pas de surveillance.
- La CI de notation est inchangée : elle se déclenche sur les push du relais exactement comme
  sur ceux d'un étudiant, et toute la chaîne de notation (GR-05..16) ignore le mode.
- La migration est purement additive (colonnes avec valeurs par défaut, aucune réécriture) :
  le service de production reçoit `work_mode = 'free'` partout et ne change pas de
  comportement.
- Le quota est porté par le **propriétaire de la classe**, et non par le membre du personnel
  qui enregistre le devoir : c'est la personne qui donne le cours qui consomme la capacité de
  la VM.
- Le portail reste extractible : tout ce qu'il connaît de classroom, ce sont ces deux
  messages signés.

## Alternatives rejetées

1. **Conserver `push` en mode en ligne** et s'en remettre à la surveillance : deux voies
   d'écriture sur le même dépôt, un contenu d'examen indéfendable, et l'invariant « aucun
   secret dans le conteneur » perdrait son objet puisque l'étudiant disposerait de toute
   façon d'un identifiant.
2. **Distribuer un token de courte durée dans le conteneur** pour que l'étudiant pousse
   lui-même : c'est exactement le secret que le durcissement du conteneur interdit, et il
   serait exfiltrable depuis n'importe quel terminal de l'éditeur.
3. **Un appel HTTP synchrone au portail lors de l'enregistrement du devoir** : une VM de
   portail indisponible ferait échouer une action d'enseignant sans rapport, et il faudrait
   réinventer la reprise que pg-boss fournit déjà.
4. **Une activation globale par variable d'environnement** : il serait impossible de faire
   tourner une classe sans exposer toutes les autres, et il n'y aurait nulle part où placer
   le quota par enseignant.
5. **Un quota global unique** plutôt qu'un quota par enseignant : un enseignant démarrant un
   examen consommerait la capacité de tous les autres sans qu'aucun écran ne le montre.
