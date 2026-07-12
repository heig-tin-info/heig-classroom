# Importer la liste

## Ce que ça fait

Remplit le roster de la classe depuis un fichier — les étudiants rattachent ensuite leur siège automatiquement à la première connexion (e-mail correspondant).

## Comment importer

Déposez un export **Excel ou CSV**. Les colonnes nom, prénom et e-mail sont détectées de manière permissive (en-têtes français acceptés). Vous pouvez aussi ajouter les étudiants un à un, ou coller des lignes CSV.

## En cas de ré-import

L'import est idempotent : les entrées existantes sont retrouvées par e-mail et gardent leur rattachement ; seuls les noms sont rafraîchis. Rien n'est supprimé implicitement.
