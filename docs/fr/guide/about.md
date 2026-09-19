# Qu'est-ce que HEIG Classroom

GitHub a annoncé en mai 2026 que GitHub Classroom, son outil d'orchestration des
dépôts étudiants autour des devoirs, serait retiré le 28 août 2026, après
18 mois en mode maintenance. La transition officielle oriente les enseignants
vers deux produits partenaires : [Codio](https://www.codio.com/), une plateforme
commerciale d'apprentissage pratique, et Classroom 50, une alternative libre et
gratuite maintenue par la Fifty Foundation.

Aucun des deux ne correspond à la manière dont l'informatique est enseignée dans
le département TIN de la HEIG-VD, où les besoins sont élémentaires mais
spécifiques. Un enseignant écrit un devoir sous la forme d'un dépôt Git
ordinaire, chaque étudiant en reçoit sa propre copie privée avec accès en push,
un workflow de CI note chaque push, et l'ensemble se verrouille de lui-même au
délai de rendu. Autour de ce noyau, nous voulons une source de vérité unique par
devoir, une vue tenant sur une page de qui a poussé quoi et de quels tests
passent, des fichiers protégés que les étudiants ne peuvent pas altérer (tests,
configuration de la CI), la possibilité de squasher l'historique du devoir pour
que la solution ne fuite jamais depuis le dépôt maître privé, un chemin propre
pour pousser des correctifs vers chaque dépôt étudiant au moyen de pull
requests, une réutilisation aisée des devoirs d'une année à l'autre, et une
connexion par Switch edu-ID avec le compte GitHub lié à l'identité académique de
l'étudiant.

Plutôt que de plier une plateforme générique à tout cela, nous avons construit
HEIG Classroom de zéro pour le semestre d'automne 2026. C'est un petit monolithe
Fastify au-dessus de PostgreSQL, qui pilote GitHub par l'intermédiaire d'une
GitHub App. GitHub reste la source de vérité pour tout ce qui relève de Git ; le
portail orchestre.

## Flux de travail de l'enseignant

L'enseignant écrit le devoir où il le souhaite, sous la forme d'un dépôt normal
doté d'un workflow de CI `grading.yml` qui affiche les points obtenus et le
maximum (une revue de code fondée sur un LLM s'y insère tout aussi bien que de
simples tests unitaires). Les dépôts étudiants vivent dans une organisation
GitHub, typiquement une par cours comme `heig-info2-tin-b`, passée au plan Team
gratuitement grâce à GitHub Education. La GitHub App HEIG Classroom est
installée une fois sur cette organisation.

À partir de là, tout se passe dans le portail :

1. Créer une classe rattachée à l'organisation.
2. Importer la liste des étudiants depuis la liste GAPS, déposée sous forme de
   fichier Excel ou CSV. La détection des colonnes est permissive, l'export
   fonctionne donc tel quel.
3. Créer un devoir pointant vers le dépôt source, choisir les dates, la
   stratégie de délai de rendu et les fichiers protégés directement dans
   l'arborescence du dépôt.
4. Publier. Les étudiants peuvent désormais accepter le devoir.

À la création, le portail squashe la source dans un dépôt frère portant le
suffixe `-squashed`. Ce dépôt est la source de vérité unique distribuée aux
étudiants : contenu complet, aucun historique, de sorte que la solution et le
processus de rédaction restent privés. L'enseignant peut continuer d'y
committer, et le portail peut ensuite ouvrir des pull requests sur chaque dépôt
étudiant pour distribuer les correctifs.

## Flux de travail de l'étudiant

Les étudiants se connectent avec Switch edu-ID. À la première connexion, le
portail met en correspondance leur adresse e-mail vérifiée avec la liste des
étudiants et les rattache automatiquement : il n'y a donc aucun code
d'invitation à saisir. La seule étape manuelle est la liaison de leur compte
GitHub, qui utilise une portée OAuth minimale `read:user`.

Ensuite, l'étudiant choisit un devoir, clique sur accepter, attend quelques
secondes le temps du provisionnement de son dépôt privé (créé à partir de la
source squashée, protégé contre les force pushes, avec l'accès en push accordé),
puis le clone et travaille normalement : commit, push, et ainsi de suite. Chaque
push déclenche la CI de notation et la note indicative apparaît dans le portail.
Au moment du délai de rendu, le dépôt est soit verrouillé en écriture, soit
marqué par un commit vide signé, selon la stratégie choisie par l'enseignant. Si
une CI a été configurée, la note est là, directement dans l'interface.

## Traçabilité

Le commit de délai de rendu est écrit par le bot de l'App et les force pushes
sont bloqués par un ruleset de dépôt : l'historique jusqu'au délai de rendu peut
donc être tenu pour une preuve fiable. Pour les devoirs qui demandent des points
de contrôle intermédiaires, la même astuce se généralise en jalons : un commit
de bot déposé à la demande ou à une heure programmée. GitHub n'offre aucune
primitive atomique « committer partout à la fois », mais révoquer l'accès en
push, committer, puis restaurer l'accès s'en approche suffisamment en pratique.

## CLI

Une CLI compagnon (une extension `gh`) dialogue avec l'API du portail au moyen
d'une clé d'API enseignant. Elle clone ou synchronise tout un devoir ou toute
une classe en une seule opération, ce qui est pratique pour noter hors ligne ou
conserver une sauvegarde locale :

```bash
$ gh classroom
Select your classroom
> (dropdown)
Select your assignment
> (dropdown with all)
... then it clones
```
