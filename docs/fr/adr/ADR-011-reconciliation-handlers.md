# ADR-011 — La réconciliation réutilise les gestionnaires de webhooks idempotents

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

GitHub peut perdre ou retarder des livraisons de webhooks ; certains événements n'existent
tout simplement pas (expiration d'invitation, GH-24). Les spécifications exigent un
rattrapage : réconciliation des GradeRuns toutes les 15 min (GR-07), réconciliation
quotidienne des branches, des invitations et des livraisons manquées (GH-62). Après une
restauration de la base de données (NFR-16), l'état doit se resynchroniser de lui-même. Le
risque classique est d'écrire deux chemins de code de mise à jour de l'état (un pour les
webhooks, un pour l'interrogation périodique) qui divergent avec le temps.

## Décision

1. Une règle structurante (empruntée à la proposition robustesse) : **chaque élément d'état a
   deux voies d'arrivée — webhook (nominale) et réconciliation (de repli) — mais un seul
   chemin de code de mise à jour**. Les tâches cron de réconciliation construisent des
   événements normalisés et invoquent **les mêmes gestionnaires idempotents** que le pipeline
   de webhooks.
2. L'idempotence des gestionnaires repose sur les contraintes UNIQUE du schéma (ADR-003) :
   rejouer un événement, quelle qu'en soit la source, ne produit jamais de doublon.
3. Les tâches cron retenues : `reconcile.grades` (15 min, GR-07), `reconcile.repos` (24 h,
   branches et invitations, GH-24), `reconcile.deliveries` (24 h,
   `GET /app/hook/deliveries` avec redelivery, GH-62), plus les tâches de maintenance (purge,
   courriels).
4. Une exception délibérée : l'**heure de réception** d'un push réconcilié après coup est
   inconnue — la règle conservatrice GR-14.3 s'applique (`after_deadline = true` si le délai
   de rendu est passé), ouverte à l'arbitrage d'un enseignant.

## Conséquences

- Un seul chemin de code d'état à tester et à maintenir ; l'interrogation périodique de repli
  ne peut pas diverger de la voie nominale.
- **La conception idempotente est aussi le plan de reprise** : après une panne ou une
  restauration, les tâches cron absorbent d'elles-mêmes la fenêtre perdue, sans procédure
  particulière.
- L'interrogation périodique reste limitée au rattrapage (NFR-10) : en fonctionnement
  nominal, tout arrive par les webhooks.

## Alternatives rejetées

1. **Un chemin de code de réconciliation séparé** : une double implémentation des règles
   d'état, avec une divergence garantie à long terme ; c'est exactement le défaut que cette
   règle prévient.
2. **Une interrogation périodique généralisée** au lieu des webhooks : cela violerait NFR-10
   (limites de débit, interrogation limitée au rattrapage) et dégraderait la latence NFR-12.
