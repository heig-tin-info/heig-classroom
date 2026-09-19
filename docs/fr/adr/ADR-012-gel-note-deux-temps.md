# ADR-012 — Gel de la note : heure de réception écrite de façon synchrone, gel en deux temps

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

La note gelée au délai de rendu est la donnée la plus contestable du système. La référence du
gel est l'heure de réception par le serveur du webhook de push, persistée par SHA (GR-14,
H6) — jamais l'horodatage git, qui peut être falsifié. Un run sur un commit reçu avant le
délai de rendu mais terminé après celui-ci compte dans la note gelée, dans la limite d'une
période de grâce (GR-14.4, 30 min par défaut). Les webhooks sont traités de façon asynchrone
par une file (GH-60) : si l'heure de réception dépendait du traitement, un retard de la file
changerait les notes.

## Décision

1. **Écriture synchrone de `push_receipts`** dans le gestionnaire HTTP du webhook, avant la
   mise en file de la tâche : l'heure de réception (la donnée juridiquement décisive du gel)
   ne dépend jamais du retard de la file. L'accusé de réception reste sous les 5 s (deux
   INSERT).
2. Une **table `bot_commits`** (`student_repo_id`, `sha`, `kind`) alimentée à chaque push du
   bot (revert, délai de rendu, synchronisation) : un filtre d'éligibilité GR-05/GH-44
   **déterministe**, plus fiable qu'une inférence à partir de l'acteur au moment du run.
3. **Un gel en deux temps** (lecture littérale de GR-12 et GR-14.4, empruntée à la
   proposition productivité) :
   1. Lorsque le délai de rendu est appliqué, `frozen_grade_run_id` est fixé
      **provisoirement** (la note GR-09 courante à cet instant).
   2. Pendant la période de grâce, seuls les runs sur des commits reçus avant le délai de
      rendu (présents dans `push_receipts`) peuvent encore améliorer ce pointeur.
   3. À `deadline + grace_minutes`, le ticker fixe `frozen_at` et `frozen_final` : la note
      gelée devient définitive et immuable, et les runs ultérieurs ne la changent plus.
4. Un SHA sans heure de réception connue (webhook perdu, réconcilié après coup) est traité
   comme `after_deadline = true` dès que le délai de rendu est passé — le choix conservateur
   GR-14.3, ouvert à l'arbitrage d'un enseignant à la lumière de l'historique.
5. La période de grâce est configurable par devoir ; le portail recommande 60 min lorsque
   l'effectif de la classe fait de la capacité des runners le facteur limitant (ADR-007).

## Conséquences

- Le gel est **insensible au délai de traitement** : une rafale au délai de rendu ne produit
  qu'un retard d'affichage, jamais une note erronée.
- Les litiges se règlent sur des faits persistés : `push_receipts.received_at` par SHA,
  `bot_commits` pour exclure les commits du bot, l'historique complet des GradeRuns.
- Le pipeline de notation et le gel sont découplés de la disponibilité des runners : un
  runner en panne retarde les notes, et le gel attend la période de grâce puis verrouille.

## Alternatives rejetées

1. **Heure de réception écrite par le worker asynchrone** (proposition productivité, non
   explicitée) : un retard de la file décalerait l'heure de référence vers l'heure de
   traitement — inacceptable pour une donnée qui sépare les rendus à la seconde.
2. **Un gel en une seule étape à `deadline + grace` uniquement** : plus simple, mais il
   n'offre aucune note provisoire à afficher pendant la période de grâce, et la lecture
   littérale de GR-12 (gel au délai de rendu) serait perdue.
3. **Un filtre de bot fondé uniquement sur le `github.actor` du run** : il dépend du contexte
   d'exécution du workflow ; la table `bot_commits` par SHA est vérifiable après coup et
   rejouable.
