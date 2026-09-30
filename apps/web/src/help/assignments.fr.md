# Devoirs

## Qu'est-ce qu'un devoir

Un devoir distribue un **dépôt source** à chaque étudiant sous forme de **dépôt privé** individuel. La plateforme fige la source, l'étudiant accepte pour obtenir sa copie, et la correction tourne dans son dépôt.

## Cycle de vie

**draft** → **published** → **locked**. **Publish** (le bouton d'une ligne en brouillon) ouvre l'acceptation. À l'échéance, les dépôts sont verrouillés ou reçoivent un commit-marqueur — automatiquement, avec une période de grâce pour les runs CI en cours.

## Réouvrir ou replanifier

Éditez le devoir et repoussez l'échéance dans le futur : les dépôts sont déverrouillés, la correction reprend jusqu'à la nouvelle échéance et le round de review finale est réinitialisé.

## Voir les devoirs archivés

Cliquez le bouton **archives** à côté de **New assignment**. Les devoirs archivés portent un badge *archived* ; le bouton de restauration en ramène un. Archiver cache le devoir aux étudiants mais conserve dépôts et notes.

## Supprimer un devoir

**Delete** (dans le menu de la ligne) reste disponible tant qu'aucun étudiant ni aucun groupe n'a accepté le devoir, qu'il soit en brouillon, publié ou archivé. Le dépôt distribué sur GitHub est supprimé avec lui, les étudiants ne le voient plus et son nom redevient libre pour un nouveau devoir. Dès qu'une acceptation existe, il ne reste que **Archive**, pour ne perdre aucun travail d'étudiant.
