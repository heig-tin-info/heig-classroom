# Source distribuée

## Squash (défaut)

La branche est réduite à un **unique commit initial** : les étudiants
reçoivent le matériel sans son historique. Recommandé — les tâtonnements de
l'enseignant (et toute solution ayant transité par l'historique) restent
privés.

## Whole history

L'historique complet des branches sélectionnées est poussé tel quel. Utile
quand l'historique fait partie du matériel (exercice de refactoring, par ex.).

Dans les deux cas le snapshot atterrit dans un dépôt `<slug>-squashed` ; les
copies étudiantes en sont issues, jamais du dépôt source vivant.
