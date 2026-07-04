# ADR-011 — La réconciliation réutilise les handlers idempotents des webhooks

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

GitHub peut perdre ou retarder des livraisons de webhooks ; certains événements n'existent
pas (expiration d'invitation, GH-24). Les specs imposent un rattrapage : réconciliation des
GradeRuns toutes les 15 min (GR-07), réconciliation quotidienne des branches, invitations et
livraisons manquées (GH-62). Après une restauration de base (NFR-16), l'état doit se
resynchroniser seul. Le risque classique est d'écrire deux codes de mise à jour d'état (un
pour les webhooks, un pour le polling) qui divergent avec le temps.

## Décision

1. Règle structurante (empruntée à la proposition robustesse) : **tout état a deux chemins
   d'arrivée — webhook (nominal) et réconciliation (secours) — mais un seul code de mise à
   jour**. Les crons de réconciliation construisent des événements normalisés et invoquent
   **les mêmes handlers idempotents** que le pipeline webhook.
2. L'idempotence des handlers repose sur les contraintes UNIQUE du schéma (ADR-003) :
   rejouer un événement, quelle qu'en soit la source, ne produit jamais de doublon.
3. Crons retenus : `reconcile.grades` (15 min, GR-07), `reconcile.repos` (24 h, branches et
   invitations, GH-24), `reconcile.deliveries` (24 h, `GET /app/hook/deliveries` avec
   redelivery, GH-62), plus les tâches d'entretien (purge, e-mails).
4. Exception délibérée : l'**heure de réception** d'un push réconciliée après coup est
   inconnue — la règle conservatrice GR-14.3 s'applique (`after_deadline = true` si la
   deadline est passée), arbitrable par le teacher.

## Conséquences

- Un seul code d'état à tester et à maintenir ; le polling de secours ne peut pas diverger
  du chemin nominal.
- **La conception idempotente est aussi le plan de reprise** : après une panne ou une
  restauration, les crons résorbent d'eux-mêmes la fenêtre perdue, sans procédure spéciale.
- Le polling reste limité au rattrapage (NFR-10) : en régime nominal, tout arrive par
  webhook.

## Alternatives rejetées

1. **Code de réconciliation séparé** : double implémentation des règles d'état, divergence
   garantie à terme ; c'est le défaut que cette règle prévient.
2. **Polling périodique généralisé** au lieu des webhooks : violerait NFR-10 (rate limits,
   polling limité au rattrapage) et dégraderait la latence NFR-12.
