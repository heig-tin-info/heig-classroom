# Vue du devoir

## Ce que montre cette table

Les chiffres en haut résument acceptation, CI, note moyenne et échéance. En dessous, une ligne par étudiant inscrit : acceptation, dernier commit, checks CI en direct et note. La table est triable, la recherche filtre les étudiants, et cliquer une ligne déplie son activité de commits.

Dans un **devoir de groupe**, la table se lit par équipe : une ligne par groupe, ses membres listés sous son nom. Le groupe partage un seul dépôt, créé quand son premier membre accepte ; chaque membre y est invité et reçoit la note du groupe dans les exports.

## Comment fonctionnent les notes (deux temps)

- **Devoir ouvert** — chaque push lance la correction objective (build + tests) ; la `GRADE` extraite est **indicative**.
- **À l'échéance** — la note est gelée, puis la review LLM complète tourne sur le commit gelé et committe `GRADING.yml` (points et justification par critère) dans le dépôt étudiant. Cette review est la note **officielle** ; un run de review en échec ne compte jamais.

## Lire les colonnes

- **checks** — check-runs en direct sur le HEAD courant. Un tiret après l'échéance est normal : le commit-marqueur d'échéance n'a pas de CI.
- **grade** — la note gelée une fois verrouillé (cadenas), la note courante sinon. L'icône historique liste tous les runs capturés.
- **Grade now** (icône lecture) — lance la correction immédiatement pour cet étudiant.

## Synchroniser les dépôts étudiants

Quand le dépôt source avance, une bannière propose d'ouvrir des **pull requests de sync** sur tous les dépôts étudiants ; chacun merge à son rythme. Les fichiers protégés (critères, workflow de correction) sont restaurés automatiquement si un étudiant les modifie.

## Environnement en ligne et mode examen

Un devoir dans un mode **en ligne** vit aussi dans le portail d'environnements ; la bannière affiche la dernière synchronisation réussie, ou l'erreur de la dernière tentative. **Resync** le repousse.

En **mode examen SEB**, la bannière propose en plus :

- **Télécharger le .seb** — la configuration Safe Exam Browser de cette épreuve, en HTTPS simple. Ouvrez-la dans l'outil de configuration SEB pour y lire la Browser Exam Key de chaque machine du parc, et **ne l'enregistrez jamais de nouveau** : enregistrer régénère le sel et invalide tous les fichiers déjà distribués. Les étudiants reçoivent le lien `sebs://` depuis leur propre page ; celui-là lance SEB, ce n'est pas ce qu'il vous faut ici.
- **Config Key** — l'empreinte que le portail a calculée pour ce fichier. Elle doit être identique à la Config Key qu'affiche l'outil de configuration. Si les deux diffèrent, le démarrage de l'épreuve sera refusé, et aucune BEK n'y changera rien.

Le bouton n'apparaît qu'une fois le devoir arrivé dans le portail : avant la première synchronisation réussie, il n'y a pas de `.seb` à télécharger. Le protocole complet est dans `apps/codespace/docs/preuve-b-manuelle.md`.
