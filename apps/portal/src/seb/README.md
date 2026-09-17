# `seb/` — volet examen : Config Key, Browser Exam Key, fichier `.seb`

Tâche P4 de [docs/jalon-0.md](../../../../docs/jalon-0.md). Ce module ne dépend
de rien d'autre dans `apps/portal/src/` : les devoirs, le vérificateur et la
création de session lui sont injectés.

| Fichier | Rôle |
| --- | --- |
| `plist.ts` | lecture et écriture du sous-ensemble plist qu'utilise un `.seb`, en gardant le **type déclaré** de chaque feuille |
| `configKey.ts` | normalisation « SEB-JSON » puis SHA-256 : la Config Key |
| `verify.ts` | `SebVerifier`, implémentations `real` et `simulated`, `createSebVerifier` |
| `examSession.ts` | cookie `exam_session` signé (HMAC) et sa vérification |
| `sebFile.ts` | génération du `.seb` d'un devoir, sa Config Key, le lien `sebs://` |
| `routes.ts` | greffon Fastify `sebRoutes` : `GET /exam/:a.seb` et `GET /exam/:a/start` |
| `fixtures/` | vecteurs de test copiés du greffon Moodle, cf. `fixtures/PROVENANCE.md` |

## Sources

- Spécification du calcul de la Config Key :
  <https://safeexambrowser.org/developer/seb-config-key.html>
- Intégration et Browser Exam Key (un BEK par version et par plateforme) :
  <https://safeexambrowser.org/developer/seb-integration.html>
- Implémentation de référence, greffon Moodle `quizaccess_seb`, branche
  `MOODLE_405_STABLE` :
  - `classes/config_key.php` — retrait d'`originatorVersion`, puis SHA-256 :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/config_key.php>
  - `classes/property_list.php` — `to_json()`, `array_sort()`,
    `prepare_plist_for_json_encoding()` ; c'est le fichier qui porte réellement
    l'algorithme :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/property_list.php>
  - `classes/seb_access_manager.php` — `check_key()` et
    `check_browser_exam_keys()`, la formule des deux en-têtes :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/seb_access_manager.php>
  - `classes/link_generator.php` — le schéma `sebs://` :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/link_generator.php>
  - `classes/helper.php` — `Content-Type: application/seb`, `filename=config.seb` :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/helper.php>
  - `classes/seb_quiz_settings.php` — `process_seb_config_manually()`, qui
    montre qu'une configuration **partielle** est légitime :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/classes/seb_quiz_settings.php>
  - `tests/config_key_test.php` — les trois vecteurs de Config Key :
    <https://github.com/moodle/moodle/blob/MOODLE_405_STABLE/mod/quiz/accessrule/seb/tests/config_key_test.php>
- Configuration `.seb` non chiffrée publiée par le projet SEB lui-même, d'où
  viennent la forme des règles de filtrage d'URL et la confirmation que le
  fichier est du plist XML nu :
  <https://github.com/SafeExamBrowser/SafeExamBrowser-Website/blob/master/exams/MoodleDemoEduhubDaysFilterUC.seb>

## Algorithme de la Config Key

Porté de `property_list::to_json()`. Chaque règle est commentée dans
`configKey.ts` avec sa ligne de référence.

0. **Retirer `originatorVersion`** (`config_key::generate`). C'est de la
   métadonnée : « which SEB version saved the config file ». Le retrait est
   récursif, comme `plist_map`.
1. **Aucun espace, aucun retour à la ligne.**
2. **Aucun échappement de caractère**, en particulier **pas** les antislash des
   règles de filtrage d'URL. PHP ne sait pas désactiver l'échappement de
   l'antislash dans `json_encode` ; la référence le contourne en remplaçant
   chaque `\` par une chaîne sentinelle avant l'encodage, puis à l'envers. Le
   port émet directement l'antislash brut. Conséquence : **la chaîne SEB-JSON
   n'est pas du JSON valide** dès qu'une chaîne contient un antislash. C'est
   voulu par la spécification.
3. **Tri des clés de chaque `<dict>`**, récursivement, y compris dans les
   tableaux. Ordre : algorithme de collation Unicode, locale racine, force par
   défaut — donc la casse est une différence *tertiaire* et la minuscule passe
   en premier : `allowWlan` avant `allowWLAN`. Ce n'est **pas** un tri
   ASCII, ni un `localeCompare` sur la locale courante.
4. **Suppression des `<dict>` vides**, en cascade de bas en haut : un
   dictionnaire qui ne contient que des dictionnaires vides disparaît lui aussi.
   Les **tableaux** vides, eux, sont conservés (`"additionalResources":[]` dans
   le vecteur mac).
5. Chaînes en UTF-8, laissées littérales (`JSON_UNESCAPED_UNICODE`).
6. Base16 en minuscules.
7. `<data>` → sa chaîne base64, telle qu'écrite dans le plist.
8. `<date>` → ISO 8601.

Puis SHA-256 de cette chaîne, en hexadécimal minuscule.

### Trois pièges, et ce que fait ce port

- **La configuration vide donne `[]`, pas `{}`.** La référence sérialise le
  plist en tableau PHP, et `json_encode` d'un tableau PHP vide donne `[]`.
  D'où la clé `4f53cda1…` du vecteur « configuration vide », qui est bien
  `sha256("[]")`. `serialiseDict` reproduit ce comportement.
- **Le tri dépend de la locale du moteur.** `new Intl.Collator('root')` est
  rejeté par Node, et `'und'` retombe sur la locale par défaut de la machine
  (`en-US` ici) : le résultat dépendrait du poste. Le port fixe `'en'`, qui ne
  porte aucun ajustement de collation dans CLDR et vaut donc l'ordre racine. Ce
  qui *prouve* que l'ordre est le bon, ce n'est pas ce raisonnement mais le
  vecteur `JSON_unencrypted_mac_001.txt` : 239 clés, plusieurs ne différant que
  par la casse, comparées caractère par caractère.
- **Une configuration partielle est légitime.** SEB calcule la Config Key sur
  le contenu du fichier, pas sur ses réglages une fois les valeurs par défaut
  appliquées. `seb_quiz_settings::process_seb_config_manually()` part d'un
  `property_list` vide et n'y met que les réglages du formulaire. `sebFile.ts`
  fait pareil : il n'écrit qu'une trentaine de clés.

## Vérification du démarrage

`seb_access_manager::check_key()` :
`hash('sha256', $url . $validkey) === $header`. Donc, sur
`GET /exam/<devoir>/start` :

- `X-SafeExamBrowser-ConfigKeyHash` doit valoir `sha256(url + configKey)` ;
- `X-SafeExamBrowser-RequestHash` doit valoir `sha256(url + bek)` pour **au
  moins un** des BEK acceptés du devoir (`check_browser_exam_keys` boucle sur
  la liste).

`url` est l'URL **absolue telle que le navigateur l'a demandée, sans
fragment**. Les deux comparaisons passent par `hashesEqual`, qui compare les
condensés SHA-256 des deux chaînes avec `crypto.timingSafeEqual` — longueurs
toujours égales, donc pas de court-circuit. La boucle sur les BEK ne s'arrête
pas au premier succès, pour que la durée ne dise pas *quel* BEK a réussi.

### Reconstruire l'URL derrière un frontal

`absoluteRequestUrl(req, options)`, trois modes, du plus sûr au moins sûr :

| Réglage | Comportement | Quand |
| --- | --- | --- |
| `publicOrigin: "https://codespace.heig-vd.ch"` | origine fixe, rien de ce que le client envoie n'entre dans le calcul | **production** |
| `trustForwarded: true` | lit `X-Forwarded-Proto` et `X-Forwarded-Host` (premier élément d'une liste) | frontal qui réécrit systématiquement ces en-têtes |
| aucun des deux | `Host` plus `defaultProtocol` | développement en clair |

Le piège est réel : un frontal TLS termine le HTTPS, le portail voit
`http://127.0.0.1:3000/...`, et le haché ne correspond jamais. Le réglage sûr
est `publicOrigin`, parce qu'un `Host` ou un `X-Forwarded-Host` manipulable
laisserait l'étudiant choisir l'URL sur laquelle le haché est calculé.

### Les deux implémentations

- `real` : ce qui précède.
- `simulated` : accepte `X-Dev-SEB: ok`, refuse tout le reste.
  `createSebVerifier` **lève** si `mode === "simulated"` et
  `NODE_ENV === "production"` (invariant 8 de `CLAUDE.md`, affirmé par
  `verify.test.ts`). Le refus est une exception au démarrage, pas un repli
  silencieux : une production mal configurée ne doit pas démarrer.

Le jeu de cas de refus est passé aux **deux** implémentations dans
`verify.test.ts` et `routes.test.ts` : aucune requête non explicitement
autorisée ne passe, quel que soit le mode.

## Le cookie, et pourquoi le proxy ne lit pas d'en-tête SEB

Invariant 5 de `CLAUDE.md`, motivé par analyse.md § 4.5 : rien ne garantit que
SEB ajoute ses en-têtes aux mises à niveau websocket ni aux requêtes de service
worker. Un proxy qui les exigerait casserait l'éditeur, et un proxy qui les
exigerait « quand ils sont là » ne garantirait rien.

Donc : vérification **une fois**, sur `/exam/<devoir>/start`, puis émission d'un
cookie `exam_session` signé en HMAC-SHA256 portant `assignmentId`, `sessionId`,
l'adresse du client et l'horodatage. `checkExamRequest(request, …)` est la seule
chose que `proxy/` appellera ; elle ne touche à aucun en-tête SEB. Adresse
différente de celle de la vérification initiale → refus `address-mismatch`
(analyse.md D5).

Le cookie n'est pas chiffré : tout ce qu'il porte est déjà connu du client, et
il ne contient **jamais** de BEK.

## Le fichier `.seb`

Plist XML **non chiffré**, servi en `application/seb` sous le nom
`config.seb`. C'est la forme que sert `quizaccess_seb` et celle des exemples
publiés par le projet SEB : ni gzip, ni préfixe de quatre octets. Le
chiffrement ne concerne que les fichiers protégés par mot de passe, écartés par
analyse.md § 4.4 (« le chiffrement du fichier `.seb` n'apporte rien à
l'intégrité, la Config Key la garantit »).

Réglages écrits, tous relevés sur des configurations SEB réelles
(`fixtures/unencrypted_win_223.seb` et l'exemple du projet SEB) : `startURL`,
`quitURL`, `URLFilterEnable`/`URLFilterRules` (une seule règle « autoriser »
sur le domaine du portail), `allowDownUploads: false`,
`enablePrivateClipboard: true`, kiosque, `sendBrowserExamKey: true`,
`examKeySalt`, `browserExamKey` vide.

**`browserExamKey` reste vide, à dessein.** Avec un `examKeySalt` propre au
devoir, SEB calcule le BEK à partir du sel *et de son propre binaire* : un BEK
par plateforme et par version, d'où la liste côté devoir (analyse.md § 4.4).
Écrire un BEK dans le fichier donnerait le même BEK partout — et remettrait le
secret partagé à l'étudiant, ce que project.md § 9 interdit.

Le lien remis à l'étudiant est `sebs://<hôte>/exam/<devoir>.seb` : la même URL
que le `https://`, schéma remplacé, comme `link_generator::get_link()`.

## Décisions

1. **Porter, pas réinventer.** Le port suit `property_list.php` ligne à ligne,
   y compris ses bizarreries (`[]` pour une configuration vide, antislash non
   échappé dans les valeurs mais échappé dans les clés). Une clé qui
   « semblerait plus propre » serait une clé fausse.
2. **Le type plist est conservé** jusqu'à la sérialisation (`SebValue`), au lieu
   de retomber sur les primitives JavaScript : un `<integer>` et un `<real>` ne
   se sérialisent pas pareil, un `<data>` non plus.
3. **Un devoir sans BEK est refusé**, là où Moodle laisse passer quand la liste
   est vide (`is_allowed_browser_examkeys_configured`). En mode examen, une
   liste vide est une erreur de configuration, pas une dispense.
4. **Pas de `@fastify/cookie`** dans `routes.ts` : le greffon doit pouvoir
   s'enregistrer dans une instance qui l'a déjà, ou pas encore. La valeur est
   en base64url, sans caractère à échapper.
5. **Refus journalisé, secret jamais.** Le journal porte l'identifiant du
   devoir, la raison, l'adresse et l'URL. Ni la liste des BEK, ni les hachés
   reçus, qui sont des fonctions du secret partagé. Un test l'affirme.
6. **Vecteurs sourcés uniquement.** Aucune valeur attendue ne sort de ce code.
   Les trois vecteurs de Config Key et la chaîne SEB-JSON intermédiaire
   viennent du jeu de tests de `quizaccess_seb` ; les tests qui ne peuvent pas
   l'être (sensibilité au changement d'un réglage, idempotence) sont des
   propriétés, pas des valeurs.

## `TODO(verify)`

Rien n'a été vérifié contre un binaire SEB : aucun n'est installé sur ce poste.
La preuve B manuelle, [docs/preuve-b-manuelle.md](../../../../docs/preuve-b-manuelle.md),
existe pour lever ces points.

- **`configKey.ts`, `isoDate()`** — format des `<date>`. La référence lit un
  horodatage Unix et le formate avec le `'c'` de PHP, soit
  `1940-10-09T22:13:56+00:00`, décalage explicite et non `Z`. Aucun vecteur
  publié n'exerce ce chemin : le seul test Moodle qui touche une date affirme
  que deux fixtures portant la même date ont la même clé, ce qui ne fixe pas le
  format. Les configurations que ce portail génère ne contiennent aucune
  `<date>`, donc le chemin est écrit d'après la référence et non prouvé.
- **`configKey.ts`, `jsonNumber()`** — très grands flottants. PHP écrit
  `1.0e+30`, JavaScript `1e+30`. Les seuls `<real>` d'un `.seb` sont les seuils
  de batterie, dans `[0,1]` : divergence laissée non traitée et non testée.
- **`sebFile.ts`, `browserViewMode: 1`** — les deux configurations de référence
  valent `0`. La valeur `1` (plein écran) n'a pas été vérifiée sur une version
  épinglée de SEB.
- **`sebFile.ts`, `browserURLSalt: true`** — valeur reprise des deux
  configurations de référence ; sa sémantique exacte n'a pas été vérifiée sur
  une version épinglée.
- **`sebFile.ts`, `browserExamKey: ""`** — les deux configurations de référence
  le laissent vide, ce qui conforte le choix, mais la sémantique d'un
  `browserExamKey` **non** vide (BEK imposé au client) n'a pas été vérifiée.
- **Version de SEB** — aucun réglage n'a été confronté à une version épinglée
  du client. Les noms et types viennent de configurations enregistrées par SEB
  Windows 2.2.3 et macOS 2.1.4, qui sont anciennes.
- **Suppression d'un `<dict>` vide contenu dans un `<array>`** — la référence
  supprime pendant l'itération (`$parent->del($key)` sur un `CFArray`), ce qui
  peut décaler les indices. Ce port supprime proprement. Aucun `.seb` connu ne
  contient de dictionnaire vide dans un tableau ; la divergence est théorique
  et non testée.

## Tests

```bash
pnpm --filter @codespace/portal test
```

`configKey.test.ts` (vecteurs et règles de normalisation), `verify.test.ts`
(formule, cas de refus, invariant 8, reconstruction d'URL),
`examSession.test.ts` (cookie), `sebFile.test.ts` (génération, idempotence,
lien `sebs://`), `routes.test.ts` (les deux routes, les deux implémentations,
le chemin du proxy).
