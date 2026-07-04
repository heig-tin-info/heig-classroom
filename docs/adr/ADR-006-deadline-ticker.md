# ADR-006 — Deadline par ticker-sweeper unique, pas de job one-shot planifié

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

Le job de deadline doit démarrer au plus 60 s après l'échéance et s'appliquer sur 100 dépôts
en moins de 5 min (US-22, NFR-13), survivre à une panne de n'importe quelle durée sans double
application (NFR-09), et suivre les replanifications de deadline (US-08, GH-43). Les
deadlines sont saisies en Europe/Zurich et stockées en UTC (C-02).

## Décision

1. Un **ticker unique** s'exécute toutes les 20 s, protégé par un advisory lock Postgres
   (sûr même après scission `WORKER_MODE`) : il sélectionne les assignments publiés dont
   `deadline_at <= now()` et `deadline_applied_at IS NULL`, et enfile un job
   `deadline.apply` (singleton par assignment).
2. `deadline.apply` fan-out en jobs par dépôt (concurrence 10), chacun idempotent (relit
   `locked_at` et `bot_commits` avant d'agir) ; les échecs individuels restent en retry sans
   bloquer les autres dépôts.
3. Le **gel** suit la même mécanique : un scan sur `frozen_at IS NULL` déclenche le gel
   définitif à `deadline + grace_minutes` (détail dans l'ADR-012).
4. Les index partiels `assignments(deadline_at) WHERE state='published' AND
   deadline_applied_at IS NULL` (et l'équivalent pour le gel) rendent le scan gratuit.

## Conséquences

- Démarrage garanti en moins de 60 s (période 20 s, marge facteur 3).
- **Replanification gratuite** : le ticker relit la table, aucune annulation de job à gérer.
- **Rattrapage après panne gratuit** : la condition SQL reste vraie tant que la deadline
  n'est pas appliquée ; aucune double application grâce à `deadline_applied_at` et aux
  contraintes d'idempotence.
- Un seul chemin de code à tester et à déboguer.

## Alternatives rejetées

1. **Job one-shot planifié à `deadline_at`** (`startAfter`, propositions productivité et
   robustesse en optimisation de latence, doublé d'un sweeper de garantie) : la « ceinture
   et bretelles » maintient deux chemins de code qui peuvent diverger, pour un gain de
   latence nul face à un ticker à 20 s. La revue a retenu le mécanisme unique.
2. **Cron externe (systemd timer)** : sort la logique du processus applicatif et complique
   le déploiement sans bénéfice ; pg-boss et le ticker in-process couvrent le besoin.
