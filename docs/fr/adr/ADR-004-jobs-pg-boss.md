# ADR-004 — File de tâches pg-boss sur Postgres

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

Les tâches critiques (provisionnement, délai de rendu, revert, notation, synchronisation, courriels) doivent être
durables, idempotentes, rejouables et rattrapées après une interruption (NFR-09). Les webhooks sont
acquittés en moins de 5 s (GH-60) puis traités de manière asynchrone. Le pire débit attendu
est un pic au délai de rendu : environ 100 pushes et 100 événements `workflow_run` en quelques
minutes, soit moins de 10 tâches/s.

## Décision

1. **pg-boss 10** : une file de tâches persistée **dans PostgreSQL** — nouvelles tentatives exponentielles,
   `singletonKey` (idempotence), tâches planifiées, cron intégré, rétention et archivage.
2. Concurrence bornée par type de tâche (10 workers) : les pics remplissent la file sans jamais
   menacer l'acquittement des webhooks ni les quotas GitHub.
3. Échec d'un handler : 5 tentatives avec backoff exponentiel, puis **dead-letter**, visible dans l'écran
   d'administration technique avec rejeu manuel et alerte dans le journal.
4. Clés de singleton normalisées : `provision:<assignment>:<user>` (GH-20),
   `deadline:<assignment>` (GH-43), `revert:<repo>:<head_sha>`.

## Conséquences

- Aucun broker ni Redis à exploiter : la file survit à un crash en même temps que la base de données,
  est couverte par la même sauvegarde, et peut être inspectée en SQL.
- Le débit requis est de plusieurs ordres de grandeur inférieur à ce que pg-boss sait faire ; la charge que la
  file impose à Postgres est négligeable à cette échelle.
- Les métriques d'exploitation (profondeur de file, retard, tâches en dead-letter) sont exposées sur `/metrics`
  (emprunté à la proposition robustesse).

## Alternatives rejetées

1. **BullMQ + Redis** : une file rapide, mais qui impose un second composant à état à sauvegarder,
   superviser et sécuriser, pour un débit dont le projet n'a pas besoin.
2. **RabbitMQ, SQS ou un broker dédié** : sur-ingénierie évidente pour 20 classes ; aucune
   NFR ne le justifie.
3. **Cron système + tables maison** : réinventer les nouvelles tentatives, le backoff et les singletons sans
   les garanties éprouvées de pg-boss.
