# ADR-007 — Runners auto-hébergés éphémères pour la notation, dimensionnés par le gel

## Statut

Acceptée (2026-07-03, phase 3). Mesures de confirmation attendues de l'étude préliminaire S3 (avant M4,
GH-44.3).

## Contexte

La notation s'exécute exclusivement sur GitHub Actions (C-04), sur des dépôts privés. Le plan Team
inclut 3 000 min/mois ; l'estimation basse (100 étudiants × 20 exécutions/mois × 2,5 min) donne
5 000 min, avec des pics bien pires durant les semaines de rendu. Le dépassement est structurel. À cela
s'ajoute la GR-14.4, qui exige que les exécutions portant sur des commits reçus avant le délai de rendu se terminent dans le
délai de grâce, faute de quoi elles sont exclues de la note gelée : la capacité de calcul est dictée
par le gel, non par le confort. Enfin, la GH-02 interdit toute permission d'organisation supplémentaire
pour la GitHub App sans révision de la spécification.

## Décision

1. Une **VM runner dédiée** (8 vCPU / 16 Go / 100 Go), distincte de la VM applicative,
   hors du réseau interne HEIG, avec un trafic sortant filtré (GitHub et miroirs de paquets uniquement).
2. **8 runners éphémères** (`--ephemeral`, un conteneur non privilégié jetable par tâche,
   respawn systemd), une image immuable reconstruite par la CI, correctifs mensuels.
3. **Dimensionnement dérivé du gel** : capacité requise = pic × durée d'exécution / grâce.
   Au pire, 100 exécutions × 3 min / 30 min = 10 emplacements ; avec la grâce recommandée de 60 min pour
   les classes de plus de 60 étudiants, 5 emplacements suffisent — 8 emplacements donnent la marge.
   `grace_minutes` reste configurable par devoir (30 min par défaut, conformément à H6).
4. **Enregistrement hors de la GitHub App** (GH-02 inchangée) : un PAT fine-grained dédié,
   à portée organisation, avec la seule permission « Self-hosted runners: read & write »,
   stocké uniquement sur l'hôte de la VM runner (root, 600), expirant au bout de 12 mois. Le superviseur
   génère une configuration **JIT** par tâche ; les conteneurs de tâche ne voient jamais le PAT.
5. Un **groupe de runners d'organisation** visible par tous les dépôts privés : les dépôts étudiants
   créés dynamiquement sont couverts sans appel d'API au moment du provisionnement (l'organisation
   est dédiée à l'enseignement). Label `grading` ; le modèle `grading.yml` utilise
   `runs-on: [self-hosted, grading]` et la condition anti-bot GH-44.
6. **Un plan B en deux étapes** : reconstruction scriptée de la VM en moins d'une heure ; en dernier recours,
   une limite de dépense GitHub et une PR de synchronisation basculant `runs-on` sur `ubuntu-latest`
   (dégradation payante plutôt qu'une interruption de service).

## Conséquences

- Le coût de la notation est fixe et nul en minutes ; les 3 000 minutes hébergées restent disponibles pour
  l'enseignant.
- Le code étudiant, hostile par définition, s'exécute dans un conteneur jetable sans aucun secret : la
  convention d'annotation GR-02 n'exige aucun token dans `grading.yml`, si bien que le rayon d'impact d'une
  évasion est proche de zéro (la VM runner n'a accès à rien).
- Une interruption de la VM runner ne fait que retarder les notes : le gel s'appuie sur `push_receipts`,
  insensible au délai de traitement.
- Un secret de plus à gérer (le PAT des runners), à portée minimale et avec rotation décrite dans le
  runbook.

## Alternatives rejetées

1. **Les runners hébergés par GitHub seuls** : dépassement budgétaire certain, facturation à piloter, et le risque
   de voir la notation coupée au milieu d'un délai de rendu ; conservés uniquement comme plan B.
2. **Enregistrement JIT par la GitHub App** (proposition simplicité) : cela exigerait la permission
   d'organisation « Self-hosted runners: write », en contradiction avec le tableau GH-02, qui
   interdit toute permission supplémentaire sans révision de la spécification. Écartée au profit du
   PAT dédié, qui isole en outre ce pouvoir sur l'hôte runner.
3. **Un groupe de runners restreint à une liste de dépôts** (propositions productivité et robustesse) :
   cela imposerait un appel d'API pour ajouter le dépôt au groupe à chaque
   provisionnement, avec une permission d'organisation qui n'est pas prévue ; la visibilité « tous les dépôts
   privés » est sûre dans une organisation dédiée.
4. **Dimensionnement pour la ruée moyenne** (proposition simplicité : 6 emplacements, vidage < 15 min ;
   proposition productivité : 4 à 6 emplacements, file de 60 min) : une file de 60 min face à une grâce de 30 min
   manquerait des exécutions éligibles à la note gelée, en violation de la GR-14.4. Le dimensionnement retenu
   part de la contrainte inscrite dans la spécification.
