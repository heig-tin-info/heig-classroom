HEIG GitHub Classroom

Portail web deux rôles : student et teacher
Le teacher peut créer des classroom avec un nom et y insérer une liste d'étudiants
Dans sa vue il voit le nombre d'assignments pour chaque classroom, la date de début, la date d'échéanche
Il voit aussi la liste des étudiants sous forme d'un tableau : nom, prénom, e-mail, compte GitHub, dernière connexion

Quand on crée une classroom on l'assigne à une organisation et le système demande les droits d'accès à cette organisation

Il peut créer des assignments. Un assignment a: 

- Un nom d'assignment
- Une deadline (date heure)
- Une date de début (date heure)
- Un lien vers un dépôt GitHub source de l'assignment qui doit être dans l'organisation
- La stratégie par défaut de source:
  1. Whole repository (tout l'historique)
  2. Squash into primary commits
- Les branches à récupérer (par défaut seulement master ou main selon laquelle existe)
- Protected files: liste des fichiers du REPO qui ne peuvent pas être modifies par l'étudiant
  Par défaut on regarde si y'a un criteria.yml et un README.md et on les coche
- Deadline strategy: 
  1. Lock de repository
  2. Do a deadline commit (empty commit with a comment)

Quand l'étudiant se connecte il a la vue de ses assignments et un lien vers leur dépôt GitHub de travail

En backend le service a plusieurs taches: 

- Authentifier le user (GitHub/HEIG-VD)
- Collecter les métriques des répos étudiants (date dernier commit, hash, état des tests)
- Au moment d'accepter l'assignment par l'étudiant on
  - Créer le référentiel dans l'organisation
  - On donne les droits de commit/push à l'étudiant on interdit (si possible le forced push)
  - On collecte le lien vers le répo pour que l'étudiant puisse y avoir accès
- Une tâche de fond (hook, cron…):
  - Vérouille le push sur tous les référentiels de l'assignment à la deadline
  - Fait le commit de deadline ou vérouille le référentiel selon la stratégie
  - Récupère les status du CI (l'étudiant et le teacher peuvent toujours voir le status et la note indicative après chaque passe CI si grading est present)

Sur le référentiel, les tests sont effectués par un CI grading.yml qui retournent la note de l'étudiant
Si le CI grading est absent, pas de grading, juste un status pass/fail sur le repo est récupéré 

Une API avec clé d'API est dispo pour le teacher. Elle permet de récupérer les infos pour permettre à un cli d'automatiser le clone des référentiels

Une autre fonctionnalité importante est que le teacher peut modifier le référentiel source s'il push il peut synchroniser les référentiels d'étudiant en créant un PR. C'est pourquoi il y a deux référentiels sources: 

1. Le référentiel source (private)
2. Le référentiel source squashed (private) (utilisé comme base pour créer les référentiels d'étudiants et utilise pour faire des modifs via PR), ce dernier est créé au moment de la creation de l'assignment, et le teacher à accès au lien depuis l'interface web
3. Les référentiels des étudiants (private pour chaque étudiant)

---

On doit travailler en plusieurs phases: 

1. Réanaylser les besoins 
2. Consolider le cahier des charges et les specs du projet
3. Définir l'architecture logicielle, la stack utilisée (front/back), websocket, api…
4. Implémentation
5. Tests
