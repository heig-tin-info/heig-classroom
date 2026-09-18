# heig.codespace-statusbar

Extension cuite dans l'image etudiante `codespace/c-dev` du projet
heig-codespace. Elle ajoute a droite de la barre d'etat le temps restant
jusqu'a l'echeance du devoir et un bouton « Fermer » qui ramene au portail.

Tout vient de l'environnement du conteneur (`CODESPACE_DEADLINE`,
`CODESPACE_RETURN_URL`, `CODESPACE_ASSIGNMENT_NAME`), pose par le `podman run`
du portail. Aucun acces reseau, aucune telemetrie, aucune dependance.

Documentation complete : `images/c-dev/README.md` du depot heig-classroom.
