# ADR-007 — Runners self-hosted éphémères pour le grading, dimensionnés par le gel

## Statut

Accepté (2026-07-03, phase 3). Mesures de confirmation attendues du spike S3 (avant M4,
GH-44.3).

## Contexte

Le grading s'exécute exclusivement sur GitHub Actions (C-04), sur dépôts privés. Le plan
Team inclut 3 000 min/mois ; l'hypothèse basse (100 étudiants × 20 runs/mois × 2,5 min)
donne 5 000 min, avec des pointes bien pires en semaine de rendu. Le dépassement est
structurel. Par ailleurs, GR-14.4 impose que les runs portant sur des commits reçus avant la
deadline se terminent dans le délai de grâce, sinon ils sont exclus de la note gelée : la
capacité de calcul est pilotée par le gel, pas par le confort. Enfin, GH-02 proscrit toute
permission organisation supplémentaire pour la GitHub App sans révision de la spec.

## Décision

1. **VM runner dédiée** (8 vCPU / 16 Go / 100 Go), séparée de la VM applicative, hors réseau
   interne HEIG, egress filtré (GitHub et miroirs de paquets uniquement).
2. **8 runners éphémères** (`--ephemeral`, un conteneur jetable non privilégié par job,
   respawn systemd), image immuable reconstruite par CI, patching mensuel.
3. **Dimensionnement dérivé du gel** : capacité requise = rafale × durée de run / grâce.
   Pire cas 100 runs × 3 min / 30 min = 10 slots ; avec la grâce recommandée à 60 min pour
   les classes de plus de 60 étudiants, 5 slots suffisent — 8 slots donnent la marge.
   `grace_minutes` reste paramétrable par assignment (défaut 30 min, conforme H6).
4. **Enregistrement hors GitHub App** (GH-02 inchangée) : un fine-grained PAT dédié, portée
   organisation, unique permission « Self-hosted runners: read & write », stocké uniquement
   sur l'hôte de la VM runner (root, 600), expiration 12 mois. Le superviseur génère une
   configuration **JIT** par job ; les conteneurs de job ne voient jamais le PAT.
5. **Runner group d'organisation** visible de tous les dépôts privés : les dépôts étudiants
   créés dynamiquement sont couverts sans appel API par provisionnement (l'organisation est
   dédiée à l'enseignement). Label `grading` ; le template `grading.yml` utilise
   `runs-on: [self-hosted, grading]` et la condition anti-bot GH-44.
6. **Plan B en deux crans** : reconstruction scriptée de la VM en moins d'une heure ; en
   dernier recours, spending limit GitHub et PR de synchro basculant `runs-on` vers
   `ubuntu-latest` (dégradation payante plutôt que panne).

## Conséquences

- Coût de grading fixe et nul en minutes ; les 3 000 min hosted restent pour le teacher.
- Le code étudiant, hostile par définition, s'exécute dans un conteneur jetable sans aucun
  secret : la convention d'annotation GR-02 n'exige aucun token dans `grading.yml`, le blast
  radius d'une évasion est quasi nul (la VM runner n'a accès à rien).
- Une panne de la VM runner ne retarde que les notes : le gel se fonde sur `push_receipts`,
  insensible au retard de traitement.
- Un secret de plus à gérer (le PAT runners), à portée minimale, rotation au runbook.

## Alternatives rejetées

1. **Runners hébergés GitHub seuls** : dépassement de budget certain, facturation à piloter,
   risque de coupure de grading en pleine échéance ; conservés uniquement en plan B.
2. **Enregistrement JIT via la GitHub App** (proposition simplicité) : exigerait la
   permission organisation « Self-hosted runners: write », en contradiction avec le tableau
   GH-02 qui proscrit toute permission supplémentaire sans révision de la spec. Écarté au
   profit du PAT dédié, qui isole aussi ce pouvoir sur l'hôte runner.
3. **Runner group restreint à une liste de dépôts** (propositions productivité et
   robustesse) : imposerait un appel API d'ajout au groupe à chaque provisionnement, avec
   permission organisation non prévue ; la visibilité « tous les dépôts privés » est sûre
   dans une organisation dédiée.
4. **Dimensionnement au rush moyen** (proposition simplicité : 6 slots, drain < 15 min ;
   proposition productivité : 4-6 slots, file de 60 min) : la file de 60 min contre 30 min
   de grâce ferait manquer des runs éligibles à la note gelée, en violation de GR-14.4. Le
   dimensionnement retenu part de la contrainte de la spec.
