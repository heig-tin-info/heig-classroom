# ADR-001 — Monolithe modulaire, processus unique, découpage `WORKER_MODE` optionnel

## Statut

Acceptée (2026-07-03, phase 3).

## Contexte

La plateforme sert un portail web, deux API, un point d'entrée webhook, un flux SSE et des
tâches de fond (délai de rendu, provisionnement, notation). Les volumes sont faibles (NFR-11 : 30 à 100 étudiants par
classe, 20 classes actives), la cible de disponibilité est de 99 % (NFR-08), et l'équipe
d'exploitation se résume à un enseignant aidé ponctuellement. Le coût de possession est le critère décisif.
Les pics (webhooks au délai de rendu) relèvent d'un problème de file d'attente, non de passage à l'échelle.

## Décision

1. Un **monolithe modulaire** : un processus Node.js unique (`hgc-server`) porte le portail
   (SPA statique), l'API du portail, l'API v1 par clé, la réception des webhooks, le flux SSE et
   les workers de tâches.
2. Les frontières internes sont des **modules TypeScript** aux interfaces explicites (`auth`,
   `roster`, `assignments`, `github`, `provisioning`, `protected-files`, `deadline`,
   `grading`, `sync`, `metrics`, `notifications`, `api-v1`, `events`, `jobs`), auxquels
   s'ajoute un paquet `packages/domain` de règles métier pures (regex GR-02, agrégation GR-06,
   éligibilité GR-05, gel GR-12/14) sans dépendance à un framework ni à la base de données.
3. Une variable d'environnement `WORKER_MODE` permet de séparer plus tard les rôles `web` et
   `worker` **sans aucune modification de code** : l'option d'évolution est gratuite, elle n'est
   pas payée d'avance.
4. Le point de défaillance unique du processus unique est **accepté** : redémarrage automatique, webhooks redélivrés
   (GH-62), délais de rendu rattrapés par le ticker (NFR-09) ; une indisponibilité du portail n'empêche jamais
   les étudiants de travailler sur GitHub.

## Conséquences

- Un seul journal à lire, une seule unité de déploiement, un retour arrière trivial (tag précédent).
- Pas de cache distribué : les jetons d'installation GitHub vivent en mémoire (GH-03).
- Le bus d'événements SSE est un simple EventEmitter intra-processus ; si un découpage `WORKER_MODE`
  devait survenir, il basculerait sur `LISTEN/NOTIFY` de Postgres (prévu, non implémenté en v1).
- Tout incident (fuite mémoire, tâche bloquante) touche à la fois le portail, les webhooks et les délais de rendu :
  un risque accepté au regard de la NFR-08 (99 %), surveillé par la sonde externe.

## Alternatives rejetées

1. **Microservices** (aucune proposition ne les a retenus) : les volumes ne les justifient pas ; chaque
   service ajouterait du déploiement, du réseau et de l'observabilité à exploiter.
2. **Deux rôles de processus dès la v1** (proposition robustesse : conteneurs `web` + `worker`,
   relais `LISTEN/NOTIFY`) : un conteneur de plus et un canal de communication de plus, non
   essentiels à 100 étudiants ; la revue a conservé le découpage comme option (`WORKER_MODE`,
   proposition productivité) plutôt que payé d'avance.
3. **Kubernetes ou un orchestrateur** : rien dans les NFR ne le justifie ; la charge
   d'exploitation continue est hors de proportion pour une équipe d'une personne.
