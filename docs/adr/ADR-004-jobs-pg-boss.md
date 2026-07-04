# ADR-004 — File de jobs pg-boss sur Postgres

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Les jobs critiques (provisionnement, deadline, revert, grading, synchro, e-mails) doivent
être durables, idempotents, rejouables et rattrapés après panne (NFR-09). Les webhooks sont
acquittés en moins de 5 s (GH-60) puis traités en asynchrone. Le pire débit attendu est une
rafale de deadline : environ 100 pushes plus 100 `workflow_run` en quelques minutes, soit
moins de 10 jobs/s.

## Décision

1. **pg-boss 10** : file de jobs persistante **dans PostgreSQL** — retries exponentiels,
   `singletonKey` (idempotence), jobs planifiés, cron intégré, rétention et archivage.
2. Concurrence bornée par type de job (10 workers) : les rafales remplissent la file sans
   jamais menacer l'acquittement des webhooks ni les quotas GitHub.
3. Échec de handler : 5 tentatives à backoff exponentiel, puis **dead-letter** visible dans
   l'écran d'administration technique avec relance manuelle et alerte log.
4. Clés singleton normalisées : `provision:<assignment>:<user>` (GH-20),
   `deadline:<assignment>` (GH-43), `revert:<repo>:<head_sha>`.

## Conséquences

- Aucun broker ni Redis à exploiter : la file survit à un crash avec la base, est couverte
  par la même sauvegarde et s'inspecte en SQL.
- Le débit requis est de plusieurs ordres de grandeur sous les capacités de pg-boss ; la
  charge de la file sur Postgres est négligeable à cette échelle.
- Les métriques d'exploitation (profondeur de file, lag, jobs en dead-letter) sont exposées
  sur `/metrics` (emprunt à la proposition robustesse).

## Alternatives rejetées

1. **BullMQ + Redis** : file performante mais impose un deuxième composant stateful à
   sauvegarder, superviser et sécuriser, pour un débit dont le projet n'a pas besoin.
2. **RabbitMQ, SQS ou broker dédié** : sur-ingénierie manifeste pour 20 classrooms ;
   aucune NFR ne le justifie.
3. **Cron système + tables maison** : réinventer retries, backoff et singleton sans les
   garanties éprouvées de pg-boss.
