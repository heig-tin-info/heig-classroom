# Vue du devoir

## Ce que montre cette table

Une ligne par étudiant inscrit : acceptation, dernier commit, checks CI en direct et note. La table est triable et la recherche filtre les étudiants.

## Comment fonctionnent les notes (deux temps)

- **Devoir ouvert** — chaque push lance la correction objective (build + tests) ; la `GRADE` extraite est **indicative**.
- **À l'échéance** — la note est gelée, puis la review LLM complète tourne sur le commit gelé et committe `GRADING.yml` (points et justification par critère) dans le dépôt étudiant. Cette review est la note **officielle** ; un run de review en échec ne compte jamais.

## Lire les colonnes

- **checks** — check-runs en direct sur le HEAD courant. Un tiret après l'échéance est normal : le commit-marqueur d'échéance n'a pas de CI.
- **grade** — la note gelée une fois verrouillé (cadenas), la note courante sinon. L'icône historique liste tous les runs capturés.
- **Grade now** (icône lecture) — lance la correction immédiatement pour cet étudiant.

## Synchroniser les dépôts étudiants

Quand le dépôt source avance, une bannière propose d'ouvrir des **pull requests de sync** sur tous les dépôts étudiants ; chacun merge à son rythme. Les fichiers protégés (critères, workflow de correction) sont restaurés automatiquement si un étudiant les modifie.
