# Configuration d'examen (.seb)

## Ce qu'est ce fichier

Un devoir en **mode examen SEB** ne s'ouvre que depuis Safe Exam Browser. Le portail d'environnements génère un fichier `.seb` par devoir : il désigne la page de départ, verrouille le navigateur et porte un sel propre à cette épreuve.

## Téléchargez-le en HTTPS, pas par `sebs://`

**Télécharger le .seb** vous donne le fichier brut. Enregistrez-le, ne l'ouvrez pas.

Les étudiants reçoivent un autre lien sur leur propre page, `sebs://…`, qui remet le fichier directement à Safe Exam Browser : celui-ci démarre en mode kiosque et vous n'inspectez plus rien. Ce lien est pour eux, ce bouton est pour vous.

## N'enregistrez jamais le fichier de nouveau

Ouvrez-le dans l'outil de configuration SEB (`Fichier → Ouvrir`, onglet **Exam**) pour y lire la **Browser Exam Key** de cette machine — une clé par plateforme et par version de SEB présente en salle. Reportez les clés dans le formulaire du devoir, une par ligne.

Cliquer sur **Enregistrer** dans l'outil régénère le sel : la Config Key change, toutes les clés déjà relevées deviennent fausses, et tous les fichiers déjà distribués cessent de fonctionner. C'est irréversible.

## Config Key

L'empreinte que le portail a calculée pour le fichier qu'il sert. L'outil de configuration affiche la sienne ; les deux doivent être identiques, caractère pour caractère. Si elles diffèrent, le démarrage de l'épreuve sera refusé et aucune Browser Exam Key n'y changera rien — signalez-le avant l'examen.

La clé n'apparaît ici qu'une fois le devoir arrivé dans le portail. Pressez **Resync** si le contraire est affiché.

Le protocole complet, y compris les refus à tester avant une épreuve, est dans `apps/codespace/docs/preuve-b-manuelle.md`.
