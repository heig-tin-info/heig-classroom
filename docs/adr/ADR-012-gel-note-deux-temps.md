# ADR-012 — Gel de note : heure de réception écrite synchronement, gel en deux temps

## Statut

Accepté (2026-07-03, phase 3).

## Contexte

La note gelée à la deadline est la donnée la plus litigieuse du système. La référence du gel
est l'heure de réception serveur du webhook push, persistée par SHA (GR-14, H6) — jamais
l'horodatage git, falsifiable. Un run portant sur un commit reçu avant la deadline mais
terminé après compte pour la note gelée, dans la limite d'un délai de grâce (GR-14.4,
défaut 30 min). Les webhooks sont traités en asynchrone via une file (GH-60) : si l'heure de
réception dépendait du traitement, un retard de file changerait des notes.

## Décision

1. **Écriture synchrone de `push_receipts`** dans le handler HTTP du webhook, avant
   l'enfilage du job : l'heure de réception (donnée légale du gel) ne dépend jamais du
   retard de la file. L'acquittement reste sous 5 s (deux INSERT).
2. **Table `bot_commits`** (`student_repo_id`, `sha`, `kind`) alimentée à chaque push bot
   (revert, deadline, synchro) : filtre **déterministe** d'éligibilité GR-05/GH-44, plus
   fiable que l'inférence par acteur au moment du run.
3. **Gel en deux temps** (lecture littérale de GR-12 et GR-14.4, empruntée à la proposition
   productivité) :
   1. À l'application de la deadline, `frozen_grade_run_id` est posé **provisoirement**
      (note courante GR-09 à cet instant).
   2. Pendant le délai de grâce, seuls les runs portant sur des commits reçus avant la
      deadline (présents dans `push_receipts`) peuvent encore améliorer ce pointeur.
   3. À `deadline + grace_minutes`, le ticker pose `frozen_at` et `frozen_final` : la note
      gelée devient définitive et immuable, les runs postérieurs ne la modifient jamais.
4. Un SHA sans heure de réception connue (webhook perdu, réconcilié après coup) est traité
   `after_deadline = true` dès que la deadline est passée — choix conservateur GR-14.3,
   arbitrable par le teacher au vu de l'historique.
5. Le délai de grâce est paramétrable par assignment ; le portail recommande 60 min quand
   l'effectif rend la capacité runner limitante (ADR-007).

## Conséquences

- Le gel est **insensible au retard de traitement** : une rafale de deadline ne produit que
  du retard d'affichage, jamais une note erronée.
- Les litiges se tranchent sur des faits persistés : `push_receipts.received_at` par SHA,
  `bot_commits` pour l'exclusion des commits bot, historique complet des GradeRuns.
- Le pipeline de grading et le gel sont découplés de la disponibilité du runner : un runner
  en panne retarde les notes, le gel attend la grâce puis fige.

## Alternatives rejetées

1. **Heure de réception écrite par le worker asynchrone** (proposition productivité, non
   explicité) : un retard de file déplacerait l'heure de référence vers l'heure de
   traitement — inacceptable pour une donnée qui départage un rendu à la seconde près.
2. **Gel en un temps à `deadline + grâce` uniquement** : plus simple mais n'offre aucune
   note provisoire à afficher pendant la grâce, et la lecture littérale de GR-12 (gel à la
   deadline) serait perdue.
3. **Filtre bot par `github.actor` du run seulement** : dépend du contexte d'exécution du
   workflow ; la table `bot_commits` par SHA est vérifiable a posteriori et rejouable.
