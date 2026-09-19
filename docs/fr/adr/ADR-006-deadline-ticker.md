# ADR-006 — Délais de rendu par un unique ticker-balayeur, sans tâche ponctuelle planifiée

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

La tâche de délai de rendu doit démarrer au plus tard 60 s après l'échéance et s'appliquer à 100 dépôts en
moins de 5 min (US-22, NFR-13), survivre à une interruption de durée quelconque sans double application
(NFR-09), et suivre les replanifications de délai de rendu (US-08, GH-43). Les délais de rendu sont saisis en
Europe/Zurich et stockés en UTC (C-02).

## Décision

1. Un **ticker unique** s'exécute toutes les 20 s, protégé par un verrou consultatif Postgres (sûr même
   après un découpage `WORKER_MODE`) : il sélectionne les devoirs publiés dont
   `deadline_at <= now()` et `deadline_applied_at IS NULL`, et met en file une tâche `deadline.apply`
   (singleton par devoir).
2. `deadline.apply` se déploie en tâches par dépôt (concurrence 10), chacune idempotente (elle
   relit `locked_at` et `bot_commits` avant d'agir) ; les échecs individuels restent en nouvelle tentative
   sans bloquer les autres dépôts.
3. Le **gel** suit le même mécanisme : un balayage sur `frozen_at IS NULL` déclenche le gel
   définitif à `deadline + grace_minutes` (détails dans l'ADR-012).
4. Les index partiels `assignments(deadline_at) WHERE state='published' AND
   deadline_applied_at IS NULL` (et son équivalent pour le gel) rendent le balayage gratuit.

## Conséquences

- Démarrage garanti en moins de 60 s (période de 20 s, une marge d'un facteur 3).
- **La replanification est gratuite** : le ticker relit la table, il n'y a aucune annulation de tâche à
  gérer.
- **Le rattrapage après une interruption est gratuit** : la condition SQL reste vraie tant que le délai de rendu
  n'a pas été appliqué ; pas de double application, grâce à `deadline_applied_at` et aux
  contraintes d'idempotence.
- Un seul chemin de code à tester et à déboguer.

## Alternatives rejetées

1. **Une tâche ponctuelle planifiée à `deadline_at`** (`startAfter`, propositions productivité et robustesse
   au titre d'une optimisation de latence, appuyées par un balayeur de garantie) : l'approche « bretelles
   et ceinture » maintient deux chemins de code qui peuvent diverger, pour un gain de latence nul face à
   un ticker de 20 s. La revue a conservé le mécanisme unique.
2. **Cron externe (timer systemd)** : il sort la logique du processus applicatif et
   complique le déploiement sans bénéfice ; pg-boss et le ticker intra-processus couvrent le besoin.
